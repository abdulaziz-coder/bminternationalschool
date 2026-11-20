from datetime import date, timedelta
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app import teacher_auth, teacher_portal
from app.main import app
from app.runtime import loop_factory
from test_admin import ORIGIN, local_account, login as admin_login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

# A fixed "today" (a Wednesday), so the tests do not depend on the day they run.
TODAY = date(2026, 11, 18)
MONDAY = date(2026, 11, 16)
ELSEWHERE = {"Origin": "https://unrelated.example"}


@pytest.fixture(autouse=True)
def fixed_day(monkeypatch):
    monkeypatch.setattr(teacher_portal, "today", lambda: TODAY)
    teacher_auth.sessions.clear()
    teacher_auth.attempts.clear()
    yield
    teacher_auth.sessions.clear()


def school(client) -> dict:
    """A maths teacher with lessons in 5-A on Monday 08:00 and Wednesday 09:00, another teacher, and three students."""
    admin_login(client)
    client.post("/api/admin/subjects", json={"names": {"uz": "Matematika", "en": "Mathematics"}, "grades": [5]}, headers=ORIGIN)
    zarina = client.post("/api/admin/teachers", json={"full_name": "Karimova Zarina", "subject": "Matematika"}, headers=ORIGIN).json()
    vali = client.post("/api/admin/teachers", json={"full_name": "Aliyev Vali", "subject": "Matematika"}, headers=ORIGIN).json()
    students = {name: client.post("/api/admin/students", json={"full_name": name, "grade": 5, "class_name": letter}, headers=ORIGIN).json()["id"]
                for name, letter in (("Aliyev Ali", "a"), ("Bakirov Bobur", "A"), ("Other Class", "B"))}
    lessons = {}
    for key, teacher, day, period in (("monday", zarina, 0, 0), ("wednesday", zarina, 2, 1), ("vali", vali, 4, 3)):
        lessons[key] = client.post("/api/admin/timetable/lessons", json={"grade": 5, "class_name": "A", "day": day, "period": period, "teacher_id": teacher["teacher"]["id"]}, headers=ORIGIN).json()["id"]
    client.post("/api/admin/logout", headers=ORIGIN)
    assert client.post("/api/teacher/login", json={"login": zarina["teacher"]["login"], "password": zarina["password"]}, headers=ORIGIN).status_code == 200
    return {"lessons": lessons, "students": students}


def test_teacher_pages_need_a_teacher_sign_in():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/teacher/timetable").status_code == 401
        assert client.get(f"/api/teacher/lessons/{uuid4()}/register", params={"date": "2026-11-16"}).status_code == 401
        assert client.put(f"/api/teacher/lessons/{uuid4()}/register", params={"date": "2026-11-16"}, json={"marks": []}, headers=ORIGIN).status_code == 401
        # An admin's sign-in is not a teacher's.
        admin_login(client)
        assert client.get("/api/teacher/timetable").status_code == 401


def test_teacher_sees_their_own_week(database_client):
    client = database_client
    setup = school(client)
    week = client.get("/api/teacher/timetable").json()
    assert (week["week_start"], week["today"]) == ("2026-11-16", "2026-11-18")
    # Only their own lessons, with the date each falls on and the class size.
    assert [(item["day"], item["period"], item["date"], item["grade"], item["class_name"], item["students"], item["recorded"], item["subject_names"]["en"]) for item in week["lessons"]] == [
        (0, 0, "2026-11-16", 5, "A", 2, False, "Mathematics"), (2, 1, "2026-11-18", 5, "A", 2, False, "Mathematics")]
    # Any date in another week shows that week.
    assert client.get("/api/teacher/timetable", params={"start": "2026-11-26"}).json()["week_start"] == "2026-11-23"
    assert client.get("/api/teacher/timetable", params={"start": "not a date"}).status_code == 422
    assert setup["lessons"]["vali"] not in {item["id"] for item in week["lessons"]}


def test_teacher_records_attendance_and_grades(database_client):
    client = database_client
    setup = school(client)
    monday, ali, bobur, other = setup["lessons"]["monday"], setup["students"]["Aliyev Ali"], setup["students"]["Bakirov Bobur"], setup["students"]["Other Class"]
    url = f"/api/teacher/lessons/{monday}/register"

    blank = client.get(url, params={"date": "2026-11-16"}).json()
    assert (blank["class_name"], blank["editable"], blank["saved_at"], blank["subject_names"]["uz"]) == ("A", True, None, "Matematika")
    assert [(student["full_name"], student["attendance"], student["score"]) for student in blank["students"]] == [("Aliyev Ali", None, None), ("Bakirov Bobur", None, None)]

    marks = {"marks": [{"student_id": ali, "attendance": "late", "score": 5}, {"student_id": bobur, "attendance": "absent"}]}
    assert client.put(url, params={"date": "2026-11-16"}, json=marks, headers=ELSEWHERE).status_code == 403
    saved = client.put(url, params={"date": "2026-11-16"}, json=marks, headers=ORIGIN)
    assert saved.status_code == 200 and saved.headers["cache-control"] == "no-store" and saved.json()["saved_at"]
    assert [(student["attendance"], student["score"]) for student in saved.json()["students"]] == [("late", 5), ("absent", None)]
    assert [item["recorded"] for item in client.get("/api/teacher/timetable").json()["lessons"]] == [True, False]

    # Saving again replaces the marks; a grade may be left empty.
    again = client.put(url, params={"date": "2026-11-16"}, json={"marks": [{"student_id": ali, "attendance": "present", "score": None}, {"student_id": bobur, "attendance": "present", "score": 3}]}, headers=ORIGIN).json()
    assert [(student["attendance"], student["score"]) for student in again["students"]] == [("present", None), ("present", 3)]
    # The same lesson a week earlier is a separate register.
    assert [student["attendance"] for student in client.get(url, params={"date": "2026-11-09"}).json()["students"]] == [None, None]

    put = lambda body, on="2026-11-16": client.put(url, params={"date": on}, json=body, headers=ORIGIN)  # noqa: E731
    # Not on the lesson's weekday, in the future, a student from another class, the same student twice, bad values.
    assert put(marks, on="2026-11-17").json()["detail"] == "wrong_day"
    assert put(marks, on="2026-11-23").json()["detail"] == "future_date"
    assert client.get(url, params={"date": "2026-11-23"}).json()["editable"] is False
    assert put({"marks": [{"student_id": other, "attendance": "present"}]}).json()["detail"] == "unknown_student"
    assert put({"marks": [{"student_id": ali, "attendance": "present"}, {"student_id": ali, "attendance": "late"}]}).json()["detail"] == "duplicate_student"
    for bad in ({"student_id": ali, "attendance": "absent", "score": 4}, {"student_id": ali, "attendance": "present", "score": 6}, {"student_id": ali, "attendance": "present", "score": 0},
                {"student_id": ali, "attendance": "present", "score": "5"}, {"student_id": ali, "attendance": "sick"}):
        assert put({"marks": [bad]}).status_code == 422

    # Another teacher's lesson, or an unknown one, cannot be opened.
    assert client.get(f"/api/teacher/lessons/{setup['lessons']['vali']}/register", params={"date": "2026-11-20"}).status_code == 404
    assert client.get(f"/api/teacher/lessons/{uuid4()}/register", params={"date": "2026-11-16"}).status_code == 404

    # Today's lesson can be filled in; removing a student removes their marks.
    today = client.put(f"/api/teacher/lessons/{setup['lessons']['wednesday']}/register", params={"date": "2026-11-18"}, json={"marks": [{"student_id": ali, "attendance": "present", "score": 4}]}, headers=ORIGIN)
    assert today.status_code == 200
    admin_login(client)
    client.delete(f"/api/admin/students/{ali}", headers=ORIGIN)
    assert [student["full_name"] for student in client.get(url, params={"date": "2026-11-16"}).json()["students"]] == ["Bakirov Bobur"]


def test_week_starts_on_monday():
    assert teacher_portal.monday_of(date(2026, 11, 22)) == MONDAY  # a Sunday belongs to the week before
    assert teacher_portal.monday_of(MONDAY) == MONDAY and teacher_portal.monday_of(MONDAY + timedelta(days=5)) == MONDAY

from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.runtime import loop_factory
from test_admin import ORIGIN, local_account, login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

ELSEWHERE = {"Origin": "https://unrelated.example"}


def setup_school(client) -> dict[str, str]:
    """Two subjects and three teachers; returns the teachers' ids by name."""
    login(client)
    client.post("/api/admin/subjects", json={"names": {"uz": "Matematika", "en": "Mathematics", "ru": "Математика"}, "grades": [1, 2, 3, 4, 5]}, headers=ORIGIN)
    client.post("/api/admin/subjects", json={"names": {"en": "Physics"}, "grades": [7, 8, 9]}, headers=ORIGIN)
    teachers = {}
    for name, subject in (("Karimova Zarina", "Matematika"), ("Aliyev Vali", "Matematika"), ("Usmonov Bek", "Physics")):
        teachers[name] = client.post("/api/admin/teachers", json={"full_name": name, "subject": subject}, headers=ORIGIN).json()["teacher"]["id"]
    return teachers


def lesson(teacher_id, day=0, period=0, grade=5, class_name="A"):
    return {"grade": grade, "class_name": class_name, "day": day, "period": period, "teacher_id": teacher_id}


def test_timetable_is_private():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/admin/timetable/classes").status_code == 401
        assert client.get("/api/admin/timetable", params={"grade": 5, "class_name": "A"}).status_code == 401
        assert client.post("/api/admin/timetable/lessons", json=lesson(str(uuid4())), headers=ORIGIN).status_code == 401
        assert client.delete(f"/api/admin/timetable/lessons/{uuid4()}", headers=ORIGIN).status_code == 401


@pytest.mark.parametrize("patch", [{"grade": 0}, {"grade": 12}, {"grade": "5"}, {"day": 6}, {"day": -1}, {"period": 7}, {"class_name": "A-1"}, {"class_name": "a" * 11}, {"teacher_id": "nobody"}, {"extra": 1}])
def test_invalid_lessons_rejected_before_database(patch):
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        login(client)
        assert client.post("/api/admin/timetable/lessons", json={**lesson(str(uuid4())), **patch}, headers=ORIGIN).status_code == 422
        assert client.get("/api/admin/timetable", params={"grade": 5, "class_name": "A-1"}).status_code == 422


def test_admin_builds_a_class_timetable(database_client):
    client = database_client
    teachers = setup_school(client)
    zarina, vali, bek = teachers["Karimova Zarina"], teachers["Aliyev Vali"], teachers["Usmonov Bek"]

    # Grade 5 takes mathematics (two teachers) but not physics.
    table = client.get("/api/admin/timetable", params={"grade": 5, "class_name": "a"}).json()
    assert (table["grade"], table["class_name"], table["lessons"], table["busy"]) == (5, "A", [], [])
    assert [(option["subject"], option["teacher_name"], option["subject_names"]["en"]) for option in table["options"]] == [("Matematika", "Aliyev Vali", "Mathematics"), ("Matematika", "Karimova Zarina", "Mathematics")]

    assert client.post("/api/admin/timetable/lessons", json=lesson(zarina), headers=ELSEWHERE).status_code == 403
    placed = client.post("/api/admin/timetable/lessons", json=lesson(zarina, day=0, period=0, class_name=" a "), headers=ORIGIN)
    assert placed.status_code == 201 and placed.headers["cache-control"] == "no-store"
    assert {key: placed.json()[key] for key in ("day", "period", "teacher_name", "subject")} == {"day": 0, "period": 0, "teacher_name": "Karimova Zarina", "subject": "Matematika"}

    # The same time in the same class is taken; a subject the grade does not take is refused; unknown teachers too.
    assert client.post("/api/admin/timetable/lessons", json=lesson(vali, day=0, period=0), headers=ORIGIN).json()["detail"] == "time_taken"
    assert client.post("/api/admin/timetable/lessons", json=lesson(bek, day=0, period=1), headers=ORIGIN).json()["detail"] == "subject_not_for_grade"
    assert client.post("/api/admin/timetable/lessons", json=lesson(str(uuid4()), day=0, period=1), headers=ORIGIN).status_code == 404

    # A teacher cannot be in two classes at once, and the other class sees when they are busy.
    assert client.post("/api/admin/timetable/lessons", json=lesson(zarina, day=0, period=0, class_name="B"), headers=ORIGIN).json()["detail"] == "teacher_busy"
    other = client.get("/api/admin/timetable", params={"grade": 5, "class_name": "B"}).json()
    assert other["busy"] == [{"teacher_id": zarina, "day": 0, "period": 0, "grade": 5, "class_name": "A"}]
    assert client.post("/api/admin/timetable/lessons", json=lesson(vali, day=0, period=0, class_name="B"), headers=ORIGIN).status_code == 201
    assert client.post("/api/admin/timetable/lessons", json=lesson(zarina, day=5, period=6), headers=ORIGIN).status_code == 201

    table = client.get("/api/admin/timetable", params={"grade": 5, "class_name": "A"}).json()
    assert [(item["day"], item["period"], item["teacher_name"]) for item in table["lessons"]] == [(0, 0, "Karimova Zarina"), (5, 6, "Karimova Zarina")]
    assert table["busy"] == [{"teacher_id": vali, "day": 0, "period": 0, "grade": 5, "class_name": "B"}]

    # Classes come from the students' list and from timetables.
    client.post("/api/admin/students", json={"full_name": "Aliyev Ali", "grade": 5, "class_name": "a"}, headers=ORIGIN)
    client.post("/api/admin/students", json={"full_name": "Usmonova Malika", "grade": 9}, headers=ORIGIN)
    assert client.get("/api/admin/timetable/classes").json() == [
        {"grade": 5, "class_name": "A", "students": 1, "lessons": 2},
        {"grade": 5, "class_name": "B", "students": 0, "lessons": 1},
        {"grade": 9, "class_name": "", "students": 1, "lessons": 0},
    ]

    # Removing a lesson frees the time; removing a teacher removes their lessons.
    first = table["lessons"][0]["id"]
    assert client.delete(f"/api/admin/timetable/lessons/{first}", headers=ELSEWHERE).status_code == 403
    assert client.delete(f"/api/admin/timetable/lessons/{first}", headers=ORIGIN).status_code == 204
    assert client.delete(f"/api/admin/timetable/lessons/{first}", headers=ORIGIN).status_code == 204
    assert client.post("/api/admin/timetable/lessons", json=lesson(vali, day=0, period=0), headers=ORIGIN).json()["detail"] == "teacher_busy"
    assert client.delete(f"/api/admin/teachers/{zarina}", headers=ORIGIN).status_code == 204
    assert client.get("/api/admin/timetable", params={"grade": 5, "class_name": "A"}).json()["lessons"] == []
    assert [option["teacher_name"] for option in client.get("/api/admin/timetable", params={"grade": 5, "class_name": "A"}).json()["options"]] == ["Aliyev Vali"]

from datetime import date, datetime
from io import BytesIO
from uuid import uuid4

from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
import pytest

from app.main import app
from app.runtime import loop_factory
from app.students import map_columns, parse_date, parse_grade, read_workbook
from test_admin import ORIGIN, local_account, login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

STUDENT = {"full_name": "Aliyev Vali", "grade": 5, "class_name": "A", "birth_date": "2015-09-01", "parent_name": "Aliyev Sardor", "parent_phone": "+998 90 123 45 67"}
XLSX_HEADERS = {**ORIGIN, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}


def workbook(*rows) -> bytes:
    book = Workbook()
    for row in rows:
        book.active.append(row)
    output = BytesIO()
    book.save(output)
    return output.getvalue()


def test_students_are_private():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/admin/students").status_code == 401
        assert client.get("/api/admin/students/template").status_code == 401
        assert client.post("/api/admin/students", json=STUDENT, headers=ORIGIN).status_code == 401
        assert client.post("/api/admin/students/import", content=workbook(["Name", "Grade"]), headers=XLSX_HEADERS).status_code == 401
        assert client.put(f"/api/admin/students/{uuid4()}", json=STUDENT, headers=ORIGIN).status_code == 401
        assert client.delete(f"/api/admin/students/{uuid4()}", headers=ORIGIN).status_code == 401


@pytest.mark.parametrize("patch", [{"full_name": " "}, {"full_name": "a" * 121}, {"grade": 0}, {"grade": 12}, {"grade": "5"}, {"class_name": "a" * 11}, {"birth_date": "not a date"}, {"birth_date": "1900-01-01"}, {"birth_date": "2999-01-01"}, {"parent_phone": "call me"}, {"extra": 1}])
def test_invalid_students_rejected_before_database(patch):
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        login(client)
        assert client.post("/api/admin/students", json={**STUDENT, **patch}, headers=ORIGIN).status_code == 422


def test_reading_grades_dates_and_headers():
    assert parse_grade(5) == (5, None) and parse_grade(5.0) == (5, None) and parse_grade("7") == (7, None)
    assert parse_grade("5A") == (5, "A") and parse_grade("5-a") == (5, "A") and parse_grade("10 «Б»") == (10, "Б") and parse_grade("3-sinf") == (3, None)
    assert parse_grade("fifth") == (None, None) and parse_grade(5.5) == (None, None) and parse_grade(None) == (None, None)
    assert parse_date("01.09.2015") == date(2015, 9, 1) and parse_date("2015-09-01") == date(2015, 9, 1) and parse_date(datetime(2015, 9, 1)) == date(2015, 9, 1)
    assert parse_date("") is None and parse_date("soon") is False
    assert map_columns(("№", "F.I.Sh", "Sinf", "Tug‘ilgan sana", "Ota-onasining ismi", "Telefon")) == {"parent_phone": [5], "birth_date": [3], "parent_name": [4], "grade": [2], "full_name": [1]}
    assert map_columns(("Фамилия", "Имя", "Класс", "Телефон родителя"))["full_name"] == [0, 1]


def test_workbook_rows_are_validated_one_by_one():
    students, problems, total = read_workbook(workbook(
        ["Students of the school"], [],
        ["№", "Full name", "Grade", "Class letter", "Date of birth", "Parent", "Parent phone"],
        [1, "  Aliyev   Vali ", "5", "a", "01.09.2015", "Aliyev Sardor", 998901234567.0],
        [2, "Karimova Zarina", "6-B", None, None, None, None],
        [3, None, 4, None, None, None, None],
        [4, "No Grade", "twelve", None, None, None, None],
        [5, "Too Old", 9, None, "1900-01-01", None, None],
        [6, "Bad Phone", 9, None, None, None, "ask the teacher"],
        [None, None, None, None, None, None, None],
    ))
    assert total == 6
    assert [(number, student.full_name, student.grade, student.class_name) for number, student in students] == [(4, "Aliyev Vali", 5, "a"), (5, "Karimova Zarina", 6, "B")]
    assert students[0][1].birth_date == date(2015, 9, 1) and students[0][1].parent_phone == "998901234567"
    assert [(problem.row, problem.reason) for problem in problems] == [(6, "missing_name"), (7, "bad_grade"), (8, "bad_date"), (9, "bad_phone")]


def test_unreadable_uploads_are_refused():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        login(client)
        post = lambda content: client.post("/api/admin/students/import", content=content, headers=XLSX_HEADERS)  # noqa: E731
        assert (post(b"name,grade\nA,1").status_code, post(b"name,grade\nA,1").json()["detail"]) == (400, "not_excel")
        assert post(b"").json()["detail"] == "not_excel"
        assert post(workbook(["Something", "Else"], ["a", "b"])).json()["detail"] == "missing_columns"
        assert post(b"x" * (5 * 1024 * 1024 + 1)).status_code == 413
        assert client.post("/api/admin/students/import", content=workbook(["Name", "Grade"]), headers={**XLSX_HEADERS, "Origin": "https://unrelated.example"}).status_code == 403
        template = client.get("/api/admin/students/template")
        assert template.status_code == 200 and "students-template.xlsx" in template.headers["content-disposition"]
        # The template itself is a valid import file.
        assert [cell.value for cell in load_workbook(BytesIO(template.content)).active[1]][:2] == ["Full name", "Grade"]
        assert read_workbook(template.content)[0][0][1].full_name == "Aliyev Vali"


def test_admin_adds_edits_searches_and_removes_students(database_client):
    client = database_client
    login(client)
    assert client.post("/api/admin/students", json=STUDENT, headers={"Origin": "https://unrelated.example"}).status_code == 403
    created = client.post("/api/admin/students", json=STUDENT, headers=ORIGIN)
    assert created.status_code == 201 and created.headers["cache-control"] == "no-store"
    student = created.json()
    assert student["parent_phone"] == "+998901234567" and student["birth_date"] == "2015-09-01"
    minimal = client.post("/api/admin/students", json={"full_name": "Karimova Zarina", "grade": 2, "class_name": "", "parent_phone": ""}, headers=ORIGIN).json()
    assert minimal["class_name"] is None and minimal["parent_phone"] is None and minimal["birth_date"] is None

    page = client.get("/api/admin/students").json()
    assert page["total"] == 2 and page["all_students"] == 2 and [item["grade"] for item in page["items"]] == [2, 5]
    assert client.get("/api/admin/students", params={"grade": 5}).json()["total"] == 1
    assert client.get("/api/admin/students", params={"q": "zarina"}).json()["items"][0]["id"] == minimal["id"]
    assert client.get("/api/admin/students", params={"q": "90 123"}).json()["total"] == 1
    assert client.get("/api/admin/students", params={"q": "sardor"}).json()["total"] == 1
    assert client.get("/api/admin/students", params={"q": "%"}).json() | {"items": []} == {"items": [], "total": 0, "page": 1, "page_size": 25, "all_students": 2}
    assert len(client.get("/api/admin/students", params={"page_size": 1, "page": 2}).json()["items"]) == 1

    edited = client.put(f"/api/admin/students/{student['id']}", json={**STUDENT, "grade": 6, "class_name": "B"}, headers=ORIGIN)
    assert edited.status_code == 200 and (edited.json()["grade"], edited.json()["class_name"]) == (6, "B")
    assert client.put(f"/api/admin/students/{uuid4()}", json=STUDENT, headers=ORIGIN).status_code == 404
    assert client.delete(f"/api/admin/students/{student['id']}", headers={"Origin": "https://unrelated.example"}).status_code == 403
    assert client.delete(f"/api/admin/students/{student['id']}", headers=ORIGIN).status_code == 204
    assert client.delete(f"/api/admin/students/{student['id']}", headers=ORIGIN).status_code == 204
    assert client.get("/api/admin/students").json()["total"] == 1


def test_excel_import_previews_then_saves_and_skips_duplicates(database_client):
    client = database_client
    login(client)
    client.post("/api/admin/students", json=STUDENT, headers=ORIGIN)
    content = workbook(
        ["F.I.Sh", "Sinf", "Tug‘ilgan sana", "Ota-onasi", "Telefon"],
        ["aliyev vali", "5-A", None, None, None],  # already enrolled
        ["Karimova Zarina", "6-B", "12.03.2014", "Karimov Anvar", "+998 91 111 22 33"],
        ["Karimova Zarina", "6-B", None, None, None],  # listed twice
        ["Usmonov Bek", 7, None, None, None],
        ["", 3, None, None, None],
    )
    preview = client.post("/api/admin/students/import", content=content, headers=XLSX_HEADERS)
    assert preview.status_code == 200
    report = preview.json()
    assert (report["rows"], report["added"], report["duplicates"], report["problem_count"], report["saved"]) == (5, 2, 2, 1, False)
    assert [student["full_name"] for student in report["preview"]] == ["Karimova Zarina", "Usmonov Bek"]
    assert report["problems"] == [{"row": 6, "name": None, "reason": "missing_name"}]
    # A preview changes nothing.
    assert client.get("/api/admin/students").json()["total"] == 1

    saved = client.post("/api/admin/students/import", params={"dry_run": "false"}, content=content, headers=XLSX_HEADERS).json()
    assert (saved["added"], saved["saved"]) == (2, True)
    listed = client.get("/api/admin/students").json()
    assert listed["total"] == 3
    zarina = next(item for item in listed["items"] if item["full_name"] == "Karimova Zarina")
    assert (zarina["grade"], zarina["class_name"], zarina["birth_date"], zarina["parent_phone"]) == (6, "B", "2014-03-12", "+998911112233")
    # Importing the same file again adds nobody.
    again = client.post("/api/admin/students/import", params={"dry_run": "false"}, content=content, headers=XLSX_HEADERS).json()
    assert (again["added"], again["duplicates"]) == (0, 4)
    assert client.get("/api/admin/students").json()["total"] == 3

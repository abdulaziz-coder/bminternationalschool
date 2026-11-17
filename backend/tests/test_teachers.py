from io import BytesIO
from uuid import uuid4

from fastapi.testclient import TestClient
from openpyxl import Workbook
import pytest

from app.admin_auth import hash_password
from app.db import TeacherRecord
from app.main import app
from app.runtime import loop_factory
from app.teachers import PASSWORD_ALPHABET, login_base, new_password, read_workbook, unique_login
from test_admin import ORIGIN, local_account, login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401
import asyncio

TEACHER = {"full_name": "Karimova Zarina", "subject": "Mathematics", "phone": "+998 90 123 45 67"}
XLSX_HEADERS = {**ORIGIN, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}


def workbook(*rows) -> bytes:
    book = Workbook()
    for row in rows:
        book.active.append(row)
    output = BytesIO()
    book.save(output)
    return output.getvalue()


def test_teachers_are_private():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/admin/teachers").status_code == 401
        assert client.get("/api/admin/teachers/template").status_code == 401
        assert client.post("/api/admin/teachers", json=TEACHER, headers=ORIGIN).status_code == 401
        assert client.post("/api/admin/teachers/import", content=workbook(["Name", "Subject"]), headers=XLSX_HEADERS).status_code == 401
        assert client.put(f"/api/admin/teachers/{uuid4()}", json=TEACHER, headers=ORIGIN).status_code == 401
        assert client.post(f"/api/admin/teachers/{uuid4()}/password", headers=ORIGIN).status_code == 401
        assert client.delete(f"/api/admin/teachers/{uuid4()}", headers=ORIGIN).status_code == 401


@pytest.mark.parametrize("patch", [{"full_name": " "}, {"subject": ""}, {"subject": "a" * 81}, {"phone": "call me"}, {"login": "chosen.by.client"}, {"password": "chosen"}])
def test_invalid_teachers_rejected_before_database(patch):
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        login(client)
        assert client.post("/api/admin/teachers", json={**TEACHER, **patch}, headers=ORIGIN).status_code == 422


def test_generated_logins_and_passwords():
    assert login_base("Karimova Zarina Anvarovna") == "karimova.zarina"
    assert login_base("  O‘ktamov   G‘ayrat ") == "oktamov.gayrat"
    assert login_base("Каримова Зарина") == "karimova.zarina" and login_base("Шодиев Жўрабек") == "shodiev.jorabek"
    assert login_base("李") == "teacher"
    taken = {"karimova.zarina"}
    assert unique_login("Karimova Zarina", taken) == "karimova.zarina2" and unique_login("Karimova Zarina", taken) == "karimova.zarina3"
    passwords = {new_password() for _ in range(200)}
    assert len(passwords) == 200 and all(len(password) == 10 and set(password) <= set(PASSWORD_ALPHABET) for password in passwords)


def test_teacher_workbook_rows_are_validated():
    teachers, problems, total = read_workbook(workbook(
        ["O‘qituvchilar ro‘yxati"], ["№", "F.I.Sh", "Fan", "Telefon"],
        [1, " Karimova  Zarina ", "Matematika", 998901234567.0], [2, "Aliyev Vali", "Ingliz tili", None],
        [3, None, "Fizika", None], [4, "No Subject", None, None], [5, "Bad Phone", "Kimyo", "ask"],
    ))
    assert total == 5
    assert [(teacher.full_name, teacher.subject, teacher.phone) for teacher in teachers] == [("Karimova Zarina", "Matematika", "998901234567"), ("Aliyev Vali", "Ingliz tili", None)]
    assert [(problem.row, problem.reason) for problem in problems] == [(5, "missing_name"), (6, "missing_subject"), (7, "bad_phone")]


def test_admin_adds_teachers_and_receives_one_time_sign_in_details(database_client):
    client = database_client
    login(client)
    assert client.post("/api/admin/teachers", json=TEACHER, headers={"Origin": "https://unrelated.example"}).status_code == 403
    created = client.post("/api/admin/teachers", json=TEACHER, headers=ORIGIN)
    assert created.status_code == 201 and created.headers["cache-control"] == "no-store"
    teacher, password = created.json()["teacher"], created.json()["password"]
    assert teacher["login"] == "karimova.zarina" and teacher["phone"] == "+998901234567" and len(password) == 10
    namesake = client.post("/api/admin/teachers", json={**TEACHER, "subject": "Physics", "phone": None}, headers=ORIGIN).json()
    assert namesake["teacher"]["login"] == "karimova.zarina2" and namesake["password"] != password

    # The list never contains passwords or hashes, and the stored hash matches the issued password.
    page = client.get("/api/admin/teachers").json()
    assert page["total"] == 2 and set(page["items"][0]) == {"id", "full_name", "subject", "phone", "login", "created_at", "updated_at"}
    assert client.get("/api/admin/teachers", params={"q": "physics"}).json()["total"] == 1
    assert client.get("/api/admin/teachers", params={"q": "zarina2"}).json()["total"] == 1
    assert client.get("/api/admin/teachers", params={"q": "90 123"}).json()["total"] == 1

    async def stored():
        async with client.enquiry_sessions() as session:
            return await session.get(TeacherRecord, teacher["id"])

    record = asyncio.run(stored(), loop_factory=loop_factory)
    assert record.password_hash == hash_password(password, bytes.fromhex(record.password_salt)) and password not in (record.password_hash, record.password_salt)

    # Editing keeps the login; resetting issues a different password and invalidates the old one.
    edited = client.put(f"/api/admin/teachers/{teacher['id']}", json={"full_name": "Karimova Zarina Anvarovna", "subject": "Algebra", "phone": ""}, headers=ORIGIN)
    assert edited.status_code == 200 and (edited.json()["login"], edited.json()["subject"], edited.json()["phone"]) == ("karimova.zarina", "Algebra", None)
    url = f"/api/admin/teachers/{teacher['id']}/password"
    assert client.post(url, headers={"Origin": "https://unrelated.example"}).status_code == 403
    reset = client.post(url, headers=ORIGIN)
    assert reset.status_code == 200 and reset.json()["password"] != password and reset.json()["teacher"]["login"] == "karimova.zarina"
    record = asyncio.run(stored(), loop_factory=loop_factory)
    assert record.password_hash == hash_password(reset.json()["password"], bytes.fromhex(record.password_salt))
    assert record.password_hash != hash_password(password, bytes.fromhex(record.password_salt))
    assert client.post(f"/api/admin/teachers/{uuid4()}/password", headers=ORIGIN).status_code == 404
    assert client.put(f"/api/admin/teachers/{uuid4()}", json=TEACHER, headers=ORIGIN).status_code == 404

    assert client.delete(f"/api/admin/teachers/{teacher['id']}", headers=ORIGIN).status_code == 204
    assert client.delete(f"/api/admin/teachers/{teacher['id']}", headers=ORIGIN).status_code == 204
    assert client.get("/api/admin/teachers").json()["total"] == 1


def test_teacher_excel_import_previews_then_saves_with_sign_in_details(database_client):
    client = database_client
    login(client)
    client.post("/api/admin/teachers", json=TEACHER, headers=ORIGIN)
    content = workbook(
        ["F.I.Sh", "Fan", "Telefon"],
        ["karimova zarina", "mathematics", None],  # already on the list
        ["Aliyev Vali", "English", "+998 91 111 22 33"],
        ["Aliyev Vali", "English", None],  # listed twice
        ["Aliyev Vali", "History", None],  # same name, another subject: a different record
        ["", "Physics", None],
    )
    preview = client.post("/api/admin/teachers/import", content=content, headers=XLSX_HEADERS)
    assert preview.status_code == 200
    report = preview.json()
    assert (report["rows"], report["added"], report["duplicates"], report["problem_count"], report["saved"], report["credentials"]) == (5, 2, 2, 1, False, [])
    assert client.get("/api/admin/teachers").json()["total"] == 1

    saved = client.post("/api/admin/teachers/import", params={"dry_run": "false"}, content=content, headers=XLSX_HEADERS).json()
    assert saved["added"] == 2 and saved["saved"] is True
    assert [(item["full_name"], item["subject"], item["login"]) for item in saved["credentials"]] == [("Aliyev Vali", "English", "aliyev.vali"), ("Aliyev Vali", "History", "aliyev.vali2")]
    assert len({item["password"] for item in saved["credentials"]}) == 2
    assert client.get("/api/admin/teachers").json()["total"] == 3
    again = client.post("/api/admin/teachers/import", params={"dry_run": "false"}, content=content, headers=XLSX_HEADERS).json()
    assert (again["added"], again["duplicates"], again["credentials"]) == (0, 4, [])
    assert client.post("/api/admin/teachers/import", content=workbook(["Name", "Phone"], ["A B", "1"]), headers=XLSX_HEADERS).json()["detail"] == "missing_columns"
    assert client.post("/api/admin/teachers/import", content=b"not a workbook", headers=XLSX_HEADERS).json()["detail"] == "not_excel"

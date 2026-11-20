import time

from fastapi.testclient import TestClient
import pytest

from app import teacher_auth
from app.main import app
from app.runtime import loop_factory
from test_admin import ORIGIN, local_account, login as admin_login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

TEACHER = {"full_name": "Karimova Zarina", "subject": "Mathematics", "phone": "+998 90 123 45 67"}
ELSEWHERE = {"Origin": "https://unrelated.example"}
IDENTITY = {"full_name": "Karimova Zarina", "subject": "Mathematics", "subject_names": {"en": "Mathematics"}, "login": "karimova.zarina"}


@pytest.fixture(autouse=True)
def clean_teacher_sessions():
    teacher_auth.sessions.clear()
    teacher_auth.attempts.clear()
    yield
    teacher_auth.sessions.clear()
    teacher_auth.attempts.clear()


def add_teacher(client, **changes) -> dict:
    """Adds a teacher as the admin would and returns {"teacher": ..., "password": ...}."""
    admin_login(client)
    # A teacher's subject must be in the admin's subject list.
    for subject in ("Mathematics", "Physics"):
        client.post("/api/admin/subjects", json={"names": {"en": subject}, "grades": [5]}, headers=ORIGIN)
    created = client.post("/api/admin/teachers", json={**TEACHER, **changes}, headers=ORIGIN).json()
    client.post("/api/admin/logout", headers=ORIGIN)
    return created


def sign_in(client, login, password, headers=ORIGIN):
    return client.post("/api/teacher/login", json={"login": login, "password": password}, headers=headers)


def test_teacher_pages_need_a_sign_in():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/teacher/session").status_code == 401
        for body in ({"login": "", "password": "x"}, {"login": "x", "password": ""}, {"login": "x" * 61, "password": "x"}, {"login": "x", "password": "x" * 129}, {"login": "x"}, {"login": "x", "password": "x", "extra": 1}):
            assert client.post("/api/teacher/login", json=body, headers=ORIGIN).status_code == 422
        assert client.post("/api/teacher/logout", headers=ORIGIN).status_code == 204


def test_teacher_signs_in_with_the_generated_details(database_client):
    client = database_client
    created = add_teacher(client)
    login, password = created["teacher"]["login"], created["password"]
    assert login == "karimova.zarina"
    assert sign_in(client, login, password, ELSEWHERE).status_code == 403
    assert sign_in(client, login, "not the password").status_code == 401
    assert sign_in(client, "nobody.here", password).status_code == 401
    # An unknown login and a wrong password are refused with the same words.
    assert sign_in(client, "someone.else", "x").json() == sign_in(client, login, password + "x").json()
    teacher_auth.attempts.clear()

    # The login may be typed with capitals or spaces around it; the password must be exact.
    assert sign_in(client, login, password.swapcase()).status_code == 401
    signed_in = sign_in(client, f"  {login.upper()} ", password)
    assert signed_in.status_code == 200 and signed_in.headers["cache-control"] == "no-store"
    assert signed_in.json() == IDENTITY
    cookie = signed_in.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/api/teacher" in cookie
    assert password not in signed_in.text and password.lower() not in cookie
    assert client.get("/api/teacher/session").json() == IDENTITY
    # A teacher's session opens nothing in the admin panel or the parent pages.
    assert client.get("/api/admin/teachers").status_code == 401
    assert client.get("/api/parent/session").status_code == 401

    # The admin edits the teacher: they stay signed in and see the change.
    admin_login(client)
    client.put(f"/api/admin/teachers/{created['teacher']['id']}", json={**TEACHER, "subject": "Physics"}, headers=ORIGIN)
    assert client.get("/api/teacher/session").json() == {**IDENTITY, "subject": "Physics", "subject_names": {"en": "Physics"}}

    assert client.post("/api/teacher/logout", headers=ELSEWHERE).status_code == 403
    assert client.post("/api/teacher/logout", headers=ORIGIN).status_code == 204
    assert client.get("/api/teacher/session").status_code == 401


def test_a_new_password_or_removal_signs_the_teacher_out(database_client):
    client = database_client
    created = add_teacher(client)
    teacher, password = created["teacher"], created["password"]
    assert sign_in(client, teacher["login"], password).status_code == 200

    admin_login(client)
    replaced = client.post(f"/api/admin/teachers/{teacher['id']}/password", headers=ORIGIN).json()["password"]
    assert client.get("/api/teacher/session").status_code == 401
    assert sign_in(client, teacher["login"], password).status_code == 401
    assert sign_in(client, teacher["login"], replaced).status_code == 200

    for session in teacher_auth.sessions.values():
        session.expires = time.time() - 1
    assert client.get("/api/teacher/session").status_code == 401

    assert sign_in(client, teacher["login"], replaced).status_code == 200
    client.delete(f"/api/admin/teachers/{teacher['id']}", headers=ORIGIN)
    assert client.get("/api/teacher/session").status_code == 401
    assert sign_in(client, teacher["login"], replaced).status_code == 401


def test_wrong_passwords_are_rate_limited_per_login_and_per_address(database_client):
    client = database_client
    created = add_teacher(client)
    login, password = created["teacher"]["login"], created["password"]
    for _ in range(teacher_auth.MAX_ATTEMPTS):
        assert sign_in(client, login, "wrong").status_code == 401
    # Even the right password waits once the limit is reached.
    assert sign_in(client, login, password).status_code == 429
    # From another address the same login is still locked for the minute; a different login is not.
    teacher_auth.attempts.pop("address:testclient", None)
    assert sign_in(client, login, password).status_code == 429
    assert sign_in(client, "someone.else", "wrong").status_code == 401
    teacher_auth.attempts.clear()
    assert sign_in(client, login, password).status_code == 200

import time

from fastapi.testclient import TestClient
import pytest

from app import parents
from app.main import app
from app.runtime import loop_factory
from test_admin import ORIGIN, local_account, login as admin_login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

STUDENT = {"full_name": "Aliyev Vali", "grade": 5, "class_name": "A", "birth_date": "2015-09-01", "parent_name": "Aliyev Sardor", "parent_phone": "+998 90 123 45 67"}
ELSEWHERE = {"Origin": "https://unrelated.example"}


@pytest.fixture(autouse=True)
def clean_parent_sessions():
    parents.sessions.clear()
    parents.attempts.clear()
    yield
    parents.sessions.clear()
    parents.attempts.clear()


def add_student(client, **changes) -> dict:
    admin_login(client)
    student = client.post("/api/admin/students", json={**STUDENT, **changes}, headers=ORIGIN).json()
    client.post("/api/admin/logout", headers=ORIGIN)
    return student


def sign_in(client, pass_key, headers=ORIGIN):
    return client.post("/api/parent/login", json={"pass_key": pass_key}, headers=headers)


def test_parent_pages_need_a_pass_key():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/parent/session").status_code == 401
        # Not a key at all: refused without looking anything up.
        for text in ("hello", "AAAA-AAAA-AAA", "0000-0000-0000", "x" * 40):
            assert sign_in(client, text).status_code == 401
        assert client.post("/api/parent/login", json={"pass_key": ""}, headers=ORIGIN).status_code == 422
        assert client.post("/api/parent/login", json={"pass_key": "x" * 41}, headers=ORIGIN).status_code == 422
        assert client.post("/api/parent/login", json={"pass_key": "AAAA-AAAA-AAAA", "extra": 1}, headers=ORIGIN).status_code == 422
        assert client.post("/api/parent/logout", headers=ORIGIN).status_code == 204


def test_wrong_keys_are_rate_limited():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        for _ in range(parents.MAX_ATTEMPTS):
            assert sign_in(client, "not a key").status_code == 401
        assert sign_in(client, "not a key").status_code == 429


def test_parent_signs_in_with_only_the_pass_key(database_client):
    client = database_client
    student = add_student(client)
    key = student["pass_key"]
    assert sign_in(client, key, ELSEWHERE).status_code == 403
    assert sign_in(client, "AAAA-AAAA-AAAA").status_code == 401

    # Typed in lower case with spaces instead of dashes.
    signed_in = sign_in(client, f"  {key.lower().replace('-', ' ')} ")
    assert signed_in.status_code == 200 and signed_in.headers["cache-control"] == "no-store"
    assert signed_in.json() == {"full_name": "Aliyev Vali", "grade": 5, "class_name": "A"}
    cookie = signed_in.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/api/parent" in cookie
    assert key.lower() not in cookie and key not in signed_in.text
    assert client.get("/api/parent/session").json() == {"full_name": "Aliyev Vali", "grade": 5, "class_name": "A"}
    # A parent's session opens nothing in the admin panel.
    assert client.get("/api/admin/students").status_code == 401

    # The admin edits the child: the parent stays signed in and sees the change.
    admin_login(client)
    client.put(f"/api/admin/students/{student['id']}", json={**STUDENT, "grade": 6, "class_name": "B"}, headers=ORIGIN)
    assert client.get("/api/parent/session").json() == {"full_name": "Aliyev Vali", "grade": 6, "class_name": "B"}

    assert client.post("/api/parent/logout", headers=ELSEWHERE).status_code == 403
    assert client.post("/api/parent/logout", headers=ORIGIN).status_code == 204
    assert client.get("/api/parent/session").status_code == 401


def test_a_new_pass_key_or_removal_signs_the_parent_out(database_client):
    client = database_client
    student = add_student(client)
    other = add_student(client, full_name="Karimova Zarina")
    assert sign_in(client, student["pass_key"]).status_code == 200

    admin_login(client)
    replaced = client.post(f"/api/admin/students/{student['id']}/pass-key", headers=ORIGIN).json()
    assert client.get("/api/parent/session").status_code == 401
    assert sign_in(client, student["pass_key"]).status_code == 401
    assert sign_in(client, replaced["pass_key"]).json()["full_name"] == "Aliyev Vali"

    client.delete(f"/api/admin/students/{student['id']}", headers=ORIGIN)
    assert client.get("/api/parent/session").status_code == 401
    assert sign_in(client, replaced["pass_key"]).status_code == 401
    # Another family's key still works and shows only their child.
    assert sign_in(client, other["pass_key"]).json()["full_name"] == "Karimova Zarina"

    for session in parents.sessions.values():
        session.expires = time.time() - 1
    assert client.get("/api/parent/session").status_code == 401

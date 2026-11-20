from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.runtime import loop_factory
from test_admin import ORIGIN, local_account, login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

SUBJECT = {"names": {"en": "Mathematics"}, "grades": [1, 2, 3, 4]}
ELSEWHERE = {"Origin": "https://unrelated.example"}


def test_subjects_are_private():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/admin/subjects").status_code == 401
        assert client.post("/api/admin/subjects", json=SUBJECT, headers=ORIGIN).status_code == 401
        assert client.put(f"/api/admin/subjects/{uuid4()}", json=SUBJECT, headers=ORIGIN).status_code == 401
        assert client.delete(f"/api/admin/subjects/{uuid4()}", headers=ORIGIN).status_code == 401


@pytest.mark.parametrize("patch", [{"names": {}}, {"names": {"en": " "}}, {"names": {"en": "a"}}, {"names": {"en": "a" * 81}}, {"names": {"de": "Mathe"}}, {"names": "Mathematics"}, {"name": "Mathematics"}, {"grades": [0]}, {"grades": [12]}, {"grades": [5, 5]}, {"grades": ["5"]}, {"grades": [5.5]}, {"grades": "all"}, {"grades": None}, {"extra": 1}])
def test_invalid_subjects_rejected_before_database(patch):
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        login(client)
        assert client.post("/api/admin/subjects", json={**SUBJECT, **patch}, headers=ORIGIN).status_code == 422


def test_admin_creates_edits_and_removes_subjects(database_client):
    client = database_client
    login(client)
    assert client.post("/api/admin/subjects", json=SUBJECT, headers=ELSEWHERE).status_code == 403
    created = client.post("/api/admin/subjects", json={"names": {"en": "  Mathematics   and logic "}, "grades": [4, 1, 3, 2]}, headers=ORIGIN)
    assert created.status_code == 201 and created.headers["cache-control"] == "no-store"
    maths = created.json()
    # The name is tidied and the grades are kept in order.
    assert (maths["name"], maths["grades"]) == ("Mathematics and logic", [1, 2, 3, 4])
    # A subject can be created first and given its grades later.
    art = client.post("/api/admin/subjects", json={"names": {"en": "Art"}}, headers=ORIGIN).json()
    assert art["grades"] == []
    assert client.post("/api/admin/subjects", json={"names": {"en": "English"}, "grades": list(range(1, 12))}, headers=ORIGIN).json()["grades"] == list(range(1, 12))

    # The same name in another letter case or spacing is the same subject.
    assert client.post("/api/admin/subjects", json={"names": {"en": "mathematics AND logic"}, "grades": [5]}, headers=ORIGIN).status_code == 409
    assert [subject["name"] for subject in client.get("/api/admin/subjects").json()] == ["Art", "English", "Mathematics and logic"]

    edited = client.put(f"/api/admin/subjects/{art['id']}", json={"names": {"en": "Fine art"}, "grades": [7, 5, 6]}, headers=ORIGIN)
    assert edited.status_code == 200 and (edited.json()["name"], edited.json()["grades"]) == ("Fine art", [5, 6, 7])
    # Changing only the letter case of a subject's own name is allowed; taking another subject's name is not.
    assert client.put(f"/api/admin/subjects/{art['id']}", json={"names": {"en": "FINE ART"}, "grades": []}, headers=ORIGIN).json() | {"id": 0, "created_at": 0, "updated_at": 0} == {"id": 0, "name": "FINE ART", "names": {"en": "FINE ART"}, "grades": [], "teachers": 0, "created_at": 0, "updated_at": 0}
    assert client.put(f"/api/admin/subjects/{art['id']}", json={"names": {"en": "english"}, "grades": []}, headers=ORIGIN).status_code == 409
    assert client.put(f"/api/admin/subjects/{art['id']}", json=SUBJECT, headers=ELSEWHERE).status_code == 403
    assert client.put(f"/api/admin/subjects/{uuid4()}", json=SUBJECT, headers=ORIGIN).status_code == 404
    # A refused change leaves the list usable.
    assert len(client.get("/api/admin/subjects").json()) == 3

    assert client.delete(f"/api/admin/subjects/{maths['id']}", headers=ELSEWHERE).status_code == 403
    assert client.delete(f"/api/admin/subjects/{maths['id']}", headers=ORIGIN).status_code == 204
    assert client.delete(f"/api/admin/subjects/{maths['id']}", headers=ORIGIN).status_code == 204
    assert [subject["name"] for subject in client.get("/api/admin/subjects").json()] == ["English", "FINE ART"]
    # A removed subject's name can be used again.
    assert client.post("/api/admin/subjects", json={"names": {"en": "Mathematics and logic"}, "grades": [1]}, headers=ORIGIN).status_code == 201


def test_teachers_follow_their_subject_and_keep_it_from_being_removed(database_client):
    client = database_client
    login(client)
    maths = client.post("/api/admin/subjects", json=SUBJECT, headers=ORIGIN).json()
    art = client.post("/api/admin/subjects", json={"names": {"en": "Art"}}, headers=ORIGIN).json()
    assert maths["teachers"] == 0
    for name in ("Karimova Zarina", "Aliyev Vali"):
        assert client.post("/api/admin/teachers", json={"full_name": name, "subject": "Mathematics"}, headers=ORIGIN).status_code == 201
    assert {subject["name"]: subject["teachers"] for subject in client.get("/api/admin/subjects").json()} == {"Art": 0, "Mathematics": 2}

    # Renaming the subject renames it for its teachers.
    renamed = client.put(f"/api/admin/subjects/{maths['id']}", json={"names": {"en": "Maths"}, "grades": [1]}, headers=ORIGIN).json()
    assert (renamed["name"], renamed["teachers"]) == ("Maths", 2)
    assert {teacher["subject"] for teacher in client.get("/api/admin/teachers").json()["items"]} == {"Maths"}

    # A subject with teachers cannot be removed; one without can.
    refused = client.delete(f"/api/admin/subjects/{maths['id']}", headers=ORIGIN)
    assert (refused.status_code, refused.json()["detail"]) == (409, "in_use")
    assert client.delete(f"/api/admin/subjects/{art['id']}", headers=ORIGIN).status_code == 204
    for teacher in client.get("/api/admin/teachers").json()["items"]:
        client.delete(f"/api/admin/teachers/{teacher['id']}", headers=ORIGIN)
    assert client.delete(f"/api/admin/subjects/{maths['id']}", headers=ORIGIN).status_code == 204
    assert client.get("/api/admin/subjects").json() == []


def test_subject_names_in_each_language(database_client):
    client = database_client
    login(client)
    created = client.post("/api/admin/subjects", json={"names": {"ru": " Математика ", "en": "Mathematics", "uz": "Matematika"}, "grades": [1]}, headers=ORIGIN)
    assert created.status_code == 201
    maths = created.json()
    # The Uzbek name is the main one; the names come back in a fixed order.
    assert (maths["name"], list(maths["names"].items())) == ("Matematika", [("uz", "Matematika"), ("en", "Mathematics"), ("ru", "Математика")])
    # Without an Uzbek name the English one is the main name, then the Russian one.
    assert client.post("/api/admin/subjects", json={"names": {"ru": "Физика", "en": "Physics", "uz": ""}}, headers=ORIGIN).json()["name"] == "Physics"
    assert client.post("/api/admin/subjects", json={"names": {"ru": "Химия"}}, headers=ORIGIN).json()["name"] == "Химия"

    # A name in any language that another subject already uses, in any language, is refused.
    for names in ({"en": "matematika"}, {"uz": "Physics"}, {"ru": "МАТЕМАТИКА"}, {"uz": "Biologiya", "en": "Chemistry", "ru": "Химия"}):
        assert client.post("/api/admin/subjects", json={"names": names}, headers=ORIGIN).status_code == 409

    # A teacher can be given the subject by any of its names, and is stored with the main name.
    for typed in ("Mathematics", "математика", "MATEMATIKA"):
        teacher = client.post("/api/admin/teachers", json={"full_name": f"Teacher {typed}", "subject": typed}, headers=ORIGIN).json()["teacher"]
        assert teacher["subject"] == "Matematika"

    # Adding an Uzbek name changes the main name, and the teachers follow it.
    physics = next(item for item in client.get("/api/admin/subjects").json() if item["name"] == "Physics")
    client.post("/api/admin/teachers", json={"full_name": "Physics Teacher", "subject": "Physics"}, headers=ORIGIN)
    edited = client.put(f"/api/admin/subjects/{physics['id']}", json={"names": {"uz": "Fizika", "en": "Physics", "ru": "Физика"}, "grades": [9]}, headers=ORIGIN).json()
    assert (edited["name"], edited["teachers"]) == ("Fizika", 1)
    assert client.get("/api/admin/teachers", params={"q": "Physics Teacher"}).json()["items"][0]["subject"] == "Fizika"
    # Removing a translation keeps the others.
    assert client.put(f"/api/admin/subjects/{physics['id']}", json={"names": {"uz": "Fizika", "ru": ""}, "grades": [9]}, headers=ORIGIN).json()["names"] == {"uz": "Fizika"}

from datetime import datetime
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.runtime import loop_factory
from test_admin import ORIGIN, local_account, login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

NOTICE = {"category": "admission_guide", "title": "Admissions guide for the new academic year", "body": "Step 1: send an enquiry.\nStep 2: visit the school."}


def test_managing_notices_requires_sign_in():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/admin/notices").status_code == 401
        assert client.post("/api/admin/notices", json=NOTICE, headers=ORIGIN).status_code == 401
        assert client.put(f"/api/admin/notices/{uuid4()}", json=NOTICE, headers=ORIGIN).status_code == 401
        assert client.delete(f"/api/admin/notices/{uuid4()}", headers=ORIGIN).status_code == 401


@pytest.mark.parametrize("patch", [{"category": "other"}, {"title": "  "}, {"title": "ab"}, {"title": "a" * 161}, {"body": ""}, {"body": "a" * 5001}, {"published": "maybe"}, {"extra": 1}])
def test_invalid_notices_rejected_before_database(patch):
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert login(client).status_code == 200
        assert client.post("/api/admin/notices", json={**NOTICE, **patch}, headers=ORIGIN).status_code == 422


def test_admin_posts_edits_hides_and_deletes_notices(database_client):
    client = database_client
    assert client.get("/api/notices").json() == []
    assert login(client).status_code == 200
    assert client.post("/api/admin/notices", json=NOTICE, headers={"Origin": "https://unrelated.example"}).status_code == 403

    guide = client.post("/api/admin/notices", json={**NOTICE, "title": "  " + NOTICE["title"] + "  "}, headers=ORIGIN)
    assert guide.status_code == 201
    assert guide.headers["cache-control"] == "no-store"
    guide = guide.json()
    assert guide["title"] == NOTICE["title"] and guide["published"] is True and guide["published_at"] is not None
    draft = client.post("/api/admin/notices", json={"category": "news", "title": "Open day", "body": "Details soon.", "published": False}, headers=ORIGIN).json()
    assert draft["published"] is False and draft["published_at"] is None

    # Visitors only ever receive published notices, without management fields.
    public = client.get("/api/notices").json()
    assert [notice["id"] for notice in public] == [guide["id"]]
    assert set(public[0]) == {"id", "category", "title", "body", "published_at"}
    assert public[0]["body"] == NOTICE["body"]
    assert {notice["id"] for notice in client.get("/api/admin/notices").json()} == {guide["id"], draft["id"]}

    # Editing keeps the publication time; publishing a draft puts it first.
    edited = client.put(f"/api/admin/notices/{guide['id']}", json={**NOTICE, "body": "Updated steps."}, headers=ORIGIN).json()
    assert edited["body"] == "Updated steps."
    # The same instant may be reported in a different time zone after a reload.
    assert datetime.fromisoformat(edited["published_at"]) == datetime.fromisoformat(guide["published_at"])
    assert client.put(f"/api/admin/notices/{draft['id']}", json={"category": "news", "title": "Open day", "body": "Saturday at 10:00."}, headers=ORIGIN).json()["published"] is True
    assert [notice["id"] for notice in client.get("/api/notices").json()] == [draft["id"], guide["id"]]

    # Hiding a notice removes it from the public list without deleting it.
    hidden = client.put(f"/api/admin/notices/{guide['id']}", json={**NOTICE, "published": False}, headers=ORIGIN)
    assert hidden.status_code == 200 and hidden.json()["published_at"] is None
    assert [notice["id"] for notice in client.get("/api/notices").json()] == [draft["id"]]

    assert client.put(f"/api/admin/notices/{uuid4()}", json=NOTICE, headers=ORIGIN).status_code == 404
    assert client.delete(f"/api/admin/notices/{draft['id']}", headers={"Origin": "https://unrelated.example"}).status_code == 403
    assert client.delete(f"/api/admin/notices/{draft['id']}", headers=ORIGIN).status_code == 204
    assert client.delete(f"/api/admin/notices/{draft['id']}", headers=ORIGIN).status_code == 204
    assert client.get("/api/notices").json() == []
    assert [notice["id"] for notice in client.get("/api/admin/notices").json()] == [guide["id"]]

from datetime import datetime
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.runtime import loop_factory
from test_admin import ORIGIN, local_account, login  # noqa: F401 - local_account is an autouse fixture
from test_api import database_client  # noqa: F401

NOTICE = {"category": "Admission guide", "title": "Admissions guide for the new academic year", "body": "Step 1: send an enquiry.\nStep 2: visit the school."}


def test_managing_notices_requires_sign_in():
    with TestClient(app, backend_options={"loop_factory": loop_factory}) as client:
        assert client.get("/api/admin/notices").status_code == 401
        assert client.post("/api/admin/notices", json=NOTICE, headers=ORIGIN).status_code == 401
        assert client.put(f"/api/admin/notices/{uuid4()}", json=NOTICE, headers=ORIGIN).status_code == 401
        assert client.delete(f"/api/admin/notices/{uuid4()}", headers=ORIGIN).status_code == 401


@pytest.mark.parametrize("patch", [{"category": " "}, {"category": "x"}, {"category": "a" * 41}, {"category": None}, {"title": "  "}, {"title": "ab"}, {"title": "a" * 161}, {"body": ""}, {"body": "a" * 5001}, {"published": "maybe"}, {"extra": 1}])
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
    draft = client.post("/api/admin/notices", json={"category": "News", "title": "Open day", "body": "Details soon.", "published": False}, headers=ORIGIN).json()
    assert draft["published"] is False and draft["published_at"] is None

    # Visitors only ever receive published notices, without management fields.
    public = client.get("/api/notices").json()
    assert [notice["id"] for notice in public] == [guide["id"]]
    assert set(public[0]) == {"id", "category", "title", "body", "pinned", "published_at"}
    assert public[0]["body"] == NOTICE["body"]
    assert {notice["id"] for notice in client.get("/api/admin/notices").json()} == {guide["id"], draft["id"]}

    # Editing keeps the publication time; publishing a draft puts it first.
    edited = client.put(f"/api/admin/notices/{guide['id']}", json={**NOTICE, "body": "Updated steps."}, headers=ORIGIN).json()
    assert edited["body"] == "Updated steps."
    # The same instant may be reported in a different time zone after a reload.
    assert datetime.fromisoformat(edited["published_at"]) == datetime.fromisoformat(guide["published_at"])
    assert client.put(f"/api/admin/notices/{draft['id']}", json={"category": "News", "title": "Open day", "body": "Saturday at 10:00."}, headers=ORIGIN).json()["published"] is True
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


def test_pinned_notices_come_first_until_unpinned(database_client):
    client = database_client
    login(client)
    older = client.post("/api/admin/notices", json=NOTICE, headers=ORIGIN).json()
    newer = client.post("/api/admin/notices", json={"category": "News", "title": "Open day", "body": "Saturday at 10:00."}, headers=ORIGIN).json()
    pinned_draft = client.post("/api/admin/notices", json={"category": "News", "title": "Hidden", "body": "Not ready.", "published": False, "pinned": True}, headers=ORIGIN).json()
    assert older["pinned"] is False and pinned_draft["pinned"] is True
    assert [notice["id"] for notice in client.get("/api/notices").json()] == [newer["id"], older["id"]]

    url = f"/api/admin/notices/{older['id']}/pinned"
    assert client.patch(url, json={"pinned": True}, headers={"Origin": "https://unrelated.example"}).status_code == 403
    assert client.patch(url, json={"pinned": "yes please"}, headers=ORIGIN).status_code == 422
    pinned = client.patch(url, json={"pinned": True}, headers=ORIGIN)
    assert pinned.status_code == 200 and pinned.json()["pinned"] is True
    # Pinning changes neither the text nor the publication time.
    assert pinned.json()["body"] == older["body"]
    assert datetime.fromisoformat(pinned.json()["published_at"]) == datetime.fromisoformat(older["published_at"])
    public = client.get("/api/notices").json()
    assert [(notice["id"], notice["pinned"]) for notice in public] == [(older["id"], True), (newer["id"], False)]
    assert [notice["id"] for notice in client.get("/api/admin/notices").json()][:2] == [pinned_draft["id"], older["id"]]

    # A full edit can unpin; a pinned draft stays private.
    assert client.put(f"/api/admin/notices/{older['id']}", json=NOTICE, headers=ORIGIN).json()["pinned"] is False
    assert [notice["id"] for notice in client.get("/api/notices").json()] == [newer["id"], older["id"]]
    assert client.patch(f"/api/admin/notices/{uuid4()}/pinned", json={"pinned": True}, headers=ORIGIN).status_code == 404
    client.cookies.clear()
    assert client.patch(url, json={"pinned": True}, headers=ORIGIN).status_code == 401


def test_admins_create_categories_and_reuse_existing_spelling(database_client):
    client = database_client
    login(client)

    def post(category):
        response = client.post("/api/admin/notices", json={**NOTICE, "category": category}, headers=ORIGIN)
        assert response.status_code == 201
        return response.json()

    events = post("  School   events ")
    assert events["category"] == "School events"
    # The same category typed differently joins the existing one instead of creating a near-duplicate.
    assert post("school EVENTS")["category"] == "School events"
    assert post("news")["category"] == "News"
    assert post("ADMISSION GUIDE")["category"] == "Admission guide"
    assert {notice["category"] for notice in client.get("/api/notices").json()} == {"School events", "News", "Admission guide"}
    # Editing can move a notice to a brand-new category.
    moved = client.put(f"/api/admin/notices/{events['id']}", json={**NOTICE, "category": "Ta’til jadvali"}, headers=ORIGIN)
    assert moved.status_code == 200 and moved.json()["category"] == "Ta’til jadvali"

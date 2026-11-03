from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import main


client = TestClient(main.app)


class FakeNoteRef:
    id = "note-123"

    def __init__(self, note=None):
        self.note = note or {}

    def set(self, payload):
        self.note = payload

    def get(self):
        return SimpleNamespace(
            exists=bool(self.note),
            to_dict=lambda: self.note,
        )

    def delete(self):
        self.note = {}

    def collection(self, _name):
        return SimpleNamespace(stream=lambda: [])


class FakeNotesCollection:
    def __init__(self, notes=None):
        self.notes = notes or []
        self.created = FakeNoteRef()

    def where(self, *_args):
        return self

    def order_by(self, *_args, **_kwargs):
        return self

    def limit(self, _count):
        return self

    def stream(self):
        return [SimpleNamespace(to_dict=lambda note=note: note) for note in self.notes]

    def document(self, _note_id=None):
        return self.created


class FakeDb:
    def __init__(self, notes=None):
        self.notes = FakeNotesCollection(notes)

    def collection(self, name):
        assert name == "notes"
        return self.notes


def auth(monkeypatch, *, verified=True, uid="token-user"):
    monkeypatch.setattr(
        main.firebase_auth,
        "verify_id_token",
        lambda _token: {"uid": uid, "email": "student@example.com", "email_verified": verified},
    )


def note_payload(**overrides):
    payload = {
        "title": "Lecture notes",
        "fileName": "lecture.pdf",
        "extension": "pdf",
        "fileSize": 100,
        "searchTerms": ["lecture"],
        "storagePath": "notes/token-user/note-123/lecture.pdf",
    }
    payload.update(overrides)
    return payload


def test_unverified_user_rejected_on_post(monkeypatch):
    auth(monkeypatch, verified=False)
    response = client.post("/api/notes", json=note_payload(), headers={"Authorization": "Bearer token"})
    assert response.status_code == 403
    assert "Verify your email" in response.json()["detail"]


def test_non_uploader_rejected_on_delete(monkeypatch):
    auth(monkeypatch, uid="different-user")
    fake_db = FakeDb()
    fake_db.notes.created = FakeNoteRef({"uploaderId": "owner-user", "fileSize": 100})
    monkeypatch.setattr(main, "get_firestore", lambda: fake_db)
    response = client.delete("/api/notes/note-123", headers={"Authorization": "Bearer token"})
    assert response.status_code == 403


def test_size_over_5_mb_rejected(monkeypatch):
    auth(monkeypatch)
    response = client.post(
        "/api/notes",
        json=note_payload(fileSize=5 * 1024 * 1024 + 1),
        headers={"Authorization": "Bearer token"},
    )
    assert response.status_code == 422


def test_title_over_120_chars_rejected(monkeypatch):
    auth(monkeypatch)
    response = client.post(
        "/api/notes",
        json=note_payload(title="x" * 121),
        headers={"Authorization": "Bearer token"},
    )
    assert response.status_code == 422


def test_uploader_id_in_body_is_ignored(monkeypatch):
    auth(monkeypatch, uid="token-user")
    fake_db = FakeDb()
    monkeypatch.setattr(main, "get_firestore", lambda: fake_db)
    response = client.post(
        "/api/notes",
        json=note_payload(uploaderId="attacker-user"),
        headers={"Authorization": "Bearer token"},
    )
    assert response.status_code == 201
    assert fake_db.notes.created.note["uploaderId"] == "token-user"


def test_quota_exceeded_returns_413(monkeypatch):
    auth(monkeypatch)
    fake_db = FakeDb([{"uploaderId": "token-user", "fileSize": 50 * 1024 * 1024}])
    monkeypatch.setattr(main, "get_firestore", lambda: fake_db)
    response = client.post(
        "/api/notes",
        json=note_payload(fileSize=1),
        headers={"Authorization": "Bearer token"},
    )
    assert response.status_code == 413
    assert "50 MB" in response.json()["detail"]

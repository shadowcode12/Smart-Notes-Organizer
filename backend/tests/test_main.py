from fastapi.testclient import TestClient

from app import main


client = TestClient(main.app)


def test_health_is_public():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_missing_header_is_unauthorized():
    response = client.get("/me")
    assert response.status_code == 401


def test_invalid_token_is_unauthorized(monkeypatch):
    def reject(_token):
        raise ValueError("invalid")

    monkeypatch.setattr(main.firebase_auth, "verify_id_token", reject)
    response = client.get("/me", headers={"Authorization": "Bearer invalid"})
    assert response.status_code == 401


def test_valid_token_returns_identity(monkeypatch):
    monkeypatch.setattr(
        main.firebase_auth,
        "verify_id_token",
        lambda token: {"uid": "user-123", "email": "student@example.com"},
    )
    response = client.get("/me", headers={"Authorization": "Bearer valid"})
    assert response.status_code == 200
    assert response.json() == {"uid": "user-123", "email": "student@example.com"}

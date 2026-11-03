import json
import os
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from pydantic import BaseModel, Field
import firebase_admin
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials, firestore


if not firebase_admin._apps:
    service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if service_account_json:
        try:
            firebase_admin.initialize_app(
                credentials.Certificate(json.loads(service_account_json))
            )
        except (ValueError, json.JSONDecodeError):
            pass

app = FastAPI(title="SmartNotes Backend")


def require_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    try:
        return firebase_auth.verify_id_token(token)
    except Exception as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from error


def verified_user(user: Annotated[dict, Depends(require_user)]) -> dict:
    if not user.get("email_verified", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Verify your email address before using notes.")
    if not user.get("uid"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user identity")
    return user


def optional_user(authorization: Annotated[str | None, Header()] = None) -> dict | None:
    if not authorization:
        return None
    return require_user(authorization)


def get_firestore():
    if not firebase_admin._apps:
        raise HTTPException(status_code=500, detail="Backend is not configured")
    try:
        return firestore.client()
    except Exception as error:
        raise HTTPException(status_code=500, detail="Backend is not configured") from error


class NoteMetadata(BaseModel):
    title: str = Field(..., max_length=120)
    description: str = ""
    subject: str = ""
    tags: list[str] = Field(default_factory=list)
    fileName: str = ""
    mimeType: str = ""
    contentType: str = ""
    extension: str = ""
    fileSize: int = Field(..., ge=1, le=5 * 1024 * 1024)
    size: int | None = None
    storagePath: str | None = None
    searchTerms: list[str] = Field(default_factory=list, max_length=40)
    thumbnail: str | None = Field(default=None, max_length=100000)
    uploaderId: str | None = None
    uploaderName: str = ""
    storageMode: str | None = None
    isChunked: bool | None = None
    chunkCount: int | None = None
    id: str | None = None
    createdAt: object | None = None

    class Config:
        extra = "allow"


def note_data(snapshot) -> dict:
    data = snapshot.to_dict() or {}
    data.setdefault("id", snapshot.id)
    return data


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/me")
def me(user: Annotated[dict, Depends(require_user)]) -> dict[str, str | None]:
    return {"uid": user.get("uid", ""), "email": user.get("email")}


@app.get("/api/notes")
def list_notes(
    search: str = Query(default=""),
    subject: str = Query(default=""),
    extension: str = Query(default=""),
    mine: bool = Query(default=False),
    user: Annotated[dict | None, Depends(optional_user)] = None,
):
    if mine:
        if not user:
            raise HTTPException(status_code=401, detail="Sign in to view your notes.")
        uid = user.get("uid")
        if not uid:
            raise HTTPException(status_code=401, detail="Invalid user identity")
    else:
        uid = None

    notes_ref = get_firestore().collection("notes")
    if mine:
        notes_ref = notes_ref.where("uploaderId", "==", uid)
    if subject:
        notes_ref = notes_ref.where("subject", "==", subject)
    if extension:
        notes_ref = notes_ref.where("extension", "==", extension)
    if search.strip():
        notes_ref = notes_ref.where("searchTerms", "array_contains", search.strip().lower())

    snapshots = notes_ref.order_by("createdAt", direction=firestore.Query.DESCENDING).limit(100).stream()
    return [note_data(snapshot) for snapshot in snapshots]


@app.post("/api/notes", status_code=201)
def create_note(note: NoteMetadata, user: Annotated[dict, Depends(verified_user)]):
    db = get_firestore()
    uid = user["uid"]
    if note.storagePath and not note.storagePath.startswith(f"notes/{uid}/"):
        raise HTTPException(status_code=422, detail="storagePath must start with notes/<uid>/.")

    existing = db.collection("notes").where("uploaderId", "==", uid).stream()
    used_bytes = sum(
        int((item.to_dict() or {}).get("fileSize", (item.to_dict() or {}).get("size", 0)) or 0)
        for item in existing
    )
    if used_bytes + note.fileSize > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Your notes exceed the 50 MB per-user storage quota.")

    payload = note.model_dump(exclude_none=True) if hasattr(note, "model_dump") else note.dict(exclude_none=True)
    payload["uploaderId"] = uid
    payload["size"] = note.fileSize
    requested_id = payload.pop("id", None)
    payload.pop("createdAt", None)
    note_ref = db.collection("notes").document(requested_id) if requested_id else db.collection("notes").document()
    payload["id"] = note_ref.id
    payload["createdAt"] = firestore.SERVER_TIMESTAMP
    note_ref.set(payload)
    return {**payload, "createdAt": None}


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: str, user: Annotated[dict, Depends(verified_user)]):
    db = get_firestore()
    note_ref = db.collection("notes").document(note_id)
    snapshot = note_ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="The note could not be found.")
    note = snapshot.to_dict() or {}
    if note.get("uploaderId") != user["uid"]:
        raise HTTPException(status_code=403, detail="Only the note uploader can delete this note.")
    for chunk in note_ref.collection("chunks").stream():
        chunk.reference.delete()
    note_ref.delete()
    return {"deleted": True, "id": note_id}

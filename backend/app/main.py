import json
import os
from typing import Annotated, Any

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:
    boto3 = None

    class BotoCoreError(Exception):
        pass

    class ClientError(Exception):
        pass
from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
import firebase_admin
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials, firestore


if not firebase_admin._apps:
    service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    service_account_file = os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE")
    if service_account_json:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(service_account_json)))
    elif service_account_file:
        firebase_admin.initialize_app(credentials.Certificate(service_account_file))

app = FastAPI(title="SmartNotes Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_FILE_BYTES = 5 * 1024 * 1024
LINK_SECONDS = 300


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
    model_config = ConfigDict(extra="allow")

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

class FileUploadRequest(BaseModel):
    noteId: str = Field(..., pattern=r"^[A-Za-z0-9_-]{5,100}$")
    fileName: str = Field(..., min_length=1, max_length=180)
    size: int = Field(..., ge=1, le=MAX_FILE_BYTES)
    contentType: str = Field(default="application/octet-stream", max_length=100)


class FileKeyRequest(BaseModel):
    key: str = Field(..., min_length=1, max_length=300)


class ReportRequest(BaseModel):
    noteId: str = Field(..., min_length=1, max_length=100)
    reason: str = Field(..., min_length=1, max_length=300)


def b2_client():
    if boto3 is None:
        raise HTTPException(status_code=500, detail="File storage dependencies are not installed.")
    values = {name: os.getenv(name) for name in ("B2_KEY_ID", "B2_APP_KEY", "B2_REGION")}
    if not all(values.values()) or not os.getenv("B2_BUCKET"):
        raise HTTPException(status_code=500, detail="File storage is not configured.")
    return boto3.client(
        "s3",
        endpoint_url=f"https://s3.{values['B2_REGION']}.backblazeb2.com",
        aws_access_key_id=values["B2_KEY_ID"],
        aws_secret_access_key=values["B2_APP_KEY"],
        region_name=values["B2_REGION"],
    )


def clean_file_name(name: str) -> str:
    safe = "".join("_" if char in '/\\"' or ord(char) < 32 else char for char in name).strip()
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid file name.")
    return safe[:180]


def valid_file_key(key: str) -> bool:
    return key.startswith("notes/") and ".." not in key and len(key) <= 300


def presigned_url(method: str, key: str, **params: Any) -> str:
    try:
        return b2_client().generate_presigned_url(
            "put_object" if method == "PUT" else "get_object" if method == "GET" else "delete_object",
            Params={"Bucket": os.environ["B2_BUCKET"], "Key": key, **params},
            ExpiresIn=LINK_SECONDS,
            HttpMethod=method,
        )
    except (BotoCoreError, ClientError) as error:
        raise HTTPException(status_code=500, detail="Could not create file link.") from error


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


@app.post("/api/files/upload-url")
def create_upload_url(
    request: FileUploadRequest,
    user: Annotated[dict, Depends(verified_user)],
):
    key = f"notes/{user['uid']}/{request.noteId}/{clean_file_name(request.fileName)}"
    content_type = request.contentType or "application/octet-stream"
    url = presigned_url(
        "PUT",
        key,
        ContentType=content_type,
        ContentLength=request.size,
    )
    return {"key": key, "url": url, "headers": {"Content-Type": content_type}}


@app.get("/api/files/download-url")
def create_download_url(
    key: str = Query(..., max_length=300),
    user: Annotated[dict, Depends(require_user)] = None,
):
    if not valid_file_key(key):
        raise HTTPException(status_code=400, detail="Invalid file path.")
    return {"url": presigned_url("GET", key)}


@app.post("/api/files/delete-url")
def create_delete_url(
    request: FileKeyRequest,
    user: Annotated[dict, Depends(require_user)],
):
    if not valid_file_key(request.key):
        raise HTTPException(status_code=400, detail="Invalid file path.")
    if not request.key.startswith(f"notes/{user.get('uid')}/"):
        raise HTTPException(status_code=403, detail="You can only delete your own files.")
    return {"url": presigned_url("DELETE", request.key)}


@app.post("/api/reports", status_code=201)
def create_report(
    request: ReportRequest,
    user: Annotated[dict, Depends(verified_user)],
):
    db = get_firestore()
    report_id = f"{user['uid']}_{request.noteId}"
    report_ref = db.collection("reports").document(report_id)
    if report_ref.get().exists:
        raise HTTPException(status_code=409, detail="You have already reported this note.")
    report_ref.set(
        {
            "reporterId": user["uid"],
            "noteId": request.noteId,
            "reason": request.reason,
            "createdAt": firestore.SERVER_TIMESTAMP,
        }
    )
    return {"id": report_id, "reported": True}


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
    storage_path = note.get("storagePath")
    if storage_path:
        if not storage_path.startswith(f"notes/{user['uid']}/") or not valid_file_key(storage_path):
            raise HTTPException(status_code=422, detail="Invalid storage path.")
        try:
            b2_client().delete_object(Bucket=os.environ["B2_BUCKET"], Key=storage_path)
        except (BotoCoreError, ClientError) as error:
            raise HTTPException(status_code=502, detail="Could not delete the stored file.") from error
    for chunk in note_ref.collection("chunks").stream():
        chunk.reference.delete()
    note_ref.delete()
    return {"deleted": True, "id": note_id}

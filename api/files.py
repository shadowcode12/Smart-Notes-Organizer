# Backend for note files on Backblaze B2 (Python, runs as a Vercel function).
# Checks the Firebase sign-in, then returns short-lived presigned links, so browsers send
# file bytes straight to B2 (Vercel request bodies are limited to 4.5 MB).
# Env vars (Vercel dashboard, never commit): B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_REGION.
import json
import os
import re
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import boto3
from botocore.config import Config
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

PROJECT_ID = "smartnotes-8f51d"
MAX_BYTES = 5 * 1024 * 1024
LINK_SECONDS = 300
NOTE_ID = re.compile(r"^[A-Za-z0-9_-]{5,100}$")
OPS = {"PUT": "put_object", "GET": "get_object", "DELETE": "delete_object"}


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def env(name):
    value = os.environ.get(name)
    if not value:
        raise HttpError(500, "File storage is not configured.")
    return value


def signed_in_user(headers):
    header = headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HttpError(401, "Sign in first.")
    try:
        claims = id_token.verify_firebase_token(header[7:], google_requests.Request(), audience=PROJECT_ID)
    except Exception:
        raise HttpError(401, "Your sign-in has expired. Please log in again.")
    return claims.get("user_id") or claims.get("sub"), claims.get("email_verified") is True


def valid_key(key):
    return isinstance(key, str) and len(key) <= 300 and key.startswith("notes/") and ".." not in key


def safe_name(name):
    return re.sub(r'[/\\"\x00-\x1f]', "_", str(name or "")).strip()[:180]


def s3_client():
    region = env("B2_REGION")
    return boto3.client(
        "s3",
        endpoint_url=f"https://s3.{region}.backblazeb2.com",
        aws_access_key_id=env("B2_KEY_ID"),
        aws_secret_access_key=env("B2_APP_KEY"),
        region_name=region,
        config=Config(signature_version="s3v4"),
    )


def presign(method, key, content_type=None):
    params = {"Bucket": env("B2_BUCKET"), "Key": key}
    if content_type:
        params["ContentType"] = content_type
    return s3_client().generate_presigned_url(OPS[method], Params=params, ExpiresIn=LINK_SECONDS)


class handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _route(self, method):
        try:
            query = parse_qs(urlparse(self.path).query)
            action = query.get("action", [""])[0]

            if method == "POST" and action == "upload-url":
                uid, verified = signed_in_user(self.headers)
                if not verified:
                    raise HttpError(403, "Verify your email address before uploading.")
                body = self._body()
                note_id = body.get("noteId", "")
                if not NOTE_ID.match(str(note_id)):
                    raise HttpError(400, "Invalid note id.")
                size = body.get("size")
                if not isinstance(size, int) or size <= 0 or size > MAX_BYTES:
                    raise HttpError(400, "File must be between 1 byte and 5 MB.")
                name = safe_name(body.get("fileName"))
                if not name:
                    raise HttpError(400, "Invalid file name.")
                content_type = body.get("contentType")
                if not isinstance(content_type, str) or len(content_type) > 100:
                    content_type = "application/octet-stream"
                key = f"notes/{uid}/{note_id}/{name}"
                url = presign("PUT", key, content_type)
                return self._send(200, {"key": key, "url": url, "headers": {"Content-Type": content_type}})

            if method == "GET" and action == "download-url":
                signed_in_user(self.headers)
                key = query.get("key", [""])[0]
                if not valid_key(key):
                    raise HttpError(400, "Invalid file path.")
                return self._send(200, {"url": presign("GET", key)})

            if method == "POST" and action == "delete-url":
                uid, _ = signed_in_user(self.headers)
                key = self._body().get("key", "")
                if not valid_key(key):
                    raise HttpError(400, "Invalid file path.")
                if not key.startswith(f"notes/{uid}/"):
                    raise HttpError(403, "You can only delete your own files.")
                return self._send(200, {"url": presign("DELETE", key)})

            raise HttpError(404, "Not found.")
        except HttpError as error:
            self._send(error.status, {"error": error.message})
        except Exception:
            traceback.print_exc()
            self._send(500, {"error": "Something went wrong. Please try again."})

    def do_POST(self):
        self._route("POST")

    def do_GET(self):
        self._route("GET")

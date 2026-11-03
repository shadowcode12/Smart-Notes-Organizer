# SmartNotes Backend Skeleton

## Setup

Create and activate a virtual environment, then install the dependencies:

```text
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
```

Run the development server with:

```text
uvicorn backend.app.main:app --reload
```

Set `FIREBASE_SERVICE_ACCOUNT_JSON` to the service-account JSON string before
starting the server. The backend returns `Backend is not configured` if this
variable is absent; it never reads credentials from a file.

The notes API is available at `/api/notes`. Public listing is supported, while
creating and deleting notes require a verified Firebase email. Tests mock
Firebase verification and Firestore, so they never need credentials.

The browser uses the backend when `window.SMART_NOTES_BACKEND_URL` is set.
Without that setting it keeps the existing Firestore/local behavior.

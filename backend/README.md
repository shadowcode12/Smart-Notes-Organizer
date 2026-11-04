# SmartNotes Backend

## Setup

Create and activate a virtual environment, then install the dependencies:

```text
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
```

Run the development server with:

```text
cd backend
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Set `FIREBASE_SERVICE_ACCOUNT_JSON` to the service-account JSON string, or
`FIREBASE_SERVICE_ACCOUNT_FILE` to a local service-account file, before starting
the server. File storage also requires the B2 variables in `.env.example`.

The notes API is available at `/api/notes`. Public listing is supported, while
creating and deleting notes require a verified Firebase email. Tests mock
Firebase verification and Firestore, so they never need credentials.

The browser uses `http://localhost:8000` by default and can override it with
`window.SMART_NOTES_API_BASE`. Without Firebase configuration it keeps the
existing local behavior.

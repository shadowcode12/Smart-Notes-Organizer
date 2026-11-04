# SmartNotes

A student study-notes exchange. Students upload lecture notes and study guides, browse a shared community feed, download files, and message the people who wrote them.

SmartNotes is a static, multi-page website built with plain HTML, CSS, and browser JavaScript. It uses Firebase Authentication and Cloud Firestore for accounts, notes, and chat. For demos, it can also run without any Firebase setup by using a local fallback mode.

> **Status:** prototype. The Firestore security rules in this repository must be deployed to your Firebase project before real users use it. See [Security](#security).

## Contents

- [Features](#features)
- [Pages](#pages)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Firebase setup](#firebase-setup)
- [Local mode](#local-mode)
- [Data model](#data-model)
- [File uploads and storage](#file-uploads-and-storage)
- [Testing](#testing)
- [Run locally](#run-locally)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [License](#license)

## Features

**Accounts**

- Email and password sign-up and login, with a verification email after sign-up.
- Google sign-in.
- Password reset by email.
- Passwords must be at least 10 characters and include an uppercase letter, a lowercase letter, and a number or symbol.
- Sessions persist across reloads until you log out.

**Uploading notes**

- Select or drag in several files at once. Each file can have a title, subject, tags, and a description.
- Accepted types: PDF, DOC, DOCX, PPT, PPTX, JPG, JPEG, PNG, GIF, and WEBP.
- Maximum size is 5 MB per file.
- Only verified accounts can upload.

**Community feed**

- Live updates when notes are added or deleted.
- Search by title, description, subject, author, or tag.
- Filter by subject or file type, or show only your own notes.
- Free, one-click downloads for signed-in users.
- Authors can delete their own notes.

**Chat**

- One-to-one messages between a student and the author of a note.
- Conversations update in real time.
- Only verified accounts can send messages.

**Dashboard**

- A personal dashboard with your upload count and chat count.
- A My Notes page for managing your uploads.
- A full-page chat workspace.

## Pages

| Page | File | Purpose |
| --- | --- | --- |
| Home | `index.html` | Landing page, upload area, and community preview |
| Dashboard | `pages/dashboard.html` | Signed-in overview and quick upload |
| My Notes | `pages/notes.html` | Upload manager, your notes, and the full community feed |
| Chats | `pages/chats.html` | Two-column chat workspace |
| Features | `pages/features.html` | Feature overview |
| Templates | `pages/templates.html` | Workspace and template overview |
| Blog | `pages/blog.html` | Study-tips articles |
| Log in | `pages/login.html` | Existing-user sign-in |
| Sign up | `pages/signup.html` | New-user registration |
| Terms, Privacy, Guidelines | `pages/terms.html`, `pages/privacy.html`, `pages/guidelines.html` | Legal and community pages |

Signed-in pages (dashboard, notes, chats) redirect logged-out visitors to the log-in page.

## Tech stack

- HTML5, CSS3, and ES modules. No framework and no bundler.
- Firebase Authentication and Cloud Firestore, loaded from Google's CDN (`gstatic.com`), version 10.12.2.
- `localStorage` and IndexedDB for local mode.
- Firebase CLI for deploying Firestore rules.
- Node.js test runner with `@firebase/rules-unit-testing` for the rules tests.
- Python with FastAPI and Backblaze B2 presigned links for the local API.

## Project structure

```text
smart-notes-organizer/
├── index.html                  Landing page
├── pages/                      All other website pages
├── css/style.css               Shared styles
├── js/
│   ├── config/firebase-config.js   Firebase setup and local-mode detection
│   ├── modules/auth.js             Sign-up, login, Google sign-in, route guards
│   ├── modules/notes.js            Uploads, feed, downloads, deletes
│   ├── modules/chat.js             Conversations and messages
│   └── script.js                   Navigation, search, and diagnostics
├── tests/
│   └── firestore.rules.test.js     Firestore rules tests (emulator)
├── backend/                        FastAPI backend
├── docs/
│   └── BACKEND_PLAN.md             Planned backend scope and endpoints
├── firestore.rules                 Firestore security rules
├── firebase.json                   Firebase config (rules and hosting headers)
├── package.json                    npm scripts and dependencies
└── README.md
```

## Getting started

### Requirements

- A modern browser with ES module support.
- A local web server. Opening the HTML files directly (`file://`) blocks the module imports.
- Node.js 18 or newer, only if you want to run the rules tests.

### Run locally

Use the included `run-demo.bat` to start the FastAPI backend on
http://localhost:8000 and the static frontend on http://localhost:8080. Exact
setup, environment variables, and the presentation checklist are in [DEMO.md](DEMO.md).

Without a Firebase configuration, the site runs in [local mode](#local-mode).

## Firebase setup

The default Firebase configuration lives in `js/config/firebase-config.js`. To use a different project without editing that file, define this before the Firebase module loads:

```html
<script>
  window.SMART_NOTES_FIREBASE_CONFIG = {
    apiKey: "your-web-api-key",
    authDomain: "your-project.firebaseapp.com",
    projectId: "your-project-id",
    messagingSenderId: "your-sender-id",
    appId: "your-app-id"
  };
</script>
```

Steps to set up a Firebase project:

1. Create a Firebase project and register a web app.
2. In **Authentication**, enable the **Email/Password** provider, and enable **Google** if you want Google sign-in.
3. Add your website's domain (and `localhost` for development) under **Authentication → Settings → Authorized domains**.
4. Create a **Cloud Firestore** database.
5. Deploy the security rules from this repository:

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules --project your-project-id
   ```

The web API key is not a secret. It identifies your web app. Access control comes from Firebase Authentication and the Firestore security rules, so the rules must be deployed.

## Local mode

Local mode turns on automatically when Firebase is not configured, the API key is invalid, or the browser is offline. In local mode, everything is stored in the browser:

| Data | Where it is stored |
| --- | --- |
| Accounts and session | `localStorage` |
| Note details | `localStorage` |
| Note file contents | IndexedDB (`smartnotes-files`) |
| Chat messages | `localStorage` |

Local-mode accounts are not shared between browsers or people, and local-mode passwords are stored in plain text. Use local mode for demos only.

Permission and security-rule errors from Firebase do not switch to local mode. They are shown to the user so the configuration can be fixed.

## Data model

All data lives in Firestore unless noted.

**`users/{uid}`**: `displayName`, `email`, `updatedAt`.

**`notes/{noteId}`**: `id`, `title`, `description`, `subject`, `tags`, `fileName`, `mimeType`, `fileSize`, `extension`, `uploaderId`, `uploaderName`, `createdAt`, `chunkCount`, `isChunked`.

**`notes/{noteId}/chunks/{index}`**: `index` (0 to 14) and `data` (a base64 slice of the file, at most 768,000 characters).

**`conversations/{conversationId}`**: `participants` (exactly two user IDs), `participantNames`, `lastMessage`, `updatedAt`.

**`conversations/{conversationId}/messages/{messageId}`**: `senderId`, `recipientId`, `text` (at most 2,000 characters), `createdAt`.

A conversation ID is the two user IDs sorted and joined with an underscore, so both people always reach the same conversation.

## File uploads and storage

- Maximum file size: **5 MB**.
- Every file is stored as base64 chunks of about 500 KB each, with at most 15 chunks per file.
- Chunks are stored in a Firestore subcollection of the note when Firebase is active, and in IndexedDB in local mode.
- Files are not stored in Firebase Cloud Storage yet.

Client-side checks are for user experience. The Firestore rules enforce the size and structure limits on the server side.

## Testing

### Firestore rules tests

The rules tests run against the Firestore emulator, so they need Java and the Firebase CLI:

```bash
npm install
npm test
```

The test suite covers public and private reads, verified-account requirements, note and chunk ownership, chunk limits, batch deletes, and message sender and participant checks. All six tests should pass. Lines starting with `PERMISSION_DENIED` are normal: they are denied writes that the tests expect.

### Backend tests

```bash
pip install -r backend/requirements.txt
python -m pytest backend/tests
```

## Security

The current security measures are:

- Firestore rules that require verified email for writes, restrict note and chunk changes to the owner, and require participants for chat.
- Content Security Policy that blocks inline scripts and restricts where scripts, frames, and connections can come from.
- Clickjacking protection through `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- Client-side password rules and input sanitization.

Known gaps before a public launch:

- Route guards and form checks run only in the browser. Server-side rules are the real protection.
- The password policy is checked only in the browser. Enable Firebase's password policy in the console as well.
- Files are not scanned for malware, and the file type check is based on the file extension.
- Local-mode accounts store passwords in plain text.
- Notes uploaded before the ownership fields existed cannot be edited or deleted by their authors until they are migrated.

## Troubleshooting

**The page is blank or the scripts don't load.** Serve the folder over HTTP. Don't open the HTML files directly.

**The site says it is in local mode.** Check that the Firebase configuration is correct, the domain is in Authorized domains, and Authentication and Firestore are enabled.

**Uploads or messages fail with a permission error.** Confirm the account is verified (check your email for the verification link), and confirm the Firestore rules are deployed.

**Google sign-in does not open.** Allow pop-ups for the site, and make sure the domain is listed under Authorized domains.

**`npm test` says "port taken".** Another program is using port 8080. The emulator needs that port. Close the program, or find it with `netstat -ano | findstr :8080`.

**`npm test` says "Missing script" or "module not found".** Run `npm install` first.

## Known limitations

- No automated tests for the frontend.
- No moderation, reporting, or account-deletion flow yet.
- Files are stored in Firestore chunks, not in object storage.
- The AI study assistant shown on the homepage is a planned feature and is not implemented.
- Search runs in the browser over the notes that are loaded, so it won't scale to a large collection.

## Roadmap

1. Move file storage to Firebase Cloud Storage with signed URLs.
2. Build the backend for file processing, moderation, and account deletion (see `docs/BACKEND_PLAN.md`).
3. Add reporting, admin review, and takedown tools.
4. Add frontend tests and continuous integration.
5. Add the AI study assistant (summaries and flashcards) on the server.

## License

No license has been chosen yet. Add a `LICENSE` file before you share or reuse the code publicly.

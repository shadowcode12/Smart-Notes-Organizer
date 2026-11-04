# SmartNotes local demo

## Setup

1. Install Python 3.11 or newer.
2. Install backend dependencies:

   ```bat
   python -m pip install -r backend\requirements.txt
   ```

3. Set `FIREBASE_SERVICE_ACCOUNT_JSON` to the Firebase service-account JSON string,
   or set `FIREBASE_SERVICE_ACCOUNT_FILE` to a local service-account JSON file.
4. Set `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, and `B2_REGION` for file uploads.
5. Run `run-demo.bat`. It starts the API at `http://localhost:8000`, the frontend at
   `http://localhost:8080`, and opens the site.

Never commit credentials. `.env` files and service-account JSON files are ignored.

## Demo checklist

1. Sign up, verify the message, log in, and log out.
2. Click Google sign-in and confirm the popup opens.
3. Open the forgot-password modal.
4. Upload a PDF and confirm its thumbnail, B2 key, and feed entry.
5. Upload DOCX and PPTX; confirm PPTX downloads rather than previews.
6. Preview a PDF and DOCX in the modal.
7. Download a note and confirm the filename.
8. Search for a title word beyond the first page of results.
9. Test subject, extension, and mine filters.
10. Select four files and confirm the three-file pause countdown; exceed 50 MB and confirm the limit message.
11. Confirm the sidebar meter shows used space, free space, file count, and last upload.
12. Report another user's note, then repeat and confirm "already reported".
13. Delete your own note and confirm the feed entry and B2 file disappear.
14. Open chat with another user, send a message, and confirm it appears.

## Five-minute presentation flow

1. Start `run-demo.bat` and show the dashboard and local backend health.
2. Sign in, search the feed, and demonstrate subject/extension/mine filters.
3. Upload a PDF, show thumbnail generation and the new feed entry.
4. Preview a document, download a PPTX, and show the quota meter.
5. Use a second account to report a note, then delete the first account's note.
6. Finish by opening chat and sending a message.

@echo off
setlocal
set "ROOT=%~dp0"

if not defined FIREBASE_SERVICE_ACCOUNT_JSON if not defined FIREBASE_SERVICE_ACCOUNT_FILE (
  echo Warning: FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_FILE is missing.
  echo Firebase-backed backend features will not work until one is set.
)

if exist "%ROOT%backend\.venv\Scripts\python.exe" (
  start "SmartNotes backend" cmd /k "cd /d %ROOT%backend && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
) else if exist "%ROOT%backend\venv\Scripts\python.exe" (
  start "SmartNotes backend" cmd /k "cd /d %ROOT%backend && venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
) else (
  start "SmartNotes backend" cmd /k "cd /d %ROOT%backend && python -m uvicorn app.main:app --port 8000"
)

start "SmartNotes frontend" cmd /k "cd /d %ROOT% && python -m http.server 8080"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8080"
echo SmartNotes is starting at http://localhost:8080
endlocal

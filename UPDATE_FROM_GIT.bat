@echo off
REM ============================================================
REM  Call Quality Platform - pull the latest version from Git and restart the service
REM  Run AS ADMINISTRATOR on the server. Keeps config.json, data\ and logs\ untouched.
REM ============================================================
setlocal
cd /d "%~dp0"

where git >nul 2>&1 || ( echo [ERROR] git not found in PATH. & pause & exit /b 1 )

echo Pulling latest code...
git pull --ff-only || ( echo [ERROR] git pull failed. Fix conflicts and retry. & pause & exit /b 1 )

echo Installing dependencies...
call npm install --no-audit --no-fund || ( echo [ERROR] npm install failed. & pause & exit /b 1 )

if exist "%~dp0nssm.exe" (
  echo Restarting service...
  "%~dp0nssm.exe" restart CallQualityPlatform
) else (
  echo nssm.exe not found - restart the platform manually (npm start).
)
echo Done.
pause

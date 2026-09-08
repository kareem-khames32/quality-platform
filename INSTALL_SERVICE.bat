@echo off
REM ============================================================
REM  Call Quality Platform - Install as Windows Service (via NSSM)
REM  Run AS ADMINISTRATOR. Requires nssm.exe next to this file
REM  (https://nssm.cc/download, win64\nssm.exe) and Node.js installed.
REM ============================================================
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 ( echo [ERROR] Run this file as Administrator. & pause & exit /b 1 )
if not exist "%~dp0nssm.exe" ( echo [ERROR] nssm.exe not found next to this script. & pause & exit /b 1 )
where node >nul 2>&1
if %errorlevel% neq 0 ( echo [ERROR] node.exe not found in PATH. Install Node.js 22+ first. & pause & exit /b 1 )
if not exist "%~dp0node_modules" ( echo Installing dependencies... & call npm install --no-audit --no-fund )
if not exist "%~dp0config.json" ( echo [ERROR] config.json not found. Copy config.example.json to config.json and edit it. & pause & exit /b 1 )

for /f "delims=" %%i in ('where node') do set NODE_EXE=%%i

echo Installing "CallQualityPlatform" service...
"%~dp0nssm.exe" stop CallQualityPlatform >nul 2>&1
"%~dp0nssm.exe" remove CallQualityPlatform confirm >nul 2>&1
"%~dp0nssm.exe" install CallQualityPlatform "%NODE_EXE%" "--no-warnings=ExperimentalWarning src\server.js"
"%~dp0nssm.exe" set CallQualityPlatform AppDirectory "%~dp0"
"%~dp0nssm.exe" set CallQualityPlatform DisplayName "Call Quality Platform"
"%~dp0nssm.exe" set CallQualityPlatform Description "Maharah call quality: CDR ingest, speech-to-text, banned words and complaint tickets"
"%~dp0nssm.exe" set CallQualityPlatform Start SERVICE_AUTO_START
"%~dp0nssm.exe" set CallQualityPlatform AppExit Default Restart
"%~dp0nssm.exe" set CallQualityPlatform AppRestartDelay 5000
if not exist "%~dp0logs" mkdir "%~dp0logs"
"%~dp0nssm.exe" set CallQualityPlatform AppStdout "%~dp0logs\platform.log"
"%~dp0nssm.exe" set CallQualityPlatform AppStderr "%~dp0logs\platform-error.log"
"%~dp0nssm.exe" set CallQualityPlatform AppRotateFiles 1
"%~dp0nssm.exe" set CallQualityPlatform AppRotateBytes 10485760
"%~dp0nssm.exe" start CallQualityPlatform

echo.
echo DONE. Service "CallQualityPlatform" installed. URL: http://localhost:8090
echo   nssm status  CallQualityPlatform
echo   nssm restart CallQualityPlatform
echo Firewall: netsh advfirewall firewall add rule name="Call Quality Platform" dir=in action=allow protocol=TCP localport=8090
pause

@echo off
REM ============================================================
REM  Call Quality Platform watchdog - run every 5 minutes by Task Scheduler as SYSTEM
REM  (the task is created by INSTALL_SERVICE.bat).
REM   - service stopped                              -> start it
REM   - /healthz fails twice in a row (10 minutes)   -> restart it (hung process, stalled lanes, database problem)
REM  Put a file named maintenance.flag next to this script to pause the watchdog during maintenance.
REM ============================================================
setlocal
cd /d "%~dp0"
set "SVC=CallQualityPlatform"
set "LOG=%~dp0logs\watchdog.log"
set "FAILF=%~dp0logs\watchdog.fail"
if not exist "%~dp0logs" mkdir "%~dp0logs"
if exist "%~dp0maintenance.flag" exit /b 0

sc query %SVC% | find "RUNNING" >nul
if errorlevel 1 (
  echo %date% %time% service not running - starting it>> "%LOG%"
  "%~dp0nssm.exe" start %SVC% >nul 2>&1
  exit /b 0
)

REM HTTP port from config.json (the HTTP port always answers /healthz, even when HTTPS is enabled)
set "PORT=8090"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "try { $c = Get-Content -Raw -LiteralPath '%~dp0config.json' | ConvertFrom-Json; if ($c.server.port) { $c.server.port } else { 8090 } } catch { 8090 }"`) do set "PORT=%%p"

set "CODE=000"
for /f "usebackq delims=" %%c in (`curl.exe -s -o nul -w "%%{http_code}" -m 25 http://127.0.0.1:%PORT%/healthz`) do set "CODE=%%c"

if "%CODE%"=="200" goto healthy
if exist "%FAILF%" goto restart
echo %CODE%> "%FAILF%"
echo %date% %time% healthz failed once (HTTP %CODE%) - will restart if it fails again>> "%LOG%"
exit /b 0

:restart
del "%FAILF%" >nul 2>&1
echo %date% %time% healthz failed twice (HTTP %CODE%) - restarting the service>> "%LOG%"
"%~dp0nssm.exe" restart %SVC% >nul 2>&1
exit /b 0

:healthy
if exist "%FAILF%" del "%FAILF%" >nul 2>&1
exit /b 0

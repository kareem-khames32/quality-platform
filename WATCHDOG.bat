@echo off
REM ============================================================
REM  Call Quality Platform watchdog - run every 5 minutes by Task Scheduler as SYSTEM
REM  (the task is created by INSTALL_SERVICE.bat).
REM   - service stopped                              -> start it
REM   - /healthz fails twice in a row (10 minutes)   -> restart it (hung process, stalled lanes, database problem)
REM  A file named maintenance.flag next to this script pauses the watchdog during maintenance;
REM  a flag older than 60 minutes (an update that died half-way) is ignored and removed.
REM  The probe uses curl.exe when present, otherwise PowerShell. If neither can run, nothing is restarted.
REM ============================================================
setlocal
cd /d "%~dp0"
set "SVC=CallQualityPlatform"
set "LOG=%~dp0logs\watchdog.log"
set "FAILF=%~dp0logs\watchdog.fail"
if not exist "%~dp0logs" mkdir "%~dp0logs"

if not exist "%~dp0maintenance.flag" goto checkservice
set "STALE="
for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "if ((Get-Item -LiteralPath '%~dp0maintenance.flag').LastWriteTime -lt (Get-Date).AddMinutes(-60)) { 'stale' }"`) do set "STALE=%%s"
if "%STALE%"=="stale" goto staleflag
if exist "%FAILF%" del "%FAILF%" >nul 2>&1
exit /b 0

:staleflag
>> "%LOG%" echo %date% %time% maintenance.flag older than 60 minutes - ignoring and removing it
del "%~dp0maintenance.flag" >nul 2>&1

:checkservice
sc query %SVC% | find "RUNNING" >nul
if not errorlevel 1 goto probe
>> "%LOG%" echo %date% %time% service not running - starting it
if exist "%FAILF%" del "%FAILF%" >nul 2>&1
"%~dp0nssm.exe" start %SVC% >nul 2>&1
exit /b 0

:probe
REM HTTP port from config.json (the HTTP port always answers /healthz, even when HTTPS is enabled)
set "PORT=8090"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "try { $c = Get-Content -Raw -LiteralPath '%~dp0config.json' | ConvertFrom-Json; if ($c.server.port) { $c.server.port } else { 8090 } } catch { 8090 }"`) do set "PORT=%%p"

set "CODE=NOPROBE"
where curl.exe >nul 2>&1
if errorlevel 1 goto psprobe
for /f "usebackq delims=" %%c in (`curl.exe -s -o nul -w "%%{http_code}" -m 25 http://127.0.0.1:%PORT%/healthz`) do set "CODE=%%c"
if not "%CODE%"=="NOPROBE" goto judge
:psprobe
for /f "usebackq delims=" %%c in (`powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 25 -Uri 'http://127.0.0.1:%PORT%/healthz').StatusCode } catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }"`) do set "CODE=%%c"

:judge
if "%CODE%"=="200" goto healthy
if "%CODE%"=="NOPROBE" goto noprobe
if exist "%FAILF%" goto restart
> "%FAILF%" echo %CODE%
>> "%LOG%" echo %date% %time% healthz failed once (HTTP %CODE%) - will restart if it fails again
exit /b 0

:noprobe
>> "%LOG%" echo %date% %time% could not run a health probe (no curl.exe and PowerShell failed) - not restarting
exit /b 0

:restart
del "%FAILF%" >nul 2>&1
>> "%LOG%" echo %date% %time% healthz failed twice (HTTP %CODE%) - restarting the service
"%~dp0nssm.exe" restart %SVC% >nul 2>&1
exit /b 0

:healthy
if exist "%FAILF%" del "%FAILF%" >nul 2>&1
exit /b 0

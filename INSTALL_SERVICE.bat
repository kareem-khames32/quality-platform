@echo off
REM ============================================================
REM  Call Quality Platform - install the Windows service via NSSM, or re-apply its settings and restart it.
REM  Run AS ADMINISTRATOR. Requires nssm.exe next to this file and Node.js 22+.
REM    INSTALL_SERVICE.bat          interactive
REM    INSTALL_SERVICE.bat quiet    no pause (used by UPDATE_FROM_GIT.bat)
REM
REM  What it sets up so the platform keeps running on its own:
REM   - delayed automatic start after every server restart
REM   - NSSM restarts the process 5 s after any crash; Windows service recovery restarts NSSM itself
REM   - a watchdog task (every 5 min) restarts the service if it is stopped or not healthy (hung)
REM   - size-based log rotation while running (the platform itself deletes logs older than 14 days)
REM   - firewall rules for 8443/8090
REM  An existing service is updated in place (stop, apply settings, start) and never removed,
REM  so a failed step can not leave the server without the service.
REM  Exit code 0 only when the service is RUNNING and answers /healthz with 200.
REM ============================================================
setlocal
cd /d "%~dp0"
set "QUIET=%~1"
set "SVC=CallQualityPlatform"

fltmc >nul 2>&1
if errorlevel 1 ( echo [ERROR] Run this file as Administrator ^(right-click ^> Run as administrator^). & goto fail )
if not exist "%~dp0nssm.exe" ( echo [ERROR] nssm.exe not found next to this script. & goto fail )
where node >nul 2>&1
if errorlevel 1 ( echo [ERROR] node.exe not found in PATH. Install Node.js 22+ first. & goto fail )
if not exist "%~dp0node_modules" ( echo Installing dependencies... & call npm install --no-audit --no-fund )
if not exist "%~dp0config.json" ( echo [ERROR] config.json not found. Copy config.example.json to config.json and edit it. & goto fail )

set "NODE_EXE="
for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"
REM folder path WITHOUT the trailing backslash (a trailing \ before a closing quote breaks argument parsing)
set "APPDIR=%~dp0"
set "APPDIR=%APPDIR:~0,-1%"
set "NSSM=%~dp0nssm.exe"
set "ARGS=--no-warnings=ExperimentalWarning src\server.js"
if not exist "%APPDIR%\logs" mkdir "%APPDIR%\logs"

REM keep the watchdog from touching the service while it is being reconfigured
> "%APPDIR%\maintenance.flag" echo install

sc query %SVC% >nul 2>&1
if errorlevel 1 goto install
echo Service %SVC% exists - stopping it to apply the settings ...
"%NSSM%" stop %SVC% >nul 2>&1
"%NSSM%" set %SVC% Application "%NODE_EXE%" >nul
"%NSSM%" set %SVC% AppParameters "%ARGS%" >nul
goto configure

:install
echo Installing service %SVC% ...
"%NSSM%" install %SVC% "%NODE_EXE%" "%ARGS%"
if errorlevel 1 ( echo [ERROR] nssm install failed. & goto fail )

:configure
"%NSSM%" set %SVC% AppDirectory "%APPDIR%" >nul
"%NSSM%" set %SVC% DisplayName "Call Quality Platform" >nul
"%NSSM%" set %SVC% Description "Maharah call quality: CDR ingest, speech-to-text, AI analysis and complaint tickets" >nul
REM start automatically after boot, a little after network and SQL services are up
"%NSSM%" set %SVC% Start SERVICE_DELAYED_AUTO_START >nul
REM restart on any exit (crash) after 5 seconds
"%NSSM%" set %SVC% AppExit Default Restart >nul
"%NSSM%" set %SVC% AppRestartDelay 5000 >nul
"%NSSM%" set %SVC% AppStopMethodConsole 10000 >nul
REM logs: rotate at 10 MB while the service is running (old files are deleted by the platform after 14 days)
"%NSSM%" set %SVC% AppStdout "%APPDIR%\logs\platform.log" >nul
"%NSSM%" set %SVC% AppStderr "%APPDIR%\logs\platform-error.log" >nul
"%NSSM%" set %SVC% AppRotateFiles 1 >nul
"%NSSM%" set %SVC% AppRotateOnline 1 >nul
"%NSSM%" reset %SVC% AppRotateSeconds >nul 2>&1
"%NSSM%" set %SVC% AppRotateBytes 10485760 >nul
REM second safety net: if the NSSM wrapper itself dies, Windows restarts the service
sc failure %SVC% reset= 86400 actions= restart/5000/restart/15000/restart/60000 >nul
sc failureflag %SVC% 1 >nul

REM watchdog: every 5 minutes, (re)start the service if it is stopped or unhealthy
schtasks /create /tn "CallQualityPlatform Watchdog" /tr "\"%APPDIR%\WATCHDOG.bat\"" /sc minute /mo 5 /ru SYSTEM /rl HIGHEST /f >nul
if errorlevel 1 echo [WARN] could not create the watchdog scheduled task

REM firewall rules (idempotent)
netsh advfirewall firewall delete rule name="Call Quality HTTPS" >nul 2>&1
netsh advfirewall firewall add rule name="Call Quality HTTPS" dir=in action=allow protocol=TCP localport=8443 >nul
netsh advfirewall firewall delete rule name="Call Quality HTTP" >nul 2>&1
netsh advfirewall firewall add rule name="Call Quality HTTP" dir=in action=allow protocol=TCP localport=8090 >nul

echo Starting service %SVC% ...
"%NSSM%" start %SVC% >nul 2>&1
set /a N=0
:waitrun
sc query %SVC% | find "RUNNING" >nul
if not errorlevel 1 goto running
set /a N+=1
if %N% geq 30 ( echo [ERROR] The service did not reach RUNNING within 60 seconds. & goto startfail )
ping -n 3 127.0.0.1 >nul
goto waitrun

:running
call :getport
echo Waiting for http://127.0.0.1:%PORT%/healthz ...
set /a N=0
:waithealth
call :probe
if "%CODE%"=="200" goto healthy
set /a N+=1
if %N% geq 18 ( echo [ERROR] The service is running but /healthz answered "%CODE%" for 90 seconds. & goto startfail )
ping -n 6 127.0.0.1 >nul
goto waithealth

:healthy
if exist "%APPDIR%\logs\watchdog.fail" del "%APPDIR%\logs\watchdog.fail" >nul 2>&1
if exist "%APPDIR%\maintenance.flag" del "%APPDIR%\maintenance.flag" >nul 2>&1
echo.
echo DONE. Service "%SVC%" is running and healthy.
echo   - starts automatically after a server restart (delayed start)
echo   - restarts itself if it crashes; the watchdog restarts it if it hangs
echo   - logs:   %APPDIR%\logs\platform.log
echo   - health: http://127.0.0.1:%PORT%/healthz
if /i not "%QUIET%"=="quiet" pause
exit /b 0

:startfail
echo --- last lines of logs\platform-error.log ---
powershell -NoProfile -Command "if (Test-Path -LiteralPath '%APPDIR%\logs\platform-error.log') { Get-Content -Tail 25 -LiteralPath '%APPDIR%\logs\platform-error.log' }"
echo The watchdog keeps trying to start the service every 5 minutes.
goto fail

:fail
REM never leave the watchdog paused
if defined APPDIR if exist "%APPDIR%\maintenance.flag" del "%APPDIR%\maintenance.flag" >nul 2>&1
if /i not "%QUIET%"=="quiet" pause
exit /b 1

REM ---------------- helpers ----------------
:getport
REM HTTP port from config.json (the HTTP port always answers /healthz, even when HTTPS is enabled)
set "PORT=8090"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "try { $c = Get-Content -Raw -LiteralPath '%APPDIR%\config.json' | ConvertFrom-Json; if ($c.server.port) { $c.server.port } else { 8090 } } catch { 8090 }"`) do set "PORT=%%p"
exit /b 0

:probe
set "CODE=000"
for /f "usebackq delims=" %%c in (`powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:%PORT%/healthz').StatusCode } catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }"`) do set "CODE=%%c"
exit /b 0

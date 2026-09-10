@echo off
REM ============================================================
REM  Call Quality Platform - install (or re-apply) the Windows service via NSSM.
REM  Run AS ADMINISTRATOR. Requires nssm.exe next to this file and Node.js 22+.
REM    INSTALL_SERVICE.bat          interactive
REM    INSTALL_SERVICE.bat quiet    no pause (used by UPDATE_FROM_GIT.bat)
REM
REM  What it sets up so the platform keeps running on its own:
REM   - delayed automatic start after every server restart
REM   - NSSM restarts the process 5 s after any crash; Windows service recovery restarts NSSM itself
REM   - a watchdog task (every 5 min) restarts the service if it is stopped or not healthy (hung)
REM   - daily + size-based log rotation while running, firewall rules for 8443/8090
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
if not exist "%APPDIR%\logs" mkdir "%APPDIR%\logs"

echo Installing service %SVC% ...
"%NSSM%" stop %SVC% >nul 2>&1
"%NSSM%" remove %SVC% confirm >nul 2>&1
"%NSSM%" install %SVC% "%NODE_EXE%" "--no-warnings=ExperimentalWarning src\server.js"
if errorlevel 1 ( echo [ERROR] nssm install failed. & goto fail )
"%NSSM%" set %SVC% AppDirectory "%APPDIR%" >nul
"%NSSM%" set %SVC% DisplayName "Call Quality Platform" >nul
"%NSSM%" set %SVC% Description "Maharah call quality: CDR ingest, speech-to-text, AI analysis and complaint tickets" >nul
REM start automatically after boot, a little after network and SQL services are up
"%NSSM%" set %SVC% Start SERVICE_DELAYED_AUTO_START >nul
REM restart on any exit (crash) after 5 seconds
"%NSSM%" set %SVC% AppExit Default Restart >nul
"%NSSM%" set %SVC% AppRestartDelay 5000 >nul
"%NSSM%" set %SVC% AppStopMethodConsole 10000 >nul
REM logs: rotate daily and at 10 MB, also while the service is running
"%NSSM%" set %SVC% AppStdout "%APPDIR%\logs\platform.log" >nul
"%NSSM%" set %SVC% AppStderr "%APPDIR%\logs\platform-error.log" >nul
"%NSSM%" set %SVC% AppRotateFiles 1 >nul
"%NSSM%" set %SVC% AppRotateOnline 1 >nul
"%NSSM%" set %SVC% AppRotateSeconds 86400 >nul
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

"%NSSM%" start %SVC%
if exist "%APPDIR%\maintenance.flag" del "%APPDIR%\maintenance.flag"

echo.
echo DONE. Service "%SVC%" installed and started.
echo   - starts automatically after a server restart (delayed start)
echo   - restarts itself if it crashes; the watchdog restarts it if it hangs
echo   - logs:   %APPDIR%\logs\platform.log
echo   - health: http://127.0.0.1:8090/healthz
if /i not "%QUIET%"=="quiet" pause
exit /b 0

:fail
if /i not "%QUIET%"=="quiet" pause
exit /b 1

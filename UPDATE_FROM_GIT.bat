@echo off
REM ============================================================
REM  Call Quality Platform - pull the latest version from Git, re-apply the service settings and restart.
REM  Run AS ADMINISTRATOR on the server. config.json, branches.ini, data\ and logs\ are never touched.
REM ============================================================
REM cmd reads a .bat file while running it and "git pull" may rewrite this very file: run from a temp copy.
if /i not "%~1"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\cq_update_from_git.bat" >nul
  call "%TEMP%\cq_update_from_git.bat" --from-temp "%~dp0"
  exit /b
)
setlocal
set "APP=%~2"
cd /d "%APP%"

fltmc >nul 2>&1
if errorlevel 1 ( echo [ERROR] Run as Administrator: right-click ^> Run as administrator. & pause & exit /b 1 )
where git >nul 2>&1
if errorlevel 1 ( echo [ERROR] git not found in PATH. & pause & exit /b 1 )

REM pause the watchdog while we update
> "%APP%maintenance.flag" echo update

echo Pulling latest code...
git pull --ff-only
if errorlevel 1 ( echo [ERROR] git pull failed - fix it and run again. & del "%APP%maintenance.flag" & pause & exit /b 1 )

echo Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo [ERROR] npm install failed. & del "%APP%maintenance.flag" & pause & exit /b 1 )

echo Re-applying service settings and restarting...
call "%APP%INSTALL_SERVICE.bat" quiet
if errorlevel 1 (
  if exist "%APP%maintenance.flag" del "%APP%maintenance.flag"
  echo.
  echo [ERROR] The new version did not come up healthy - see the lines above and logsplatform-error.log.
  echo         The watchdog keeps trying to start it every 5 minutes.
  pause
  exit /b 1
)
if exist "%APP%maintenance.flag" del "%APP%maintenance.flag"

echo.
echo Update finished: the service is running and healthy.
echo Health check: http://127.0.0.1:8090/healthz
pause

@echo off
rem Pulls the latest version from git, reinstalls dependencies and rebuilds.
setlocal
cd /d "%~dp0"

echo Pulling latest changes...
git pull --ff-only
if errorlevel 1 goto failed

echo Installing dependencies...
call npm install
if errorlevel 1 goto failed

echo Building...
call npm run build
if errorlevel 1 goto failed

echo.
echo Up to date. Run Start.bat to launch.
pause
exit /b 0

:failed
echo.
echo Something went wrong (see above).
pause
exit /b 1

@echo off
rem Reinstalls dependencies, does a clean build and starts the app.
setlocal
cd /d "%~dp0"

echo Installing dependencies...
call npm install
if errorlevel 1 goto failed

if exist dist rmdir /s /q dist
echo Building...
call npm run build
if errorlevel 1 goto failed

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:failed
echo.
echo Something went wrong (see above).
pause
exit /b 1

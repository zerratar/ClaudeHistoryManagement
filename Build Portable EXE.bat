@echo off
rem Builds a single portable "Claude History Manager <version>.exe" into the release folder.
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto failed
)

echo Building the portable exe (takes a minute)...
call npm run dist
if errorlevel 1 goto failed

echo.
echo Done. Opening the release folder...
start "" explorer "%~dp0release"
exit /b 0

:failed
echo.
echo Something went wrong (see above).
pause
exit /b 1

@echo off
rem Starts Claude History Manager. Installs dependencies and rebuilds only when needed.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 goto failed
)

rem Rebuild when the build is missing or any source file is newer than it.
set NEEDBUILD=0
if not exist "dist\main\main.js" set NEEDBUILD=1
if not exist "dist\renderer\index.html" set NEEDBUILD=1
if "%NEEDBUILD%"=="0" (
  powershell -NoProfile -Command "$b=(Get-Item 'dist\renderer\index.html').LastWriteTime; $s=Get-ChildItem src,package.json,vite.config.ts -Recurse -File | Where-Object { $_.LastWriteTime -gt $b } | Select-Object -First 1; if ($s) { exit 1 } else { exit 0 }"
  if errorlevel 1 set NEEDBUILD=1
)
if "%NEEDBUILD%"=="1" (
  echo Building...
  call npm run build
  if errorlevel 1 goto failed
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:failed
echo.
echo Something went wrong (see above).
pause
exit /b 1

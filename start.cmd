@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 goto fail
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
echo.
echo Could not start Y LaYncher. Check that Node.js is installed and run npm.cmd install.
pause
exit /b 1

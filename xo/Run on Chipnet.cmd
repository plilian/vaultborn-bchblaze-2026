@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\@xo-cash\engine" (
  echo Installing the XO packages into this folder, about 160 MB ...
  call npm install --omit=dev
  if errorlevel 1 (
    echo The installation failed. Check the internet connection and free disk space, then run this file again.
    pause
    exit /b 1
  )
)
node run-chipnet.mjs %*
echo.
pause

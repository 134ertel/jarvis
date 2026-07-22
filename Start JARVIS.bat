@echo off
title JARVIS
cd /d "%~dp0frontend"

if not exist node_modules (
    echo Installing frontend dependencies for the first time - this may take a minute...
    call npm install
)

echo Starting JARVIS - the real backend and the dev app will open shortly...
call npm run dev

echo.
echo JARVIS has stopped. Press any key to close this window.
pause >nul

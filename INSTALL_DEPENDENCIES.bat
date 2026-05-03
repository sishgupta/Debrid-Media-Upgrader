@echo off
:: Ensure we are running from the script's directory
cd /d "%~dp0"

echo ======================================================
echo STEP 1: INSTALLING SYSTEM REQUIREMENTS
echo ======================================================
echo.

echo Checking/Installing Node.js...
winget install -e --id OpenJS.NodeJS.LTS --scope machine --accept-package-agreements --accept-source-agreements

echo Checking/Installing Git...
winget install -e --id Git.Git --scope machine --accept-package-agreements --accept-source-agreements

echo Checking/Installing FFmpeg...
winget install -e --id gyan.ffmpeg --scope machine --accept-package-agreements --accept-source-agreements

echo.
echo ======================================================
echo INSTALLATION COMPLETE
echo.
echo IMPORTANT: Close this window and RE-OPEN a new terminal
echo before running START_APP.bat to ensure the new tools work.
echo ======================================================
pause

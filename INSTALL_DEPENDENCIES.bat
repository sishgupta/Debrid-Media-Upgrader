@echo off
:: Ensure we are running from the script's directory
cd /d "%~dp0"

echo ======================================================
echo STEP 1: INSTALLING SYSTEM REQUIREMENTS
echo ======================================================
echo.

echo Installing Node.js LTS...
winget install -e --id OpenJS.NodeJS.LTS --scope machine --accept-package-agreements --accept-source-agreements
if %errorLevel% neq 0 echo [INFO] Node.js check complete.

echo.
echo Installing Git...
winget install -e --id Git.Git --scope machine --accept-package-agreements --accept-source-agreements
if %errorLevel% neq 0 echo [INFO] Git check complete.

echo.
echo Installing FFmpeg...
winget install -e --id gyan.ffmpeg --scope machine --accept-package-agreements --accept-source-agreements
if %errorLevel% neq 0 echo [INFO] FFmpeg check complete.

echo.
echo ======================================================
echo INSTALLATION COMPLETE
echo.
echo IMPORTANT: Please RESTART your terminal or CMD window 
echo before running START_APP.bat for the first time.
echo ======================================================
pause

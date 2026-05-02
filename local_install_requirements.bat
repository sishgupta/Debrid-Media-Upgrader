@echo off
echo ======================================================
echo STEP 1: INSTALLING REQUIREMENTS (NODE.JS, GIT, FFMPEG)
echo ======================================================
echo.

echo Installing Node.js (LTS)...
winget install -e --id OpenJS.NodeJS.LTS --scope machine --accept-package-agreements --accept-source-agreements
if %errorLevel% neq 0 echo [WARN] Node.js installation might have failed or is already installed.

echo.
echo Installing Git...
winget install -e --id Git.Git --scope machine --accept-package-agreements --accept-source-agreements
if %errorLevel% neq 0 echo [WARN] Git installation might have failed or is already installed.

echo.
echo Installing FFmpeg...
winget install -e --id gyan.ffmpeg --scope machine --accept-package-agreements --accept-source-agreements
if %errorLevel% neq 0 echo [WARN] FFmpeg installation might have failed or is already installed.

echo.
echo ======================================================
echo INSTALLATION COMPLETE
echo Please RESTART your terminal/CMD/PowerShell 
echo for the changes to take effect!
echo ======================================================
pause

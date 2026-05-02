@echo off
echo ======================================================
echo STEP 2: DOWNLOAD SOURCE FROM GITHUB
echo ======================================================
echo.

set "RepoUrl=https://github.com/sishgupta/Debrid-Media-Upgrader.git"

echo Cloning repository: %RepoUrl%
echo.

git clone %RepoUrl%

if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Git clone failed. 
    echo Please ensure Git is installed and you have an internet connection.
    pause
    exit /b 1
)

echo.
echo ======================================================
echo DOWNLOAD COMPLETE
echo.
echo Next steps:
echo 1. Enter the directory: cd Debrid-Media-Upgrader
echo 2. Run local_run.bat to start the app.
echo ======================================================
pause

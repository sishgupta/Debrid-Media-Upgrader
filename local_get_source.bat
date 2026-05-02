@echo off
echo ======================================================
echo STEP 2: DOWNLOAD SOURCE FROM GITHUB
echo ======================================================
echo.

set /p RepoUrl="Enter your GitHub Repository URL (e.g., https://github.com/user/repo.git): "

if "%RepoUrl%"=="" (
    echo [ERROR] No URL provided.
    pause
    exit /b 1
)

echo.
echo Cloning repository...
git clone %RepoUrl%

echo.
echo ======================================================
echo DOWNLOAD COMPLETE
echo You can now navigate into the folder and run local_run.bat
echo ======================================================
pause

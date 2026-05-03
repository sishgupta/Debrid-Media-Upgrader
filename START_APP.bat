@echo off
setlocal

:: Ensure we are running from the script's directory
cd /d "%~dp0"

echo ======================================================
echo STEP 2: SETUP AND START APPLICATION
echo ======================================================
echo.

:: 1. Verify Git Installation
where git >nul 2>nul
if %errorLevel% neq 0 (
    echo [ERROR] Git is not installed or not in your PATH.
    echo Please run INSTALL_DEPENDENCIES.bat and RESTART your CMD window.
    pause
    exit /b 1
)

:: 2. Check if we need to download the source code
if not exist package.json (
    echo [NOTICE] Source code not found. Initializing repository...
    git init
    git remote add origin https://github.com/sishgupta/Debrid-Media-Upgrader.git
    git fetch
    git checkout -f main
    if errorlevel 1 (
        echo [ERROR] Failed to download source code.
        pause
        exit /b 1
    )
) else (
    echo [INFO] Source code detected. Checking for updates...
    git pull
)

echo.

:: 3. Verify Node Installation
where npm >nul 2>nul
if %errorLevel% neq 0 (
    echo [ERROR] Node.js/NPM is not installed or not in your PATH.
    echo Please run INSTALL_DEPENDENCIES.bat and RESTART your CMD window.
    pause
    exit /b 1
)

:: 5. Install Dependencies
if not exist node_modules (
    echo [NOTICE] First time setup: Installing components...
    echo This may take a few minutes.
    call npm install
)

echo.
echo Starting application...
echo.

:: 6. Run the app
call npm run dev

pause

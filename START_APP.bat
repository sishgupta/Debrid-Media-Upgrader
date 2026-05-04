@echo off
setlocal

:: Ensure we are running from the script's directory
cd /d "%~dp0"

echo ======================================================
echo STEP 2: SETUP AND START APPLICATION
echo ======================================================
echo.

:: 1. Update Check
if "%1"=="--no-update" goto :skip_update

where git >nul 2>nul
if %errorLevel% equ 0 (
    if exist .git (
        echo [INFO] Checking for updates...
        git pull > .update_log 2>&1
        findstr /C:"Updating" .update_log >nul
        if %errorLevel% equ 0 (
            echo [NOTICE] Script was updated. Restarting...
            del .update_log >nul 2>&1
            start "" /b "%~f0" --no-update
            exit /b
        )
        del .update_log >nul 2>&1
    )
) else (
    echo [INFO] Git not found, skipping update check.
)

:skip_update
echo.

:: 2. Verify Node/NPM Installation
call npm -v >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Node.js/NPM is not installed or not in your PATH.
    echo Please run INSTALL_DEPENDENCIES.bat and RESTART your CMD window.
    pause
    exit /b 1
)

:: 3. Download Source if missing (for first-time local setup)
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
)

:: 4. Install Dependencies
if not exist node_modules (
    echo [NOTICE] First time setup: Installing components...
    echo (This may take a few minutes)
    call npm install
)

echo.
echo Starting application...
echo.

:: 5. Run the app
call npx tsx server.ts

if %errorlevel% neq 0 pause

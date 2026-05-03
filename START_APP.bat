@echo off
setlocal enabledelayedexpansion

:: Ensure we are running from the script's directory
cd /d "%~dp0"

echo ======================================================
echo STARTING DEBRID MEDIA UPGRADER
echo ======================================================
echo.

:: 1. Check for Git updates
echo Checking for updates...
git pull 2>nul
if %errorLevel% equ 0 (
    echo [OK] Code is up to date.
) else (
    echo [INFO] Skipping update check (Git sync not available here).
)

echo.

:: 2. Initial Setup: Environment Variables
if not exist ".env" (
    if exist ".env.example" (
        echo [NOTICE] Generating .env from example...
        copy ".env.example" ".env" >nul
        echo Please edit your .env file to add your API keys.
    ) else (
        echo [NOTICE] Generating empty .env...
        echo # Add your API keys here > .env
        echo TMDB_API_KEY=>> .env
        echo AIOSTREAMS_URL=>> .env
    )
)

:: 3. Initial Setup: Dependencies
if not exist "node_modules\" (
    echo [NOTICE] First time setup - installing components...
    echo This may take a few minutes.
    call npm install
)

echo.
echo Starting application...
echo.

:: 4. Run the app
call npm run dev

pause

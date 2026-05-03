@echo off
setlocal enabledelayedexpansion

echo ======================================================
echo STARTING DEBRID MEDIA UPGRADER
echo ======================================================
echo.

:: 1. Check for Git updates (optional, will fail gracefully if git isn't in path yet)
echo Checking for updates...
git pull 2>nul
if %errorLevel% equ 0 (
    echo [OK] Code is up to date.
) else (
    echo [INFO] Skipping update check - Git not found or no remote repo.
)

echo.

:: 2. Initial Setup: Environment Variables
if not exist ".env" (
    echo [NOTICE] Generating .env from example...
    copy .env.example .env
    echo Please edit your .env file to add your API keys.
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

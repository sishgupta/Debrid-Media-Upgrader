@echo off
echo ======================================================
echo STEP 3: COMPILE AND RUN APPLICATION
echo ======================================================
echo.

:: Check if node_modules exists, if not run npm install
if not exist "node_modules\" (
    echo Installing dependencies (this may take a few minutes)...
    call npm install
)

:: Check if .env exists, if not warn user
if not exist ".env" (
    echo [WARN] No .env file found. 
    echo Copying .env.example to .env ...
    copy .env.example .env
    echo Please edit the .env file with your API keys before continuing!
    pause
)

echo.
echo Starting the application in development mode...
echo.
call npm run dev

pause

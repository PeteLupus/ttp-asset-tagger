@echo off
title TTP Asset Tagger

cd /d "%~dp0"

echo.
echo  ==========================================
echo   TTP Asset Tagger
echo  ==========================================
echo.

if not exist "runtime\node.exe" (
    echo  ERROR: runtime\node.exe not found.
    echo  Make sure you unzipped the full folder.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  First-time setup - installing dependencies...
    echo  This may take a minute, please wait.
    echo.
    "runtime\node.exe" "runtime\node_modules\npm\bin\npm-cli.js" install
    if %errorlevel% neq 0 (
        echo.
        echo  ERROR: Setup failed. See error above.
        pause
        exit /b 1
    )
    echo.
    echo  Setup complete.
    echo.
)

echo  Starting server...
echo  Browser will open at http://localhost:3000
echo.
echo  Keep this window open while you work.
echo  Close it when you are done for the day.
echo.

start "" cmd /c "timeout /t 6 /nobreak >nul && start http://localhost:3000"

"runtime\node.exe" server.js

echo.
echo  Server stopped.
pause

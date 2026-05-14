@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "BUN_EXE=bun"
where bun >nul 2>nul
if errorlevel 1 (
    echo Bun is not installed. Install from https://bun.sh
    pause
    exit /b 1
)

echo ============================================
echo  RP Platform — Production Server
echo ============================================
echo.

if not exist "apps\web\dist\index.html" (
    echo Frontend not built. Building now...
    call %BUN_EXE% run scripts\build.ts web
    if errorlevel 1 (
        echo Frontend build failed.
        pause
        exit /b 1
    )
    echo.
)

if not exist "services\api\dist" (
    echo API not built. Building now...
    call %BUN_EXE% run scripts\build.ts api-stack
    if errorlevel 1 (
        echo API build failed.
        pause
        exit /b 1
    )
    echo.
)

echo Starting server on http://127.0.0.1:8787
echo Press Ctrl+C to stop.
echo.

"%BUN_EXE%" "services\api\src\prod-server.ts"

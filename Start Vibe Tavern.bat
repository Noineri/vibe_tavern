@echo off
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
    echo Bun is not installed. Install from https://bun.sh
    pause
    exit /b 1
)

:: Everything else (port, build skip, port check, logging) lives in scripts/start.ts.
bun scripts/start.ts
pause

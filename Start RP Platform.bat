@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
    echo Bun is not installed. Install from https://bun.sh
    pause
    exit /b 1
)

set "VITE_RP_API_URL=http://127.0.0.1:8787"

if exist "..\mcp\.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("..\mcp\.env") do (
        set "KEY=%%A"
        set "VALUE=%%B"
        if not "!KEY!"=="" if /i not "!KEY:~0,1!"=="#" (
            if /i "!KEY!"=="NANO_GPT_BASE_URL" set "VITE_RP_DEFAULT_BASE_URL=!VALUE!"
            if /i "!KEY!"=="NANO_GPT_MODEL" set "VITE_RP_DEFAULT_MODEL=!VALUE!"
        )
    )
    set "VITE_RP_DEFAULT_PROVIDER_LABEL=NanoGPT"
)

echo ============================================
echo  RP Platform
echo ============================================
echo.
echo Server: http://127.0.0.1:8787
echo.

echo Checking dependencies...
if not exist "node_modules" goto :do_install
if not exist "node_modules\hono" goto :do_install
if not exist "node_modules\vite" goto :do_install
echo Dependencies OK.
goto :build

:do_install
echo Installing dependencies...
call bun install
if errorlevel 1 (
    echo.
    echo Failed to install dependencies.
    pause
    exit /b 1
)

:build
echo.
echo Building...
call bun run build
if errorlevel 1 (
    echo.
    echo Build failed.
    pause
    exit /b 1
)

:run
echo.
echo Starting server...
echo Press Ctrl+C to stop.
echo.

REM Проверяем, не занят ли порт
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue) { Write-Host ''; Write-Host 'ERROR: Port 8787 is already in use.'; Write-Host 'Kill the old process first:'; Get-NetTCPConnection -LocalPort 8787 | ForEach-Object { Write-Host ('  taskkill /PID ' + $_.OwningProcess + ' /F') }; Write-Host ''; exit 1 }"
if errorlevel 1 (
    pause
    exit /b 1
)

bun services/api/src/prod-server.ts
set "EXIT_CODE=%ERRORLEVEL%"

REM Graceful exits (0=normal, 1=Ctrl+C, 58=window closed) - just exit silently
if "%EXIT_CODE%"=="0" exit /b 0
if "%EXIT_CODE%"=="1" exit /b 0
if "%EXIT_CODE%"=="58" exit /b 0

REM Unexpected crash - show error and wait for keypress
echo.
echo Server crashed with exit code %EXIT_CODE%.
pause

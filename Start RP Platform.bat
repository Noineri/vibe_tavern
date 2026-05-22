@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
    echo Bun is not installed. Install from https://bun.sh
    pause
    exit /b 1
)

set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

set "RP_PLATFORM_LOG_DIR=%LOG_DIR%"
set "RP_PLATFORM_LOG_FILE=%LOG_DIR%\dev-launcher.log"
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
echo  RP Platform - Dev Server
echo ============================================
echo.
echo API: http://127.0.0.1:8787
echo Web: http://localhost:4173
echo Logs: %LOG_DIR%
echo.

echo Checking dependencies...
if not exist "node_modules" goto :do_install
if not exist "node_modules\hono" goto :do_install
if not exist "node_modules\vite" goto :do_install
echo Dependencies OK.
goto :run

:do_install
echo Installing dependencies...
call bun install
if errorlevel 1 (
    echo.
    echo Failed to install dependencies.
    pause
    exit /b 1
)

:run
echo.
echo Starting dev server...
echo Press Ctrl+C to stop.
echo.

bun ".\scripts\dev-supervisor.ts"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo Server stopped normally.
) else if "%EXIT_CODE%"=="1" (
    echo Server stopped.
) else if "%EXIT_CODE%"=="3221225786" (
    echo Server stopped ^(window closed^).
) else if "%EXIT_CODE%"=="-1073741510" (
    echo Server stopped ^(Ctrl+C^).
) else (
    echo Server crashed with exit code %EXIT_CODE%.
    echo Check logs: %LOG_DIR%
)
pause

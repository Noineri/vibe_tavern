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

set "VITE_RP_API_URL=http://127.0.0.1:8788"

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
echo  Vibe Tavern
echo ============================================
echo.
echo Server: http://127.0.0.1:8788
if /i "%LOG_LEVEL%"=="debug" echo Log level: debug
echo.

echo Checking dependencies...
if not exist "node_modules" goto :do_install
if not exist "node_modules\hono" goto :do_install
if not exist "node_modules\vite" goto :do_install
echo Dependencies OK.
goto :build

:do_install
echo Installing dependencies...
call %BUN_EXE% install
if errorlevel 1 (
    echo.
    echo Failed to install dependencies.
    pause
    exit /b 1
)

:build
echo.
echo Building...
call %BUN_EXE% run build
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

powershell.exe -NoProfile -Command "$conn = Get-NetTCPConnection -LocalPort 8788 -ErrorAction SilentlyContinue; if ($conn) { $ProcId = $conn[0].OwningProcess; Write-Host ''; Write-Host 'Port 8788 is already in use by PID' $ProcId; exit 10 } else { exit 0 }"
if %ERRORLEVEL%==10 (
    powershell.exe -NoProfile -Command "$ProcId = (Get-NetTCPConnection -LocalPort 8788 -ErrorAction SilentlyContinue)[0].OwningProcess; Write-Host 'Kill PID' $ProcId '? [Y/n]'; $a = Read-Host; if ($a -eq '' -or $a -eq 'Y' -or $a -eq 'y') { Stop-Process -Id $ProcId -Force; Write-Host 'Killed.'; exit 0 } else { Write-Host 'Cancelled.'; exit 1 }"
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

rem ── Create log directory ──
if not exist "logs" mkdir logs

rem ── Generate timestamp via PowerShell ──
for /f "usebackq" %%T in (`powershell.exe -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd_HHmmss'"`) do set "TIMESTAMP=%%T"
set "LOG_FILE=logs\server-!TIMESTAMP!.log"

echo Logging to !LOG_FILE!
echo.

rem ── Run bun with live output + log to file ──
powershell.exe -NoProfile -Command "& bun services/api/src/server/prod-server.ts 2>&1 | Tee-Object -FilePath '!LOG_FILE!' -Append; exit $LASTEXITCODE"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo Server stopped cleanly.
) else if "%EXIT_CODE%"=="1" (
    echo Server stopped ^(code 1^).
) else if "%EXIT_CODE%"=="3221225786" (
    echo Server stopped ^(Ctrl+C^).
) else if "%EXIT_CODE%"=="-1073741510" (
    echo Server stopped ^(Ctrl+C^).
) else (
    echo Server exited with code %EXIT_CODE%.
)
echo Log saved to !LOG_FILE!
echo.
pause

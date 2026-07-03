@echo off
REM Vibe Tavern launcher — thin wrapper around the compiled binary.
REM Self-update logic lives inside the binary: `vibe-tavern.exe update` does
REM the check, prompt, download, verify, and atomic swap, then exits so we
REM can run the (possibly updated) server.
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "BINARY=%SCRIPT_DIR%\vibe-tavern.exe"

if not exist "%BINARY%" (
    echo Error: %BINARY% not found.
    echo   Re-download from https://github.com/Noineri/vibe_tavern/releases
    pause
    exit /b 1
)

REM Update is best-effort — never block server start.
"%BINARY%" update

"%BINARY%" %*

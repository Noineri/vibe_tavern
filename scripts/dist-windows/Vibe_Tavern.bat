@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  Vibe Tavern - Windows launcher (archive distribution)
REM  Bundled version: __VERSION__
REM
REM  Mirrors scripts/dist-linux/Vibe_Tavern.sh: checks GitHub for
REM  a newer release, self-updates on demand, then starts the
REM  bundled server. The self-update re-launches this script from
REM  %%TEMP%% so it can swap its own directory (a running .bat
REM  cannot move the folder it lives in).
REM ============================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "BINARY=%SCRIPT_DIR%\vibe-tavern.exe"
set "LOCAL_VERSION=__VERSION__"
set "REPO_OWNER=Noineri"
set "REPO_NAME=vibe_tavern"
set "REPO_API_URL=https://api.github.com/repos/%REPO_OWNER%/%REPO_NAME%/releases/latest"
set "REPO_HTML_URL=https://github.com/%REPO_OWNER%/%REPO_NAME%/releases/latest"

REM --- Internal self-update mode (re-launched from %%TEMP%%) ---
if /i "%~1"=="__VT_SELF_UPDATE__" goto :self_update

echo Checking for updates...

curl -sSf --connect-timeout 5 "%REPO_API_URL%" -o "%TEMP%\vt-latest.json" 2>nul
if errorlevel 1 (
    echo Could not check for updates (offline or API unavailable^).
    del "%TEMP%\vt-latest.json" 2>nul
    goto :run
)

set "LATEST_TAG="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content -LiteralPath '%TEMP%\vt-latest.json' -Raw | ConvertFrom-Json).tag_name"`) do set "LATEST_TAG=%%i"
del "%TEMP%\vt-latest.json" 2>nul

if not defined LATEST_TAG (
    echo Could not determine latest version.
    goto :run
)

REM Strip a leading 'v' (e.g. v1.2.3 -> 1.2.3)
set "LATEST_VERSION=%LATEST_TAG:v=%"

if /i "%LOCAL_VERSION%"=="%LATEST_VERSION%" (
    echo You're using the latest version of Vibe Tavern.
    goto :run
)

echo.
echo --------------------------------------------------
echo   Update available!
echo   Current: v%LOCAL_VERSION%
echo   Latest:  v%LATEST_VERSION%
echo   Release: %REPO_HTML_URL%
echo --------------------------------------------------
set "choice="
set /p "choice=  Download and install update? [Y/n]: "

if /i "%choice%"=="n" (
    echo   Skipping update.
    goto :run
)

REM Re-launch this script from %%TEMP%% in a new window so it can
REM move its own directory out from under the original process.
set "UPDATER=%TEMP%\vt-updater.bat"
copy /y "%~f0" "%UPDATER%" >nul
start "" "%UPDATER%" __VT_SELF_UPDATE__ "%SCRIPT_DIR%" "%LATEST_TAG%" "%LATEST_VERSION%"
exit /b

:self_update
REM Give the original process a moment to release file handles.
ping -n 3 127.0.0.1 >nul

set "TARGET_DIR=%~2"
set "LATEST_TAG=%~3"
set "LATEST_VERSION=%~4"
set "ARCHIVE_URL=https://github.com/%REPO_OWNER%/%REPO_NAME%/releases/download/%LATEST_TAG%/Vibe-Tavern-%LATEST_TAG%-windows.zip"
set "TMP_ARCHIVE=%TEMP%\vibe-tavern-update.zip"
set "NEXT_DIR=%TARGET_DIR%.next"
set "OLD_DIR=%TARGET_DIR%.old"

echo   Downloading...
curl -fL --progress-bar "%ARCHIVE_URL%" -o "%TMP_ARCHIVE%"
if errorlevel 1 (
    echo   Download failed.
    goto :self_update_done
)

echo   Extracting...
if exist "%NEXT_DIR%" rmdir /s /q "%NEXT_DIR%"
mkdir "%NEXT_DIR%"
powershell -NoProfile -Command "Expand-Archive -LiteralPath '%TMP_ARCHIVE%' -DestinationPath '%NEXT_DIR%' -Force"

echo   Updating...
if exist "%OLD_DIR%" rmdir /s /q "%OLD_DIR%"
move "%TARGET_DIR%" "%OLD_DIR%" >nul 2>&1
if errorlevel 1 (
    echo   Update failed: could not replace the current install.
    echo   Close any running Vibe Tavern instances and try again.
    rmdir /s /q "%NEXT_DIR%" 2>nul
    del /f /q "%TMP_ARCHIVE%" 2>nul
    goto :self_update_done
)
move "%NEXT_DIR%" "%TARGET_DIR%" >nul 2>&1
rmdir /s /q "%OLD_DIR%" 2>nul
del /f /q "%TMP_ARCHIVE%" 2>nul

echo   Update complete!
echo.

:self_update_done
REM Run the (now updated) binary from the stable target path.
"%TARGET_DIR%\vibe-tavern.exe"
del /f /q "%~f0" 2>nul
exit /b

:run
echo.
"%BINARY%" %*

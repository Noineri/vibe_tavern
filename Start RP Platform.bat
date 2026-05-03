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
set "BUN_EXECUTABLE=%BUN_EXE%"

set "LOG_DIR=%~dp0logs"
set "RP_PLATFORM_LOG_FILE=%LOG_DIR%\dev-launcher.log"
set "RP_PLATFORM_LOG_DIR=%LOG_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

> "%RP_PLATFORM_LOG_FILE%" echo === Start RP Platform.bat started at %date% %time% ===
>> "%RP_PLATFORM_LOG_FILE%" echo Working directory: %cd%
>> "%RP_PLATFORM_LOG_FILE%" echo Bun executable: %BUN_EXE%

if exist "..\mcp\.env" (
  >> "%RP_PLATFORM_LOG_FILE%" echo Loading defaults from ..\mcp\.env
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
set "VITE_RP_API_URL=http://127.0.0.1:8787"

echo Log file: "%RP_PLATFORM_LOG_FILE%"
echo API log: "%LOG_DIR%\dev-api.log"
echo Web log: "%LOG_DIR%\dev-web.log"
>> "%RP_PLATFORM_LOG_FILE%" echo VITE_RP_API_URL=%VITE_RP_API_URL%

 if not exist "node_modules" (
   >> "%RP_PLATFORM_LOG_FILE%" echo node_modules missing, running bun install
   echo Installing dependencies...
   call bun install
   if errorlevel 1 goto :fail
 )

 >> "%RP_PLATFORM_LOG_FILE%" echo Launching %BUN_EXE% .\scripts\dev-supervisor.ts
 start "" /wait /b "%BUN_EXE%" ".\scripts\dev-supervisor.ts"
 set "RP_EXIT_CODE=%ERRORLEVEL%"
 >> "%RP_PLATFORM_LOG_FILE%" echo Launcher exited with code %RP_EXIT_CODE%
 if "%RP_EXIT_CODE%"=="0" goto :eof
 if "%RP_EXIT_CODE%"=="-1073741510" goto :eof
 if "%RP_EXIT_CODE%"=="3221225786" goto :eof
  if not "%RP_EXIT_CODE%"=="0" (
   echo.
   echo Launcher failed. Check "%RP_PLATFORM_LOG_FILE%"
   pause
  )
  goto :eof

:fail
>> "%RP_PLATFORM_LOG_FILE%" echo bun install failed with code %ERRORLEVEL%
echo.
echo Failed to install dependencies.
echo Check "%RP_PLATFORM_LOG_FILE%"
pause

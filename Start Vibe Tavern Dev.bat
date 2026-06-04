@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LOG_LEVEL=debug"

echo Starting Vibe Tavern in dev mode...
echo LOG_LEVEL=debug
echo.

call "%~dp0Start Vibe Tavern.bat"

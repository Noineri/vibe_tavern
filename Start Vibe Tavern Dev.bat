@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LOG_LEVEL=debug"

rem Dev/playtest server runs on a dedicated port (8788) so it never collides
rem with — and can't be killed by — another instance on the default 8787
rem (e.g. an agent launching its own test server).
set "RP_PLATFORM_PORT=8788"

echo Starting Vibe Tavern in dev mode...
echo LOG_LEVEL=debug
echo Port: %RP_PLATFORM_PORT%
echo.

call "%~dp0Start Vibe Tavern.bat"

@echo off
rem ─────────────────────────────────────────────────────────────────────
rem  Theme Tuner launcher.
rem  Starts the Vite dev server (frontend only — no backend needed for the
rem  tuner) and opens the browser at the #theme-tuner hash. Double-click to
rem  use; close the "Theme Tuner — dev server" window to stop the server.
rem
rem  Port is 4173 (apps/web/vite.config.ts -> server.port).
rem ─────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

echo Starting Vibe Tavern dev server (this takes a few seconds)...
title Theme Tuner - dev server

rem Launch dev:web in its own window so it keeps running after this script exits.
start "Theme Tuner - dev server" cmd /k "bun run dev:web"

rem Give Vite time to boot before opening the browser.
timeout /t 5 /nobreak >nul

echo Opening browser at http://localhost:4173/#theme-tuner
start "" http://localhost:4173/#theme-tuner

endlocal

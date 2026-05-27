# Packaging Vibe Tavern — Standalone Windows Build

## Overview

Vibe Tavern can be packaged as a standalone Windows application: a single executable (`vibe-tavern.exe`) paired with a pre-built frontend (`web/`), wrapped in an Inno Setup installer. The installer places program files in the user's chosen directory (e.g., `Program Files`), while all user data lives in `%LOCALAPPDATA%\ClawTavern` and survives reinstall/upgrade.

## Quick Start

```bash
# 1. Build the standalone distribution
bun scripts/build-standalone.ts

# 2. Test the executable
./dist/vibe-tavern.exe

# 3. Build the installer (requires Inno Setup 6+)
bun scripts/build-installer.ts
```

## Build Commands

| Command | What it does | Output |
|---------|-------------|--------|
| `bun run build:standalone` | Builds frontend + compiles standalone exe | `dist/vibe-tavern.exe` + `dist/web/` |
| `bun run build:installer` | Runs standalone build + Inno Setup | `installer/output/vibe-tavern-setup.exe` |
| `bun run build:prod` | Builds API stack packages (no exe) | Per-package `dist/` directories |

> **Note:** The standalone build pipeline compiles the frontend internally via `bun x vite build apps/web`. There is no separate `build:web` root script — the standalone pipeline handles it.

## Output Structure

After `bun run build:standalone`:

```
dist/
  vibe-tavern.exe          ← compiled standalone server
  web/
    index.html             ← frontend entry
    assets/                ← JS/CSS bundles
    fonts/                 ← web fonts
```

After `bun run build:installer`:

```
installer/
  vibe-tavern.iss          ← Inno Setup script
  output/
    vibe-tavern-setup.exe  ← distributable installer
```

## Data Directory Conventions

The standalone executable resolves data directories from OS conventions. No data is written to the installation directory.

| Data | Location |
|------|----------|
| SQLite database | `%LOCALAPPDATA%\ClawTavern\vibe-tavern.db` |
| Avatar/image assets | `%LOCALAPPDATA%\ClawTavern\assets\` |
| Prompt traces | `%LOCALAPPDATA%\ClawTavern\traces\` |
| Debug logs | `%LOCALAPPDATA%\ClawTavern\logs\send-debug.log` |

### OS-specific defaults

| OS | Data directory |
|----|---------------|
| Windows | `%LOCALAPPDATA%\ClawTavern` (or `C:\Users\<user>\AppData\Local\ClawTavern`) |
| macOS | `~/Library/Application Support/ClawTavern` |
| Linux | `~/.local/share/vibe-tavern` (respects `$XDG_DATA_HOME`) |

## Environment Variable Overrides

All paths can be overridden via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `RP_PLATFORM_DATA_DIR` | OS convention (see above) | Root directory for all user data |
| `RP_PLATFORM_WEB_DIR` | `web/` next to executable | Frontend static files directory |
| `RP_PLATFORM_HOST` | `127.0.0.1` | Listen host |
| `RP_PLATFORM_PORT` | `8787` | Listen port |
| `RP_PLATFORM_OPEN_BROWSER` | `1` | Set to `0` to suppress auto-open |

## Inno Setup Installer

### Prerequisites

- [Inno Setup 6+](https://jrsoftware.org/isinfo.php) installed
- ISCC.exe on PATH, or set `ISCC_PATH` environment variable

### Building

```bash
bun run build:installer
```

### What the installer does

1. Installs `vibe-tavern.exe` and `web/` to user-chosen directory
2. Creates desktop shortcut (optional, checked by default)
3. Creates Start Menu entry
4. Offers to launch the app after installation

### What the installer does NOT do

- Does NOT create or modify files in `%LOCALAPPDATA%` — data is created by the app on first run
- Does NOT delete user data on uninstall — `%LOCALAPPDATA%\ClawTavern` is preserved
- Does NOT install system services, drivers, or registry keys beyond uninstaller registration

### Customizing the installer

Edit `installer/vibe-tavern.iss` to change:
- `AppVersion` — update for each release
- `AppPublisher` — your organization name
- `SetupIconFile` — path to an `.ico` file for the installer and app icon
- `AppId` — unique GUID (change only if creating a distinct product)

## Architecture

### Standalone vs Dev vs Prod

| Mode | Entry point | Data paths | Frontend |
|------|------------|-----------|----------|
| Dev | `dev-supervisor.ts` | Source tree (`import.meta.dir`) | Vite dev server |
| Prod | `prod-server.ts` | Source tree (`import.meta.dir` + env vars) | Built `apps/web/dist/` |
| Standalone | `standalone-server.ts` | OS convention (`%LOCALAPPDATA%`) | `web/` next to exe |

All three modes share the same DI wiring, services, and app factory. The only difference is how directories are resolved at startup.

### Path resolution flow

```
standalone-server.ts
  → resolveStandalonePaths()     // resolves all dirs from env/OS
    → createRuntimeStore(dataDir) // creates DB in data dir
    → SessionRuntime({ dataDir }) // passes to file store + prompt service
    → configureLogDir(logsDir)    // sets debug log path
    → AssetService(assetsDir)     // sets avatar path
    → createApp({ staticDir })    // serves frontend from webDir
```

## Troubleshooting

### `bun build --compile` fails

- Ensure all dependencies are installed: `bun install`
- Check for native `.node` modules — `bun:sqlite` is built-in and works, but third-party native modules may not
- Run `bun build services/api/src/standalone-server.ts --outfile test.exe --compile` directly to see detailed errors

### Exe starts but frontend not found

- Ensure `web/` directory exists next to `vibe-tavern.exe`
- Check `RP_PLATFORM_WEB_DIR` env var if overriding
- The server prints `[standalone] Frontend not found` if `index.html` is missing

### Database not created

- Check that the data directory is writable
- On Windows: ensure `%LOCALAPPDATA%` resolves correctly (run `echo %LOCALAPPDATA%` in cmd)
- Set `RP_PLATFORM_DATA_DIR` to a known writable path for testing

### Port already in use

- Set `RP_PLATFORM_PORT` to a different port
- Or kill the existing process: `netstat -ano | findstr :8787`

### Inno Setup not found

- Install from https://jrsoftware.org/isinfo.php
- Or set `ISCC_PATH` to the full path of `ISCC.exe`
- Default search paths: `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`

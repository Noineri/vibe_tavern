# Packaging Vibe Tavern — Standalone Windows Build

## Overview

Vibe Tavern can be packaged as a standalone Windows application: a single executable (`vibe-tavern.exe`) paired with a pre-built frontend (`web/`), runtime assets (tokenizers, migrations, prompt), and wrapped in an Inno Setup installer. The installer places program files in the user's chosen directory (e.g., `Program Files`), while all user data lives in `%LOCALAPPDATA%\VibeTavern` and survives reinstall/upgrade.

## Quick Start

```bash
# 1. Build the standalone distribution
bun run build:standalone

# 2. Test the executable
./out/standalone/vibe-tavern.exe

# 3. Build the installer (requires Inno Setup 6+)
bun run build:installer
```

## Build Commands

| Command | What it does | Output |
|---------|-------------|--------|
| `bun scripts/build.ts prod` | Builds all packages + frontend into `out/` | `out/services/api/`, `out/apps/web/` |
| `bun run build:standalone` | Builds frontend + compiles standalone exe + copies assets | `out/standalone/vibe-tavern.exe` + `out/standalone/web/` + assets |
| `bun run build:installer` | Runs standalone build + Inno Setup | `installer/output/vibe-tavern-setup.exe` |

## Output Structure

### Production bundle (`bun scripts/build.ts prod`)

```
out/
  services/api/
    prod-server.js           ← production entry point
    index.js                  ← API barrel
    script-ai-prompt.md       ← copied from services/api/assets/
    tokenizers/
      claude.json
      llama3.json
      mistral.json
      nemo.json
      qwen2.json
      deepseek.json
      mimo.json
      glm-4.6.json
      command-r.json
      command-a.json
    drizzle/                  ← DB migrations
      meta/_journal.json
      0000_*.sql ... 0012_*.sql
  apps/web/
    index.html                ← frontend entry
    assets/                   ← JS/CSS bundles
```

### Standalone build (`bun run build:standalone`)

```
out/standalone/
  vibe-tavern.exe             ← compiled standalone server
  web/
    index.html                ← frontend entry
    assets/                   ← JS/CSS bundles
  tokenizers/
    claude.json
    llama3.json
    mistral.json
    nemo.json
    qwen2.json
    deepseek.json
    mimo.json
    glm-4.6.json
    command-r.json
    command-a.json
  drizzle/                    ← DB migrations
  script-ai-prompt.md         ← Script AI system prompt
```

### Installer build (`bun run build:installer`)

```
installer/
  vibe-tavern.iss             ← Inno Setup script
  output/
    vibe-tavern-setup.exe     ← distributable installer
```

## Data Directory Conventions

The standalone executable resolves data directories from OS conventions. No data is written to the installation directory.

| Data | Location |
|------|----------|
| SQLite database | `%LOCALAPPDATA%\VibeTavern\vibe-tavern.db` |
| Avatar/image assets | `%LOCALAPPDATA%\VibeTavern\assets\` |
| Prompt traces | `%LOCALAPPDATA%\VibeTavern\traces\` |
| Debug logs | `%LOCALAPPDATA%\VibeTavern\logs\send-debug.log` |

### OS-specific defaults

| OS | Data directory |
|----|---------------|
| Windows | `%LOCALAPPDATA%\VibeTavern` (or `C:\Users\<user>\AppData\Local\VibeTavern`) |
| macOS | `~/Library/Application Support/VibeTavern` |
| Linux | `~/.local/share/vibe-tavern` (respects `$XDG_DATA_HOME`) |

## Environment Variable Overrides

All paths can be overridden via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `VIBE_TAVERN_DB_PATH` | `{dataDir}/vibe-tavern.db` | SQLite database file path |
| `RP_PLATFORM_DATA_DIR` | OS convention (see above) | Root directory for all user data |
| `RP_PLATFORM_ROOT_DIR` | `process.cwd()` | Root directory for resolving relative paths |
| `RP_PLATFORM_WEB_DIR` | `web/` next to executable | Frontend static files directory |
| `RP_PLATFORM_HOST` | `127.0.0.1` | Listen host |
| `RP_PLATFORM_PORT` | `8787` | Listen port |
| `RP_PLATFORM_OPEN_BROWSER` | `1` | Set to `0` to suppress auto-open |

## Mobile/LAN Access in Standalone Builds

By default the standalone app listens on `127.0.0.1`, which is only reachable from the same machine. To use **Mobile Access** from another device on the LAN or through Tailscale/VPN, run the server on a reachable host, for example:

```powershell
$env:RP_PLATFORM_HOST = "0.0.0.0"
$env:RP_PLATFORM_PORT = "8787"
.\vibe-tavern.exe
```

Then open **Mobile Access** in the web UI and scan/copy one of the generated `http(s)://IP:PORT/#token=...` URLs.

Security behavior:

- Local loopback access (`127.0.0.1`/`::1`) bypasses mobile auth.
- Remote `/api/*` access is fail-closed: if no token exists, remote requests return 401.
- Generated QR/copy URLs include the current token in the hash; the browser stores it locally and sends it via `Authorization: Bearer` on API requests.
- Regenerate/revoke takes effect immediately without restarting the executable.
- `GET`/`HEAD /api/assets/*` are public for image rendering; uploads and API mutations require auth.

If the page loads but mobile requests fail, check that the OS firewall allows inbound TCP traffic on `RP_PLATFORM_PORT` and that the phone can reach the selected LAN/Tailscale IP.

## Inno Setup Installer

### Prerequisites

- [Inno Setup 6+](https://jrsoftware.org/isinfo.php) installed
- ISCC.exe on PATH, or set `ISCC_PATH` environment variable

### Building

```bash
bun run build:installer
```

### What the installer does

1. Installs `vibe-tavern.exe`, `web/`, `tokenizers/`, `drizzle/`, and `script-ai-prompt.md` to user-chosen directory
2. Creates desktop shortcut (optional, checked by default)
3. Creates Start Menu entry
4. Offers to launch the app after installation

### What the installer does NOT do

- Does NOT create or modify files in `%LOCALAPPDATA%` — data is created by the app on first run
- Does NOT delete user data on uninstall — `%LOCALAPPDATA%\VibeTavern` is preserved
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
| Dev | `services/api/src/server/prod-server.ts` (via `bun run dev`) | `data/` relative to project root | Vite dev server |
| Prod | `out/services/api/prod-server.js` | `data/` + env vars | `out/apps/web/` |
| Standalone | `out/standalone/vibe-tavern.exe` | OS convention (`%LOCALAPPDATA%\VibeTavern`) | `web/` next to exe |

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

### Startup checks

All server modes run `runStartupFileChecks()` before bootstrapping services. This verifies the existence and readability of:

- Data directory + asset subdirectory
- Database file (or confirms it will be created)
- Migrations directory + journal + SQL files
- Tokenizer files (`claude.json`, `llama3.json`, `mistral.json`, `nemo.json`, `qwen2.json`, `deepseek.json`, `mimo.json`, `glm-4.6.json`, `command-r.json`, `command-a.json`)
- Script AI prompt (`script-ai-prompt.md`)
- Web bundle + `index.html` (if applicable)

If any required file is missing, the server exits with a clear error message indicating which file and resolved path.

## Troubleshooting

### `bun build --compile` fails

- Ensure all dependencies are installed: `bun install`
- Check for native `.node` modules — `bun:sqlite` is built-in and works, but third-party native modules may not
- Run `bun build services/api/src/server/standalone-server.ts --outfile test.exe --compile` directly to see detailed errors

### Exe starts but frontend not found

- Ensure `web/` directory exists next to `vibe-tavern.exe`
- Check `RP_PLATFORM_WEB_DIR` env var if overriding
- The server prints `[startup-check] ⚠️ web bundle: missing` if `index.html` is not found

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

### Migration errors on startup

- Check `[startup-check]` lines in the console output — they show the resolved migrations path and file count
- Ensure `drizzle/` directory with SQL files exists next to the executable (standalone) or in `out/services/api/drizzle/` (prod)
- The startup check logs the exact path it's looking for

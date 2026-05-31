# Android Setup Guide

Vibe Tavern runs locally on Android through Termux + proot Ubuntu. The APK orchestrates everything — you don't need to type commands manually.

## Requirements

- **Android device** with ARM64 processor
- **Termux** installed from [F-Droid](https://f-droid.org/packages/com.termux/) (NOT the Play Store version — it's broken)
- ~500MB free space for the Ubuntu container + Vibe Tavern

## Install

1. Download the Vibe Tavern APK from [Releases](https://github.com/Noineri/vibe_tavern/releases) and install it.
2. Open the app. If Termux is not installed, it will guide you to F-Droid.
3. Grant the Android permission: **"Run commands in Termux environment"** — the app will prompt you.
4. Tap **📦 Install / Update**.

The APK will:
- Copy the bundled Vibe Tavern build to your device
- Install Termux packages (curl, tar, proot-distro, procps)
- Set up a proot Ubuntu container
- Unpack Vibe Tavern into `~/vibe-tavern/` inside Ubuntu
- Start the server

This takes a minute or two. You'll see progress in a Termux window.

## Start the Server

Tap **🚀 Start Server** in the APK. It opens a visible Termux session with a 6-step diagnostic log, then launches the server.

Once running, tap **🌐 Open in Browser** — it opens `http://127.0.0.1:8787` in your phone's browser.

> **Tip:** Keep Termux open while using Vibe Tavern. If you swipe it away, the server stops.

## Stop the Server

Tap **⏹ Stop Server** in the APK. Or use the notification "Server is running — tap to open" → "Stop Server".

## Update

Tap **🔄 Update Program** (same button, relabels after first install). It reinstalls the bundled build over the existing one. Your data (chats, characters, settings) is preserved — it lives in a separate directory.

## Uninstall

Two options in the APK:

- **Delete Vibe Tavern** — removes program files, chats, settings. Keeps the Ubuntu container in case you want to reinstall.
- **Delete everything** — removes the entire Ubuntu proot container.

## Troubleshooting

### Start does nothing
- Check the Termux session for error messages.
- Make sure Termux is from F-Droid, not Play Store.
- Make sure you granted **"Run commands in Termux environment"** permission.
- In Termux, check that `~/.termux/termux.properties` contains `allow-external-apps=true`. The installer tries to set this automatically, but some Android versions block it.

### Web UI lags or freezes
- Disable battery optimization for Termux in Android settings.
- Keep Termux in the recent apps list (don't swipe it away).
- Disable aggressive battery saver modes if your phone has them.

### Browser doesn't open
- Open manually: go to `http://127.0.0.1:8787` in any browser.

### "proot-distro not found" error
- You need to install first. Tap **📦 Install / Update**.

## How It Works

The APK is a **server orchestrator**, not a web client. It:

1. Manages a proot Ubuntu container inside Termux
2. Runs the Vibe Tavern ARM64 binary inside that container
3. Opens your phone's browser at `http://127.0.0.1:8787`

No WebView, no in-app rendering. The browser handles everything — keyboard, scrolling, rendering. This is intentional: the native browser is faster and more reliable than any embedded WebView.

The bundled Vibe Tavern build is a pre-compiled ARM64 binary with embedded frontend. No `git clone`, no `bun install`, no build steps on device.

### File Locations (inside proot Ubuntu)

| Path | Contents |
|------|----------|
| `~/vibe-tavern/` | Program files (binary, web assets, migrations) |
| `~/.local/share/vibe-tavern/` | User data (database, summaries, assets) |
| `~/start-vibe-tavern.sh` | Start script with environment variables |

### Logs

| Log | Location (in Termux home) |
|-----|---------------------------|
| Install log | `~/vibe-tavern-install.log` |
| Start log | `~/vibe-tavern-start.log` |
| Stop log | `~/vibe-tavern-stop.log` |
| Uninstall log | `~/vibe-tavern-uninstall.log` |

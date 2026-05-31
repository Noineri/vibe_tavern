# Android Setup Guide

Vibe Tavern runs locally on Android through Termux + proot Ubuntu. The APK orchestrates everything, but a few manual steps are required the first time.

## Requirements

- **Android device** with ARM64 processor
- **Termux** installed from [F-Droid](https://f-droid.org/packages/com.termux/) (**NOT** the Play Store version — it's broken and abandoned)
- ~500MB free space for the Ubuntu container + Vibe Tavern

## First-Time Setup

These steps are required **once** before the APK can work. After this, everything is one-tap.

### Step 1: Install Termux from F-Droid

1. Open [F-Droid](https://f-droid.org/packages/com.termux/) on your phone.
2. Download and install Termux.
3. Open Termux and wait for the boot message to finish.

### Step 2: Update Termux packages

Fresh Termux installs often have outdated packages that break `curl` and other tools. Run this **inside Termux**:

```
apt update && apt full-upgrade
```

Press `y` and Enter when prompted. This may take a minute.

> **Important:** If you see a "mirror not selected" warning, run `termux-change-repo` first and pick a mirror, then repeat the command above.

### Step 3: Allow external apps to run commands

The APK needs permission to execute commands in Termux. Run this **inside Termux**:

```
mkdir -p ~/.termux
echo "allow-external-apps=true" >> ~/.termux/termux.properties
termux-reload-settings
```

### Step 4: Restart Termux

Close Termux completely:
1. Type `exit` in Termux and press Enter.
2. Swipe Termux away from the recent apps list.
3. Re-open Termux from your app drawer.

This ensures the `allow-external-apps` setting takes effect.

### Step 5: Install Vibe Tavern APK

1. Download the Vibe Tavern APK from [Releases](https://github.com/Noineri/vibe_tavern/releases) and install it.
2. Open the APK.
3. If you skipped any of steps 1–4, the APK will detect the problem and tell you what's missing.
4. Grant the Android permission: **"Run commands in Termux environment"** — the app will prompt you.
5. Tap **📦 Install / Update**.

The APK will:
- Copy the bundled Vibe Tavern build to your device
- Install Termux packages (curl, tar, proot-distro, procps)
- Set up a proot Ubuntu container
- Unpack Vibe Tavern into `~/vibe-tavern/` inside Ubuntu
- Start the server

This takes 1–2 minutes. You'll see progress in a Termux window.

## Daily Use

### Start the Server

Tap **🚀 Start Server** in the APK. It opens a visible Termux session with a diagnostic log, then launches the server.

Once running, tap **🌐 Open in Browser** — it opens `http://127.0.0.1:8787` in your phone's browser.

> **Tip:** Keep Termux open while using Vibe Tavern. If you swipe it away, the server stops.

### Stop the Server

Tap **⏹ Stop Server** in the APK. Or use the notification "Server is running — tap to open" → "Stop Server".

### Update

Tap **🔄 Update Program** (same button, relabels after first install). It reinstalls the bundled build over the existing one. Your data (chats, characters, settings) is preserved — it lives in a separate directory.

### Uninstall

Two options in the APK:

- **Delete Vibe Tavern** — removes program files, chats, settings. Keeps the Ubuntu container in case you want to reinstall.
- **Delete everything** — removes the entire Ubuntu proot container.

## Troubleshooting

### "CANNOT LINK EXECUTABLE curl" / SSL errors

Your Termux packages are outdated. Open Termux and run:

```
apt update && apt full-upgrade
```

Then restart Termux (exit, swipe away, reopen) and try again.

### APK buttons do nothing

Check these in order:

1. **Is Termux from F-Droid?** The Play Store version is broken. Uninstall it and install from [F-Droid](https://f-droid.org/packages/com.termux/) instead.
2. **Did you allow external apps?** Open Termux and run:
   ```
   mkdir -p ~/.termux
   echo "allow-external-apps=true" >> ~/.termux/termux.properties
   termux-reload-settings
   ```
   Then **restart Termux completely** (exit → swipe away → reopen).
3. **Did you grant the permission?** The APK prompts for "Run commands in Termux environment". Check Android Settings → Apps → Vibe Tavern → Permissions.
4. **Did you update packages?** Run `apt update && apt full-upgrade` in Termux.

### Install script shows "No mirror selected"

Open Termux and run:

```
termux-change-repo
```

Pick a mirror (the default usually works), then retry the install from the APK.

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

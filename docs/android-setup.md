# Android Setup Guide

Vibe Tavern runs locally on ARM64 Android devices through Termux and proot Ubuntu.

The APK installs and controls the local server, while the Vibe Tavern interface opens in the phone's normal browser.

## Requirements

- an ARM64 Android device;
- Termux from [F-Droid](https://f-droid.org/packages/com.termux/), not the abandoned Play Store build;
- roughly 500 MB of free space for Ubuntu and Vibe Tavern;
- permission to install an APK downloaded from GitHub Releases.

## First-time setup

### 1. Install and prepare Termux

Install Termux from F-Droid, open it, and wait until the initial shell prompt appears.

You do not need to update packages manually during normal setup; the Vibe Tavern installer performs a noninteractive package update with retries before installing its required tools.

### 2. Allow Vibe Tavern to run Termux commands

Run inside Termux:

```sh
mkdir -p ~/.termux
printf '%s\n' \
  'allow-external-apps=true' \
  >> ~/.termux/termux.properties
termux-reload-settings
```

Then type `exit`, swipe Termux away from recent apps, reopen it, and wait for the shell prompt so the setting takes effect before you return to Vibe Tavern.

### 3. Handle the one-time signing transition if necessary

If an old pre-release or debug-signed Vibe Tavern launcher is installed, Android cannot update it to the permanently signed official build.

Uninstall only the old Android launcher once, then install the first official APK from GitHub Releases.

Do not use **Delete Vibe Tavern** or **Delete everything** for this signing transition because those actions intentionally remove server data.

Removing only the Android launcher leaves data stored inside Termux intact.

All later official APKs use the same package and signing key and update in place.

### 4. Install the official APK

Download the exact `Vibe-Tavern-vX.Y.Z-android.apk` asset from [GitHub Releases](https://github.com/Noineri/vibe_tavern/releases), install it, and open Vibe Tavern.

Grant **Run commands in Termux environment** when Android requests it.

If Android hides that permission behind restricted settings, use the launcher's settings button, choose **Allow restricted settings** from the app-settings menu, enable **Run commands in Termux environment** under all permissions, then return and tap **Continue**.

If the launcher reports that Termux or its permission is missing, use the shown setup/settings action and return to the launcher afterward.

### 5. Install the bundled server

Tap **Install server vX.Y.Z**.

The launcher opens a visible Termux session that:

- updates required Termux packages noninteractively while keeping local configuration files;
- installs `curl`, `tar`, `proot-distro`, and `procps`;
- creates or reuses the pinned Ubuntu 24.04 container;
- streams the bundled archive through a temporary localhost foreground service, without storage permission or a Downloads copy;
- validates and extracts the ARM64 server bundled in the APK;
- installs program files into `~/vibe-tavern` inside Ubuntu;
- keeps user data in `~/.local/share/vibe-tavern`;
- starts the server.

Initial Ubuntu setup can take several minutes depending on the device and network.

The temporary **Preparing the bundled server for Termux** notification disappears after Termux receives the archive.

## Daily use

Tap **Start Server in Termux** to open a visible diagnostic session and launch the local server.

Tap **Open in Browser** to open `http://127.0.0.1:8787`.

Keep Termux running while using Vibe Tavern because force-closing or swiping it away can stop the server.

Tap **Stop Server** to stop the exact Vibe Tavern process.

## Updating the launcher and server

Launcher and server updates are two explicit steps.

### Launcher APK update

The launcher checks the latest public stable GitHub Release once per process, and **Check for launcher update** performs a manual check.

No GitHub token is required.

Automatic checks never download anything.

When an update is available:

1. review the version and release notes;
2. choose **Download APK** to give consent;
3. wait for Android `DownloadManager` to finish;
4. if prompted, allow Vibe Tavern to install unknown apps in Android settings;
5. confirm the update in Android's system installer;
6. reopen Vibe Tavern after installation.

Cancelling the offer or Android installer leaves the currently installed launcher working.

The launcher reconnects to an in-progress download after reopening instead of downloading a duplicate.

### Bundled server update

Installing a newer APK does not silently replace the running server payload.

After reopening the new launcher, it shows **Update server to vX.Y.Z** when the installed server version is older or unknown.

Tap that action explicitly and wait for the visible Termux installation to complete.

The update replaces only `~/vibe-tavern`; chats, characters, settings, summaries, and assets remain under `~/.local/share/vibe-tavern`.

After completion, start or open Vibe Tavern and confirm that launcher and server versions match.

## Uninstall options

**Delete Vibe Tavern** removes program files and all Vibe Tavern user data while retaining the Ubuntu container.

**Delete everything** removes the entire proot Ubuntu container, including Vibe Tavern data.

Uninstalling only the Android APK through Android settings does not run either destructive cleanup action.

## Troubleshooting

### `CANNOT LINK EXECUTABLE curl` or SSL errors

Update Termux packages with `apt update && apt full-upgrade`, then fully restart Termux and retry.

### The launcher buttons do nothing

Verify that Termux came from F-Droid, `allow-external-apps=true` is present, Termux was restarted, and Android granted **Run commands in Termux environment** to Vibe Tavern.

If Termux was force-stopped, open it once, wait for the shell prompt, return to Vibe Tavern, and retry the action.

### The installer reports no mirror, a repository hash mismatch, or a mirror sync error

Run `termux-change-repo` in Termux, choose a different mirror, then retry **Install server** or **Update server**.

### The installer reports that the `ubuntu` container is not installed

Return to Vibe Tavern and retry the installation with the current launcher; it checks exact container names and installs the pinned Ubuntu 24.04 image when `ubuntu` is absent.

### The bundled archive transfer is interrupted

Return to Vibe Tavern and retry **Install server** or **Update server**. The archive is streamed privately over `127.0.0.1`; Termux storage permission and a file in Downloads are not required.

### Android refuses the launcher update

For the first official permanently signed release, remove an older debug-signed launcher once and install the official APK manually.

For later releases, confirm that the downloaded asset is the exact Android APK from the official GitHub Release and that Android allows Vibe Tavern to install unknown apps.

### A download was interrupted

Reopen Vibe Tavern; it reconciles the persisted `DownloadManager` job and offers installation when the APK is ready.

### The server update fails

Read or copy the visible Termux diagnostics and check `~/vibe-tavern-install.log` in the Termux home directory.

A failed validation stops before the atomic program-directory swap, leaving the previous installed program and separate user data intact.

### The browser does not open

Open `http://127.0.0.1:8787` manually in any browser after the server starts.

### The web UI lags or stops

Disable battery optimization for Termux, keep its session in recent apps, and disable aggressive vendor battery-saving modes.

## Architecture and file locations

The APK is a server orchestrator rather than a WebView client.

It runs the precompiled ARM64 server in proot Ubuntu and delegates UI rendering, keyboard behavior, downloads, and cookies to the system browser.

No `git clone`, `bun install`, or source build runs on the device.

During installation, a temporary foreground service streams the bundled archive to Termux over `127.0.0.1` and stops after a successful transfer; the archive is not staged in shared storage.

| Path inside proot Ubuntu | Contents |
|---|---|
| `~/vibe-tavern/` | Replaceable program files: server binary, web assets, migrations, prompts, and tokenizers |
| `~/.local/share/vibe-tavern/` | Persistent user data: database, characters, chats, summaries, settings, and assets |
| `~/start-vibe-tavern.sh` | Generated server start script |

| Log in Termux home | Purpose |
|---|---|
| `~/vibe-tavern-install.log` | Server installation and payload updates |
| `~/vibe-tavern-start.log` | Server startup diagnostics |
| `~/vibe-tavern-stop.log` | Stop diagnostics |
| `~/vibe-tavern-uninstall.log` | Destructive cleanup diagnostics |

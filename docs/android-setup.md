# Android Setup Guide

Vibe Tavern for Android is one native ARM64 launcher APK for Android 10 and later. It runs the server locally on your phone and opens the Vibe Tavern interface in your normal system browser; it is not a WebView app and does not require Termux for a clean installation.

## Before you install

- Use an ARM64 phone or tablet running Android 10 or later.
- Download the Android APK from [GitHub Releases](https://github.com/Noineri/vibe_tavern/releases).
- Keep enough free device storage for the APK to extract its bundled server files and for your chats and media.
- Back up or export data you cannot lose before uninstalling the native launcher: its chats, settings, provider keys, and assets are private app data and Android removes them when the app is uninstalled.

## Install and first run

1. Download the `Vibe-Tavern-vX.Y.Z-android.apk` asset from GitHub Releases and open it.
2. If Android blocks the install, allow installs from the app you used to download or open the APK, then return to the installer and confirm it.
3. Open Vibe Tavern after installation. On first run, the launcher extracts its bundled server payload into private app storage; this can take a little while.
4. Grant notification permission if Android asks. The launcher uses a visible foreground-service notification while the local server is running.
5. Tap **Start Server** and wait for the launcher to report that the server is ready.
6. Tap **Open in Browser**. This is a separate action and opens `http://127.0.0.1:8787` in your system browser.

The start button changes to **Stop Server** while Vibe Tavern owns the running server. Stop it there or with the notification action. The browser interface is separate from the launcher, so your browser keeps its usual keyboard, downloads, cookies, and rendering behavior.

## Keeping the server responsive

The launcher offers Android's battery-optimization exemption when you first start the server. Allow it if your device offers the option, especially if the browser UI slows down after you switch apps.

For reliable background use:

- set Vibe Tavern's battery use to **Unrestricted** or disable battery optimization in Android settings when your phone provides that control;
- keep the Vibe Tavern launcher in your recent-apps list while using the browser UI;
- disable aggressive manufacturer battery-saver modes for Vibe Tavern.

A foreground notification helps keep the server alive, but some manufacturer power managers can still freeze background apps.

## Updating the launcher

The launcher checks the latest stable GitHub Release and also provides **Check for launcher update**. It never downloads an APK without your approval.

When an update is available:

1. review the offered version and notes;
2. choose **Download APK**;
3. wait for the Android download to finish;
4. if Android requests it, allow Vibe Tavern to install unknown apps in its app settings;
5. confirm replacement in Android's system installer;
6. reopen Vibe Tavern so it can extract the matching bundled server payload if necessary.

Official releases keep package ID `com.vibetavern.launcher` and the permanent release signing identity, so they install over the existing official launcher and retain native app-private data. An old launcher built with a different historical/debug signing key cannot update in place; uninstall that old launcher once and install the official APK. Export any native data first if it matters to you.

## Migrating from the old launcher only

This section is only for people who previously used the old Termux-based launcher. Clean native installs never need Termux and should skip this section.

The migration panel appears only when the launcher recognizes the old installation marker and no native database is present. It does not read from or write to the old installation itself.

1. Stop the old server first, so it does not keep port 8787 occupied.
2. In Termux, run `termux-setup-storage` and grant storage access if Android asks.
3. In the old Ubuntu guest, run the exact command shown by the launcher:

```sh
proot-distro login ubuntu -- bash -lc 'set -eu; test -f "$HOME/.local/share/vibe-tavern/vibe-tavern.db"; tar -czf /sdcard/Download/vt-migration.tar.gz -C "$HOME/.local/share" vibe-tavern'
```

4. Return to Vibe Tavern, choose the archive from Android's document picker, and start the import.

The old installation remains untouched. The launcher validates the archive and extracts it to private staging before replacing native data, retains a backup until the new server passes its API health check, and restores the previous native data if activation fails. **Start fresh instead** dismisses migration and leaves the old installation untouched; after a successful import, remove the old installation only when you are satisfied that the migrated data is present.

## Troubleshooting

### Port 8787 is already in use

If the launcher says another server is ready on port 8787, it will not stop that process. This is commonly an old server left running during an upgrade. Stop the old server, then return to the launcher and tap **Start Server** again.

### The server does not become ready

Wait for bundled-file extraction to finish, then copy the server log with **Copy server log** and inspect its last lines. **Open in Browser** only works after the local API reports ready; a browser response alone is not enough. Try starting again after addressing the reported error.

### The browser UI lags, hangs, or stops saving after switching apps

Set Vibe Tavern to **Unrestricted** battery use or disable battery optimization, keep the launcher in recents, and turn off aggressive OEM battery saving. Then stop and start the server again.

### Android will not install a launcher update

When prompted, allow Vibe Tavern to install unknown apps in Android settings, then return to the launcher. If an older launcher was signed with a different key, Android cannot replace it in place; export any needed native data, uninstall that old launcher, and install the official release APK manually.

### Migration fails

Read the error in the launcher and verify that the selected archive was made with the displayed command and contains the old `vibe-tavern` data directory. Migration validation happens before native data is replaced. If startup after activation fails, the launcher restores the prior native data; the old installation was never modified and remains available as rollback.

## Data and logs

The native launcher stores its data in Android app-private storage. The extracted payload is replaceable program material; your chats, settings, provider keys, and assets are separate private data. Removing the app through Android uninstalls that native data, so export what you need before uninstalling.

The launcher records the current server launch in `server.log`. Use **Copy server log** for support or **Clear server log** before reproducing a problem.

For developer build and updater-fixture details, see [`mobile/README.md`](../mobile/README.md). The retained historical source is documented in [`mobile/legacy-termux/README.md`](../mobile/legacy-termux/README.md).

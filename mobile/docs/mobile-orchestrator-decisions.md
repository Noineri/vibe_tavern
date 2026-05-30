# Mobile Orchestrator Decisions

This document records the implementation decisions for the Vibe Tavern Android launcher.

## Product role

The APK is a **local server orchestrator**, not a web client.

Responsibilities:

- install/update the bundled Vibe Tavern ARM64 build into Termux/proot Ubuntu;
- start the local server in a visible Termux session;
- stop the local server;
- open the system browser at `http://127.0.0.1:8787`;
- remove Vibe Tavern files or the full Ubuntu container when requested.

Non-goals:

- no WebView;
- no in-app rendering of the Vibe Tavern UI;
- no on-device source build pipeline.

## Runtime model

The Android app launches commands through Termux `RUN_COMMAND`.

The server runs inside `proot-distro` Ubuntu and listens on:

```text
RP_PLATFORM_HOST=127.0.0.1
RP_PLATFORM_PORT=8787
```

The APK opens the user-facing UI through a normal Android browser intent:

```text
Intent(ACTION_VIEW, Uri.parse("http://127.0.0.1:8787"))
```

This keeps browser behavior, cookies, downloads, keyboard handling, and mobile rendering outside the APK.

## Installation and update policy

The device must not run heavyweight development operations:

- no `bun install` on device;
- no `bun run build` on device;
- no `git clone` on device;
- no `git pull` on device.

Instead, the desktop build produces a prebuilt ARM64 archive:

```text
vibe-tavern-android-arm64.tgz
```

The APK bundles that archive as an Android asset and copies/serves it to Termux during installation.

The installed program directory is:

```text
~/vibe-tavern
```

The user data directory is separate:

```text
~/.local/share/vibe-tavern
```

This separation allows program updates without mixing binaries and user data.

## Termux requirements

Termux is an external dependency and should be installed from F-Droid.

The launcher requires Android permission:

```text
Run commands in Termux environment
```

Termux must allow external app commands through:

```text
~/.termux/termux.properties
allow-external-apps=true
```

The installer attempts to write this setting and calls `termux-reload-settings`, but users may still need to grant the Android permission manually.

## Visible start session

Starting the server opens a visible Termux session:

```text
RUN_COMMAND_BACKGROUND=false
```

This is intentional. A visible session gives users and testers a diagnostic log when startup fails.

The start script prints numbered diagnostic steps before launching the binary.

## Process handling

Never use pattern-based process matching for this launcher.

Forbidden:

```sh
pkill -f ...
pgrep -f ...
pgrep -af ...
```

Reason: pattern matching can match the parent bash command line and terminate the diagnostic script/session itself.

Use exact process-name matching only:

```sh
pkill -TERM -x 'vibe-tavern'
pkill -KILL -x 'vibe-tavern'
pgrep -ax 'vibe-tavern'
```

The start path intentionally avoids cleanup/kill logic. Cleanup is handled by the Stop button.

## Stop behavior

Stop sends exact-name termination commands both from Termux context and inside the proot Ubuntu context where needed.

After sending Stop, the APK polls `http://127.0.0.1:8787` until the server stops responding, then updates the UI state.

## Uninstall behavior

There are two uninstall modes:

1. **Delete Vibe Tavern**
   - stops the server;
   - removes `~/vibe-tavern`;
   - removes `~/.local/share/vibe-tavern`;
   - removes the generated start script;
   - keeps the Ubuntu container.

2. **Delete everything**
   - stops the server;
   - removes the full `proot-distro` Ubuntu container.

Both uninstall flows write a Termux-side log:

```text
~/vibe-tavern-uninstall.log
```

The uninstall Termux session stays open at the end with a `Press Enter to close` prompt so users can copy logs before the session closes.

## Localization

The launcher includes an in-app language selector:

- Russian;
- English.

The selected language is saved in `SharedPreferences`.

If no language was selected yet, the app defaults to Russian when the Android system language is Russian; otherwise it defaults to English.

The current localization covers the orchestrator UI, status messages, help dialog, uninstall dialog, and progress messages. Termux script logs remain primarily English for easier debugging and copy/paste support.

## Build commands

Build the Android APK from this repository:

```powershell
cd android
& 'C:\Users\user\.gradle\manual\gradle-8.9\bin\gradle.bat' assembleDebug
```

Debug APK output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

The ARM64 server artifact is built in the main Vibe Tavern repository and then copied into this repo's Android assets:

```sh
cd ../vibe_tavern
bun run build:android-arm64
```

Bundled asset path in this repository:

```text
android/app/src/main/assets/vibe-tavern-android-arm64.tgz
```

## Current accepted lifecycle

The launcher is considered successful when these operations work on device:

- install/update;
- start server;
- open browser;
- stop server;
- start again after stop;
- delete Vibe Tavern files;
- delete the full Ubuntu container;
- switch UI language.

# Mobile Orchestrator Decisions

This document records the implementation decisions for the Vibe Tavern Android launcher.

## Product role

The APK is a local-server orchestrator, not a web client.

Responsibilities:

- install or update the bundled Vibe Tavern ARM64 server inside Termux/proot Ubuntu;
- start the local server in a visible Termux session;
- stop the local server;
- open the system browser at `http://127.0.0.1:8787`;
- discover launcher updates from public GitHub Releases;
- hand approved APK updates to Android's system installer;
- remove Vibe Tavern files or the full Ubuntu container when requested.

Non-goals:

- no WebView or in-app rendering of the web UI;
- no silent APK installation;
- no automatic APK download;
- no on-device `git clone`, dependency installation, or source build.

## Runtime model

The Android app launches commands through Termux `RUN_COMMAND`.

The server runs inside `proot-distro` Ubuntu with `VIBE_TAVERN_HOST=127.0.0.1` and `VIBE_TAVERN_PORT=8787`.

The APK opens the UI with a normal Android browser intent, which keeps cookies, downloads, keyboard handling, and rendering in the user's browser.

Native Android execution remains out of scope while Bun's Android runtime is not production-ready; Termux plus proot Ubuntu is the supported runtime boundary.

## Release identity and signing

The release APK uses the permanent application ID `com.vibetavern.launcher` and a permanent signing key restored only inside GitHub Actions.

Release builds fail closed unless all four signing inputs are present:

- `ANDROID_KEYSTORE_BASE64`;
- `ANDROID_KEYSTORE_PASSWORD`;
- `ANDROID_KEY_ALIAS`;
- `ANDROID_KEY_PASSWORD`.

The keystore is reconstructed under `RUNNER_TEMP`, never committed, and the resulting APK is verified with `apksigner` before publication.

An APK signed by an old debug key cannot be updated in place to the permanent release key, so users of a pre-release debug build must uninstall that launcher once and install the first official release.

Uninstalling only the Android launcher does not remove Vibe Tavern data stored inside Termux; using the launcher's destructive Delete actions does.

All later official releases keep the same package ID and signing identity and therefore install in place.

## Launcher update policy

The launcher checks the latest public stable GitHub Release without a token.

It checks once per process and also exposes a manual **Check for launcher update** action.

An automatic check may report availability but never starts a download.

The user must approve the release dialog before `DownloadManager` is used, and Android's system installer always requires a separate confirmation.

Before installer handoff, the downloaded APK must have the expected package ID, expected version name, and a strictly higher version code.

If Android requires per-app permission to install unknown apps, the launcher opens the system settings page and resumes the pending installation after permission is granted.

Download state is persisted so process recreation reconnects to the same `DownloadManager` job instead of starting a duplicate.

Production discovery is fixed to the GitHub HTTPS endpoint; private-LAN HTTP endpoints and version overrides exist only in explicit debug builds, and release builds reject every local-test override.

## Server payload policy

Each release APK bundles the CI-built `vibe-tavern-android-arm64.tgz` archive.

The launcher passes the maintained `install.sh` asset directly to a visible Termux command and streams the archive through a temporary localhost foreground service that survives Activity backgrounding, stops after a successful transfer, and does not require shared-storage permission or a Downloads copy.

The archive contains a `version.txt` marker matching the APK release and an executable `vibe-tavern` ARM64 server.

Replacing the APK never silently applies its bundled server payload.

The launcher stores the last applied payload version separately from the launcher version and shows **Install server vX.Y.Z** or **Update server to vX.Y.Z** when explicit application is required.

The program directory is `~/vibe-tavern` inside proot Ubuntu.

The user data directory is `~/.local/share/vibe-tavern` and remains outside the program swap.

Installation extracts into `~/vibe-tavern.next`, validates the archive, version marker, and server binary, stops only the exact server process, then swaps program directories.

This preserves chats, characters, settings, summaries, and assets across server updates.

## Termux requirements

Termux is an external dependency and must be installed from F-Droid rather than the abandoned Play Store build.

The launcher requires Android's **Run commands in Termux environment** permission.

Termux must allow external app commands through `allow-external-apps=true` in `~/.termux/termux.properties`.

The installer preserves this setting and calls `termux-reload-settings`, but a first-time user must still set it before the launcher can issue its first command, grant Android permission, and restart Termux manually when required by the installed Termux/Android combination.

## Visible start session and process handling

Starting the server uses `RUN_COMMAND_BACKGROUND=false` so failures remain visible and copyable in Termux.

Never use `pkill -f`, `pgrep -f`, or `pgrep -af` in launcher lifecycle code because pattern matching can terminate the parent diagnostic shell.

Use exact process-name matching such as `pkill -TERM -x 'vibe-tavern'`, `pkill -KILL -x 'vibe-tavern'`, and `pgrep -ax 'vibe-tavern'`.

The start path does not perform cleanup; cleanup belongs to the Stop action.

Stop sends exact-name termination commands in the required Termux and proot contexts, then polls `http://127.0.0.1:8787` until the server is unavailable.

## Uninstall behavior

**Delete Vibe Tavern** stops the server and removes program files, user data, and the generated start script while retaining the Ubuntu container.

**Delete everything** stops the server and removes the full proot Ubuntu container.

Both flows write `~/vibe-tavern-uninstall.log` and keep the Termux session visible long enough to copy diagnostics.

## Localization and identity

The launcher provides English and Russian UI selected through an in-app language control and persisted in `SharedPreferences`.

The initial language follows the Android system language, defaulting to English outside Russian locales.

Active setup, lifecycle, update, help, and uninstall states are bilingual; Termux diagnostics remain primarily English for support and copy/paste.

The launcher and adaptive icon use the canonical book-and-stars mark, coffee palette, Alegreya headings, and Inter controls generated from the web application's source assets.

## Build and verification

Build the ARM64 payload from the repository root:

```sh
bun run build:android-arm64
```

For a local APK build, copy `out/vibe-tavern-android-arm64.tar.gz` to `mobile/android/app/src/main/assets/vibe-tavern-android-arm64.tgz`, then run:

```sh
cd mobile/android
./gradlew testDebugUnitTest assembleDebug
```

On Windows, use `gradlew.bat` instead of `./gradlew`.

The tag-driven release workflow builds the ARM payload, stages it into the APK, runs Android tests, assembles the permanently signed release APK, verifies the embedded payload marker and executable mode, verifies the APK signature, renames it to `Vibe-Tavern-vX.Y.Z-android.apk`, and only then uploads it for publication.

The debug-only same-LAN harness in `mobile/android/scripts/serve-local-update.ts` exercises discovery, consent, download, unknown-source recovery, system installation, and explicit payload application without a public test release.

## Accepted lifecycle

The launcher is considered successful when a device can complete:

- fresh Termux/proot installation from the bundled archive;
- visible server start and browser opening;
- exact-name stop and restart;
- no-update and update-available launcher checks;
- explicit APK download and Android-confirmed in-place installation;
- launcher/server version mismatch display after APK replacement;
- explicit matching server payload application with existing data preserved;
- process recreation during download without duplication;
- both uninstall modes;
- English/Russian switching and canonical branding.

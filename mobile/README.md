# Vibe Tavern Mobile Launcher

The maintained Android distribution is one native ARM64 launcher APK for Android 10 and later. It runs the bundled Vibe Tavern server locally, keeps it alive through a foreground service while it is running, and opens the interface in the system browser; it does not use a WebView or require a supported parallel Termux edition.

## Documentation

- [English setup guide](../docs/android-setup.md)
- [Russian setup guide](../docs/android-setup-ru.md)
- [Mobile launcher decision history](docs/mobile-orchestrator-decisions.md)
- [Frozen Termux archive](legacy-termux/README.md)

## Repository layout

- `android/` — Gradle application, Kotlin launcher, resources, tests, and APK configuration.
- `android/app/src/main/java/com/vibetavern/launcher/ServerService.kt` — foreground-service owner for the native server child and its readiness/log lifecycle.
- `android/app/src/main/java/com/vibetavern/launcher/MainActivity.kt` — launcher controls, payload extraction, browser handoff, updater, diagnostics, battery guidance, and legacy-only migration entry.
- `android/app/src/main/java/com/vibetavern/launcher/LegacyMigration.kt` — safe import of a user-selected archive from an old launcher installation.
- `android/app/src/main/java/com/vibetavern/launcher/ReleaseUpdate.kt` and `ApkUpdateManager.kt` — GitHub Releases discovery, approved download, validation, and Android installer handoff.
- `android/scripts/serve-local-update.ts` — debug-only same-LAN APK updater fixture.
- `legacy-termux/` — frozen, unsupported archive; it is not part of a current build, test, CI, or release path.

## Generated APK inputs

Run this from the repository root before every local Gradle build:

```sh
bun run build:android-native
```

The command regenerates inputs that are deliberately never committed:

```text
mobile/android/app/src/main/jniLibs/arm64-v8a/libvibetavern.so
mobile/android/app/src/main/assets/payload/web/
mobile/android/app/src/main/assets/payload/drizzle/
mobile/android/app/src/main/assets/payload/tokenizers/
mobile/android/app/src/main/assets/payload/prompts/
```

`libvibetavern.so` is the native Android ARM64 server executable. `useLegacyPackaging` makes Gradle extract it so Android can execute it from `nativeLibraryDir`; the payload is copied from APK assets to the app's private files directory on first run or when the bundled payload version changes.

## Build, test, and debug APK

From the repository root, regenerate the native inputs, then run the Android unit tests and build a debug APK:

```sh
bun run build:android-native
cd mobile/android
./gradlew testDebugUnitTest assembleDebug
```

On Windows, use:

```powershell
bun run build:android-native
cd mobile/android
.\gradlew.bat testDebugUnitTest assembleDebug
```

The debug APK is written to:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Use the release workflow for a signed distributable APK. It runs the native-input build, Android tests, release assembly, embedded-payload checks, and APK signature verification before publishing the `Vibe-Tavern-vX.Y.Z-android.apk` release asset.

## Native runtime contract

The launcher starts `libvibetavern.so` with this frozen local contract:

- host `127.0.0.1` and port `8787`;
- app-private data at `<filesDir>/data`;
- extracted payload at `<filesDir>/payload`, including `web`, `drizzle`, `tokenizers`, and `prompts`;
- browser auto-open disabled in the server, because the launcher owns the separate system-browser action;
- `BUN_OPTIONS=--no-orphans`, `HOME=<filesDir>`, and `TMPDIR=<cacheDir>`.

The foreground service owns the child for its full lifetime: the thread that starts it remains parked on `waitFor()`. Readiness is a successful `GET /api/runtime/version`, not merely an HTTP response from the bind-first web placeholder. The current launch writes `filesDir/server.log`; the launcher can copy or clear it, and records the child exit code.

The service uses Android's `dataSync` foreground-service type. Android notification permission is requested where the platform requires it. The launcher also offers a battery-optimization exemption because a foreground service cannot prevent every OEM battery freezer; users should keep Vibe Tavern in recents and disable aggressive vendor power saving when browser requests lag after app switching.

## Launcher controls and data

The stateful server button starts or stops only the launcher-owned server. **Open in Browser** is separate and enabled after API readiness; it opens `http://127.0.0.1:8787` with Android's normal browser intent. If another server already owns port 8787, the launcher does not stop it and tells the user to stop the old server first.

Chats, settings, keys, and assets live in Android app-private data. Removing the launcher APK removes that native app data, so users must export anything they need before uninstalling. Payload extraction and APK replacement never intentionally replace `<filesDir>/data`.

## Legacy migration only

Termux is not a current runtime prerequisite or supported alternative edition. A user upgrading from the old launcher may see a one-time migration panel only when its old-launcher marker is present and no native database exists. The panel asks the user to stop the old server, run `termux-setup-storage`, and execute the displayed archive command in the old Ubuntu guest:

```sh
proot-distro login ubuntu -- bash -lc 'set -eu; test -f "$HOME/.local/share/vibe-tavern/vibe-tavern.db"; tar -czf /sdcard/Download/vt-migration.tar.gz -C "$HOME/.local/share" vibe-tavern'
```

The user selects that archive through Android's document picker. The native launcher validates and stages it before replacing native data, retains a backup until the new server passes its API health check, and restores the prior native data if activation fails. **Start fresh instead** permanently dismisses the migration panel without modifying the old installation. Clean native installations never need Termux.

## APK updates and signing continuity

The launcher checks the latest stable GitHub Release and can manually check for an update. A user must approve the download, and Android separately confirms installation. The downloaded APK is checked for the expected package ID, version name, and increasing version code before installer handoff; Android may require the per-app unknown-apps permission.

Official APKs retain package ID `com.vibetavern.launcher` and the permanent release signing identity so they update in place. A launcher signed with a different historical/debug key cannot update in place and must be uninstalled once before installing an official build. APK replacement preserves native app-private data and causes the matching bundled payload to be extracted on the next launch.

## Debug-only same-LAN updater fixture

The fixture builds matching native payloads into both the base and update debug APK, then serves GitHub-shaped release metadata and the update APK over a private LAN endpoint. It is never available to release builds.

```sh
bun mobile/android/scripts/serve-local-update.ts \
  --host 192.168.1.20 \
  --port 8791 \
  --base-version 0.0.0 \
  --update-version 0.0.1 \
  --base-code 1 \
  --update-code 2
```

Install the fixture's `/base.apk` on a same-LAN device, open Vibe Tavern, choose **Check for launcher update**, approve the download, grant the Android install permission if requested, and confirm the system installer. The fixture rebuilds the matching native payload for each APK; it has no archive-staging option.

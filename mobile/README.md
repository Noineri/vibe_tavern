# Vibe Tavern Mobile Launcher

The Android APK is a local-server orchestrator for Vibe Tavern on ARM64 phones through Termux and proot Ubuntu.

It installs and controls the bundled server, then opens `http://127.0.0.1:8787` in the system browser; it does not embed a WebView or build the application on the device.

## Documentation

- [English setup guide](../docs/android-setup.md)
- [Russian setup guide](../docs/android-setup-ru.md)
- [Mobile orchestrator decisions](docs/mobile-orchestrator-decisions.md)

## Repository layout

- `android/` — Gradle application, Kotlin launcher, resources, tests, and APK assets.
- `android/app/src/main/assets/install.sh` — the only maintained Termux/proot installer and updater.
- `android/app/src/main/assets/start.sh` — launcher-owned Termux start entry point.
- `android/scripts/serve-local-update.ts` — debug-only same-LAN updater fixture.
- `docs/` — mobile architecture and lifecycle decisions.

## Build the ARM64 payload

From the repository root:

```sh
bun run build:android-arm64
```

The build produces:

```text
out/vibe-tavern-android-arm64.tar.gz
```

For a local APK build, stage it under the asset name expected by Android:

```sh
cp out/vibe-tavern-android-arm64.tar.gz mobile/android/app/src/main/assets/vibe-tavern-android-arm64.tgz
```

The archive must contain a matching `version.txt` marker and an executable `vibe-tavern` ARM64 binary.

## Test and build a debug APK

On Linux/macOS from the repository root:

```sh
cd mobile/android
./gradlew testDebugUnitTest assembleDebug
```

On Windows:

```powershell
cd mobile/android
.\gradlew.bat testDebugUnitTest assembleDebug
```

Output:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Run root checks when root TypeScript, packaging scripts, or release workflow behavior changes:

```sh
bun run typecheck
bun run test
```

## Debug-only LAN updater harness

The local fixture serves GitHub-shaped latest-release JSON and same-key debug APKs to a device on the same private network.

Example from the repository root:

```sh
bun mobile/android/scripts/serve-local-update.ts \
  --host 192.168.1.20 \
  --port 8791 \
  --base-version 0.0.0 \
  --update-version 0.0.1 \
  --base-code 1 \
  --update-code 2
```

Add `--include-payload true` only after staging a full ARM archive whose `version.txt` exactly matches `--update-version`.

The harness passes local endpoint/version properties only to debug builds.

`preReleaseBuild` rejects every `VIBE_UPDATE_TEST_*` property, and release builds remain fixed to the public GitHub HTTPS endpoint.

## Release signing and artifact flow

Official releases are tag-driven through `.github/workflows/release.yml`.

The Android job:

1. derives `versionName` and increasing `versionCode` from the release tag;
2. restores the permanent keystore under `RUNNER_TEMP`;
3. builds the version-matched ARM64 payload;
4. stages the archive into Android assets;
5. runs Android unit tests and `assembleRelease`;
6. extracts and validates the embedded archive, payload version, and executable mode;
7. verifies the APK with `apksigner`;
8. publishes only the exact `Vibe-Tavern-vX.Y.Z-android.apk` artifact after all gates pass.

The release build requires these repository secrets:

- `ANDROID_KEYSTORE_BASE64`;
- `ANDROID_KEYSTORE_PASSWORD`;
- `ANDROID_KEY_ALIAS`;
- `ANDROID_KEY_PASSWORD`.

Never commit or print the keystore, Base64 payload, aliases, or passwords.

The Gradle release configuration has no debug-signing fallback and fails when required signing inputs are absent.

## Update model

The launcher discovers the latest public stable GitHub Release without authentication.

Automatic checks never download; the user approves `DownloadManager`, and Android's system installer separately confirms APK replacement.

The downloaded APK is accepted only when package ID, version name, and increasing version code match expectations.

APK replacement does not silently apply the bundled server archive.

The user explicitly chooses **Install server** or **Update server** after the launcher reports a payload mismatch.

Program files under `~/vibe-tavern` are swapped separately from persistent data under `~/.local/share/vibe-tavern`.

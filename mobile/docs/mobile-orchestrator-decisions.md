# Mobile Orchestrator Decisions

This document retains the Android-launcher decision history. The current policy is at the top; all Termux/proot-runtime material below the historical divider is superseded record, not a setup or support instruction.

## Current decision — native launcher addendum (2026-09-11)

The Bun-on-Android PIE approach was proven by the native Android PoC recorded in the sibling planning report `reports/MOBILE_NATIVE_PORT_RESEARCH.md`. Vibe Tavern now maintains one current Android distribution: a native ARM64 APK for Android 10 and later. There is no supported parallel Termux edition.

The native APK remains `com.vibetavern.launcher`, keeps the GitHub Releases APK updater, and retains the permanent signing identity so official releases can update in place. The system browser renders the Vibe Tavern UI; the launcher is not a WebView client.

The launcher executes the bundled Bun Android binary from `nativeLibraryDir` and extracts the bundled payload into app-private storage. Its child lifecycle is owned by a `dataSync` foreground service: the starting thread remains parked on `waitFor()`, readiness is successful `GET /api/runtime/version`, and the native process receives the frozen local host, port, data, payload, home, temporary-directory, and no-orphans environment contract. A server on port 8787 that is not the launcher's own child is reported as foreign and is never stopped automatically.

Foreground service operation and notification permission do not overcome every OEM freezer. The launcher requests battery-exemption guidance at first server start, and user guidance is to set Vibe Tavern to unrestricted battery use where available, keep it in recents, and disable aggressive manufacturer power saving if browser requests lag or freeze.

Chats, settings, keys, and assets are native app-private data. Uninstalling the native launcher removes that data, so users must export important data first. APK replacement and bundled-payload extraction do not intentionally replace it.

Termux survives only as a non-destructive, one-time migration source for an eligible user upgrading from the old launcher: the user produces an archive, the launcher validates it into staging, keeps a backup until API health succeeds, and restores native data on failure. The old installation is never written by migration; clean native installs never see or need it.

The surviving partial Termux source is frozen under [`mobile/legacy-termux/`](../legacy-termux/README.md). It is unsupported and excluded from active build, CI, test, release, and distribution paths. Commit `965da98d` is the complete buildable pre-native resurrection snapshot and will receive a permanent tag separately; future restoration must branch from that snapshot rather than revive the partial archive.

## Current release identity and APK updater

Official releases use package ID `com.vibetavern.launcher` and the permanent release signing key restored only in release CI. Release builds fail without their required signing inputs, and CI verifies the assembled APK signature before publication. A launcher signed with a different historical/debug key cannot be replaced in place; it must be uninstalled once before an official APK is installed.

The launcher checks the latest stable GitHub Release without a token and also offers a manual check. It only downloads after user consent, validates package ID, version name, and increasing version code before handoff, and Android separately confirms installation. If Android requires unknown-app permission, the launcher opens the appropriate system settings page and resumes when the user returns.

Debug builds alone may use the same-LAN update fixture. It builds matching native payloads for both base and update APKs; release builds remain fixed to the public GitHub HTTPS endpoint.

## Current native payload and lifecycle

`bun run build:android-native` generates the uncommitted ARM64 `libvibetavern.so` and the uncommitted `assets/payload/{web,drizzle,tokenizers,prompts}` tree before Gradle assembly. Gradle packages the server as extracted JNI content and packages the payload in the APK. Each APK version causes the launcher to ensure its matching payload is extracted, without replacing native data.

The native server binds locally on `127.0.0.1:8787`; **Open in Browser** uses the system browser only after API readiness. The foreground service owns start, stop, current-launch log capture, exit-code reporting, and the notification Stop action. The launcher exposes copy/clear-log controls and reports a foreign port owner rather than trying to terminate it.

## Current migration policy

A migration panel is limited to the old-launcher marker plus absent native database, and is hidden after successful migration or **Start fresh instead**. An eligible user stops the old server, uses `termux-setup-storage` if storage access is needed, creates the archive through the command shown by the launcher, and selects it with Android's document picker. The source remains untouched. Archive validation rejects unsafe content before activation; a staged import is promoted only with rollback protection and post-start API health checking.

The exact user instructions live in the [current English setup guide](../../docs/android-setup.md) and [Russian setup guide](../../docs/android-setup-ru.md). They do not claim that final release-APK migration verification on every device has already happened.

---

# Superseded historical record — Termux/proot runtime (pre-2026-09-11)

**Status:** Historical only. The following decisions describe the retired launcher runtime and must not be read as a supported installation, build, update, or troubleshooting path. The frozen archive README and the current setup guides are the only valid references for its historical relationship to the native launcher.

## Historical product role

The former APK was a local-server orchestrator rather than a web client. It installed and updated a bundled ARM64 server inside a Termux/proot Ubuntu environment, started and stopped it through Termux commands, opened `http://127.0.0.1:8787` in the system browser, offered GitHub Releases APK updates, and exposed destructive cleanup actions. It never intended to embed a WebView, install APKs silently, or build application source on the device.

## Historical runtime model

The old Android app issued Termux `RUN_COMMAND` operations and the server ran in `proot-distro` Ubuntu with a local host and port. The browser was deliberately kept separate for cookies, downloads, keyboard behavior, and rendering. This boundary was superseded when the native Bun Android executable proved viable.

## Historical release identity and signing

The former design already established the lasting release identity: package `com.vibetavern.launcher`, permanent signing inputs restored only in CI, fail-closed release signing, `apksigner` verification, and in-place updates for later official releases. It also documented that debug-signed builds needed a one-time uninstall before the permanent release key could take over. The native launcher retains these decisions.

## Historical updater policy

The earlier updater also used the latest stable public GitHub Release, required consent before `DownloadManager`, required Android installer confirmation, validated package/version identity, persisted download state, and restricted private-LAN endpoints to debug builds. Those updater decisions remain current; only the retired server-payload behavior has changed.

## Historical payload policy

The retired payload was a bundled `vibe-tavern-android-arm64.tgz` archive delivered through a temporary localhost foreground transfer service and installed into a Termux/proot program directory, with data kept separately. It performed an explicit server-payload update after APK replacement and used swap/validation logic. This entire archive/transfer/install runtime is superseded by native `.so` execution and app-private payload extraction.

## Historical Termux requirements

The old runtime required F-Droid Termux, Android permission to run external Termux commands, an `allow-external-apps` Termux setting, a restarted shell, and an Ubuntu container. None of these are requirements for the native launcher. They matter only to a legacy user producing the one-time migration archive.

## Historical visible-session and process handling

The retired launcher used a visible Termux session for diagnostics and exact process-name matching to avoid terminating its diagnostic shell. Its stop action polled the local server after sending Termux/proot commands. Native lifecycle ownership is now in `ServerService.kt`, so these details are historical only.

## Historical deletion and localization

The retired launcher offered separate Vibe Tavern and full-container deletion flows, logged their Termux diagnostics, and provided English/Russian launcher UI with the canonical visual identity. The native launcher retains bilingual launcher UI and system-browser architecture, but its native data follows Android uninstall semantics instead of the retired container cleanup model.

## Historical build and verification

The old builder used `bun run build:android-arm64`, staged a `.tgz` asset, and built the Gradle APK around it. The release workflow verified the embedded archive and executable mode, then published an Android APK. This is superseded by `bun run build:android-native`, which generates the Android PIE executable plus payload and has Gradle package those inputs directly.

## Historical accepted lifecycle

The former acceptance path covered fresh Termux/proot installation, visible-session start/stop, launcher update, explicit archive payload application, two container deletion modes, and bilingual state. It is historical evidence for the former orchestrator only. Current acceptance is defined by the native launcher plan and current Android setup guides.

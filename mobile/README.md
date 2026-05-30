# Vibe Tavern Mobile Launcher

Android launcher/orchestrator for running Vibe Tavern locally on a phone through Termux + proot-distro Ubuntu.

The APK does **not** render the web app. It controls the local server lifecycle and opens the phone browser at:

```text
http://127.0.0.1:8787
```

## Documentation

- [Mobile orchestrator decisions](docs/mobile-orchestrator-decisions.md)

## Debug build

From this repository:

```powershell
cd android
& 'C:\Users\user\.gradle\manual\gradle-8.9\bin\gradle.bat' assembleDebug
```

Output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

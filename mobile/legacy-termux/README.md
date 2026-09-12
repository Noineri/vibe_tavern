# Legacy Termux source archive

This directory is a frozen, unsupported, non-built, and non-tested archive of the surviving Termux-only Android packaging source.

- There is no current package command, Gradle, CI, release wiring, or parallel distribution for this archive.
- The maintained Android APK is native only.
- The legacy-user data migration code lives elsewhere in the active launcher and remains supported.
- Commit `965da98d` is the complete buildable pre-native resurrection snapshot; branch from that commit (or its future permanent tag) to resurrect Termux support instead of trying to execute these partial archived paths.

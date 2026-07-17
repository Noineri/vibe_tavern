package com.vibetavern.launcher

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobilePackagingTest {
    private val repoRoot: File = generateSequence(File(System.getProperty("user.dir")).canonicalFile) { it.parentFile }
        .first { File(it, "package.json").isFile }

    @Test
    fun `release APK bundles a cross-compiled ARM archive`() {
        val workflow = File(repoRoot, ".github/workflows/release.yml").readText()
        val activity = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/MainActivity.kt",
        ).readText()
        val installer = File(
            repoRoot,
            "mobile/android/app/src/main/assets/install.sh",
        ).readText()

        assertTrue(workflow.contains("bun scripts/build-android-arm64.ts"))
        assertTrue(workflow.contains("vibe-tavern-android-arm64.tgz"))
        assertTrue(activity.contains("bundledArchiveName"))
        assertTrue(activity.contains("assets.open(\"install.sh\")"))
        assertTrue(activity.contains("proot-distro login ubuntu"))
        assertTrue(installer.contains("VIBE_TAVERN_ARCHIVE_PATH"))
        assertTrue(installer.contains("VIBE_TAVERN_ARCHIVE_URL"))
        assertTrue(installer.contains("proot-distro login \"\$DISTRO\""))
        assertFalse(installer.contains("git clone"))
        assertFalse(installer.contains("bun install"))
        assertFalse(installer.contains("bun run build"))
    }
}

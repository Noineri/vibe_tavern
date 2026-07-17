package com.vibetavern.launcher

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobilePackagingTest {
    private val repoRoot = findRepoRoot(File(requireNotNull(System.getProperty("user.dir"))).canonicalFile)

    @Test
    fun `release APK bundles a cross-compiled ARM archive`() {
        val workflow = File(repoRoot, ".github/workflows/release.yml").readText()
        val gradle = File(repoRoot, "mobile/android/app/build.gradle.kts").readText()
        val armBuilder = File(repoRoot, "scripts/build-android-arm64.ts").readText()
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
        assertTrue(workflow.contains("ANDROID_KEYSTORE_BASE64"))
        assertTrue(workflow.contains("ANDROID_KEYSTORE_PASSWORD"))
        assertTrue(workflow.contains("ANDROID_KEY_ALIAS"))
        assertTrue(workflow.contains("ANDROID_KEY_PASSWORD"))
        assertTrue(workflow.contains("apksigner"))
        assertTrue(workflow.contains("testDebugUnitTest assembleRelease"))
        assertTrue(gradle.contains("create(\"release\")"))
        assertTrue(gradle.contains("ANDROID_KEYSTORE_PATH"))
        assertFalse(gradle.contains("signingConfigs.getByName(\"debug\")"))
        assertTrue(armBuilder.contains("version.txt"))
        assertTrue(activity.contains("bundledArchiveName"))
        assertTrue(activity.contains("PREF_PAYLOAD_VERSION"))
        assertTrue(activity.contains("markCurrentPayloadInstalled"))
        assertTrue(activity.contains("assets.open(\"install.sh\")"))
        assertTrue(activity.contains("proot-distro login ubuntu"))
        assertTrue(installer.contains("VIBE_TAVERN_ARCHIVE_PATH"))
        assertTrue(installer.contains("VIBE_TAVERN_ARCHIVE_URL"))
        assertTrue(installer.contains("version.txt"))
        assertTrue(installer.contains("proot-distro login \"\$DISTRO\""))
        assertFalse(installer.contains("git clone"))
        assertFalse(installer.contains("bun install"))
        assertFalse(installer.contains("bun run build"))
    }

    private fun findRepoRoot(start: File): File {
        var current: File? = start
        while (current != null) {
            if (File(current, "package.json").isFile) return current
            current = current.parentFile
        }
        error("Could not locate the Vibe Tavern repository root from $start")
    }
}

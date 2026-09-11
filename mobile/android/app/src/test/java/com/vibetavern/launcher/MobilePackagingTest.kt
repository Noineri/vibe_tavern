package com.vibetavern.launcher

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobilePackagingTest {
    private val repoRoot = findRepoRoot(File(requireNotNull(System.getProperty("user.dir"))).canonicalFile)

    @Test
    fun `release APK builds and verifies the native ARM64 payload`() {
        val workflow = File(repoRoot, ".github/workflows/release.yml").readText()
        val ciWorkflow = File(repoRoot, ".github/workflows/ci.yml").readText()
        val gradle = File(repoRoot, "mobile/android/app/build.gradle.kts").readText()

        assertTrue(workflow.contains("bun run build:android-native"))
        assertFalse(workflow.contains("bun scripts/build-android-arm64.ts"))
        assertFalse(workflow.contains("Stage tarball in Android assets"))
        assertTrue(workflow.contains("Set Android versionCode/versionName"))
        assertTrue(workflow.contains("VERSION_CODE=\$((MAJOR * 1000000 + MINOR * 1000 + PATCH))"))
        assertTrue(workflow.contains("grep -q \"^[[:space:]]*versionCode = \${VERSION_CODE}\$\""))
        assertTrue(workflow.contains("grep -q \"^[[:space:]]*versionName = \\\"\${VERSION}\\\"\$\""))
        assertTrue(workflow.contains("ANDROID_KEYSTORE_BASE64"))
        assertTrue(workflow.contains("ANDROID_KEYSTORE_PASSWORD"))
        assertTrue(workflow.contains("ANDROID_KEY_ALIAS"))
        assertTrue(workflow.contains("ANDROID_KEY_PASSWORD"))
        assertTrue(workflow.contains("apksigner"))
        assertTrue(workflow.contains("testDebugUnitTest assembleRelease"))
        assertTrue(ciWorkflow.contains("testDebugUnitTest assembleDebug"))
        assertFalse(ciWorkflow.contains("./gradlew assembleRelease"))
        assertTrue(workflow.contains("out/Vibe-Tavern-v\${VERSION}-android.apk"))
        assertTrue(workflow.contains("out/Vibe-Tavern-v\${{ env.VERSION }}-android.apk"))
        assertTrue(workflow.contains("unzip -p \"\$APK\" lib/arm64-v8a/libvibetavern.so"))
        assertTrue(workflow.contains("unzip -p \"\$APK\" assets/payload/web/index.html"))
        assertTrue(workflow.contains("! unzip -l \"\$APK\" | grep -q 'assets/vibe-tavern-android-arm64.tgz'"))
        assertFalse(workflow.contains("unzip -p \"\$APK\" assets/vibe-tavern-android-arm64.tgz"))
        assertTrue(gradle.contains("applicationId = \"com.vibetavern.launcher\""))
        assertTrue(gradle.contains("create(\"release\")"))
        assertTrue(gradle.contains("ANDROID_KEYSTORE_PATH"))
        assertFalse(gradle.contains("signingConfigs.getByName(\"debug\")"))
    }

    @Test
    fun `native Android build inputs have the executable payload contract`() {
        val nativeBuilder = File(repoRoot, "scripts/build-android-native.ts").readText()
        val gradle = File(repoRoot, "mobile/android/app/build.gradle.kts").readText()
        val androidIgnore = File(repoRoot, "mobile/android/.gitignore").readText()
        val obsoleteArchive = File(
            repoRoot,
            "mobile/android/app/src/main/assets/vibe-tavern-android-arm64.tgz",
        )

        assertTrue(nativeBuilder.contains("[\"bun\", \"run\", \"--filter\", \"@vibe-tavern/web\", \"build\"]"))
        assertTrue(nativeBuilder.contains("assets", ignoreCase = false))
        assertTrue(nativeBuilder.contains("payload"))
        assertTrue(nativeBuilder.contains("web"))
        assertTrue(nativeBuilder.contains("drizzle"))
        assertTrue(nativeBuilder.contains("tokenizers"))
        assertTrue(nativeBuilder.contains("prompts"))
        assertTrue(nativeBuilder.contains("jniLibs"))
        assertTrue(nativeBuilder.contains("arm64-v8a"))
        assertTrue(nativeBuilder.contains("libvibetavern.so"))
        assertTrue(nativeBuilder.contains("services", ignoreCase = false))
        assertTrue(nativeBuilder.contains("standalone-server.ts"))
        assertTrue(nativeBuilder.contains("--compile"))
        assertTrue(nativeBuilder.contains("--target=bun-linux-arm64-android"))
        assertTrue(nativeBuilder.contains("--minify"))
        assertTrue(nativeBuilder.contains("VIBE_TAVERN_VERSION"))
        assertTrue(nativeBuilder.contains("VIBE_TAVERN_INSTALL_KIND=\\\"android\\\""))
        assertFalse(nativeBuilder.contains("vibe-tavern-android-arm64.tgz"))
        assertFalse(nativeBuilder.contains("tar -"))
        assertFalse(nativeBuilder.contains("gzip"))
        assertTrue(gradle.contains("minSdk = 29"))
        assertTrue(gradle.contains("abiFilters += \"arm64-v8a\""))
        assertTrue(gradle.contains("useLegacyPackaging = true"))
        assertFalse(gradle.contains("vibe-tavern-android-arm64.tgz"))
        assertTrue(androidIgnore.contains("/app/src/main/jniLibs/"))
        assertTrue(androidIgnore.contains("/app/src/main/assets/payload/"))
        assertFalse(obsoleteArchive.exists())
    }

    @Test
    fun `active Android surfaces use canonical Vibe Tavern branding`() {
        val manifest = File(repoRoot, "mobile/android/app/src/main/AndroidManifest.xml").readText()
        val activeResources = listOf(
            "mobile/android/app/src/main/res/layout/screen_launch.xml",
            "mobile/android/app/src/main/res/values/themes.xml",
        ).joinToString("\n") { relativePath -> File(repoRoot, relativePath).readText() }

        assertTrue(manifest.contains("android:icon=\"@mipmap/ic_launcher\""))
        assertTrue(activeResources.contains("@drawable/vt_logo"))
        assertTrue(activeResources.contains("@font/alegreya_variable"))
        assertFalse(activeResources.contains("🌴"))
        assertFalse(activeResources.contains("#7C3AED", ignoreCase = true))
        assertFalse(activeResources.contains("#1A1A2E", ignoreCase = true))
    }

    @Test
    fun `local updater overrides are debug-only and fail closed for release`() {
        val gradle = File(repoRoot, "mobile/android/app/build.gradle.kts").readText()
        val releaseClient = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/ReleaseUpdate.kt",
        ).readText()

        assertTrue(gradle.contains("VIBE_UPDATE_TEST_URL"))
        assertTrue(gradle.contains("VIBE_UPDATE_TEST_VERSION_NAME"))
        assertTrue(gradle.contains("VIBE_UPDATE_TEST_VERSION_CODE"))
        assertTrue(gradle.contains("Local updater test properties are forbidden for release builds"))
        assertTrue(releaseClient.contains("https://api.github.com/repos/Noineri/vibe_tavern/releases/latest"))
        assertTrue(releaseClient.contains("allowInsecureHttp"))
    }

    @Test
    fun `obsolete token and duplicate manual flows stay removed`() {
        val obsoletePaths = listOf(
            "mobile/android/app/src/main/res/layout/screen_token_input.xml",
            "mobile/android/app/src/main/res/layout/screen_install_termux.xml",
            "mobile/android/app/src/main/res/layout/screen_permission_guide.xml",
            "mobile/android/app/src/main/res/layout/view_termux_setup_command.xml",
            "mobile/android/app/src/main/res/drawable/token_input_bg.xml",
            "mobile/scripts/install.sh",
            "mobile/scripts/update.sh",
            "mobile/scripts/start.sh",
        )
        assertTrue(obsoletePaths.none { File(repoRoot, it).exists() })

        val activity = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/MainActivity.kt",
        ).readText()
        val releaseClient = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/ReleaseUpdate.kt",
        ).readText()

        assertFalse(releaseClient.contains("Authorization"))
        assertTrue(activity.contains("setPositiveButton(tr(\"Download APK\""))
        assertTrue(activity.contains("startLauncherDownload(release)"))
        assertTrue(activity.contains("apkUpdateManager.enqueue(release)"))
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

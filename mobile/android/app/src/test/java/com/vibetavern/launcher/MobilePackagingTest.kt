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
        val ciWorkflow = File(repoRoot, ".github/workflows/ci.yml").readText()
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
        assertTrue(ciWorkflow.contains("testDebugUnitTest assembleDebug"))
        assertFalse(ciWorkflow.contains("./gradlew assembleRelease"))
        assertTrue(workflow.contains("out/Vibe-Tavern-v\${VERSION}-android.apk"))
        assertTrue(workflow.contains("out/Vibe-Tavern-v\${{ env.VERSION }}-android.apk"))
        assertTrue(workflow.contains("unzip -p \"\$APK\" assets/vibe-tavern-android-arm64.tgz"))
        assertTrue(workflow.contains("tar -xOf \"\$PAYLOAD\" ./version.txt"))
        assertTrue(gradle.contains("applicationId = \"com.vibetavern.launcher\""))
        assertTrue(gradle.contains("create(\"release\")"))
        assertTrue(gradle.contains("ANDROID_KEYSTORE_PATH"))
        assertFalse(gradle.contains("signingConfigs.getByName(\"debug\")"))
        assertTrue(armBuilder.contains("version.txt"))
        assertTrue(armBuilder.contains("--mode=755"))
        assertTrue(armBuilder.contains("gzip"))
        assertTrue(activity.contains("bundledArchiveName"))
        assertTrue(activity.contains("PREF_PAYLOAD_VERSION"))
        assertTrue(activity.contains("markCurrentPayloadInstalled"))
        assertTrue(activity.contains("assets.open(\"install.sh\")"))
        assertTrue(activity.contains("proot-distro login ubuntu"))
        assertTrue(installer.contains("VIBE_TAVERN_ARCHIVE_PATH"))
        assertTrue(installer.contains("VIBE_TAVERN_ARCHIVE_URL"))
        assertTrue(installer.contains("version.txt"))
        assertTrue(installer.contains("chmod 755 \"\$NEXT_DIR/vibe-tavern\""))
        assertTrue(installer.contains("proot-distro login \"\$DISTRO\""))
        assertFalse(installer.contains("git clone"))
        assertFalse(installer.contains("bun install"))
        assertFalse(installer.contains("bun run build"))
    }

    @Test
    fun `fresh install avoids shared storage and keeps payload transfer alive`() {
        val activity = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/MainActivity.kt",
        ).readText()
        val manifest = File(repoRoot, "mobile/android/app/src/main/AndroidManifest.xml").readText()
        val installer = File(repoRoot, "mobile/android/app/src/main/assets/install.sh").readText()
        val transferService = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/PayloadTransferService.kt",
        ).readText()

        assertTrue(activity.contains("assets.open(\"install.sh\").bufferedReader()"))
        assertTrue(activity.contains("runTermuxInline(installerCommand"))
        assertTrue(activity.contains("ContextCompat.startForegroundService(this, intent)"))
        assertTrue(activity.contains("PayloadTransferService.start(this)"))
        assertFalse(activity.contains("copyBundledArchiveToDownloads"))
        assertFalse(activity.contains("copyInstallerScriptToDownloads"))
        assertFalse(activity.contains("bash -x '${'$'}installerPath'"))
        assertTrue(manifest.contains("android:name=\".PayloadTransferService\""))
        assertFalse(manifest.contains("android.permission.WRITE_EXTERNAL_STORAGE"))
        assertTrue(transferService.contains("startForeground(NOTIFICATION_ID"))
        assertTrue(transferService.contains("assets.open(ARCHIVE_NAME)"))
        assertTrue(transferService.contains("stopSelf()"))
        assertFalse(installer.contains("termux-setup-storage"))
    }

    @Test
    fun `fresh Termux bootstrap is deterministic and checks exact containers`() {
        val installer = File(
            repoRoot,
            "mobile/android/app/src/main/assets/install.sh",
        ).readText()
        val starter = File(repoRoot, "mobile/android/app/src/main/assets/start.sh").readText()
        val activity = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/MainActivity.kt",
        ).readText()
        val serverService = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/ServerService.kt",
        ).readText()

        assertTrue(installer.contains("Acquire::Retries=3"))
        assertTrue(installer.contains("--force-confold"))
        assertTrue(installer.contains("apt-get \"${'$'}{TERMUX_APT_OPTIONS[@]}\" install"))
        assertFalse(installer.contains("pkg update"))
        assertFalse(installer.contains("yes | apt"))
        assertTrue(installer.contains("proot-distro list --quiet | grep -qxF \"${'$'}DISTRO\""))
        assertTrue(installer.contains("VIBE_TAVERN_DISTRO_IMAGE:-ubuntu:24.04"))
        assertFalse(installer.contains("proot-distro list 2>&1 | grep -q"))
        assertTrue(starter.contains("proot-distro list --quiet | grep -qxF \"${'$'}{DISTRO}\""))
        assertFalse(starter.contains("proot-distro list 2>&1 | grep -q"))
        assertFalse(activity.contains("proot-distro list 2>&1 | grep -q"))
        assertFalse(serverService.contains("proot-distro list 2>&1 | grep -q"))
    }

    @Test
    fun `first-time setup is an inline accordion with a copyable command block`() {
        val activity = File(
            repoRoot,
            "mobile/android/app/src/main/java/com/vibetavern/launcher/MainActivity.kt",
        ).readText()
        val launchLayout = File(
            repoRoot,
            "mobile/android/app/src/main/res/layout/screen_launch.xml",
        ).readText()
        val permissionLayout = File(
            repoRoot,
            "mobile/android/app/src/main/res/layout/screen_permission_guide.xml",
        ).readText()
        val commandLayout = File(
            repoRoot,
            "mobile/android/app/src/main/res/layout/view_termux_setup_command.xml",
        )

        assertTrue(launchLayout.contains("@+id/first_time_setup_header"))
        assertTrue(launchLayout.contains("@+id/first_time_setup_content"))
        assertTrue(launchLayout.contains("android:visibility=\"gone\""))
        assertTrue(launchLayout.contains("@layout/view_termux_setup_command"))
        assertTrue(permissionLayout.contains("@layout/view_termux_setup_command"))
        assertTrue(commandLayout.isFile)
        assertTrue(commandLayout.readText().contains("@+id/termux_command_block"))
        assertTrue(commandLayout.readText().contains("@+id/btn_copy_termux_command"))
        assertTrue(commandLayout.readText().contains("android:textIsSelectable=\"true\""))
        assertTrue(activity.contains("toggleFirstTimeSetupHelp"))
        assertTrue(activity.contains("copyTermuxSetupCommand"))
        assertFalse(activity.contains("showFirstTimeSetupGuide"))
        assertFalse(launchLayout.contains("@+id/btn_first_time_setup"))
    }

    @Test
    fun `active Android surfaces use canonical Vibe Tavern branding`() {
        val manifest = File(repoRoot, "mobile/android/app/src/main/AndroidManifest.xml").readText()
        val activeResources = listOf(
            "mobile/android/app/src/main/res/layout/screen_launch.xml",
            "mobile/android/app/src/main/res/layout/screen_install_termux.xml",
            "mobile/android/app/src/main/res/layout/screen_permission_guide.xml",
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
        assertTrue(gradle.contains("VIBE_UPDATE_TEST_INCLUDE_PAYLOAD"))
        assertTrue(gradle.contains("Local updater test properties are forbidden for release builds"))
        assertTrue(releaseClient.contains("https://api.github.com/repos/Noineri/vibe_tavern/releases/latest"))
        assertTrue(releaseClient.contains("allowInsecureHttp"))
    }

    @Test
    fun `obsolete token and duplicate manual flows stay removed`() {
        val obsoletePaths = listOf(
            "mobile/android/app/src/main/res/layout/screen_token_input.xml",
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
        val installer = File(repoRoot, "mobile/android/app/src/main/assets/install.sh").readText()
        val starter = File(repoRoot, "mobile/android/app/src/main/assets/start.sh").readText()

        assertFalse(releaseClient.contains("Authorization"))
        assertTrue(activity.contains("setPositiveButton(tr(\"Download APK\""))
        assertTrue(activity.contains("startLauncherDownload(release)"))
        assertTrue(activity.contains("apkUpdateManager.enqueue(release)"))
        assertTrue(starter.contains("proot-distro login \"\${DISTRO}\""))
        assertTrue(starter.contains("VIBE_TAVERN_DATA_DIR=\"\$HOME/.local/share/vibe-tavern\""))
        assertTrue(installer.contains("cat > \"\$HOME/start-vibe-tavern.sh\""))
        assertTrue(installer.contains("exec ./vibe-tavern"))
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

package com.vibetavern.launcher

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseUpdateTest {
    @Test
    fun `semantic versions compare lower equal and higher components`() {
        val version = SemanticVersion.parse("1.2.3")

        assertTrue(SemanticVersion.parse("1.2.2") < version)
        assertEquals(version, SemanticVersion.parse("v1.2.3"))
        assertTrue(SemanticVersion.parse("2.0.0") > version)
    }

    @Test
    fun `malformed tags are unavailable`() {
        val decision = classifyLatestRelease("1.0.0", releaseJson(tag = "release-1.1"))

        assertEquals(
            ReleaseUnavailableReason.MALFORMED_VERSION,
            (decision as ReleaseUpdateDecision.Unavailable).reason,
        )
    }

    @Test
    fun `missing or wrongly named Android assets are unavailable`() {
        val missing = classifyLatestRelease("1.0.0", releaseJson(tag = "v1.1.0", assets = "[]"))
        val wrong = classifyLatestRelease(
            "1.0.0",
            releaseJson(
                tag = "v1.1.0",
                assets = """[{"name":"app-release.apk","browser_download_url":"https://example.invalid/app.apk","size":12}]""",
            ),
        )

        assertEquals(
            ReleaseUnavailableReason.ANDROID_ASSET_MISSING,
            (missing as ReleaseUpdateDecision.Unavailable).reason,
        )
        assertEquals(
            ReleaseUnavailableReason.ANDROID_ASSET_MISSING,
            (wrong as ReleaseUpdateDecision.Unavailable).reason,
        )
    }

    @Test
    fun `drafts and prereleases are rejected defensively`() {
        val draft = classifyLatestRelease("1.0.0", releaseJson(tag = "v1.1.0", draft = true))
        val prerelease = classifyLatestRelease("1.0.0", releaseJson(tag = "v1.1.0", prerelease = true))

        assertEquals(
            ReleaseUnavailableReason.UNSTABLE_RELEASE,
            (draft as ReleaseUpdateDecision.Unavailable).reason,
        )
        assertEquals(
            ReleaseUnavailableReason.UNSTABLE_RELEASE,
            (prerelease as ReleaseUpdateDecision.Unavailable).reason,
        )
    }

    @Test
    fun `representative JSON preserves notes and selects only the exact Android asset`() {
        val decision = classifyLatestRelease(
            currentVersion = "1.0.0",
            json = releaseJson(
                tag = "v1.2.3",
                body = "Fixes and improvements.\n\nData is preserved.",
                assets = """
                    [
                      {"name":"Vibe-Tavern-v1.2.3-linux.tar.gz","browser_download_url":"https://example.invalid/linux.tar.gz","size":100},
                      {"name":"Vibe-Tavern-v1.2.3-android.apk","browser_download_url":"https://example.invalid/vt.apk","size":200}
                    ]
                """.trimIndent(),
            ),
        ) as ReleaseUpdateDecision.UpdateAvailable

        assertEquals(SemanticVersion(1, 2, 3), decision.release.version)
        assertEquals("Fixes and improvements.\n\nData is preserved.", decision.release.notes)
        assertEquals("Vibe-Tavern-v1.2.3-android.apk", decision.release.asset.name)
        assertEquals("https://example.invalid/vt.apk", decision.release.asset.downloadUrl)
        assertEquals(200L, decision.release.asset.sizeBytes)
    }

    @Test
    fun `equal or older published versions are up to date`() {
        val equal = classifyLatestRelease("1.2.3", releaseJson(tag = "v1.2.3"))
        val older = classifyLatestRelease("1.2.3", releaseJson(tag = "v1.2.2"))

        assertTrue(equal is ReleaseUpdateDecision.UpToDate)
        assertTrue(older is ReleaseUpdateDecision.UpToDate)
    }

    @Test
    fun `client sends an unauthenticated bounded GitHub request`() = runBlocking {
        var captured: ReleaseRequest? = null
        val transport = ReleaseTransport { request ->
            captured = request
            ReleaseHttpResponse(200, releaseJson(tag = "v1.1.0"))
        }

        val decision = GitHubReleaseClient(transport).checkForUpdate("1.0.0")
        val request = requireNotNull(captured)

        assertTrue(decision is ReleaseUpdateDecision.UpdateAvailable)
        assertEquals(
            "https://api.github.com/repos/Noineri/vibe_tavern/releases/latest",
            request.url,
        )
        assertEquals("application/vnd.github+json", request.headers["Accept"])
        assertEquals("2022-11-28", request.headers["X-GitHub-Api-Version"])
        assertEquals("Vibe-Tavern-Android", request.headers["User-Agent"])
        assertFalse(request.headers.keys.any { it.equals("Authorization", ignoreCase = true) })
        assertTrue(request.connectTimeoutMillis in 1..30_000)
        assertTrue(request.readTimeoutMillis in 1..30_000)
    }

    @Test
    fun `network failures become non-blocking error decisions`() = runBlocking {
        val client = GitHubReleaseClient(ReleaseTransport { throw IOException("offline") })

        val decision = client.checkForUpdate("1.0.0")

        assertTrue(decision is ReleaseUpdateDecision.Error)
        assertEquals("offline", (decision as ReleaseUpdateDecision.Error).message)
    }

    @Test
    fun `cleartext update URLs require the explicit private-LAN test policy`() {
        val lanAssets = """
            [{"name":"Vibe-Tavern-v1.1.0-android.apk","browser_download_url":"http://192.168.1.20:8791/Vibe-Tavern-v1.1.0-android.apk","size":200}]
        """.trimIndent()
        val defaultDecision = classifyLatestRelease(
            "1.0.0",
            releaseJson(tag = "v1.1.0", assets = lanAssets),
        )
        val testDecision = classifyLatestRelease(
            "1.0.0",
            releaseJson(tag = "v1.1.0", assets = lanAssets),
            allowInsecureHttp = true,
        )

        assertEquals(
            ReleaseUnavailableReason.ANDROID_ASSET_MISSING,
            (defaultDecision as ReleaseUpdateDecision.Unavailable).reason,
        )
        assertTrue(testDecision is ReleaseUpdateDecision.UpdateAvailable)
        assertFalse(isAllowedUpdateUrl("http://example.com/update.apk", allowInsecureHttp = true))
        assertTrue(isAllowedUpdateUrl("http://10.0.0.5:8791/update.apk", allowInsecureHttp = true))
        assertTrue(isAllowedUpdateUrl("https://github.com/update.apk", allowInsecureHttp = false))
    }

    @Test
    fun `downloaded APK identity must match package expected version and increase version code`() {
        val accepted = validateDownloadedApkIdentity(
            expectedPackageName = "com.vibetavern.launcher",
            currentVersionCode = 1_002_003,
            expectedVersionName = "1.3.0",
            downloaded = DownloadedApkIdentity("com.vibetavern.launcher", 1_003_000, "1.3.0"),
        )
        val wrongPackage = validateDownloadedApkIdentity(
            "com.vibetavern.launcher",
            1_002_003,
            "1.3.0",
            DownloadedApkIdentity("com.example.impostor", 1_003_000, "1.3.0"),
        )
        val staleVersionCode = validateDownloadedApkIdentity(
            "com.vibetavern.launcher",
            1_002_003,
            "1.3.0",
            DownloadedApkIdentity("com.vibetavern.launcher", 1_002_003, "1.3.0"),
        )
        val wrongVersionName = validateDownloadedApkIdentity(
            "com.vibetavern.launcher",
            1_002_003,
            "1.3.0",
            DownloadedApkIdentity("com.vibetavern.launcher", 1_003_000, "9.9.9"),
        )

        assertEquals(ApkIdentityDecision.Accepted, accepted)
        assertEquals(
            ApkIdentityDecision.Rejected(ApkRejectionReason.WRONG_PACKAGE),
            wrongPackage,
        )
        assertEquals(
            ApkIdentityDecision.Rejected(ApkRejectionReason.VERSION_NOT_NEWER),
            staleVersionCode,
        )
        assertEquals(
            ApkIdentityDecision.Rejected(ApkRejectionReason.VERSION_NAME_MISMATCH),
            wrongVersionName,
        )
    }

    private fun releaseJson(
        tag: String,
        draft: Boolean = false,
        prerelease: Boolean = false,
        body: String = "Release notes",
        assets: String? = null,
    ): String {
        val releaseAssets = assets ?: """
            [{"name":"Vibe-Tavern-$tag-android.apk","browser_download_url":"https://example.invalid/vt.apk","size":200}]
        """.trimIndent()
        val escapedBody = body.replace("\\", "\\\\").replace("\n", "\\n").replace("\"", "\\\"")
        return """
            {
              "tag_name": "$tag",
              "name": "Vibe Tavern $tag",
              "body": "$escapedBody",
              "html_url": "https://github.com/Noineri/vibe_tavern/releases/tag/$tag",
              "draft": $draft,
              "prerelease": $prerelease,
              "assets": $releaseAssets
            }
        """.trimIndent()
    }
}

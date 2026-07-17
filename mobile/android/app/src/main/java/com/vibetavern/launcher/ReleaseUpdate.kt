package com.vibetavern.launcher

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

data class SemanticVersion(
    val major: Int,
    val minor: Int,
    val patch: Int,
) : Comparable<SemanticVersion> {
    override fun compareTo(other: SemanticVersion): Int =
        compareValuesBy(this, other, SemanticVersion::major, SemanticVersion::minor, SemanticVersion::patch)

    override fun toString(): String = "$major.$minor.$patch"

    companion object {
        private val pattern = Regex("^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$")

        fun parse(value: String): SemanticVersion {
            val match = requireNotNull(pattern.matchEntire(value.trim())) {
                "Unsupported semantic version: $value"
            }
            return SemanticVersion(
                major = requireNotNull(match.groupValues[1].toIntOrNull()),
                minor = requireNotNull(match.groupValues[2].toIntOrNull()),
                patch = requireNotNull(match.groupValues[3].toIntOrNull()),
            )
        }
    }
}

data class AndroidReleaseAsset(
    val name: String,
    val downloadUrl: String,
    val sizeBytes: Long,
)

data class PublishedRelease(
    val version: SemanticVersion,
    val tagName: String,
    val name: String,
    val notes: String,
    val pageUrl: String,
    val asset: AndroidReleaseAsset,
)

enum class ReleaseUnavailableReason {
    MALFORMED_VERSION,
    UNSTABLE_RELEASE,
    ANDROID_ASSET_MISSING,
}

sealed interface ReleaseUpdateDecision {
    data class UpdateAvailable(
        val currentVersion: SemanticVersion,
        val release: PublishedRelease,
    ) : ReleaseUpdateDecision

    data class UpToDate(
        val currentVersion: SemanticVersion,
        val release: PublishedRelease,
    ) : ReleaseUpdateDecision

    data class Unavailable(
        val reason: ReleaseUnavailableReason,
    ) : ReleaseUpdateDecision

    data class Error(
        val message: String,
    ) : ReleaseUpdateDecision
}

data class ReleaseRequest(
    val url: String,
    val headers: Map<String, String>,
    val connectTimeoutMillis: Int,
    val readTimeoutMillis: Int,
)

data class ReleaseHttpResponse(
    val statusCode: Int,
    val body: String,
)

fun interface ReleaseTransport {
    suspend fun get(request: ReleaseRequest): ReleaseHttpResponse
}

class UrlConnectionReleaseTransport(
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ReleaseTransport {
    override suspend fun get(request: ReleaseRequest): ReleaseHttpResponse = withContext(ioDispatcher) {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = request.connectTimeoutMillis
            connection.readTimeout = request.readTimeoutMillis
            connection.instanceFollowRedirects = true
            request.headers.forEach(connection::setRequestProperty)

            val statusCode = connection.responseCode
            val responseStream = if (statusCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }
            val body = responseStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            ReleaseHttpResponse(statusCode, body)
        } finally {
            connection.disconnect()
        }
    }
}

class GitHubReleaseClient(
    private val transport: ReleaseTransport = UrlConnectionReleaseTransport(),
    private val endpointUrl: String = PRODUCTION_RELEASE_API_URL,
    private val allowInsecureHttp: Boolean = false,
) {
    suspend fun checkForUpdate(currentVersion: String): ReleaseUpdateDecision {
        if (!isAllowedUpdateUrl(endpointUrl, allowInsecureHttp)) {
            return ReleaseUpdateDecision.Error("Release API URL is not allowed")
        }
        return try {
            val response = transport.get(latestReleaseRequest())
            if (response.statusCode !in 200..299) {
                ReleaseUpdateDecision.Error("GitHub release request failed with HTTP ${response.statusCode}")
            } else {
                classifyLatestRelease(currentVersion, response.body, allowInsecureHttp)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            ReleaseUpdateDecision.Error(error.message ?: "Release update check failed")
        }
    }

    private fun latestReleaseRequest() = ReleaseRequest(
        url = endpointUrl,
        headers = mapOf(
            "Accept" to "application/vnd.github+json",
            "X-GitHub-Api-Version" to "2022-11-28",
            "User-Agent" to "Vibe-Tavern-Android",
        ),
        connectTimeoutMillis = 10_000,
        readTimeoutMillis = 15_000,
    )
}

const val PRODUCTION_RELEASE_API_URL =
    "https://api.github.com/repos/Noineri/vibe_tavern/releases/latest"

fun isAllowedUpdateUrl(url: String, allowInsecureHttp: Boolean): Boolean {
    val uri = try {
        URI(url)
    } catch (_: Exception) {
        return false
    }
    val host = uri.host?.lowercase() ?: return false
    if (uri.scheme.equals("https", ignoreCase = true)) return true
    if (!allowInsecureHttp || !uri.scheme.equals("http", ignoreCase = true)) return false
    if (host == "localhost" || host == "127.0.0.1") return true

    val octets = host.split('.').map { it.toIntOrNull() ?: return false }
    if (octets.size != 4 || octets.any { it !in 0..255 }) return false
    return octets[0] == 10 ||
        (octets[0] == 172 && octets[1] in 16..31) ||
        (octets[0] == 192 && octets[1] == 168)
}

fun classifyLatestRelease(
    currentVersion: String,
    json: String,
    allowInsecureHttp: Boolean = false,
): ReleaseUpdateDecision {
    val current = try {
        SemanticVersion.parse(currentVersion)
    } catch (error: IllegalArgumentException) {
        return ReleaseUpdateDecision.Error(error.message ?: "Current launcher version is invalid")
    }

    val releaseJson = try {
        JSONObject(json)
    } catch (error: Exception) {
        return ReleaseUpdateDecision.Error(error.message ?: "GitHub release response is invalid")
    }

    if (releaseJson.optBoolean("draft") || releaseJson.optBoolean("prerelease")) {
        return ReleaseUpdateDecision.Unavailable(ReleaseUnavailableReason.UNSTABLE_RELEASE)
    }

    val tagName = releaseJson.optString("tag_name")
    val latest = try {
        SemanticVersion.parse(tagName)
    } catch (_: IllegalArgumentException) {
        return ReleaseUpdateDecision.Unavailable(ReleaseUnavailableReason.MALFORMED_VERSION)
    }

    val expectedAssetName = "Vibe-Tavern-v$latest-android.apk"
    val assetsJson = releaseJson.optJSONArray("assets")
        ?: return ReleaseUpdateDecision.Unavailable(ReleaseUnavailableReason.ANDROID_ASSET_MISSING)
    val matchingAssets = buildList {
        for (index in 0 until assetsJson.length()) {
            val candidate = assetsJson.optJSONObject(index) ?: continue
            if (candidate.optString("name") == expectedAssetName) add(candidate)
        }
    }
    if (matchingAssets.size != 1) {
        return ReleaseUpdateDecision.Unavailable(ReleaseUnavailableReason.ANDROID_ASSET_MISSING)
    }

    val assetJson = matchingAssets.single()
    val downloadUrl = assetJson.optString("browser_download_url")
    val sizeBytes = assetJson.optLong("size", -1L)
    if (!isAllowedUpdateUrl(downloadUrl, allowInsecureHttp) || sizeBytes < 0L) {
        return ReleaseUpdateDecision.Unavailable(ReleaseUnavailableReason.ANDROID_ASSET_MISSING)
    }

    val release = PublishedRelease(
        version = latest,
        tagName = tagName,
        name = releaseJson.optString("name").ifBlank { tagName },
        notes = releaseJson.optString("body"),
        pageUrl = releaseJson.optString("html_url"),
        asset = AndroidReleaseAsset(
            name = expectedAssetName,
            downloadUrl = downloadUrl,
            sizeBytes = sizeBytes,
        ),
    )
    return if (latest > current) {
        ReleaseUpdateDecision.UpdateAvailable(current, release)
    } else {
        ReleaseUpdateDecision.UpToDate(current, release)
    }
}

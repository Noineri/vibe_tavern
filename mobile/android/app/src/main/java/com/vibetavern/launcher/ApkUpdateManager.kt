package com.vibetavern.launcher

import android.app.DownloadManager
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class DownloadedApkIdentity(
    val packageName: String,
    val versionCode: Long,
    val versionName: String?,
)

enum class ApkRejectionReason {
    INVALID_APK,
    WRONG_PACKAGE,
    VERSION_NOT_NEWER,
    VERSION_NAME_MISMATCH,
}

sealed interface ApkIdentityDecision {
    data object Accepted : ApkIdentityDecision

    data class Rejected(
        val reason: ApkRejectionReason,
    ) : ApkIdentityDecision
}

fun validateDownloadedApkIdentity(
    expectedPackageName: String,
    currentVersionCode: Long,
    expectedVersionName: String,
    downloaded: DownloadedApkIdentity,
): ApkIdentityDecision {
    return when {
        downloaded.packageName != expectedPackageName ->
            ApkIdentityDecision.Rejected(ApkRejectionReason.WRONG_PACKAGE)
        downloaded.versionCode <= currentVersionCode ->
            ApkIdentityDecision.Rejected(ApkRejectionReason.VERSION_NOT_NEWER)
        downloaded.versionName != expectedVersionName ->
            ApkIdentityDecision.Rejected(ApkRejectionReason.VERSION_NAME_MISMATCH)
        else -> ApkIdentityDecision.Accepted
    }
}

sealed interface ApkDownloadState {
    data object Idle : ApkDownloadState

    data class Downloading(
        val downloadId: Long,
        val progressPercent: Int?,
    ) : ApkDownloadState

    data class Ready(
        val downloadId: Long,
        val expectedVersionName: String,
    ) : ApkDownloadState

    data class Failed(
        val reason: String,
    ) : ApkDownloadState
}

sealed interface ApkInstallHandoff {
    data class LaunchInstaller(
        val intent: Intent,
    ) : ApkInstallHandoff

    data class PermissionRequired(
        val settingsIntent: Intent,
    ) : ApkInstallHandoff

    data class Rejected(
        val reason: ApkRejectionReason,
    ) : ApkInstallHandoff

    data object MissingDownload : ApkInstallHandoff
}

class ApkUpdateManager(
    context: Context,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val appContext = context.applicationContext
    private val downloadManager = appContext.getSystemService(DownloadManager::class.java)
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun cleanupStaleDownload() {
        val expectedVersion = preferences.getString(KEY_EXPECTED_VERSION, null) ?: return
        val isStale = try {
            SemanticVersion.parse(expectedVersion) <= SemanticVersion.parse(BuildConfig.VERSION_NAME)
        } catch (_: IllegalArgumentException) {
            true
        }
        if (isStale) clearTrackedDownload(removeFromDownloadManager = true)
    }

    fun enqueue(release: PublishedRelease): ApkDownloadState.Downloading {
        clearTrackedDownload(removeFromDownloadManager = true)

        val relativePath = "updates/${release.asset.name}"
        val updatesDirectory = File(
            requireNotNull(appContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)) {
                "App-specific downloads directory is unavailable"
            },
            "updates",
        )
        check(updatesDirectory.exists() || updatesDirectory.mkdirs()) {
            "Could not create the launcher update directory"
        }
        val destination = File(updatesDirectory, release.asset.name)
        if (destination.exists()) check(destination.delete()) {
            "Could not replace the previous launcher APK"
        }

        val request = DownloadManager.Request(Uri.parse(release.asset.downloadUrl))
            .setTitle("Vibe Tavern v${release.version}")
            .setDescription("Launcher update")
            .setMimeType(APK_MIME_TYPE)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(true)
            .setDestinationInExternalFilesDir(
                appContext,
                Environment.DIRECTORY_DOWNLOADS,
                relativePath,
            )

        val downloadId = downloadManager.enqueue(request)
        preferences.edit()
            .putLong(KEY_DOWNLOAD_ID, downloadId)
            .putString(KEY_DOWNLOAD_PATH, destination.absolutePath)
            .putString(KEY_EXPECTED_VERSION, release.version.toString())
            .putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)
            .apply()
        return ApkDownloadState.Downloading(downloadId, progressPercent = null)
    }

    fun hasTrackedDownload(): Boolean =
        preferences.getLong(KEY_DOWNLOAD_ID, INVALID_DOWNLOAD_ID) != INVALID_DOWNLOAD_ID

    fun isTrackedDownload(downloadId: Long): Boolean =
        downloadId != INVALID_DOWNLOAD_ID &&
            downloadId == preferences.getLong(KEY_DOWNLOAD_ID, INVALID_DOWNLOAD_ID)

    suspend fun reconcile(): ApkDownloadState = withContext(ioDispatcher) {
        reconcileBlocking()
    }

    suspend fun prepareInstall(): ApkInstallHandoff = withContext(ioDispatcher) {
        val state = reconcileBlocking()
        if (state !is ApkDownloadState.Ready) return@withContext ApkInstallHandoff.MissingDownload

        val file = trackedFile() ?: return@withContext ApkInstallHandoff.MissingDownload
        val identity = readApkIdentity(file)
        if (identity == null) {
            clearTrackedDownload(removeFromDownloadManager = true)
            return@withContext ApkInstallHandoff.Rejected(ApkRejectionReason.INVALID_APK)
        }
        val decision = validateDownloadedApkIdentity(
            expectedPackageName = appContext.packageName,
            currentVersionCode = BuildConfig.VERSION_CODE.toLong(),
            expectedVersionName = state.expectedVersionName,
            downloaded = identity,
        )
        if (decision is ApkIdentityDecision.Rejected) {
            clearTrackedDownload(removeFromDownloadManager = true)
            return@withContext ApkInstallHandoff.Rejected(decision.reason)
        }

        if (!appContext.packageManager.canRequestPackageInstalls()) {
            preferences.edit().putBoolean(KEY_AWAITING_INSTALL_PERMISSION, true).apply()
            return@withContext ApkInstallHandoff.PermissionRequired(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${appContext.packageName}"),
                ),
            )
        }

        preferences.edit().putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false).apply()
        val contentUri = FileProvider.getUriForFile(
            appContext,
            "${appContext.packageName}.fileprovider",
            file,
        )
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(contentUri, APK_MIME_TYPE)
            clipData = ClipData.newRawUri("Vibe Tavern launcher update", contentUri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ApkInstallHandoff.LaunchInstaller(installIntent)
    }

    fun isAwaitingInstallPermission(): Boolean =
        preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)

    fun canInstallPackages(): Boolean = appContext.packageManager.canRequestPackageInstalls()

    private fun reconcileBlocking(): ApkDownloadState {
        val downloadId = preferences.getLong(KEY_DOWNLOAD_ID, INVALID_DOWNLOAD_ID)
        if (downloadId == INVALID_DOWNLOAD_ID) return ApkDownloadState.Idle
        val expectedVersion = preferences.getString(KEY_EXPECTED_VERSION, null)
            ?: return failAndClear("Downloaded APK version metadata is missing")

        val query = DownloadManager.Query().setFilterById(downloadId)
        downloadManager.query(query)?.use { cursor ->
            if (!cursor.moveToFirst()) return failAndClear("Launcher download is no longer available")
            return when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                DownloadManager.STATUS_PENDING,
                DownloadManager.STATUS_RUNNING,
                DownloadManager.STATUS_PAUSED,
                -> ApkDownloadState.Downloading(downloadId, downloadProgress(cursor))
                DownloadManager.STATUS_SUCCESSFUL -> {
                    val file = trackedFile()
                    if (file?.isFile == true && file.length() > 0L) {
                        ApkDownloadState.Ready(downloadId, expectedVersion)
                    } else {
                        failAndClear("Downloaded launcher APK is missing")
                    }
                }
                DownloadManager.STATUS_FAILED -> {
                    val reason = cursor.getInt(
                        cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON),
                    )
                    failAndClear("Launcher download failed ($reason)")
                }
                else -> failAndClear("Launcher download entered an unknown state")
            }
        }
        return failAndClear("Launcher download could not be queried")
    }

    private fun downloadProgress(cursor: android.database.Cursor): Int? {
        val total = cursor.getLong(
            cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES),
        )
        if (total <= 0L) return null
        val downloaded = cursor.getLong(
            cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR),
        )
        return ((downloaded.coerceIn(0L, total) * 100L) / total).toInt()
    }

    private fun readApkIdentity(file: File): DownloadedApkIdentity? {
        @Suppress("DEPRECATION")
        val packageInfo: PackageInfo = appContext.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
            ?: return null
        return DownloadedApkIdentity(
            packageName = packageInfo.packageName,
            versionCode = PackageInfoCompat.getLongVersionCode(packageInfo),
            versionName = packageInfo.versionName,
        )
    }

    private fun trackedFile(): File? =
        preferences.getString(KEY_DOWNLOAD_PATH, null)?.let(::File)

    private fun failAndClear(reason: String): ApkDownloadState.Failed {
        clearTrackedDownload(removeFromDownloadManager = true)
        return ApkDownloadState.Failed(reason)
    }

    private fun clearTrackedDownload(removeFromDownloadManager: Boolean) {
        val downloadId = preferences.getLong(KEY_DOWNLOAD_ID, INVALID_DOWNLOAD_ID)
        if (removeFromDownloadManager && downloadId != INVALID_DOWNLOAD_ID) {
            downloadManager.remove(downloadId)
        }
        trackedFile()?.takeIf(File::exists)?.delete()
        preferences.edit().clear().apply()
    }

    companion object {
        private const val PREFERENCES = "vibe_tavern_launcher_update"
        private const val KEY_DOWNLOAD_ID = "download_id"
        private const val KEY_DOWNLOAD_PATH = "download_path"
        private const val KEY_EXPECTED_VERSION = "expected_version"
        private const val KEY_AWAITING_INSTALL_PERMISSION = "awaiting_install_permission"
        private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
        private const val INVALID_DOWNLOAD_ID = -1L
    }
}

package com.vibetavern.launcher

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.zip.GZIPInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarConstants

/** Imports a user-produced Termux archive without ever accessing the Termux installation itself. */
class LegacyMigration(private val appFilesDir: File) {
    private val dataDir = File(appFilesDir, DATA_DIRECTORY)
    private val transactionFile = File(appFilesDir, TRANSACTION_FILE)

    class PreparedImport internal constructor(val stagingRoot: File, val data: File)

    /** Removes an incomplete promoted import and restores the pre-import data, if there was any. */
    fun recoverIncompleteTransaction() {
        if (!transactionFile.exists()) return
        val backup = File(appFilesDir, BACKUP_DIRECTORY)
        if (backup.exists()) {
            dataDir.deleteRecursivelyOrThrow()
            move(backup, dataDir, "restore the interrupted migration backup")
        } else {
            dataDir.deleteRecursivelyOrThrow()
        }
        appFilesDir.listFiles().orEmpty()
            .filter { it.name.startsWith("$STAGING_DIRECTORY-") }
            .forEach { it.deleteRecursivelyOrThrow() }
        transactionFile.deleteOrThrow()
    }

    /** Validates every archive entry before extracting the validated archive into private staging. */
    @Throws(MigrationException::class)
    fun prepare(archive: File): PreparedImport {
        val requiredBytes = validateArchive(archive)
        if (appFilesDir.usableSpace < requiredBytes) {
            throw MigrationException("Not enough free storage for the archive's declared uncompressed size")
        }
        val staging = File(appFilesDir, "$STAGING_DIRECTORY-${UUID.randomUUID()}")
        try {
            check(staging.mkdirs()) { "Could not create migration staging directory" }
            extractArchive(archive, staging)
            val extractedData = File(staging, ARCHIVE_ROOT)
            if (!File(extractedData, DATABASE_NAME).isFile) {
                throw MigrationException("Archive does not contain $ARCHIVE_ROOT/$DATABASE_NAME")
            }
            return PreparedImport(staging, extractedData)
        } catch (error: Exception) {
            staging.deleteRecursively()
            throw error.asMigrationException()
        }
    }

    /** Promotes prepared data only after the caller has stopped its owned server and verified the port. */
    @Throws(MigrationException::class)
    fun activate(prepared: PreparedImport, startServer: () -> Unit, stopFailedServer: () -> Unit, apiReady: () -> Boolean) {
        require(prepared.data.parentFile == prepared.stagingRoot) { "Prepared import is not from this migration manager" }
        val backup = File(appFilesDir, BACKUP_DIRECTORY)
        try {
            writeTransactionMarker()
            backup.deleteRecursivelyOrThrow()
            if (dataDir.exists()) move(dataDir, backup, "back up existing native data")
            move(prepared.data, dataDir, "activate imported data")
            prepared.stagingRoot.deleteRecursivelyOrThrow()
            startServer()
            if (!apiReady()) throw MigrationException("Native server did not become API-ready after migration")
            backup.deleteRecursivelyOrThrow()
            transactionFile.deleteOrThrow()
        } catch (error: Exception) {
            stopFailedServer()
            rollbackAfterFailedActivation()
            throw error.asMigrationException()
        }
    }

    fun discard(prepared: PreparedImport?) {
        prepared?.stagingRoot?.deleteRecursively()
    }

    private fun rollbackAfterFailedActivation() {
        val backup = File(appFilesDir, BACKUP_DIRECTORY)
        dataDir.deleteRecursively()
        if (backup.exists()) {
            move(backup, dataDir, "restore native data after failed migration")
        }
        File(appFilesDir, STAGING_DIRECTORY).deleteRecursively()
        transactionFile.delete()
    }

    private fun validateArchive(archive: File): Long {
        var totalSize = 0L
        val entries = mutableSetOf<String>()
        try {
            tar(archive).use { tar ->
                while (true) {
                    val entry = tar.nextEntry as? TarArchiveEntry ?: break
                    val path = validateEntry(entry, entries)
                    if (entry.isFile) {
                        totalSize = Math.addExact(totalSize, entry.size)
                    }
                    if (path == "$ARCHIVE_ROOT/$DATABASE_NAME" && !entry.isFile) {
                        throw MigrationException("Database entry must be a regular file")
                    }
                }
            }
        } catch (error: Exception) {
            throw error.asMigrationException()
        }
        if ("$ARCHIVE_ROOT/$DATABASE_NAME" !in entries) {
            throw MigrationException("Archive does not contain $ARCHIVE_ROOT/$DATABASE_NAME")
        }
        return totalSize
    }

    private fun extractArchive(archive: File, staging: File) {
        val stagingCanonical = staging.canonicalFile
        val entries = mutableSetOf<String>()
        try {
            tar(archive).use { tar ->
                while (true) {
                    val entry = tar.nextEntry as? TarArchiveEntry ?: break
                    val path = validateEntry(entry, entries)
                    val destination = File(staging, path).canonicalFile
                    if (!destination.toPath().startsWith(stagingCanonical.toPath())) {
                        throw MigrationException("Archive path escapes the migration staging directory")
                    }
                    when {
                        entry.isDirectory -> if (!destination.exists() && !destination.mkdirs()) {
                            throw MigrationException("Could not create archive directory $path")
                        }
                        entry.isFile -> {
                            destination.parentFile?.let { parent ->
                                if (!parent.exists() && !parent.mkdirs()) throw MigrationException("Could not create archive parent for $path")
                            }
                            FileOutputStream(destination).use { output -> tar.copyTo(output) }
                        }
                    }
                }
            }
        } catch (error: Exception) {
            throw error.asMigrationException()
        }
    }

    private fun validateEntry(entry: TarArchiveEntry, entries: MutableSet<String>): String {
        val originalPath = entry.name
        val path = if (entry.isDirectory) originalPath.removeSuffix("/") else originalPath
        if (path.contains('\\') || path.startsWith('/') || path.startsWith("//") || path.isBlank()) {
            throw MigrationException("Unsafe archive path: $originalPath")
        }
        val segments = path.split('/')
        if (segments.any { it.isEmpty() || it == "." || it == ".." } || segments.first() != ARCHIVE_ROOT) {
            throw MigrationException("Archive entry is outside $ARCHIVE_ROOT/: $originalPath")
        }
        if (path == ARCHIVE_ROOT && !entry.isDirectory) {
            throw MigrationException("Archive root must be a directory")
        }
        val supportedType = entry.linkFlag == TarConstants.LF_NORMAL ||
            entry.linkFlag == TarConstants.LF_OLDNORM ||
            entry.linkFlag == TarConstants.LF_DIR
        if (!supportedType || entry.isSymbolicLink || entry.isLink || (!entry.isFile && !entry.isDirectory)) {
            throw MigrationException("Unsupported archive entry: $originalPath")
        }
        if (!entries.add(path)) throw MigrationException("Duplicate archive entry: $originalPath")
        return path
    }

    private fun tar(archive: File): TarArchiveInputStream = TarArchiveInputStream(
        BufferedInputStream(GZIPInputStream(FileInputStream(archive))),
    )

    private fun writeTransactionMarker() {
        FileOutputStream(transactionFile).use { it.write("incomplete".toByteArray()) }
    }

    private fun File.deleteRecursivelyOrThrow() {
        if (exists() && !deleteRecursively()) throw MigrationException("Could not delete ${name}")
    }

    private fun File.deleteOrThrow() {
        if (exists() && !delete()) throw MigrationException("Could not delete ${name}")
    }

    private fun move(from: File, to: File, action: String) {
        if (!from.renameTo(to)) throw MigrationException("Could not $action")
    }

    private fun Exception.asMigrationException(): MigrationException = when (this) {
        is MigrationException -> this
        is IOException -> MigrationException("Could not read migration archive", this)
        else -> MigrationException(message ?: "Migration failed", this)
    }

    companion object {
        const val DATA_DIRECTORY = "data"
        const val DATABASE_NAME = "vibe-tavern.db"
        private const val ARCHIVE_ROOT = "vibe-tavern"
        private const val STAGING_DIRECTORY = ".migration-staging"
        private const val BACKUP_DIRECTORY = ".migration-backup"
        private const val TRANSACTION_FILE = ".migration-transaction"
    }
}

class MigrationException(message: String, cause: Throwable? = null) : Exception(message, cause)

package com.vibetavern.launcher

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.util.zip.GZIPOutputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.archivers.tar.TarConstants
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyMigrationTest {
    @Test
    fun `valid nested archive extracts only under private staging`() = withTempFiles { filesDir ->
        val archive = archive(filesDir, file("vibe-tavern/vibe-tavern.db", "database"), file("vibe-tavern/assets/avatar.png", "image"))

        val prepared = LegacyMigration(filesDir).prepare(archive)

        assertEquals("database", File(prepared.data, "vibe-tavern.db").readText())
        assertEquals("image", File(prepared.data, "assets/avatar.png").readText())
        assertTrue(prepared.data.canonicalPath.startsWith(filesDir.canonicalPath))
    }

    @Test
    fun `missing database and corrupt gzip are rejected without staging leftovers`() = withTempFiles { filesDir ->
        val manager = LegacyMigration(filesDir)
        val missingDb = archive(filesDir, file("vibe-tavern/settings.json", "{}"))
        val corrupt = File(filesDir, "corrupt.tar.gz").apply { writeBytes(byteArrayOf(1, 2, 3)) }

        assertFails { manager.prepare(missingDb) }
        assertFails { manager.prepare(corrupt) }
        assertFalse(filesDir.listFiles().orEmpty().any { it.name.startsWith(".migration-staging-") })
    }

    @Test
    fun `truncated gzip and unsafe paths are rejected`() = withTempFiles { filesDir ->
        val source = archive(filesDir, file("vibe-tavern/vibe-tavern.db", "database"))
        val truncated = File(filesDir, "truncated.tar.gz").apply { writeBytes(source.readBytes().dropLast(8).toByteArray()) }
        val manager = LegacyMigration(filesDir)

        assertFails { manager.prepare(truncated) }
        listOf("../vibe-tavern/vibe-tavern.db", "/vibe-tavern/vibe-tavern.db", "vibe-tavern\\vibe-tavern.db").forEachIndexed { index, path ->
            assertFails { manager.prepare(archive(filesDir, file(path, "database", "unsafe-$index.tar.gz"))) }
        }
    }

    @Test
    fun `links special entries and duplicates are rejected`() = withTempFiles { filesDir ->
        val manager = LegacyMigration(filesDir)
        val symlink = TarArchiveEntry("vibe-tavern/link", TarConstants.LF_SYMLINK).apply { linkName = "target" }
        val hardlink = TarArchiveEntry("vibe-tavern/link", TarConstants.LF_LINK).apply { linkName = "target" }
        val fifo = TarArchiveEntry("vibe-tavern/pipe", TarConstants.LF_FIFO)

        assertFails { manager.prepare(archive(filesDir, file("vibe-tavern/vibe-tavern.db", "database"), raw(symlink, ""), name = "symlink.tar.gz")) }
        assertFails { manager.prepare(archive(filesDir, file("vibe-tavern/vibe-tavern.db", "database"), raw(hardlink, ""), name = "hardlink.tar.gz")) }
        assertFails { manager.prepare(archive(filesDir, file("vibe-tavern/vibe-tavern.db", "database"), raw(fifo, ""), name = "fifo.tar.gz")) }
        assertFails { manager.prepare(archive(filesDir, file("vibe-tavern/vibe-tavern.db", "one"), file("vibe-tavern/vibe-tavern.db", "two"), name = "duplicate.tar.gz")) }
    }

    @Test
    fun `successful swap replaces native data only after health readiness`() = withTempFiles { filesDir ->
        val oldData = File(filesDir, "data").apply { mkdirs() }
        File(oldData, "vibe-tavern.db").writeText("old")
        val manager = LegacyMigration(filesDir)
        val prepared = manager.prepare(archive(filesDir, file("vibe-tavern/vibe-tavern.db", "new")))
        var started = false

        manager.activate(prepared, { started = true }, {}, { true })

        assertTrue(started)
        assertEquals("new", File(filesDir, "data/vibe-tavern.db").readText())
        assertFalse(File(filesDir, ".migration-backup").exists())
    }

    @Test
    fun `health failure restores old data and no-data state`() = withTempFiles { filesDir ->
        val oldData = File(filesDir, "data").apply { mkdirs() }
        File(oldData, "vibe-tavern.db").writeText("old")
        val manager = LegacyMigration(filesDir)
        var stopped = false
        assertFails {
            manager.activate(manager.prepare(archive(filesDir, file("vibe-tavern/vibe-tavern.db", "new"))), {}, { stopped = true }, { false })
        }
        assertTrue(stopped)
        assertEquals("old", File(filesDir, "data/vibe-tavern.db").readText())

        File(filesDir, "data").deleteRecursively()
        assertFails {
            manager.activate(manager.prepare(archive(filesDir, file("vibe-tavern/vibe-tavern.db", "new"))), {}, {}, { false })
        }
        assertFalse(File(filesDir, "data").exists())
    }

    @Test
    fun `interrupted transaction conservatively restores backup`() = withTempFiles { filesDir ->
        File(filesDir, ".migration-transaction").writeText("incomplete")
        File(filesDir, ".migration-backup").apply { mkdirs() }.resolve("vibe-tavern.db").writeText("old")
        File(filesDir, "data").apply { mkdirs() }.resolve("vibe-tavern.db").writeText("new")

        LegacyMigration(filesDir).recoverIncompleteTransaction()

        assertEquals("old", File(filesDir, "data/vibe-tavern.db").readText())
        assertFalse(File(filesDir, ".migration-transaction").exists())
    }

    private fun archive(filesDir: File, vararg entries: FixtureEntry, name: String = "migration.tar.gz"): File {
        val archive = File(filesDir, name)
        GZIPOutputStream(FileOutputStream(archive)).use { gzip ->
            TarArchiveOutputStream(gzip).use { tar ->
                tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
                entries.forEach { fixture ->
                    fixture.entry.size = fixture.content.toByteArray().size.toLong()
                    tar.putArchiveEntry(fixture.entry)
                    if (fixture.content.isNotEmpty()) tar.write(fixture.content.toByteArray())
                    tar.closeArchiveEntry()
                }
                tar.finish()
            }
        }
        return archive
    }

    private fun file(path: String, content: String, name: String = path): FixtureEntry = FixtureEntry(TarArchiveEntry(name), content)
    private fun raw(entry: TarArchiveEntry, content: String): FixtureEntry = FixtureEntry(entry, content)
    private data class FixtureEntry(val entry: TarArchiveEntry, val content: String)

    private fun assertFails(action: () -> Unit) {
        try {
            action()
            throw AssertionError("Expected migration operation to fail")
        } catch (_: MigrationException) {
            // Expected boundary failure.
        }
    }

    private fun withTempFiles(action: (File) -> Unit) {
        val filesDir = Files.createTempDirectory("legacy-migration-test").toFile()
        try {
            action(filesDir)
        } finally {
            filesDir.deleteRecursively()
        }
    }
}

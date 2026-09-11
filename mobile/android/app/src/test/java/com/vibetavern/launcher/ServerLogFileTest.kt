package com.vibetavern.launcher

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class ServerLogFileTest {
    @Test
    fun `clearing an inactive server log truncates the persisted file`() {
        val directory = Files.createTempDirectory("server-log-test").toFile()
        try {
            val logFile = File(directory, "server.log").apply { writeText("old output\n") }

            clearInactiveServerLog(logFile)

            assertEquals("", logFile.readText())
        } finally {
            directory.deleteRecursively()
        }
    }
}

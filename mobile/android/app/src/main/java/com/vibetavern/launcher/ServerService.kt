package com.vibetavern.launcher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Foreground owner for the native Vibe Tavern server child process. */
class ServerService : Service() {

    companion object {
        const val PORT = 8787
        const val BASE_URL = "http://127.0.0.1:$PORT"
        const val CHANNEL_ID = "vibe_tavern_server"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.vibetavern.launcher.STOP_SERVER"

        private const val TAG = "ServerService"
        private const val READINESS_CONNECT_TIMEOUT_MS = 1_000
        private const val READINESS_READ_TIMEOUT_MS = 1_000
        private const val READINESS_TIMEOUT_SECONDS = 120

        /** The process started by this service, never a process discovered by port probing. */
        @Volatile
        var serverProcess: Process? = null
            private set

        @Volatile
        private var activeLogWriter: ServerLogWriter? = null

        fun start(context: Context) {
            val intent = Intent(context, ServerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ServerService::class.java))
        }

        fun hasOwnedServerProcess(): Boolean = serverProcess?.isAlive == true

        /** True only after the mounted API, rather than the bind-first web placeholder, answers. */
        fun apiReady(): Boolean {
            var connection: HttpURLConnection? = null
            return try {
                connection = URL("$BASE_URL/api/runtime/version").openConnection() as HttpURLConnection
                connection.connectTimeout = READINESS_CONNECT_TIMEOUT_MS
                connection.readTimeout = READINESS_READ_TIMEOUT_MS
                connection.useCaches = false
                connection.responseCode in 200..299
            } catch (e: IOException) {
                false
            } finally {
                connection?.disconnect()
            }
        }

        /** Clears the active launch log under the same lock used by the output pump. */
        fun requestLogClear() {
            activeLogWriter?.clear()
        }
    }

    private val lifecycleLock = Any()
    private var runnerThread: Thread? = null

    @Volatile
    private var stopRequested = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopOwnedServer()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification("starting…"))
        startForegroundFlow()
        return START_NOT_STICKY
    }

    private fun startForegroundFlow() {
        synchronized(lifecycleLock) {
            if (runnerThread?.isAlive == true) return
            stopRequested = false
            runnerThread = thread(name = "vt-native-server-owner") {
                runServer()
            }
        }
    }

    private fun runServer() {
        if (stopRequested) return

        val launchedServer = try {
            launchServer()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch native server", e)
            updateNotification("failed to start — see server.log")
            return
        }
        val process = launchedServer.process

        if (stopRequested) {
            process.destroy()
        }

        var ready = false
        for (elapsedSeconds in 0..READINESS_TIMEOUT_SECONDS) {
            if (!process.isAlive) break
            if (apiReady()) {
                ready = true
                break
            }
            updateNotification("warming up… ${elapsedSeconds}s")
            try {
                Thread.sleep(1_000)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.i(TAG, "Server readiness wait interrupted")
                break
            }
        }
        updateNotification(if (ready) "running at $BASE_URL" else "not ready — see server.log")

        // This is deliberately the same thread that called ProcessBuilder.start(). Bun's
        // --no-orphans uses PDEATHSIG, so returning from the forking thread would kill the child.
        try {
            val exitCode = process.waitFor()
            try {
                launchedServer.logPump.join()
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.i(TAG, "Server log pump join interrupted", e)
            }
            launchedServer.logWriter.writeLine("server exited with code $exitCode")
            if (!stopRequested) {
                updateNotification("server stopped (code $exitCode)")
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.i(TAG, "Server owner wait interrupted", e)
        } finally {
            if (serverProcess === process) {
                serverProcess = null
            }
            launchedServer.logWriter.close()
            if (activeLogWriter === launchedServer.logWriter) {
                activeLogWriter = null
            }
        }
    }

    private fun launchServer(): LaunchedServer {
        val binary = File(applicationInfo.nativeLibraryDir, "libvibetavern.so")
        check(binary.exists()) { "libvibetavern.so missing in ${applicationInfo.nativeLibraryDir}" }

        val logWriter = ServerLogWriter(File(filesDir, "server.log"))
        activeLogWriter?.close()
        activeLogWriter = logWriter

        val payloadDir = File(filesDir, "payload")
        val processBuilder = ProcessBuilder(binary.absolutePath).apply {
            directory(filesDir)
            redirectErrorStream(true)
        }
        val environment = processBuilder.environment()
        environment["VIBE_TAVERN_HOST"] = "127.0.0.1"
        environment["VIBE_TAVERN_PORT"] = PORT.toString()
        environment["VIBE_TAVERN_DATA_DIR"] = File(filesDir, "data").absolutePath
        environment["VIBE_TAVERN_WEB_DIR"] = File(payloadDir, "web").absolutePath
        environment["VIBE_TAVERN_MIGRATIONS_DIR"] = File(payloadDir, "drizzle").absolutePath
        environment["VIBE_TAVERN_TOKENIZER_DIR"] = File(payloadDir, "tokenizers").absolutePath
        environment["VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR"] = File(payloadDir, "prompts").absolutePath
        environment["VIBE_TAVERN_ROOT_DIR"] = payloadDir.absolutePath
        environment["VIBE_TAVERN_OPEN_BROWSER"] = "0"
        environment["BUN_OPTIONS"] = "--no-orphans"
        environment["HOME"] = filesDir.absolutePath
        environment["TMPDIR"] = cacheDir.absolutePath

        // Do not move this start() into a helper thread: runServer() remains parked on waitFor().
        val process = try {
            processBuilder.start()
        } catch (e: IOException) {
            logWriter.writeLine("failed to start server: ${e.message}")
            logWriter.close()
            if (activeLogWriter === logWriter) {
                activeLogWriter = null
            }
            throw e
        }
        serverProcess = process
        return LaunchedServer(process, logWriter, startLogPump(process, logWriter))
    }

    private fun startLogPump(process: Process, logWriter: ServerLogWriter): Thread {
        return thread(name = "vt-native-server-log") {
            try {
                process.inputStream.bufferedReader().useLines { lines ->
                    lines.forEach(logWriter::writeLine)
                }
            } catch (e: IOException) {
                Log.w(TAG, "Server log pump failed", e)
                logWriter.writeLine("log pump failed: ${e.message}")
            }
        }
    }

    private data class LaunchedServer(
        val process: Process,
        val logWriter: ServerLogWriter,
        val logPump: Thread,
    )

    private fun stopOwnedServer() {
        stopRequested = true
        val process = serverProcess
        if (process != null && process.isAlive) {
            process.destroy()
        }
    }

    override fun onDestroy() {
        stopOwnedServer()
        super.onDestroy()
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, ServerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Vibe Tavern")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .addAction(0, "Stop", stopIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Vibe Tavern Server",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shown while your server is running"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private class ServerLogWriter(private val logFile: File) {
        private val lock = Any()
        private var stream = FileOutputStream(logFile, false).also {
            it.write("\n==== launch at ${System.currentTimeMillis()} ====\n".toByteArray())
            it.flush()
        }

        fun writeLine(line: String) {
            synchronized(lock) {
                try {
                    stream.write((line + "\n").toByteArray())
                    stream.flush()
                } catch (e: IOException) {
                    Log.w(TAG, "Could not write server log", e)
                }
            }
        }

        fun clear() {
            synchronized(lock) {
                try {
                    stream.close()
                    stream = FileOutputStream(logFile, false)
                } catch (e: IOException) {
                    Log.w(TAG, "Could not clear server log", e)
                }
            }
        }

        fun close() {
            synchronized(lock) {
                try {
                    stream.close()
                } catch (e: IOException) {
                    Log.w(TAG, "Could not close server log", e)
                }
            }
        }
    }
}

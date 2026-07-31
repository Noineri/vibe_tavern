package com.vibetavern.launcher

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
import androidx.core.content.ContextCompat
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class PayloadTransferService : Service() {
    companion object {
        private const val CHANNEL_ID = "vibe_tavern_payload_transfer"
        private const val NOTIFICATION_ID = 2
        private const val ARCHIVE_NAME = "vibe-tavern-android-arm64.tgz"
        private const val PREFS = "vibe_tavern_launcher"
        private const val PREF_LANGUAGE = "language"
        const val PORT = 8790
        const val ARCHIVE_URL = "http://127.0.0.1:$PORT/$ARCHIVE_NAME"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, PayloadTransferService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PayloadTransferService::class.java))
        }
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var transferJob: Job? = null
    private var serverSocket: ServerSocket? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (transferJob?.isActive != true) {
            transferJob = serviceScope.launch { serveArchiveOnce() }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serviceScope.cancel()
        serverSocket?.close()
        super.onDestroy()
    }

    private fun serveArchiveOnce() {
        try {
            val server = ServerSocket().apply {
                reuseAddress = true
                soTimeout = 20 * 60 * 1000
                bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 8)
            }
            serverSocket = server
            while (serviceScope.isActive) {
                val completed = server.accept().use { socket ->
                    val request = readRequest(socket.getInputStream())
                    val isHead = request.startsWith("HEAD /$ARCHIVE_NAME ")
                    val isGet = request.startsWith("GET /$ARCHIVE_NAME ")
                    val output = socket.getOutputStream()
                    if (!isHead && !isGet) {
                        output.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n".toByteArray())
                        output.flush()
                        return@use false
                    }
                    output.write("HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nConnection: close\r\n\r\n".toByteArray())
                    if (isGet) {
                        assets.open(ARCHIVE_NAME).use { archive -> archive.copyTo(output) }
                    }
                    output.flush()
                    isGet
                }
                if (completed) {
                    stopSelf()
                    return
                }
            }
        } catch (_: SocketTimeoutException) {
            stopSelf()
        } catch (error: Exception) {
            if (serviceScope.isActive) Log.e("PayloadTransferService", "Payload transfer failed", error)
            stopSelf()
        }
    }

    private fun readRequest(input: java.io.InputStream): String = buildString {
        val buffer = ByteArray(1024)
        while (length < 8192) {
            val read = input.read(buffer)
            if (read <= 0) break
            append(String(buffer, 0, read))
            if (contains("\r\n\r\n")) break
        }
    }

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("Vibe Tavern")
        .setContentText(tr(
            "Preparing the bundled server for Termux",
            "Подготовка встроенного сервера для Termux",
        ))
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setOngoing(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    tr("Vibe Tavern server installation", "Установка сервера Vibe Tavern"),
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        }
    }

    private fun tr(en: String, ru: String): String {
        val savedLanguage = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_LANGUAGE, null)
        val language = savedLanguage ?: Locale.getDefault().language
        return if (language == "ru") ru else en
    }
}

package com.vibetavern.launcher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class ServerService : Service() {

    companion object {
        const val CHANNEL_ID = "vibe_tavern_server"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.vibetavern.launcher.STOP_SERVER"

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
    }

    private val stopReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            // Stop Termux server processes
            try {
                val stopIntent = Intent().apply {
                    component = ComponentName("com.termux", "com.termux.app.RunCommandService")
                    action = "com.termux.RUN_COMMAND"
                    putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
                    putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", """
                        if command -v proot-distro >/dev/null 2>&1 && proot-distro list 2>&1 | grep -q ubuntu; then
                          proot-distro login ubuntu -- bash -lc 'pkill -TERM -x "vibe-tavern" 2>/dev/null || true; sleep 2; pkill -KILL -x "vibe-tavern" 2>/dev/null || true' || true
                        fi
                        pkill -TERM -x 'vibe-tavern' 2>/dev/null || true
                        sleep 1
                        pkill -KILL -x 'vibe-tavern' 2>/dev/null || true
                        termux-wake-unlock 2>/dev/null || true
                        echo stopped
                    """.trimIndent()))
                    putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
                }
                startService(stopIntent)
            } catch (_: Exception) { }

            stopSelf()
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        registerReceiver(stopReceiver, IntentFilter(ACTION_STOP), RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopPendingIntent = PendingIntent.getBroadcast(
            this, 1,
            Intent(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Vibe Tavern")
            .setContentText("Server is running — tap to open")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(0, "Stop Server", stopPendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try { unregisterReceiver(stopReceiver) } catch (_: Exception) { }
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Vibe Tavern Server",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shown while your server is running"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}

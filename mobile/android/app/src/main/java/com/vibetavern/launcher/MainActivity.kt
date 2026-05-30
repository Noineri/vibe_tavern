package com.vibetavern.launcher

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var progressText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var openBtn: Button
    private lateinit var stopBtn: Button
    private lateinit var setupBtn: Button
    private lateinit var launchBtn: Button
    private lateinit var uninstallBtn: Button
    private lateinit var languageBtn: Button

    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var pollingJob: Job? = null
    private var archiveServerJob: Job? = null

    private val RUN_CMD_PERM = "com.termux.permission.RUN_COMMAND"
    private val TERMUX_RESULT_ACTION = "com.vibetavern.launcher.TERMUX_RESULT"
    private val PREFS = "vibe_tavern_launcher"
    private val PREF_INSTALLED = "installed_once"
    private val PREF_LANGUAGE = "language"
    private val serverUrl = "http://127.0.0.1:8787"
    private val launcherBuildLabel = "orchestrator-v2-startlog-safe-step4-2026-05-29-0028"
    private val bundledArchiveName = "vibe-tavern-android-arm64.tgz"
    private val installerScriptName = "vibe-tavern-install-v5.sh"
    private val archiveServerPort = 8790
    private val sharedArchivePath = "/sdcard/Download/$bundledArchiveName"
    private val sharedInstallerPath = "/sdcard/Download/$installerScriptName"
    private val localArchiveUrl = "http://127.0.0.1:$archiveServerPort/$bundledArchiveName"

    // ========== One-time setup script (proot-distro Ubuntu + bundled archive) ==========
    private val setupScript: String
        get() = """
            set -euo pipefail
            ARCHIVE_PATH="$sharedArchivePath"
            ARCHIVE_URL="$localArchiveUrl"
            LOG="${'$'}HOME/vibe-tavern-install.log"
            exec > >(tee -a "${'$'}LOG") 2>&1
            echo "=== Vibe Tavern install: $(date) ==="

            if [ ! -f "${'$'}ARCHIVE_PATH" ]; then
              ARCHIVE_PATH="${'$'}(ls -t /sdcard/Download/vibe-tavern-android-arm64*.tgz /sdcard/Download/vibe-tavern-android-arm64*.tar.gz 2>/dev/null | head -n1 || true)"
            fi
            pkg update -y
            pkg install -y curl tar proot-distro procps
            echo y | termux-setup-storage || true
            termux-wake-lock 2>/dev/null || true

            TERMUX_ARCHIVE="${'$'}HOME/$bundledArchiveName"
            if [ -n "${'$'}ARCHIVE_PATH" ] && [ -f "${'$'}ARCHIVE_PATH" ]; then
              cp "${'$'}ARCHIVE_PATH" "${'$'}TERMUX_ARCHIVE"
            else
              echo "Archive not visible in Downloads; downloading from APK localhost server: ${'$'}ARCHIVE_URL"
              curl -fL "${'$'}ARCHIVE_URL" -o "${'$'}TERMUX_ARCHIVE"
            fi

            proot-distro install ubuntu 2>/dev/null || true

            mkdir -p ~/.termux
            grep -qxF 'allow-external-apps=true' ~/.termux/termux.properties 2>/dev/null || echo 'allow-external-apps=true' >> ~/.termux/termux.properties
            termux-reload-settings 2>/dev/null || true

            proot-distro login ubuntu -- bash -s -- "${'$'}TERMUX_ARCHIVE" <<'UBUNTU_INSTALL'
            set -euo pipefail
            ARCHIVE_PATH="${'$'}1"
            APP_DIR="${'$'}HOME/vibe-tavern"
            DATA_DIR="${'$'}HOME/.local/share/vibe-tavern"
            TMP_ARCHIVE="/tmp/vibe-tavern-android-arm64.tgz"
            NEXT_DIR="${'$'}HOME/vibe-tavern.next"
            OLD_DIR="${'$'}HOME/vibe-tavern.old"

            export DEBIAN_FRONTEND=noninteractive
            apt-get update -y
            apt-get install -y ca-certificates curl tar procps
            mkdir -p "${'$'}DATA_DIR"
            cp "${'$'}ARCHIVE_PATH" "${'$'}TMP_ARCHIVE"

            rm -rf "${'$'}NEXT_DIR"
            mkdir -p "${'$'}NEXT_DIR"
            tar -xzf "${'$'}TMP_ARCHIVE" -C "${'$'}NEXT_DIR"
            chmod +x "${'$'}NEXT_DIR/vibe-tavern"

            rm -rf "${'$'}OLD_DIR"
            if [ -d "${'$'}APP_DIR" ]; then mv "${'$'}APP_DIR" "${'$'}OLD_DIR"; fi
            mv "${'$'}NEXT_DIR" "${'$'}APP_DIR"
            rm -rf "${'$'}OLD_DIR" "${'$'}TMP_ARCHIVE"

            cat > "${'$'}HOME/start-vibe-tavern.sh" <<'START_SCRIPT'
            #!/usr/bin/env bash
            set -euo pipefail
            export RP_PLATFORM_OPEN_BROWSER=0
            export RP_PLATFORM_HOST=127.0.0.1
            export RP_PLATFORM_PORT=8787
            export RP_PLATFORM_DATA_DIR="${'$'}HOME/.local/share/vibe-tavern"
            export RP_PLATFORM_WEB_DIR="${'$'}HOME/vibe-tavern/web"
            cd "${'$'}HOME/vibe-tavern"
            exec ./vibe-tavern
            START_SCRIPT
            chmod +x "${'$'}HOME/start-vibe-tavern.sh"
            UBUNTU_INSTALL
            echo '✅ Vibe Tavern installed/updated from bundled APK archive.'
            echo '🚀 Starting server in this Termux session...'
            proot-distro login ubuntu -- bash -lc 'exec ~/start-vibe-tavern.sh'
        """.trimIndent() + "\n"

    // ========== Quick launch (post-setup, inside proot) ==========
    private val startCmd = """
        clear
        LOG="${'$'}HOME/vibe-tavern-start.log"
        exec > >(tee -a "${'$'}LOG") 2>&1
        echo '=== Vibe Tavern server start ==='
        echo 'Launcher build: $launcherBuildLabel'
        echo "Time: $(date)"
        echo "Log: ${'$'}LOG"
        echo
        echo 'This is the diagnostic start log. If startup fails, this screen will stay open.'
        echo 'Keep Termux open while using Vibe Tavern.'
        echo

        echo '[1/6] Checking Termux environment...'
        echo "TERMUX_VERSION=${'$'}{TERMUX_VERSION:-unknown}"
        echo "HOME=${'$'}HOME"
        pwd || true
        echo

        echo '[2/6] Checking required commands...'
        if ! command -v proot-distro >/dev/null 2>&1; then
          echo '❌ proot-distro is not installed. Run Install / Update from the APK first.'
          echo
          echo 'Press Enter to close this Termux session.'
          read -r _
          exit 1
        fi
        command -v proot-distro || true
        echo

        echo '[3/6] Checking Ubuntu proot...'
        proot-distro list || true
        if ! proot-distro list 2>&1 | grep -q 'ubuntu'; then
          echo '❌ Ubuntu proot is missing. Run Install / Update from the APK first.'
          echo
          echo 'Press Enter to close this Termux session.'
          read -r _
          exit 1
        fi
        echo

        echo '[4/6] Skipping stale process cleanup during Start...'
        echo 'Start no longer runs wake-lock, pgrep, or pkill here because some Android/Termux builds close the foreground session during cleanup.'
        echo 'If a stale server is already running, use Stop Server first, then Start again.'
        echo 'Step 4 OK'
        echo

        echo '[5/6] Inspecting files inside proot...'
        proot-distro login ubuntu -- bash -lc '
          set -u
          echo "proot HOME=${'$'}HOME"
          echo "start script:"
          ls -l "${'$'}HOME/start-vibe-tavern.sh" 2>/dev/null || true
          echo "app dir:"
          ls -la "${'$'}HOME/vibe-tavern" 2>/dev/null || true
          echo "data dir:"
          ls -la "${'$'}HOME/.local/share/vibe-tavern" 2>/dev/null || true
        '
        inspect_code=${'$'}?
        echo "Inspect exited with code ${'$'}inspect_code"
        echo

        echo '[6/6] Starting server inside proot...'
        echo 'If startup succeeds, this terminal becomes the server log.'
        echo
        proot-distro login ubuntu -- bash -lc '
          set -euxo pipefail
          if [ -x "${'$'}HOME/start-vibe-tavern.sh" ]; then
            bash -x "${'$'}HOME/start-vibe-tavern.sh"
          elif [ -x "${'$'}HOME/vibe-tavern/vibe-tavern" ]; then
            export RP_PLATFORM_OPEN_BROWSER=0
            export RP_PLATFORM_HOST=127.0.0.1
            export RP_PLATFORM_PORT=8787
            export RP_PLATFORM_DATA_DIR="${'$'}HOME/.local/share/vibe-tavern"
            export RP_PLATFORM_WEB_DIR="${'$'}HOME/vibe-tavern/web"
            cd "${'$'}HOME/vibe-tavern"
            exec ./vibe-tavern
          else
            echo ERROR_NO_ARCHIVE_INSTALL
            echo "Install or update Vibe Tavern from the APK first."
            exit 1
          fi
        '
        code=${'$'}?
        echo
        echo "❌ Server process exited with code ${'$'}code"
        echo "Log saved at: ${'$'}LOG"
        echo
        echo 'Common fixes:'
        echo '- Run Install / Update from the APK if files are missing.'
        echo '- Make sure Termux is from F-Droid.'
        echo '- Disable battery optimization for Termux if it gets killed or lags.'
        echo
        echo 'Press Enter to close this Termux session.'
        read -r _
        exit "${'$'}code"
    """.trimIndent()

    private val stopCmd = """
        LOG="${'$'}HOME/vibe-tavern-stop.log"
        exec > >(tee -a "${'$'}LOG") 2>&1
        echo '=== Vibe Tavern server stop ==='
        echo "Time: $(date)"
        echo "Log: ${'$'}LOG"
        echo

        echo '[1/4] Processes before stop, exact process name only:'
        pgrep -ax 'vibe-tavern' || true
        echo

        echo '[2/4] Asking server process to stop inside proot...'
        if command -v proot-distro >/dev/null 2>&1 && proot-distro list 2>&1 | grep -q 'ubuntu'; then
          proot-distro login ubuntu -- bash -lc '
            set +e
            echo "Inside proot before stop, exact process name only:"
            pgrep -ax "vibe-tavern" || true
            pkill -TERM -x "vibe-tavern" 2>/dev/null || true
            sleep 2
            pkill -KILL -x "vibe-tavern" 2>/dev/null || true
            echo "Inside proot after stop, exact process name only:"
            pgrep -ax "vibe-tavern" || true
          ' || true
        else
          echo 'Ubuntu proot not found; skipping proot stop.'
        fi
        echo

        echo '[3/4] Stopping any remaining Termux-side exact-name process...'
        pkill -TERM -x 'vibe-tavern' 2>/dev/null || true
        sleep 1
        pkill -KILL -x 'vibe-tavern' 2>/dev/null || true
        termux-wake-unlock 2>/dev/null || true
        echo

        echo '[4/4] Processes after stop, exact process name only:'
        pgrep -ax 'vibe-tavern' || true
        echo 'Done.'
    """.trimIndent()

    private val resultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val errMsg = intent?.getStringExtra("com.termux.RUN_COMMAND_RESULT_ERRMSG")
            val stderr = intent?.getStringExtra("com.termux.RUN_COMMAND_RESULT_STDERR")
            if (!errMsg.isNullOrBlank()) {
                progressText.text = "❌ Termux: $errMsg"
                progressText.visibility = View.VISIBLE
                progressBar.visibility = View.GONE
            } else if (!stderr.isNullOrBlank()) {
                progressText.text = "⚠️ Termux: ${stderr.take(180)}"
                progressText.visibility = View.VISIBLE
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            ContextCompat.checkSelfPermission(this, RUN_CMD_PERM) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(RUN_CMD_PERM), 0)
        }

        when {
            !isTermuxInstalled() -> showTermuxInstallGuide()
            !hasRunCommandPermission() -> showPermissionGuide()
            else -> showLaunchScreen()
        }
    }

    override fun onResume() {
        super.onResume()
        if (::statusText.isInitialized) refreshServerStatus(showChecking = false)
    }

    override fun onDestroy() {
        super.onDestroy()
        pollingJob?.cancel()
        archiveServerJob?.cancel()
        mainScope.cancel()
        try { unregisterReceiver(resultReceiver) } catch (_: Exception) {}
    }

    private fun isTermuxInstalled() = try {
        packageManager.getPackageInfo("com.termux", 0); true
    } catch (_: PackageManager.NameNotFoundException) { false }

    private fun hasRunCommandPermission() =
        ContextCompat.checkSelfPermission(this, RUN_CMD_PERM) == PackageManager.PERMISSION_GRANTED

    private fun markInstalled(installed: Boolean) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_INSTALLED, installed).apply()
    }

    private fun wasInstalledOnce(): Boolean =
        getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_INSTALLED, false)

    private fun currentLanguage(): String {
        val saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_LANGUAGE, null)
        if (saved == "ru" || saved == "en") return saved
        return if (Locale.getDefault().language == "ru") "ru" else "en"
    }

    private fun setLanguage(language: String) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_LANGUAGE, language).apply()
    }

    private fun isRu(): Boolean = currentLanguage() == "ru"

    private fun tr(en: String, ru: String): String = if (isRu()) ru else en

    private fun applyLaunchTexts() {
        launchBtn.text = tr("🚀 Start Server in Termux", "🚀 Запустить сервер в Termux")
        openBtn.text = tr("🌐 Open in Browser", "🌐 Открыть в браузере")
        stopBtn.text = tr("⏹ Stop Server", "⏹ Остановить сервер")
        setupBtn.text = if (wasInstalledOnce()) {
            tr("🔄 Update Program", "🔄 Обновить программу")
        } else {
            tr("📦 Install / Update", "📦 Установить / обновить")
        }
        uninstallBtn.text = tr("🗑 Uninstall", "🗑 Удалить")
        languageBtn.text = tr("🌐 Language: English", "🌐 Язык: Русский")
        findViewById<Button>(R.id.btn_help).text = tr("❓ Help / Troubleshooting", "❓ Справка / проблемы")
        findViewById<TextView>(R.id.help_hint).text = tr(
            "Tip: if the web UI lags after switching apps, disable battery optimization for Termux.",
            "Совет: если веб-интерфейс лагает после сворачивания, отключите оптимизацию батареи для Termux."
        )
    }

    // ========== Screens ==========

    private fun showTermuxInstallGuide() {
        setContentView(R.layout.screen_install_termux)
        findViewById<Button>(R.id.btn_install_termux).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/com.termux/")))
        }
        findViewById<Button>(R.id.btn_check_again).setOnClickListener { recreate() }
    }

    private fun showPermissionGuide() {
        setContentView(R.layout.screen_permission_guide)
        findViewById<Button>(R.id.btn_open_termux_settings).setOnClickListener { openAppSettings(packageName) }
        findViewById<Button>(R.id.btn_continue_after_permission).setOnClickListener { recreate() }
    }

    private fun showLaunchScreen() {
        setContentView(R.layout.screen_launch)
        statusText = findViewById(R.id.status_text)
        progressText = findViewById(R.id.progress_text)
        progressBar = findViewById(R.id.progress_bar)
        openBtn = findViewById(R.id.btn_open_browser)
        stopBtn = findViewById(R.id.btn_stop_server)
        setupBtn = findViewById(R.id.btn_one_time_setup)
        launchBtn = findViewById(R.id.btn_launch_server)
        uninstallBtn = findViewById(R.id.btn_uninstall)
        languageBtn = findViewById(R.id.btn_language)

        setupBtn.setOnClickListener { doOneTimeSetup() }
        launchBtn.setOnClickListener { launchServer() }
        openBtn.setOnClickListener { openBrowser() }
        stopBtn.setOnClickListener { stopServer() }
        uninstallBtn.setOnClickListener { confirmUninstall() }
        languageBtn.setOnClickListener { showLanguageDialog() }
        findViewById<Button>(R.id.btn_help).setOnClickListener { showHelpDialog() }

        applyLaunchTexts()
        setProgress(null, visible = false)
        setServerRunningUi(running = false, checking = true)
        refreshServerStatus(showChecking = true)
    }

    // ========== One-time setup ==========

    private fun doOneTimeSetup() {
        setProgress(tr("📦 Copying bundled archive and opening Termux installer…", "📦 Копирую архив и открываю установщик в Termux…"), visible = true)
        statusText.text = tr("📦 Installation/update runs in Termux", "📦 Установка/обновление выполняется в Termux")
        startArchiveServer()
        copyBundledArchiveToDownloads()

        tryRegisterResultReceiver()

        try {
            if (!copyInstallerScriptToDownloads()) {
                setProgress(tr("❌ Failed to copy installer script to Downloads.", "❌ Не удалось скопировать установщик в Downloads."), visible = false)
                return
            }
            runTermuxInstallerVisible()
        } catch (e: Exception) {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("vibe-setup", "bash -x $sharedInstallerPath"))
            setProgress(tr("❌ Could not auto-run Termux: ${e.message}. Installer copied; paste it in Termux.", "❌ Не удалось автоматически запустить Termux: ${e.message}. Установщик скопирован; вставьте команду в Termux."), visible = false)
            openTermux()
            return
        }

        openTermux()
        startPolling(maxAttempts = 1200, waitingLabel = tr("Installing / waiting for server", "Установка / ожидание сервера"), markInstalledOnSuccess = true)
    }

    private fun runTermuxInstallerVisible() {
        val command = """
            clear
            echo '=== Vibe Tavern installer ==='
            echo 'Archive in Downloads:'
            ls -lh '$sharedArchivePath' || true
            echo 'Archive URL fallback: $localArchiveUrl'
            echo 'Installer:'
            ls -lh '$sharedInstallerPath' || true
            echo
            if [ ! -f '$sharedInstallerPath' ]; then
              echo 'ERROR: installer script was not copied to Downloads.'
              echo 'Press Enter to close.'
              read -r _
              exit 1
            fi
            echo 'Starting installer with trace...'
            bash -x '$sharedInstallerPath'
        """.trimIndent()
        runTermuxInline(command, visible = true, sessionName = "Vibe Tavern Installer")
    }

    private fun startArchiveServer() {
        archiveServerJob?.cancel()
        archiveServerJob = mainScope.launch(Dispatchers.IO) {
            val server = ServerSocket(archiveServerPort, 8, InetAddress.getByName("127.0.0.1"))
            try {
                while (isActive) {
                    val socket = server.accept()
                    launch {
                        socket.use {
                            val input = it.getInputStream()
                            val buffer = ByteArray(1024)
                            val request = StringBuilder()
                            while (request.length < 8192) {
                                val read = input.read(buffer)
                                if (read <= 0) break
                                request.append(String(buffer, 0, read))
                                if (request.contains("\r\n\r\n")) break
                            }

                            val output = it.getOutputStream()
                            val requestText = request.toString()
                            val method = if (requestText.startsWith("HEAD ")) "HEAD" else "GET"
                            val header = "HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nConnection: close\r\n\r\n"
                            output.write(header.toByteArray(Charsets.UTF_8))
                            if (method != "HEAD") {
                                assets.open(bundledArchiveName).use { archive -> archive.copyTo(output) }
                            }
                            output.flush()
                        }
                    }
                }
            } finally {
                server.close()
            }
        }
    }

    private fun copyBundledArchiveToDownloads(): Boolean {
        return copyToDownloads(bundledArchiveName, "application/gzip") { output ->
            assets.open(bundledArchiveName).use { input -> input.copyTo(output) }
        }
    }

    private fun copyInstallerScriptToDownloads(): Boolean {
        return copyToDownloads(installerScriptName, "text/x-shellscript") { output ->
            output.write(setupScript.toByteArray(Charsets.UTF_8))
        }
    }

    private fun copyToDownloads(
        displayName: String,
        mimeType: String,
        writeContent: (java.io.OutputStream) -> Unit,
    ): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                contentResolver.delete(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    "${MediaStore.MediaColumns.DISPLAY_NAME}=?",
                    arrayOf(displayName),
                )
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
                contentResolver.openOutputStream(uri)?.use(writeContent) ?: return false
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
            } else {
                val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                downloads.mkdirs()
                val target = File(downloads, displayName)
                target.outputStream().use(writeContent)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    // ========== Server controls ==========

    private fun launchServer() {
        tryRegisterResultReceiver()
        setProgress(tr("🚀 Opening Termux and starting the server visibly…", "🚀 Открываю Termux и запускаю сервер в видимой сессии…"), visible = true)
        statusText.text = tr("🚀 Starting server in Termux", "🚀 Запускаю сервер в Termux") + "\n$launcherBuildLabel"

        try {
            runTermuxInline(startCmd, visible = true, sessionName = "Vibe Tavern Server")
        } catch (e: Exception) {
            setProgress(tr("❌ Could not open Termux: ${e.message}", "❌ Не удалось открыть Termux: ${e.message}"), visible = false)
            return
        }

        openTermux()
        startPolling(maxAttempts = 90, waitingLabel = tr("Waiting for server", "Ожидание сервера"), markInstalledOnSuccess = true)
    }

    private fun stopServer() {
        pollingJob?.cancel()
        tryRegisterResultReceiver()
        setProgress(tr("⏹ Stopping server…", "⏹ Останавливаю сервер…"), visible = true)

        try {
            runTermuxInline(stopCmd, visible = false, sessionName = "Vibe Tavern Stop")
        } catch (e: Exception) {
            setProgress(tr("❌ Could not send stop command to Termux: ${e.message}", "❌ Не удалось отправить команду остановки в Termux: ${e.message}"), visible = false)
            return
        }

        waitForServerStopped()
    }

    private fun waitForServerStopped() {
        mainScope.launch(Dispatchers.IO) {
            var stopped = false
            for (i in 1..12) {
                if (!checkServerOnce()) {
                    stopped = true
                    break
                }
                withContext(Dispatchers.Main) {
                    progressText.text = tr("Stopping server… (${i}s)", "Останавливаю сервер… (${i}s)")
                    progressText.visibility = View.VISIBLE
                }
                delay(1000)
            }

            withContext(Dispatchers.Main) {
                progressBar.visibility = View.GONE
                if (stopped) {
                    ServerService.stop(this@MainActivity)
                    progressText.text = tr("🛑 Server stopped", "🛑 Сервер остановлен")
                    progressText.visibility = View.VISIBLE
                    setServerRunningUi(running = false, checking = false)
                } else {
                    progressText.text = tr("⚠️ Stop command ran, but server still responds. Open Termux and check ~/vibe-tavern-stop.log.", "⚠️ Команда Stop выполнена, но сервер всё ещё отвечает. Откройте Termux и проверьте ~/vibe-tavern-stop.log.")
                    progressText.visibility = View.VISIBLE
                    setServerRunningUi(running = true, checking = false)
                }
            }
        }
    }

    private fun startPolling(
        maxAttempts: Int = 45,
        waitingLabel: String = "Waiting for server",
        markInstalledOnSuccess: Boolean = false,
    ) {
        pollingJob?.cancel()
        pollingJob = mainScope.launch(Dispatchers.IO) {
            var started = false
            for (i in 1..maxAttempts) {
                if (!isActive) return@launch
                withContext(Dispatchers.Main) {
                    progressText.text = "$waitingLabel… (${i}s)"
                    progressText.visibility = View.VISIBLE
                }
                if (checkServerOnce()) {
                    started = true
                    break
                }
                delay(1000)
            }

            withContext(Dispatchers.Main) {
                progressBar.visibility = View.GONE
                if (started) {
                    if (markInstalledOnSuccess) markInstalled(true)
                    setupBtn.text = tr("🔄 Update Program", "🔄 Обновить программу")
                    progressText.text = tr("✅ Server running. Tap Open to use Vibe Tavern.", "✅ Сервер работает. Нажмите «Открыть», чтобы перейти в Vibe Tavern.")
                    progressText.visibility = View.VISIBLE
                    ServerService.start(this@MainActivity)
                    setServerRunningUi(running = true, checking = false)
                } else {
                    progressText.text = tr("⚠️ Server did not respond. Check the visible Termux session or open Help.", "⚠️ Сервер не ответил. Проверьте видимую сессию Termux или откройте справку.")
                    progressText.visibility = View.VISIBLE
                    setServerRunningUi(running = false, checking = false)
                }
            }
        }
    }

    private fun refreshServerStatus(showChecking: Boolean) {
        if (showChecking) setServerRunningUi(running = false, checking = true)
        mainScope.launch(Dispatchers.IO) {
            val running = checkServerOnce()
            withContext(Dispatchers.Main) {
                if (running) {
                    markInstalled(true)
                    setupBtn.text = tr("🔄 Update Program", "🔄 Обновить программу")
                    ServerService.start(this@MainActivity)
                }
                setServerRunningUi(running = running, checking = false)
            }
        }
    }

    private fun checkServerOnce(): Boolean {
        return try {
            val conn = java.net.URL(serverUrl).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 900
            conn.readTimeout = 900
            conn.requestMethod = "GET"
            conn.responseCode in 200..399
        } catch (_: Exception) {
            false
        }
    }

    private fun setServerRunningUi(running: Boolean, checking: Boolean) {
        if (checking) {
            statusText.text = tr("🔎 Checking local server…", "🔎 Проверяю локальный сервер…")
            launchBtn.visibility = View.VISIBLE
            openBtn.visibility = View.GONE
            stopBtn.visibility = View.GONE
            return
        }

        if (running) {
            statusText.text = tr("✅ Server is running", "✅ Сервер работает") + "\n$serverUrl"
            launchBtn.visibility = View.GONE
            openBtn.visibility = View.VISIBLE
            stopBtn.visibility = View.VISIBLE
        } else {
            val installHint = if (wasInstalledOnce()) {
                tr("Installed, server is off", "Установлено, сервер выключен")
            } else {
                tr("Not running. Install/update first if this is a fresh setup.", "Сервер не запущен. Если это первая установка, сначала нажмите «Установить / обновить».")
            }
            statusText.text = "⏹ $installHint"
            launchBtn.visibility = View.VISIBLE
            openBtn.visibility = View.GONE
            stopBtn.visibility = View.GONE
        }
    }

    private fun setProgress(message: String?, visible: Boolean) {
        progressBar.visibility = if (visible) View.VISIBLE else View.GONE
        progressBar.isIndeterminate = true
        progressText.visibility = if (message.isNullOrBlank()) View.GONE else View.VISIBLE
        progressText.text = message ?: ""
    }

    // ========== Termux RUN_COMMAND ==========

    private fun runTermuxInline(command: String, visible: Boolean, sessionName: String? = null) {
        runTermuxBash(arrayOf("-lc", command), visible, sessionName)
    }

    private fun runTermuxBash(arguments: Array<String>, visible: Boolean, sessionName: String? = null) {
        val resultIntent = Intent(TERMUX_RESULT_ACTION).setPackage(packageName)
        val resultPendingIntent = PendingIntent.getBroadcast(
            this,
            1001,
            resultIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val intent = Intent().apply {
            component = ComponentName("com.termux", "com.termux.app.RunCommandService")
            action = "com.termux.RUN_COMMAND"
            putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arguments)
            putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
            putExtra("com.termux.RUN_COMMAND_BACKGROUND", !visible)
            putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0")
            putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", resultPendingIntent)
            putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", sessionName ?: "Vibe Tavern")
            putExtra("com.termux.RUN_COMMAND_COMMAND_DESCRIPTION", "Runs the Vibe Tavern local server/orchestrator command.")
            if (sessionName != null) {
                putExtra("com.termux.RUN_COMMAND_SESSION_NAME", sessionName)
                putExtra("com.termux.RUN_COMMAND_SESSION_CREATE_MODE", "no-session-with-name")
            }
        }
        startService(intent)
    }

    private fun tryRegisterResultReceiver() {
        try {
            registerReceiver(resultReceiver, IntentFilter(TERMUX_RESULT_ACTION), RECEIVER_NOT_EXPORTED)
        } catch (_: Exception) {}
    }

    // ========== Browser / help / settings ==========

    private fun openBrowser() {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(serverUrl)))
    }

    private fun openTermux() {
        packageManager.getLaunchIntentForPackage("com.termux")?.let { startActivity(it) }
    }

    private fun openAppSettings(targetPackage: String) {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", targetPackage, null)
        })
    }

    private fun copyServerUrl() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Vibe Tavern URL", serverUrl))
        setProgress(tr("Copied: $serverUrl", "Скопировано: $serverUrl"), visible = false)
    }

    private fun showLanguageDialog() {
        val languages = arrayOf("Русский", "English")
        val checked = if (isRu()) 0 else 1
        AlertDialog.Builder(this)
            .setTitle(tr("Language", "Язык"))
            .setSingleChoiceItems(languages, checked) { dialog, which ->
                setLanguage(if (which == 0) "ru" else "en")
                applyLaunchTexts()
                setServerRunningUi(running = false, checking = true)
                refreshServerStatus(showChecking = false)
                dialog.dismiss()
            }
            .setNegativeButton(tr("Cancel", "Отмена"), null)
            .show()
    }

    private fun showHelpDialog() {
        val help = if (isRu()) {
            """
                Если Start ничего не делает:
                • Start открывает видимую сессию Termux. Ошибки нужно смотреть там.
                • Termux должен быть установлен из F-Droid, не из Play Store.
                • Vibe Tavern нужно Android-разрешение: Run commands in Termux environment.
                • В Termux должно быть: allow-external-apps=true в ~/.termux/termux.properties.

                Если веб-интерфейс лагает/зависает:
                • Отключите оптимизацию батареи для Termux.
                • Не закрывайте Termux, пока пользуетесь Vibe Tavern.
                • Отключите агрессивный энергосберегающий режим, если он есть.

                Если браузер не открылся:
                • Откройте вручную: $serverUrl
            """.trimIndent()
        } else {
            """
                If Start does nothing:
                • Start opens a visible Termux session. Check that session for errors.
                • Termux must be installed from F-Droid, not Play Store.
                • Vibe Tavern needs Android permission: Run commands in Termux environment.
                • Termux needs: allow-external-apps=true in ~/.termux/termux.properties.

                If the web UI lags/freezes:
                • Disable battery optimization for Termux.
                • Keep Termux open while using Vibe Tavern.
                • Disable aggressive battery saver modes if your phone has them.

                If browser does not open:
                • Open manually: $serverUrl
            """.trimIndent()
        }

        AlertDialog.Builder(this)
            .setTitle(tr("Help / Troubleshooting", "Справка / проблемы"))
            .setMessage(help)
            .setPositiveButton(tr("Open Termux settings", "Открыть настройки Termux")) { _, _ -> openAppSettings("com.termux") }
            .setNegativeButton(tr("Copy URL", "Скопировать URL")) { _, _ -> copyServerUrl() }
            .setNeutralButton(tr("Open Termux", "Открыть Termux")) { _, _ -> openTermux() }
            .show()
    }

    private fun confirmUninstall() {
        val message = if (isRu()) {
            "Что удалить:\n\n" +
                "Удалить Vibe Tavern: удалит программу, чаты/настройки и start script внутри Ubuntu. Ubuntu-контейнер останется.\n\n" +
                "Удалить всё: удалит весь Ubuntu proot-контейнер, который использовался Vibe Tavern."
        } else {
            "Choose what to remove:\n\n" +
                "Delete Vibe Tavern: removes program files, chats/settings, and start script inside Ubuntu. Keeps the Ubuntu container.\n\n" +
                "Delete everything: removes the entire Ubuntu proot container used by Vibe Tavern."
        }
        AlertDialog.Builder(this)
            .setTitle(tr("Uninstall Vibe Tavern", "Удалить Vibe Tavern"))
            .setMessage(message)
            .setPositiveButton(tr("Delete Vibe Tavern", "Удалить Vibe Tavern")) { _, _ -> uninstallVibeTavernOnly() }
            .setNegativeButton(tr("Cancel", "Отмена"), null)
            .setNeutralButton(tr("Delete everything", "Удалить всё")) { _, _ -> uninstallEverything() }
            .show()
    }

    private fun uninstallVibeTavernOnly() {
        pollingJob?.cancel()
        setProgress(tr("🗑 Opening Termux to remove Vibe Tavern files…", "🗑 Открываю Termux для удаления файлов Vibe Tavern…"), visible = true)
        val command = """
            clear
            LOG="${'$'}HOME/vibe-tavern-uninstall.log"
            exec > >(tee -a "${'$'}LOG") 2>&1
            echo '=== Vibe Tavern uninstall: app files only ==='
            echo "Time: $(date)"
            echo "Log: ${'$'}LOG"
            echo
            code=0
            echo '[1/4] Stop server process by exact name...'
            pkill -TERM -x 'vibe-tavern' 2>/dev/null || true
            sleep 1
            pkill -KILL -x 'vibe-tavern' 2>/dev/null || true
            termux-wake-unlock 2>/dev/null || true
            echo
            echo '[2/4] Remove Vibe Tavern files inside Ubuntu, keep container...'
            if command -v proot-distro >/dev/null 2>&1 && proot-distro list 2>&1 | grep -q 'ubuntu'; then
              proot-distro login ubuntu -- bash -lc '
                set -eux
                rm -rf "${'$'}HOME/vibe-tavern" \
                       "${'$'}HOME/.local/share/vibe-tavern" \
                       "${'$'}HOME/start-vibe-tavern.sh" \
                       "${'$'}HOME/vibe-tavern.next" \
                       "${'$'}HOME/vibe-tavern.old"
              ' || code=${'$'}?
              echo "proot removal exit code: ${'$'}code"
            else
              echo 'Ubuntu proot not found; nothing to remove inside Ubuntu.'
            fi
            echo
            echo '[3/4] Remove Termux-side Vibe Tavern logs/archive...'
            rm -f ~/vibe-tavern-install.log ~/vibe-tavern-start.log ~/vibe-tavern-stop.log ~/$bundledArchiveName
            echo
            echo '[4/4] Done.'
            if [ "${'$'}code" -eq 0 ]; then
              echo '✅ Vibe Tavern files removed. Ubuntu container kept.'
            else
              echo "❌ Uninstall finished with errors. Exit code: ${'$'}code"
            fi
            echo "Log saved at: ${'$'}LOG"
            echo 'Press Enter to close this Termux session.'
            read -r _
            exit "${'$'}code"
        """.trimIndent()
        runUninstallCommand(command, "Vibe Tavern Uninstall")
    }

    private fun uninstallEverything() {
        pollingJob?.cancel()
        setProgress(tr("🗑 Opening Termux to remove Ubuntu container…", "🗑 Открываю Termux для удаления Ubuntu-контейнера…"), visible = true)
        val command = """
            clear
            LOG="${'$'}HOME/vibe-tavern-uninstall.log"
            exec > >(tee -a "${'$'}LOG") 2>&1
            echo '=== Vibe Tavern uninstall: everything ==='
            echo "Time: $(date)"
            echo "Log: ${'$'}LOG"
            echo
            code=0
            echo '[1/4] Stop server process by exact name...'
            pkill -TERM -x 'vibe-tavern' 2>/dev/null || true
            sleep 1
            pkill -KILL -x 'vibe-tavern' 2>/dev/null || true
            termux-wake-unlock 2>/dev/null || true
            echo
            echo '[2/4] Remove Ubuntu proot container...'
            proot-distro remove ubuntu || code=${'$'}?
            echo "proot-distro remove exit code: ${'$'}code"
            echo
            echo '[3/4] Remove Termux-side Vibe Tavern logs/archive...'
            rm -f ~/vibe-tavern-install.log ~/vibe-tavern-start.log ~/vibe-tavern-stop.log ~/$bundledArchiveName
            echo
            echo '[4/4] Done.'
            if [ "${'$'}code" -eq 0 ]; then
              echo '✅ Vibe Tavern and Ubuntu proot container removed.'
            else
              echo "❌ Uninstall finished with errors. Exit code: ${'$'}code"
            fi
            echo "Log saved at: ${'$'}LOG"
            echo 'Press Enter to close this Termux session.'
            read -r _
            exit "${'$'}code"
        """.trimIndent()
        runUninstallCommand(command, "Vibe Tavern Remove All")
    }

    private fun runUninstallCommand(command: String, sessionName: String) {
        try {
            runTermuxInline(command, visible = true, sessionName = sessionName)
            openTermux()
        } catch (e: Exception) {
            setProgress(tr("❌ Could not open Termux: ${e.message}", "❌ Не удалось открыть Termux: ${e.message}"), visible = false)
            return
        }
        markInstalled(false)
        ServerService.stop(this)
        setServerRunningUi(running = false, checking = false)
        setupBtn.text = tr("📦 Install / Update", "📦 Установить / обновить")
    }
}

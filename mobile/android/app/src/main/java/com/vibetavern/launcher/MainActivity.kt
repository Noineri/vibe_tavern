package com.vibetavern.launcher

import android.app.DownloadManager
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
import android.widget.ScrollView
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
    private lateinit var firstTimeSetupBtn: Button
    private lateinit var launcherUpdateBtn: Button
    private lateinit var launcherVersionText: TextView

    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val releaseClient = GitHubReleaseClient(
        endpointUrl = BuildConfig.RELEASE_API_URL,
        allowInsecureHttp = BuildConfig.ALLOW_INSECURE_RELEASE_URL,
    )
    private val apkUpdateManager by lazy { ApkUpdateManager(this) }
    private var pollingJob: Job? = null
    private var archiveServerJob: Job? = null
    private var updateCheckJob: Job? = null
    private var downloadPollingJob: Job? = null
    private var downloadReceiverRegistered = false
    private var resultReceiverRegistered = false
    private var installerHandoffInProgress = false
    private var activityStarted = false
    private var pendingUpdateRelease: PublishedRelease? = null
    private var launcherUpdateAction = LauncherUpdateAction.CHECK

    private val RUN_CMD_PERM = "com.termux.permission.RUN_COMMAND"
    private val TERMUX_RESULT_ACTION = "com.vibetavern.launcher.TERMUX_RESULT"
    private val PREFS = "vibe_tavern_launcher"
    private val PREF_INSTALLED = "installed_once"
    private val PREF_PAYLOAD_VERSION = "installed_payload_version"
    private val PREF_LANGUAGE = "language"
    private val serverUrl = "http://127.0.0.1:8787"
    private val launcherBuildLabel = "archive-orchestrator-${BuildConfig.VERSION_NAME}"
    private val bundledArchiveName = "vibe-tavern-android-arm64.tgz"
    private val installerScriptName = "vibe-tavern-install.sh"
    private val archiveServerPort = 8790
    private val sharedArchivePath = "/sdcard/Download/$bundledArchiveName"
    private val sharedInstallerPath = "/sdcard/Download/$installerScriptName"
    private val localArchiveUrl = "http://127.0.0.1:$archiveServerPort/$bundledArchiveName"
    private var installerArchivePath = sharedArchivePath

    // The APK asset `install.sh` is the single installer source of truth.

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

    private val downloadReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            if (apkUpdateManager.isTrackedDownload(downloadId) && ::launcherUpdateBtn.isInitialized) {
                observeLauncherDownload(installWhenReady = true)
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

    override fun onStart() {
        super.onStart()
        activityStarted = true
        if (!downloadReceiverRegistered) {
            ContextCompat.registerReceiver(
                this,
                downloadReceiver,
                IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                ContextCompat.RECEIVER_EXPORTED,
            )
            downloadReceiverRegistered = true
        }
    }

    override fun onResume() {
        super.onResume()
        installerHandoffInProgress = false
        pendingUpdateRelease?.let { release ->
            pendingUpdateRelease = null
            showLauncherUpdateConsent(release)
        }
        if (::statusText.isInitialized) refreshServerStatus(showChecking = false)
        if (::launcherUpdateBtn.isInitialized) {
            if (apkUpdateManager.isAwaitingInstallPermission() && apkUpdateManager.canInstallPackages()) {
                beginDownloadedApkInstall()
            } else {
                observeLauncherDownload(installWhenReady = false)
            }
        }
    }

    override fun onStop() {
        activityStarted = false
        if (downloadReceiverRegistered) {
            unregisterReceiver(downloadReceiver)
            downloadReceiverRegistered = false
        }
        super.onStop()
    }

    override fun onDestroy() {
        pollingJob?.cancel()
        archiveServerJob?.cancel()
        updateCheckJob?.cancel()
        downloadPollingJob?.cancel()
        if (resultReceiverRegistered) {
            unregisterReceiver(resultReceiver)
            resultReceiverRegistered = false
        }
        mainScope.cancel()
        super.onDestroy()
    }

    private fun isTermuxInstalled() = try {
        packageManager.getPackageInfo("com.termux", 0); true
    } catch (_: PackageManager.NameNotFoundException) { false }

    private fun hasRunCommandPermission() =
        ContextCompat.checkSelfPermission(this, RUN_CMD_PERM) == PackageManager.PERMISSION_GRANTED

    private fun markInstalled(installed: Boolean) {
        val editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_INSTALLED, installed)
        if (!installed) editor.remove(PREF_PAYLOAD_VERSION)
        editor.apply()
    }

    private fun markCurrentPayloadInstalled() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean(PREF_INSTALLED, true)
            .putString(PREF_PAYLOAD_VERSION, BuildConfig.VERSION_NAME)
            .apply()
    }

    private fun wasInstalledOnce(): Boolean =
        getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_INSTALLED, false)

    private fun installedPayloadVersion(): String? =
        getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_PAYLOAD_VERSION, null)

    private fun payloadUpdateRequired(): Boolean = installedPayloadVersion() != BuildConfig.VERSION_NAME

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
        findViewById<TextView>(R.id.launch_intro).text = tr(
            "The launcher manages the local server; Vibe Tavern opens in your browser.",
            "Лаунчер управляет локальным сервером, а Vibe Tavern открывается в браузере.",
        )
        findViewById<TextView>(R.id.management_label).text = tr(
            "Launcher and server management",
            "Управление лаунчером и сервером",
        )
        launchBtn.text = tr("🚀 Start Server in Termux", "🚀 Запустить сервер в Termux")
        openBtn.text = tr("🌐 Open in Browser", "🌐 Открыть в браузере")
        stopBtn.text = tr("⏹ Stop Server", "⏹ Остановить сервер")
        updateSetupButtonText()
        uninstallBtn.text = tr("🗑 Uninstall", "🗑 Удалить")
        languageBtn.text = tr("🌐 Language: English", "🌐 Язык: Русский")
        firstTimeSetupBtn.text = tr("🔧 First-Time Setup", "🔧 Первичная настройка")
        updateLauncherActionUi()
        updateVersionStatus()
        findViewById<Button>(R.id.btn_help).text = tr("❓ Help / Troubleshooting", "❓ Справка / проблемы")
        findViewById<TextView>(R.id.help_hint).text = tr(
            "Tip: if the web UI lags after switching apps, disable battery optimization for Termux.",
            "Совет: если веб-интерфейс лагает после сворачивания, отключите оптимизацию батареи для Termux."
        )
    }

    private fun updateSetupButtonText() {
        setupBtn.text = when {
            !wasInstalledOnce() -> tr(
                "📦 Install server v${BuildConfig.VERSION_NAME}",
                "📦 Установить сервер v${BuildConfig.VERSION_NAME}",
            )
            payloadUpdateRequired() -> tr(
                "🔄 Update server to v${BuildConfig.VERSION_NAME}",
                "🔄 Обновить сервер до v${BuildConfig.VERSION_NAME}",
            )
            else -> tr(
                "📦 Reinstall server v${BuildConfig.VERSION_NAME}",
                "📦 Переустановить сервер v${BuildConfig.VERSION_NAME}",
            )
        }
        updateVersionStatus()
    }

    // ========== Screens ==========

    private fun showTermuxInstallGuide() {
        setContentView(R.layout.screen_install_termux)
        findViewById<TextView>(R.id.termux_step_title).text = tr(
            "Step 1: Install Termux",
            "Шаг 1: установите Termux",
        )
        findViewById<TextView>(R.id.termux_install_body).text = tr(
            "Vibe Tavern needs Termux to run the local server on your device.\n\nIMPORTANT: install Termux from F-Droid, not the Play Store. The Play Store version is outdated and will not work.",
            "Vibe Tavern использует Termux для запуска локального сервера на устройстве.\n\nВАЖНО: установите Termux из F-Droid, а не из Play Store. Версия из Play Store устарела и не работает.",
        )
        findViewById<Button>(R.id.btn_install_termux).text = tr(
            "Install Termux from F-Droid",
            "Установить Termux из F-Droid",
        )
        findViewById<Button>(R.id.btn_check_again).text = tr(
            "I've installed it — continue",
            "Termux установлен — продолжить",
        )
        findViewById<Button>(R.id.btn_install_termux).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/com.termux/")))
        }
        findViewById<Button>(R.id.btn_check_again).setOnClickListener { recreate() }
    }

    private fun showPermissionGuide() {
        setContentView(R.layout.screen_permission_guide)
        findViewById<TextView>(R.id.permission_step_title).text = tr(
            "Step 2: Grant Permission",
            "Шаг 2: выдайте разрешение",
        )
        findViewById<TextView>(R.id.permission_guide_body).text = tr(
            "This permission belongs to Vibe Tavern, not Termux.\n\nFirst run this in Termux:\n  mkdir -p ~/.termux\n  echo \"allow-external-apps=true\" >> ~/.termux/termux.properties\n\nIf termux-reload-settings crashes, force stop Termux and open it again.\n\nThen:\n1. Open Vibe Tavern settings below\n2. Use ⋮ → \"Allow restricted settings\"\n3. Open Permissions → ⋮ → \"All permissions\"\n4. Enable \"Run commands in Termux environment\"\n5. Return here and tap Continue",
            "Это разрешение нужно приложению Vibe Tavern, а не Termux.\n\nСначала выполните в Termux:\n  mkdir -p ~/.termux\n  echo \"allow-external-apps=true\" >> ~/.termux/termux.properties\n\nЕсли termux-reload-settings завершается с ошибкой, принудительно остановите Termux и откройте его снова.\n\nЗатем:\n1. Откройте настройки Vibe Tavern кнопкой ниже\n2. Выберите ⋮ → «Разрешить ограниченные настройки»\n3. Откройте «Разрешения» → ⋮ → «Все разрешения»\n4. Включите «Выполнение команд в среде Termux»\n5. Вернитесь сюда и нажмите «Продолжить»",
        )
        findViewById<Button>(R.id.btn_open_termux_settings).text = tr(
            "Open Vibe Tavern Settings",
            "Открыть настройки Vibe Tavern",
        )
        findViewById<Button>(R.id.btn_continue_after_permission).text = tr("Continue", "Продолжить")
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
        firstTimeSetupBtn = findViewById(R.id.btn_first_time_setup)
        launcherUpdateBtn = findViewById(R.id.btn_check_launcher_update)
        launcherVersionText = findViewById(R.id.launcher_version_status)

        setupBtn.setOnClickListener { doOneTimeSetup() }
        firstTimeSetupBtn.setOnClickListener { showFirstTimeSetupGuide() }
        launchBtn.setOnClickListener { launchServer() }
        openBtn.setOnClickListener { openBrowser() }
        stopBtn.setOnClickListener { stopServer() }
        uninstallBtn.setOnClickListener { confirmUninstall() }
        languageBtn.setOnClickListener { showLanguageDialog() }
        launcherUpdateBtn.setOnClickListener { handleLauncherUpdateAction() }
        findViewById<Button>(R.id.btn_help).setOnClickListener { showHelpDialog() }

        apkUpdateManager.cleanupStaleDownload()
        applyLaunchTexts()
        setProgress(null, visible = false)
        setServerRunningUi(running = false, checking = true)
        refreshServerStatus(showChecking = true)
        observeLauncherDownload(installWhenReady = false)
        if (!automaticUpdateCheckStarted && !apkUpdateManager.hasTrackedDownload()) {
            automaticUpdateCheckStarted = true
            checkForLauncherUpdate(manual = false)
        }
    }

    // ========== Launcher update ==========

    private fun updateVersionStatus() {
        if (!::launcherVersionText.isInitialized) return
        val serverVersion = installedPayloadVersion()?.let { "v$it" }
            ?: tr("not applied", "не установлена")
        launcherVersionText.text = tr(
            "Launcher v${BuildConfig.VERSION_NAME} • Server payload $serverVersion",
            "Лаунчер v${BuildConfig.VERSION_NAME} • Серверная часть $serverVersion",
        )
    }

    private fun updateLauncherActionUi() {
        if (!::launcherUpdateBtn.isInitialized) return
        launcherUpdateBtn.text = when (launcherUpdateAction) {
            LauncherUpdateAction.CHECK -> tr(
                "Check for launcher update",
                "Проверить обновление лаунчера",
            )
            LauncherUpdateAction.DOWNLOADING -> tr(
                "Downloading launcher update…",
                "Загрузка обновления лаунчера…",
            )
            LauncherUpdateAction.INSTALL -> tr(
                "Install downloaded launcher update",
                "Установить загруженное обновление лаунчера",
            )
        }
        launcherUpdateBtn.isEnabled = launcherUpdateAction != LauncherUpdateAction.DOWNLOADING
    }

    private fun setLauncherUpdateStatus(message: String) {
        if (!::launcherVersionText.isInitialized) return
        updateVersionStatus()
        launcherVersionText.append("\n$message")
    }

    private fun handleLauncherUpdateAction() {
        when (launcherUpdateAction) {
            LauncherUpdateAction.CHECK -> checkForLauncherUpdate(manual = true)
            LauncherUpdateAction.DOWNLOADING -> Unit
            LauncherUpdateAction.INSTALL -> beginDownloadedApkInstall()
        }
    }

    private fun checkForLauncherUpdate(manual: Boolean) {
        updateCheckJob?.cancel()
        if (manual) {
            launcherUpdateBtn.isEnabled = false
            setLauncherUpdateStatus(tr("Checking GitHub Releases…", "Проверяю GitHub Releases…"))
        }
        updateCheckJob = mainScope.launch {
            when (val decision = releaseClient.checkForUpdate(BuildConfig.VERSION_NAME)) {
                is ReleaseUpdateDecision.UpdateAvailable -> {
                    setLauncherUpdateStatus(tr(
                        "Launcher v${decision.release.version} is available.",
                        "Доступен лаунчер v${decision.release.version}.",
                    ))
                    if (activityStarted) {
                        showLauncherUpdateConsent(decision.release)
                    } else {
                        pendingUpdateRelease = decision.release
                    }
                }
                is ReleaseUpdateDecision.UpToDate -> if (manual) {
                    setLauncherUpdateStatus(tr(
                        "Launcher is up to date.",
                        "Лаунчер уже обновлён.",
                    ))
                }
                is ReleaseUpdateDecision.Unavailable -> if (manual) {
                    setLauncherUpdateStatus(tr(
                        "No compatible Android launcher release was found.",
                        "Совместимый Android-релиз лаунчера не найден.",
                    ))
                }
                is ReleaseUpdateDecision.Error -> if (manual) {
                    setLauncherUpdateStatus(tr(
                        "Update check failed: ${decision.message}",
                        "Не удалось проверить обновление: ${decision.message}",
                    ))
                }
            }
            updateLauncherActionUi()
        }
    }

    private fun showLauncherUpdateConsent(release: PublishedRelease) {
        if (isFinishing || isDestroyed) return
        val padding = (20 * resources.displayMetrics.density).toInt()
        val notes = TextView(this).apply {
            text = tr(
                "Launcher v${release.version}\n\n${release.notes.ifBlank { "No release notes." }}\n\nThe APK will download only if you confirm. Android will then ask you to approve installation.",
                "Лаунчер v${release.version}\n\n${release.notes.ifBlank { "Без примечаний к релизу." }}\n\nAPK загрузится только после подтверждения. Затем Android отдельно попросит разрешить установку.",
            )
            setPadding(padding, padding / 2, padding, padding / 2)
            textSize = 15f
        }
        val scroll = ScrollView(this).apply { addView(notes) }
        AlertDialog.Builder(this)
            .setTitle(tr("Launcher update available", "Доступно обновление лаунчера"))
            .setView(scroll)
            .setPositiveButton(tr("Download APK", "Скачать APK")) { _, _ ->
                startLauncherDownload(release)
            }
            .setNegativeButton(tr("Later", "Позже"), null)
            .show()
    }

    private fun startLauncherDownload(release: PublishedRelease) {
        try {
            apkUpdateManager.enqueue(release)
            launcherUpdateAction = LauncherUpdateAction.DOWNLOADING
            updateLauncherActionUi()
            setLauncherUpdateStatus(tr(
                "Downloading launcher v${release.version}…",
                "Загружаю лаунчер v${release.version}…",
            ))
            observeLauncherDownload(installWhenReady = true)
        } catch (error: Exception) {
            launcherUpdateAction = LauncherUpdateAction.CHECK
            updateLauncherActionUi()
            setLauncherUpdateStatus(tr(
                "Could not start download: ${error.message}",
                "Не удалось начать загрузку: ${error.message}",
            ))
        }
    }

    private fun observeLauncherDownload(installWhenReady: Boolean) {
        downloadPollingJob?.cancel()
        downloadPollingJob = mainScope.launch {
            while (isActive) {
                when (val state = apkUpdateManager.reconcile()) {
                    ApkDownloadState.Idle -> {
                        launcherUpdateAction = LauncherUpdateAction.CHECK
                        updateLauncherActionUi()
                        return@launch
                    }
                    is ApkDownloadState.Downloading -> {
                        launcherUpdateAction = LauncherUpdateAction.DOWNLOADING
                        updateLauncherActionUi()
                        val progress = state.progressPercent?.let { "$it%" }
                            ?: tr("in progress", "в процессе")
                        setLauncherUpdateStatus(tr(
                            "Downloading launcher update: $progress",
                            "Загрузка обновления лаунчера: $progress",
                        ))
                        delay(750)
                    }
                    is ApkDownloadState.Ready -> {
                        launcherUpdateAction = LauncherUpdateAction.INSTALL
                        updateLauncherActionUi()
                        setLauncherUpdateStatus(tr(
                            "Launcher v${state.expectedVersionName} downloaded; ready for Android's installer.",
                            "Лаунчер v${state.expectedVersionName} загружен; можно открыть установщик Android.",
                        ))
                        if (installWhenReady) beginDownloadedApkInstall()
                        return@launch
                    }
                    is ApkDownloadState.Failed -> {
                        launcherUpdateAction = LauncherUpdateAction.CHECK
                        updateLauncherActionUi()
                        setLauncherUpdateStatus(tr(
                            "Download failed: ${state.reason}",
                            "Ошибка загрузки: ${state.reason}",
                        ))
                        return@launch
                    }
                }
            }
        }
    }

    private fun beginDownloadedApkInstall() {
        if (installerHandoffInProgress) return
        installerHandoffInProgress = true
        mainScope.launch {
            when (val handoff = apkUpdateManager.prepareInstall()) {
                is ApkInstallHandoff.LaunchInstaller -> {
                    setLauncherUpdateStatus(tr(
                        "Confirm the launcher update in Android's installer.",
                        "Подтвердите обновление лаунчера в установщике Android.",
                    ))
                    startActivity(handoff.intent)
                }
                is ApkInstallHandoff.PermissionRequired -> {
                    installerHandoffInProgress = false
                    setLauncherUpdateStatus(tr(
                        "Allow installs from Vibe Tavern, then return here.",
                        "Разрешите установку из Vibe Tavern, затем вернитесь сюда.",
                    ))
                    startActivity(handoff.settingsIntent)
                }
                is ApkInstallHandoff.Rejected -> {
                    installerHandoffInProgress = false
                    launcherUpdateAction = LauncherUpdateAction.CHECK
                    updateLauncherActionUi()
                    setLauncherUpdateStatus(tr(
                        "Downloaded APK rejected: ${handoff.reason}",
                        "Загруженный APK отклонён: ${handoff.reason}",
                    ))
                }
                ApkInstallHandoff.MissingDownload -> {
                    installerHandoffInProgress = false
                    launcherUpdateAction = LauncherUpdateAction.CHECK
                    updateLauncherActionUi()
                    setLauncherUpdateStatus(tr(
                        "Downloaded launcher APK is no longer available.",
                        "Загруженный APK лаунчера больше недоступен.",
                    ))
                }
            }
        }
    }

    // ========== One-time setup ==========

    private fun doOneTimeSetup() {
        setProgress(tr("📦 Copying bundled archive and opening Termux installer…", "📦 Копирую архив и открываю установщик в Termux…"), visible = true)
        statusText.text = tr("📦 Installation/update runs in Termux", "📦 Установка/обновление выполняется в Termux")
        startArchiveServer()
        val copiedArchivePath = copyBundledArchiveToDownloads()
        installerArchivePath = copiedArchivePath ?: sharedArchivePath
        val archiveCopiedToDownloads = copiedArchivePath != null

        tryRegisterResultReceiver()

        try {
            val copiedInstallerPath = copyInstallerScriptToDownloads()
            if (copiedInstallerPath == null) {
                setProgress(tr("❌ Failed to copy installer script to Downloads.", "❌ Не удалось скопировать установщик в Downloads."), visible = false)
                return
            }
            runTermuxInstallerVisible(archiveCopiedToDownloads, installerArchivePath, copiedInstallerPath)
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

    private fun runTermuxInstallerVisible(archiveCopiedToDownloads: Boolean, archivePath: String, installerPath: String) {
        val archiveCopyStatus = if (archiveCopiedToDownloads) "copied" else "copy_failed"
        val command = """
            clear
            echo '=== Vibe Tavern installer ==='
            echo 'APK archive copy to Downloads: $archiveCopyStatus'
            echo 'Actual archive path passed to installer:'
            echo '$archivePath'
            ls -lh '$archivePath' || true
            echo 'Android-renamed archive candidate:'
            ls -lh '$archivePath.gz' || true
            echo 'All visible Vibe Tavern downloads:'
            ls -lah /sdcard/Download/vibe-tavern-* 2>/dev/null || true
            echo 'Archive URL fallback: $localArchiveUrl'
            echo 'Actual installer path:'
            echo '$installerPath'
            ls -lh '$installerPath' || true
            echo
            if [ ! -f '$installerPath' ]; then
              echo 'ERROR: installer script was not copied to Downloads.'
              echo 'Press Enter to close.'
              read -r _
              exit 1
            fi
            echo 'Starting installer with trace...'
            VIBE_TAVERN_ARCHIVE_PATH='$archivePath' \
            VIBE_TAVERN_ARCHIVE_URL='$localArchiveUrl' \
            bash -x '$installerPath'
            code=${'$'}?
            echo
            if [ "${'$'}code" -eq 0 ]; then
              echo '✅ Installer finished successfully.'
            else
              echo "❌ Installer failed with exit code ${'$'}code."
              echo "Log file in Termux: ${'$'}HOME/vibe-tavern-install.log"
            fi
            echo
            echo 'Press Enter to close this Termux session.'
            read -r _
            exit "${'$'}code"
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

    private fun copyBundledArchiveToDownloads(): String? {
        // Use octet-stream so Android's DownloadProvider is less likely to
        // rename vibe-tavern-android-arm64.tgz to vibe-tavern-android-arm64.tgz.gz.
        // If Android still renames due to conflicts, copyToDownloads returns the
        // actual display name so Termux installs the file that was just created.
        return copyToDownloads(bundledArchiveName, "application/octet-stream") { output ->
            assets.open(bundledArchiveName).use { input -> input.copyTo(output) }
        }
    }

    private fun copyInstallerScriptToDownloads(): String? {
        return copyToDownloads(installerScriptName, "text/x-shellscript") { output ->
            assets.open("install.sh").use { input -> input.copyTo(output) }
        }
    }

    private fun copyToDownloads(
        displayName: String,
        mimeType: String,
        writeContent: (java.io.OutputStream) -> Unit,
    ): String? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                contentResolver.delete(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    "${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
                    arrayOf("$displayName%"),
                )
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
                contentResolver.openOutputStream(uri)?.use(writeContent) ?: return null
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)

                val actualDisplayName = contentResolver.query(
                    uri,
                    arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                } ?: displayName
                "/sdcard/Download/$actualDisplayName"
            } else {
                val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                downloads.mkdirs()
                downloads.listFiles { file -> file.name.startsWith(displayName) }
                    ?.forEach { file -> file.delete() }
                val target = File(downloads, displayName)
                target.outputStream().use(writeContent)
                target.absolutePath
            }
        } catch (_: Exception) {
            null
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
        startPolling(maxAttempts = 90, waitingLabel = tr("Waiting for server", "Ожидание сервера"))
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
                    if (markInstalledOnSuccess) markCurrentPayloadInstalled()
                    updateSetupButtonText()
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
                    updateSetupButtonText()
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
            val payloadHint = if (payloadUpdateRequired()) {
                "\n" + tr(
                    "Server payload update to v${BuildConfig.VERSION_NAME} is available",
                    "Доступно обновление серверной части до v${BuildConfig.VERSION_NAME}",
                )
            } else {
                "\n" + tr(
                    "Server payload v${BuildConfig.VERSION_NAME}",
                    "Серверная часть v${BuildConfig.VERSION_NAME}",
                )
            }
            statusText.text = tr("✅ Server is running", "✅ Сервер работает") + "\n$serverUrl" + payloadHint
            launchBtn.visibility = View.GONE
            openBtn.visibility = View.VISIBLE
            stopBtn.visibility = View.VISIBLE
        } else {
            val installHint = when {
                !wasInstalledOnce() -> tr(
                    "Not installed. Install server v${BuildConfig.VERSION_NAME} first.",
                    "Не установлено. Сначала установите сервер v${BuildConfig.VERSION_NAME}.",
                )
                payloadUpdateRequired() -> tr(
                    "Server is off; update its payload to v${BuildConfig.VERSION_NAME}.",
                    "Сервер выключен; обновите серверную часть до v${BuildConfig.VERSION_NAME}.",
                )
                else -> tr("Installed, server is off", "Установлено, сервер выключен")
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
        if (resultReceiverRegistered) return
        ContextCompat.registerReceiver(
            this,
            resultReceiver,
            IntentFilter(TERMUX_RESULT_ACTION),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        resultReceiverRegistered = true
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

    private val FIRST_TIME_SETUP_COMMAND = "mkdir -p ~/.termux && echo \"allow-external-apps=true\" >> ~/.termux/termux.properties && termux-reload-settings"

    private fun showFirstTimeSetupGuide() {
        val isRu = isRu()

        val step1Title = if (isRu) "Шаг 1: Обнови пакеты Termux" else "Step 1: Update Termux packages"
        val step1Body = if (isRu)
            "Свежий Termux часто содержит сломанные пакеты (особенно curl). Открой Termux и выполни:\napt update && apt full-upgrade\nНажми 'y' при любом запросе. Если видишь 'No mirror selected' — сначала выполни termux-change-repo."
        else
            "Fresh Termux often has broken packages (especially curl). Open Termux and run:\napt update && apt full-upgrade\nPress 'y' on any prompts. If you see 'No mirror selected', run termux-change-repo first."

        val step2Title = if (isRu) "Шаг 2: Разреши внешним приложениям выполнять команды" else "Step 2: Allow external apps to run commands"
        val step2Body = if (isRu)
            "APK нуждается в этом разрешении для управления сервером. Нажми кнопку ниже, чтобы скопировать команду, затем вставь её в Termux."
        else
            "The APK needs this permission to manage the server. Tap the button below to copy the command, then paste it in Termux."

        val step3Title = if (isRu) "Шаг 3: Перезапусти Termux" else "Step 3: Restart Termux"
        val step3Body = if (isRu)
            "Набери exit в Termux, смахни его из недавних приложений и открой заново. Это нужно чтобы настройка вступила в силу."
        else
            "Type exit in Termux, swipe it away from recent apps, then reopen it. This ensures the setting takes effect."

        val step4Title = if (isRu) "Шаг 4: Вернись сюда и нажми 'Установить'" else "Step 4: Come back and tap 'Install'"
        val step4Body = if (isRu)
            "После этого APK сможет автоматически управлять Termux. Эти шаги нужно выполнить только один раз.\n\n💡 Если при установке что-то спрашивает Y/N — нажимай Y."
        else
            "After this, the APK can automatically manage Termux. You only need to do these steps once.\n\n💡 If anything asks Y/N during install, press Y."

        val message = buildString {
            append("$step1Title\n$step1Body\n\n")
            append("$step2Title\n$step2Body\n\n")
            append("$step3Title\n$step3Body\n\n")
            append("$step4Title\n$step4Body")
        }

        AlertDialog.Builder(this)
            .setTitle(if (isRu) "🔧 Первичная настройка Termux" else "🔧 First-Time Termux Setup")
            .setMessage(message)
            .setPositiveButton(if (isRu) "📋 Скопировать команду" else "📋 Copy Command") { _, _ ->
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("termux-setup", FIRST_TIME_SETUP_COMMAND))
                setProgress(
                    if (isRu) "✅ Команда скопирована. Открой Termux и вставь её."
                    else "✅ Command copied. Open Termux and paste it.",
                    visible = false
                )
            }
            .setNegativeButton(if (isRu) "Открыть Termux" else "Open Termux") { _, _ ->
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("termux-setup", FIRST_TIME_SETUP_COMMAND))
                openTermux()
            }
            .setNeutralButton("OK", null)
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
        updateSetupButtonText()
        updateVersionStatus()
    }

    private enum class LauncherUpdateAction {
        CHECK,
        DOWNLOADING,
        INSTALL,
    }

    companion object {
        private var automaticUpdateCheckStarted = false
    }
}

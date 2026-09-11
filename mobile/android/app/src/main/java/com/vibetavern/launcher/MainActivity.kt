package com.vibetavern.launcher

import android.Manifest
import android.app.DownloadManager
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
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
    private lateinit var setupBtn: Button
    private lateinit var launchBtn: Button
    private lateinit var uninstallBtn: Button
    private lateinit var languageBtn: Button
    private lateinit var firstTimeSetupHeader: TextView
    private lateinit var firstTimeSetupContent: View
    private lateinit var launcherUpdateBtn: Button
    private lateinit var launcherVersionText: TextView
    private lateinit var migrationInstructions: TextView
    private lateinit var migrationCommand: TextView
    private lateinit var copyMigrationCommandBtn: Button
    private lateinit var importMigrationArchiveBtn: Button
    private lateinit var startFreshBtn: Button

    private val migrationManager by lazy { LegacyMigration(filesDir) }
    private var migrationJob: Job? = null
    private var migrationInProgress = false
    private val migrationArchivePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = result.data?.data ?: return@registerForActivityResult
        importMigrationArchive(uri)
    }

    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val releaseClient = GitHubReleaseClient(
        endpointUrl = BuildConfig.RELEASE_API_URL,
        allowInsecureHttp = BuildConfig.ALLOW_INSECURE_RELEASE_URL,
    )
    private val apkUpdateManager by lazy { ApkUpdateManager(this) }
    private var pollingJob: Job? = null
    private var payloadExtractionJob: Job? = null
    private var updateCheckJob: Job? = null
    private var downloadPollingJob: Job? = null
    private var downloadReceiverRegistered = false
    private var installerHandoffInProgress = false
    private var activityStarted = false
    private var pendingUpdateRelease: PublishedRelease? = null
    private var launcherUpdateAction = LauncherUpdateAction.CHECK
    private var nativeStartRequested = false
    private var extractingPayload = false
    private var serverActionStops = false

    private val serverUrl = ServerService.BASE_URL

    private val downloadReceiver = object : android.content.BroadcastReceiver() {
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
        showLaunchScreen()
        maybeRequestNotificationPermission()
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
        if (::statusText.isInitialized && !extractingPayload) refreshServerStatus(showChecking = false)
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
        payloadExtractionJob?.cancel()
        updateCheckJob?.cancel()
        downloadPollingJob?.cancel()
        migrationJob?.cancel()
        mainScope.cancel()
        super.onDestroy()
    }

    private fun preferences() = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun installedPayloadVersion(): String? = preferences().getString(PREF_PAYLOAD_VERSION, null)

    private fun payloadUpdateRequired(): Boolean = installedPayloadVersion() != BuildConfig.VERSION_NAME

    private fun currentLanguage(): String {
        val saved = preferences().getString(PREF_LANGUAGE, null)
        if (saved == "ru" || saved == "en") return saved
        return if (Locale.getDefault().language == "ru") "ru" else "en"
    }

    private fun setLanguage(language: String) {
        preferences().edit().putString(PREF_LANGUAGE, language).apply()
    }

    private fun isRu(): Boolean = currentLanguage() == "ru"

    private fun tr(en: String, ru: String): String = if (isRu()) ru else en

    private fun showLaunchScreen() {
        setContentView(R.layout.screen_launch)
        applySystemInsets()
        statusText = findViewById(R.id.status_text)
        progressText = findViewById(R.id.progress_text)
        progressBar = findViewById(R.id.progress_bar)
        openBtn = findViewById(R.id.btn_open_browser)
        setupBtn = findViewById(R.id.btn_one_time_setup)
        launchBtn = findViewById(R.id.btn_launch_server)
        migrationInstructions = findViewById(R.id.first_time_setup_migration_slot)
        migrationCommand = findViewById(R.id.migration_command)
        copyMigrationCommandBtn = findViewById(R.id.btn_copy_migration_command)
        importMigrationArchiveBtn = findViewById(R.id.btn_import_migration_archive)
        startFreshBtn = findViewById(R.id.btn_start_fresh)
        uninstallBtn = findViewById(R.id.btn_uninstall)
        languageBtn = findViewById(R.id.btn_language)
        firstTimeSetupHeader = findViewById(R.id.first_time_setup_header)
        firstTimeSetupContent = findViewById(R.id.first_time_setup_content)
        launcherUpdateBtn = findViewById(R.id.btn_check_launcher_update)
        launcherVersionText = findViewById(R.id.launcher_version_status)

        launchBtn.setOnClickListener { handleServerAction() }
        openBtn.setOnClickListener { openBrowserWhenReady() }
        uninstallBtn.setOnClickListener { confirmUninstall() }
        languageBtn.setOnClickListener { showLanguageDialog() }
        launcherUpdateBtn.setOnClickListener { handleLauncherUpdateAction() }
        findViewById<Button>(R.id.btn_help).setOnClickListener { showHelpDialog() }
        findViewById<Button>(R.id.btn_copy_server_log).setOnClickListener { copyServerLog() }
        findViewById<Button>(R.id.btn_clear_server_log).setOnClickListener { clearServerLog() }
        firstTimeSetupHeader.setOnClickListener {
            firstTimeSetupContent.visibility = if (firstTimeSetupContent.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        copyMigrationCommandBtn.setOnClickListener { copyMigrationCommand() }
        importMigrationArchiveBtn.setOnClickListener { chooseMigrationArchive() }
        startFreshBtn.setOnClickListener { startFresh() }
        setupBtn.visibility = View.GONE
        migrationManager.recoverIncompleteTransaction()

        apkUpdateManager.cleanupStaleDownload()
        applyLaunchTexts()
        configureMigrationUi()
        setProgress(null, visible = false)
        refreshServerStatus(showChecking = true)
        ensurePayloadExtracted()
        observeLauncherDownload(installWhenReady = false)
        if (!automaticUpdateCheckStarted && !apkUpdateManager.hasTrackedDownload()) {
            automaticUpdateCheckStarted = true
            checkForLauncherUpdate(manual = false)
        }
    }

    private fun hasLegacyMigrationCandidate(): Boolean =
        preferences().getBoolean(PREF_LEGACY_INSTALLED_ONCE, false) &&
            !File(File(filesDir, LegacyMigration.DATA_DIRECTORY), LegacyMigration.DATABASE_NAME).exists() &&
            !preferences().getBoolean(PREF_MIGRATION_COMPLETED, false) &&
            !preferences().getBoolean(PREF_MIGRATION_DISMISSED, false)

    private fun configureMigrationUi() {
        val eligible = hasLegacyMigrationCandidate()
        firstTimeSetupHeader.visibility = if (eligible) View.VISIBLE else View.GONE
        firstTimeSetupContent.visibility = View.GONE
        copyMigrationCommandBtn.isEnabled = !migrationInProgress
        importMigrationArchiveBtn.isEnabled = !migrationInProgress
        startFreshBtn.isEnabled = !migrationInProgress
    }

    private fun migrationBlocksStart(): Boolean = hasLegacyMigrationCandidate() || migrationInProgress

    private fun copyMigrationCommand() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("vt-migration-command", MIGRATION_COMMAND))
        setProgress(tr("Migration command copied. Run it in Termux, then choose the archive.", "Команда миграции скопирована. Выполните её в Termux, затем выберите архив."), visible = false)
    }

    private fun chooseMigrationArchive() {
        if (!hasLegacyMigrationCandidate() || migrationInProgress) return
        migrationArchivePicker.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/gzip"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/gzip", "application/octet-stream"))
        })
    }

    private fun importMigrationArchive(uri: Uri) {
        if (!hasLegacyMigrationCandidate() || migrationInProgress) return
        migrationInProgress = true
        configureMigrationUi()
        setServerState(ServerUiState.STOPPED)
        setProgress(tr("Validating and importing migration archive…", "Проверяю и импортирую архив миграции…"), visible = true)
        migrationJob = mainScope.launch(Dispatchers.IO) {
            var prepared: LegacyMigration.PreparedImport? = null
            var cachedArchive: File? = null
            try {
                if (ServerService.apiReady() && !ServerService.hasOwnedServerProcess()) {
                    throw MigrationException("Port 8787 is in use by another server. Stop the old Termux server first.")
                }
                val archive = File(cacheDir, "vt-migration-${UUID.randomUUID()}.tar.gz")
                cachedArchive = archive
                contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(archive).use(input::copyTo)
                } ?: throw MigrationException("Could not open the selected archive")
                prepared = migrationManager.prepare(archive)
                if (ServerService.hasOwnedServerProcess()) {
                    ServerService.stop(this@MainActivity)
                    var remainingSeconds = SERVER_STOP_WAIT_SECONDS
                    while (ServerService.hasOwnedServerProcess() && remainingSeconds-- > 0) delay(1_000)
                    if (ServerService.hasOwnedServerProcess()) throw MigrationException("Native server did not stop before migration")
                }
                if (ServerService.apiReady()) throw MigrationException("Port 8787 is in use by another server. Stop the old Termux server first.")
                migrationManager.activate(
                    prepared = prepared,
                    startServer = { ServerService.start(this@MainActivity) },
                    stopFailedServer = {
                        ServerService.stop(this@MainActivity)
                        var remainingSeconds = SERVER_STOP_WAIT_SECONDS
                        while (ServerService.hasOwnedServerProcess() && remainingSeconds-- > 0) Thread.sleep(1_000)
                    },
                    apiReady = readiness@{
                        repeat(SERVER_READY_WAIT_SECONDS) {
                            if (ServerService.apiReady()) return@readiness true
                            Thread.sleep(1_000)
                        }
                        false
                    },
                )
                preferences().edit().putBoolean(PREF_MIGRATION_COMPLETED, true).apply()
                withContext(Dispatchers.Main) {
                    migrationInProgress = false
                    configureMigrationUi()
                    setProgress(tr("✅ Migration complete. Your native server is ready; Termux data was not changed and can now be removed.", "✅ Миграция завершена. Нативный сервер готов; данные Termux не изменялись и теперь Termux можно удалить."), visible = false)
                    refreshServerStatus(showChecking = false)
                }
            } catch (error: Exception) {
                ServerService.stop(this@MainActivity)
                migrationManager.discard(prepared)
                withContext(Dispatchers.Main) {
                    migrationInProgress = false
                    configureMigrationUi()
                    setProgress(tr("❌ Migration failed: ${error.message}. Existing native data was restored. ${readLogTail(8_000)}", "❌ Миграция не удалась: ${error.message}. Прежние нативные данные восстановлены. ${readLogTail(8_000)}"), visible = false)
                    refreshServerStatus(showChecking = false)
                }
            } finally {
                cachedArchive?.delete()
            }
        }
    }

    private fun startFresh() {
        preferences().edit().putBoolean(PREF_MIGRATION_DISMISSED, true).apply()
        configureMigrationUi()
        setProgress(tr("Migration skipped. Termux data was not changed; you can start a fresh native server.", "Миграция пропущена. Данные Termux не изменялись; можно запустить новый нативный сервер."), visible = false)
        refreshServerStatus(showChecking = false)
    }

    private fun applySystemInsets() {
        val root = findViewById<ScrollView>(R.id.launch_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(0, bars.top, 0, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }

    private fun applyLaunchTexts() {
        findViewById<TextView>(R.id.launch_intro).text = tr(
            "The launcher manages the embedded local server; Vibe Tavern opens in your browser.",
            "Лаунчер управляет встроенным локальным сервером, а Vibe Tavern открывается в браузере.",
        )
        migrationInstructions.text = tr(
            "Previously used the old Termux launcher? Stop its server first. In Termux run termux-setup-storage and grant storage access if Android asks. Then run the command below in the Ubuntu guest, select vt-migration.tar.gz, and import it. The Termux data is not modified; after a successful import you may remove Termux.",
            "Пользовались старым лаунчером Termux? Сначала остановите его сервер. В Termux выполните termux-setup-storage и предоставьте доступ к хранилищу, если Android попросит. Затем выполните команду ниже в Ubuntu-госте, выберите vt-migration.tar.gz и импортируйте его. Данные Termux не изменяются; после успешного импорта Termux можно удалить.",
        )
        migrationCommand.text = MIGRATION_COMMAND
        copyMigrationCommandBtn.text = tr("Copy archive command", "Скопировать команду архива")
        importMigrationArchiveBtn.text = tr("Choose archive and import", "Выбрать архив и импортировать")
        startFreshBtn.text = tr("Start fresh instead", "Начать заново")
        findViewById<TextView>(R.id.management_label).text = tr(
            "Launcher and server management",
            "Управление лаунчером и сервером",
        )
        openBtn.text = tr("🌐 Open in Browser", "🌐 Открыть в браузере")
        findViewById<Button>(R.id.btn_copy_server_log).text = tr("📋 Copy server log", "📋 Скопировать журнал сервера")
        findViewById<Button>(R.id.btn_clear_server_log).text = tr("🧹 Clear server log", "🧹 Очистить журнал сервера")
        uninstallBtn.text = tr("🗑 Uninstall", "🗑 Удалить")
        languageBtn.text = tr("🌐 Language: English", "🌐 Язык: Русский")
        findViewById<Button>(R.id.btn_help).text = tr("❓ Help / Troubleshooting", "❓ Справка / проблемы")
        findViewById<TextView>(R.id.help_hint).text = tr(
            "Tip: if the web UI lags after switching apps, disable battery optimization for Vibe Tavern.",
            "Совет: если веб-интерфейс лагает после сворачивания, отключите оптимизацию батареи для Vibe Tavern.",
        )
        updateLauncherActionUi()
        updateVersionStatus()
    }

    private fun updateVersionStatus() {
        if (!::launcherVersionText.isInitialized) return
        val serverVersion = installedPayloadVersion()?.let { "v$it" }
            ?: tr("extracting on first launch", "извлекается при первом запуске")
        launcherVersionText.text = tr(
            "Launcher v${BuildConfig.VERSION_NAME} • Server payload $serverVersion",
            "Лаунчер v${BuildConfig.VERSION_NAME} • Серверная часть $serverVersion",
        )
    }

    private fun hasRequiredPayload(): Boolean {
        val payload = File(filesDir, PAYLOAD_DIRECTORY)
        return File(payload, "web/index.html").isFile &&
            hasFiles(File(payload, "drizzle")) &&
            hasFiles(File(payload, "tokenizers")) &&
            hasFiles(File(payload, "prompts"))
    }

    private fun hasFiles(directory: File): Boolean =
        directory.isDirectory && directory.walkTopDown().any { it.isFile }

    private fun ensurePayloadExtracted() {
        if (extractingPayload || (!payloadUpdateRequired() && hasRequiredPayload())) return
        payloadExtractionJob?.cancel()
        extractingPayload = true
        pollingJob?.cancel()
        setPayloadExtractionUi()
        payloadExtractionJob = mainScope.launch(Dispatchers.IO) {
            try {
                extractPayloadFromAssets { copied, total ->
                    if (copied == 1 || copied == total || copied % 25 == 0) {
                        runOnUiThread {
                            progressText.text = tr(
                                "Extracting bundled server files… $copied/$total",
                                "Извлекаю встроенные файлы сервера… $copied/$total",
                            )
                        }
                    }
                }
                preferences().edit().putString(PREF_PAYLOAD_VERSION, BuildConfig.VERSION_NAME).apply()
                withContext(Dispatchers.Main) {
                    extractingPayload = false
                    updateVersionStatus()
                    setProgress(tr("✅ Server files are ready.", "✅ Файлы сервера готовы."), visible = false)
                    refreshServerStatus(showChecking = false)
                }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) {
                    extractingPayload = false
                    setProgress(
                        tr(
                            "❌ Could not extract server files: ${error.message}. Try Start again.",
                            "❌ Не удалось извлечь файлы сервера: ${error.message}. Повторите Start.",
                        ),
                        visible = false,
                    )
                    setServerState(ServerUiState.STOPPED)
                }
            }
        }
    }

    private fun extractPayloadFromAssets(onProgress: (Int, Int) -> Unit) {
        val files = listAssetFiles(PAYLOAD_DIRECTORY)
        check(files.isNotEmpty()) { "Bundled server payload is missing" }
        val temporary = File(filesDir, "$PAYLOAD_DIRECTORY-copy-${UUID.randomUUID()}")
        val destination = File(filesDir, PAYLOAD_DIRECTORY)
        try {
            check(temporary.mkdirs()) { "Could not create payload staging directory" }
            files.forEachIndexed { index, relativePath ->
                val output = File(temporary, relativePath.removePrefix("$PAYLOAD_DIRECTORY/"))
                output.parentFile?.mkdirs()
                assets.open(relativePath).use { input ->
                    FileOutputStream(output).use { outputStream -> input.copyTo(outputStream) }
                }
                onProgress(index + 1, files.size)
            }
            check(hasRequiredPayload(temporary)) { "Bundled payload is incomplete" }
            if (destination.exists()) destination.deleteRecursively()
            check(temporary.renameTo(destination)) { "Could not activate extracted payload" }
        } catch (error: Exception) {
            temporary.deleteRecursively()
            throw error
        }
    }

    private fun hasRequiredPayload(payload: File): Boolean =
        File(payload, "web/index.html").isFile &&
            hasFiles(File(payload, "drizzle")) &&
            hasFiles(File(payload, "tokenizers")) &&
            hasFiles(File(payload, "prompts"))

    private fun listAssetFiles(path: String): List<String> {
        val children = assets.list(path).orEmpty()
        if (children.isEmpty()) return listOf(path)
        return children.flatMap { child -> listAssetFiles("$path/$child") }
    }

    private fun setPayloadExtractionUi() {
        setServerState(ServerUiState.EXTRACTING)
        openBtn.isEnabled = false
        setProgress(tr("Extracting bundled server files…", "Извлекаю встроенные файлы сервера…"), visible = true)
    }

    private fun handleServerAction() {
        if (serverActionStops) stopServer() else launchServer()
    }

    private fun launchServer() {
        if (migrationBlocksStart()) {
            setProgress(tr("Import old Termux data or choose Start fresh before starting the native server.", "Импортируйте старые данные Termux или выберите «Начать заново» перед запуском нативного сервера."), visible = false)
            return
        }
        if (extractingPayload) {
            setPayloadExtractionUi()
            return
        }
        if (!hasRequiredPayload()) {
            ensurePayloadExtracted()
            return
        }
        nativeStartRequested = true
        maybeOfferBatteryOptimizationExemption()
        setProgress(tr("🚀 Starting native server…", "🚀 Запускаю нативный сервер…"), visible = true)
        setServerState(ServerUiState.WARMING)
        ServerService.start(this)
        startPolling()
    }

    private fun stopServer() {
        pollingJob?.cancel()
        nativeStartRequested = false
        setProgress(tr("⏹ Stopping native server…", "⏹ Останавливаю нативный сервер…"), visible = true)
        ServerService.stop(this)
        mainScope.launch {
            delay(500)
            setProgress(tr("🛑 Server stopped", "🛑 Сервер остановлен"), visible = false)
            refreshServerStatus(showChecking = false)
        }
    }

    private fun startPolling() {
        pollingJob?.cancel()
        pollingJob = mainScope.launch(Dispatchers.IO) {
            for (seconds in 0..120) {
                if (!isActive) return@launch
                val owned = ServerService.hasOwnedServerProcess()
                val ready = ServerService.apiReady()
                val state = when {
                    ready && owned -> ServerUiState.READY
                    ready -> ServerUiState.FOREIGN
                    !owned && seconds > 1 -> ServerUiState.FAILED
                    else -> ServerUiState.WARMING
                }
                withContext(Dispatchers.Main) {
                    when (state) {
                        ServerUiState.READY -> setProgress(
                            tr("✅ Server is ready. Tap Open to use Vibe Tavern.", "✅ Сервер готов. Нажмите «Открыть», чтобы перейти в Vibe Tavern."),
                            visible = false,
                        )
                        ServerUiState.FOREIGN -> setProgress(
                            tr("⚠️ An old Termux server is using port 8787.", "⚠️ Старый сервер Termux использует порт 8787."),
                            visible = false,
                        )
                        ServerUiState.FAILED -> setProgress(
                            tr("❌ Native server exited. Copy the server log or open Help.", "❌ Нативный сервер завершился. Скопируйте журнал сервера или откройте справку."),
                            visible = false,
                        )
                        ServerUiState.WARMING -> progressText.text = tr("Warming up… ${seconds}s", "Запуск… ${seconds}с")
                        ServerUiState.EXTRACTING, ServerUiState.STOPPED -> Unit
                    }
                    setServerState(state)
                }
                if (state != ServerUiState.WARMING) return@launch
                delay(1_000)
            }
            withContext(Dispatchers.Main) {
                setProgress(
                    tr("⚠️ Native server did not become ready. Copy the log or open Help.", "⚠️ Нативный сервер не стал готов. Скопируйте журнал или откройте справку."),
                    visible = false,
                )
                setServerState(ServerUiState.FAILED)
            }
        }
    }

    private fun refreshServerStatus(showChecking: Boolean) {
        if (extractingPayload) return
        if (showChecking) {
            statusText.text = tr("🔎 Checking local server…", "🔎 Проверяю локальный сервер…")
        }
        mainScope.launch(Dispatchers.IO) {
            val owned = ServerService.hasOwnedServerProcess()
            val ready = ServerService.apiReady()
            withContext(Dispatchers.Main) {
                if (extractingPayload) return@withContext
                setServerState(
                    when {
                        ready && owned -> ServerUiState.READY
                        ready -> ServerUiState.FOREIGN
                        owned -> ServerUiState.WARMING
                        nativeStartRequested -> ServerUiState.FAILED
                        else -> ServerUiState.STOPPED
                    },
                )
            }
        }
    }

    private fun setServerState(state: ServerUiState) {
        serverActionStops = state == ServerUiState.WARMING || state == ServerUiState.READY
        openBtn.isEnabled = state == ServerUiState.READY || state == ServerUiState.FOREIGN
        launchBtn.text = when (state) {
            ServerUiState.WARMING, ServerUiState.READY -> tr("⏹ Stop Server", "⏹ Остановить сервер")
            ServerUiState.EXTRACTING -> tr("📦 Preparing server…", "📦 Подготавливаю сервер…")
            ServerUiState.FOREIGN -> tr("⚠️ Port 8787 is in use", "⚠️ Порт 8787 занят")
            ServerUiState.STOPPED, ServerUiState.FAILED -> tr("🚀 Start Server", "🚀 Запустить сервер")
        }
        launchBtn.isEnabled = !extractingPayload && !migrationBlocksStart() && state != ServerUiState.FOREIGN
        statusText.text = when (state) {
            ServerUiState.EXTRACTING -> tr("📦 Extracting server payload", "📦 Извлекаю серверную часть")
            ServerUiState.STOPPED -> tr("⏹ Server is stopped", "⏹ Сервер остановлен")
            ServerUiState.WARMING -> tr("⏳ Native server is warming up", "⏳ Нативный сервер запускается")
            ServerUiState.READY -> tr("✅ Native server is ready\n$serverUrl", "✅ Нативный сервер готов\n$serverUrl")
            ServerUiState.FAILED -> tr("❌ Native server exited or failed. See server log.", "❌ Нативный сервер завершился с ошибкой. Смотрите журнал сервера.")
            ServerUiState.FOREIGN -> tr(
                "⚠️ API is ready on port 8787, but it is not this app's server. Stop the old Termux server before starting Vibe Tavern here.",
                "⚠️ API готов на порту 8787, но это не сервер этого приложения. Остановите старый сервер Termux перед запуском Vibe Tavern здесь.",
            )
        }
    }

    private fun setProgress(message: String?, visible: Boolean) {
        progressBar.visibility = if (visible) View.VISIBLE else View.GONE
        progressBar.isIndeterminate = true
        progressText.visibility = if (message.isNullOrBlank()) View.GONE else View.VISIBLE
        progressText.text = message.orEmpty()
    }

    private fun openBrowserWhenReady() {
        mainScope.launch(Dispatchers.IO) {
            val ready = ServerService.apiReady()
            withContext(Dispatchers.Main) {
                if (!ready) {
                    setProgress(
                        tr("⏳ Server is not API-ready yet. Wait for the ready status before opening the browser.", "⏳ Сервер ещё не готов для API. Дождитесь статуса готовности перед открытием браузера."),
                        visible = false,
                    )
                    refreshServerStatus(showChecking = false)
                    return@withContext
                }
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(serverUrl)))
            }
        }
    }

    private fun copyServerLog() {
        mainScope.launch(Dispatchers.IO) {
            val log = readLogTail(MAX_LOG_CLIPBOARD_BYTES)
            withContext(Dispatchers.Main) {
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("vt-server-log", log))
                setProgress(
                    tr("Server log copied to clipboard.", "Журнал сервера скопирован в буфер обмена."),
                    visible = false,
                )
            }
        }
    }

    private fun readLogTail(maxBytes: Long): String {
        val log = File(filesDir, "server.log")
        if (!log.isFile) return tr("(No server log yet.)", "(Журнала сервера пока нет.)")
        return try {
            RandomAccessFile(log, "r").use { file ->
                val length = file.length()
                val count = minOf(length, maxBytes).toInt()
                file.seek(length - count)
                ByteArray(count).also(file::readFully).toString(StandardCharsets.UTF_8)
            }
        } catch (error: Exception) {
            tr("(Could not read server log: ${error.message})", "(Не удалось прочитать журнал сервера: ${error.message})")
        }
    }

    private fun clearServerLog() {
        ServerService.requestLogClear()
        setProgress(
            tr("Server log clear requested.", "Запрошена очистка журнала сервера."),
            visible = false,
        )
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
        }
    }

    private fun maybeOfferBatteryOptimizationExemption() {
        if (preferences().getBoolean(PREF_BATTERY_EXEMPTION_PROMPTED, false)) return
        val powerManager = getSystemService(PowerManager::class.java)
        if (powerManager.isIgnoringBatteryOptimizations(packageName)) return
        preferences().edit().putBoolean(PREF_BATTERY_EXEMPTION_PROMPTED, true).apply()
        AlertDialog.Builder(this)
            .setTitle(tr("Keep Vibe Tavern running", "Не закрывайте Vibe Tavern"))
            .setMessage(tr(
                "Some phones pause local servers after you switch apps. Allow Vibe Tavern to ignore battery optimization to keep browser requests working. You can also keep Vibe Tavern in your recent-apps list and disable aggressive battery saver modes.",
                "Некоторые телефоны приостанавливают локальные серверы после переключения приложений. Разрешите Vibe Tavern игнорировать оптимизацию батареи, чтобы запросы из браузера продолжали работать. Также оставьте Vibe Tavern в списке недавних приложений и отключите агрессивный режим энергосбережения.",
            ))
            .setPositiveButton(tr("Allow", "Разрешить")) { _, _ -> requestBatteryOptimizationExemption() }
            .setNegativeButton(tr("Not now", "Не сейчас"), null)
            .show()
    }

    private fun requestBatteryOptimizationExemption() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            })
        } catch (error: Exception) {
            AlertDialog.Builder(this)
                .setTitle(tr("Battery settings", "Настройки батареи"))
                .setMessage(tr(
                    "Android could not open the battery-exemption request. Open Vibe Tavern's app settings and set its battery use to unrestricted if your phone provides that option.",
                    "Android не смог открыть запрос на исключение из оптимизации батареи. Откройте настройки Vibe Tavern и выберите неограниченное использование батареи, если телефон предоставляет эту возможность.",
                ))
                .setPositiveButton(tr("Open app settings", "Открыть настройки приложения")) { _, _ -> openAppSettings() }
                .setNegativeButton(tr("Cancel", "Отмена"), null)
                .show()
        }
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", packageName, null)
        })
    }

    private fun showLanguageDialog() {
        val languages = arrayOf("Русский", "English")
        val checked = if (isRu()) 0 else 1
        AlertDialog.Builder(this)
            .setTitle(tr("Language", "Язык"))
            .setSingleChoiceItems(languages, checked) { dialog, which ->
                setLanguage(if (which == 0) "ru" else "en")
                applyLaunchTexts()
                refreshServerStatus(showChecking = false)
                dialog.dismiss()
            }
            .setNegativeButton(tr("Cancel", "Отмена"), null)
            .show()
    }

    private fun showHelpDialog() {
        val help = tr(
            "If Start does not make the server ready:\n• Copy the server log and check the last lines for the error.\n• Stop the old Termux server if it is still using port 8787.\n• Try Start again after the bundled files finish extracting.\n\nIf the web UI lags or freezes after switching apps:\n• Disable battery optimization for Vibe Tavern.\n• Keep Vibe Tavern in your recent-apps list while using it.\n• Disable aggressive vendor battery-saver modes.\n\nOpen in Browser works only after the local API is ready at $serverUrl.",
            "Если Start не делает сервер готовым:\n• Скопируйте журнал сервера и проверьте последние строки с ошибкой.\n• Остановите старый сервер Termux, если он всё ещё использует порт 8787.\n• Повторите Start после завершения извлечения встроенных файлов.\n\nЕсли веб-интерфейс лагает или зависает после переключения приложений:\n• Отключите оптимизацию батареи для Vibe Tavern.\n• Оставьте Vibe Tavern в списке недавних приложений во время работы.\n• Отключите агрессивные режимы энергосбережения производителя.\n\n«Открыть в браузере» работает только после готовности локального API по адресу $serverUrl.",
        )
        AlertDialog.Builder(this)
            .setTitle(tr("Help / Troubleshooting", "Справка / проблемы"))
            .setMessage(help)
            .setPositiveButton(tr("Open app settings", "Открыть настройки приложения")) { _, _ -> openAppSettings() }
            .setNegativeButton(tr("Copy URL", "Скопировать URL")) { _, _ -> copyServerUrl() }
            .show()
    }

    private fun copyServerUrl() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Vibe Tavern URL", serverUrl))
        setProgress(tr("Copied: $serverUrl", "Скопировано: $serverUrl"), visible = false)
    }

    private fun confirmUninstall() {
        AlertDialog.Builder(this)
            .setTitle(tr("Uninstall Vibe Tavern", "Удалить Vibe Tavern"))
            .setMessage(tr(
                "Uninstalling Vibe Tavern removes this app and its native server files, chats, and settings from this device. It does not change any old Termux installation.",
                "Удаление Vibe Tavern удалит это приложение, его нативные файлы сервера, чаты и настройки с устройства. Старая установка Termux не изменится.",
            ))
            .setPositiveButton(tr("Uninstall Vibe Tavern", "Удалить Vibe Tavern")) { _, _ ->
                ServerService.stop(this)
                startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName")))
            }
            .setNegativeButton(tr("Cancel", "Отмена"), null)
            .show()
    }

    private fun updateLauncherActionUi() {
        if (!::launcherUpdateBtn.isInitialized) return
        launcherUpdateBtn.text = when (launcherUpdateAction) {
            LauncherUpdateAction.CHECK -> tr("Check for launcher update", "Проверить обновление лаунчера")
            LauncherUpdateAction.DOWNLOADING -> tr("Downloading launcher update…", "Загрузка обновления лаунчера…")
            LauncherUpdateAction.INSTALL -> tr("Install downloaded launcher update", "Установить загруженное обновление лаунчера")
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
                    if (activityStarted) showLauncherUpdateConsent(decision.release) else pendingUpdateRelease = decision.release
                }
                is ReleaseUpdateDecision.UpToDate -> if (manual) setLauncherUpdateStatus(tr("Launcher is up to date.", "Лаунчер уже обновлён."))
                is ReleaseUpdateDecision.Unavailable -> if (manual) setLauncherUpdateStatus(tr("No compatible Android launcher release was found.", "Совместимый Android-релиз лаунчера не найден."))
                is ReleaseUpdateDecision.Error -> if (manual) setLauncherUpdateStatus(tr("Update check failed: ${decision.message}", "Не удалось проверить обновление: ${decision.message}"))
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
        AlertDialog.Builder(this)
            .setTitle(tr("Launcher update available", "Доступно обновление лаунчера"))
            .setView(ScrollView(this).apply { addView(notes) })
            .setPositiveButton(tr("Download APK", "Скачать APK")) { _, _ -> startLauncherDownload(release) }
            .setNegativeButton(tr("Later", "Позже"), null)
            .show()
    }

    private fun startLauncherDownload(release: PublishedRelease) {
        try {
            apkUpdateManager.enqueue(release)
            launcherUpdateAction = LauncherUpdateAction.DOWNLOADING
            updateLauncherActionUi()
            setLauncherUpdateStatus(tr("Downloading launcher v${release.version}…", "Загружаю лаунчер v${release.version}…"))
            observeLauncherDownload(installWhenReady = true)
        } catch (error: Exception) {
            launcherUpdateAction = LauncherUpdateAction.CHECK
            updateLauncherActionUi()
            setLauncherUpdateStatus(tr("Could not start download: ${error.message}", "Не удалось начать загрузку: ${error.message}"))
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
                        val progress = state.progressPercent?.let { "$it%" } ?: tr("in progress", "в процессе")
                        setLauncherUpdateStatus(tr("Downloading launcher update: $progress", "Загрузка обновления лаунчера: $progress"))
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
                        setLauncherUpdateStatus(tr("Download failed: ${state.reason}", "Ошибка загрузки: ${state.reason}"))
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
                    setLauncherUpdateStatus(tr("Confirm the launcher update in Android's installer.", "Подтвердите обновление лаунчера в установщике Android."))
                    startActivity(handoff.intent)
                }
                is ApkInstallHandoff.PermissionRequired -> {
                    installerHandoffInProgress = false
                    setLauncherUpdateStatus(tr("Allow installs from Vibe Tavern, then return here.", "Разрешите установку из Vibe Tavern, затем вернитесь сюда."))
                    startActivity(handoff.settingsIntent)
                }
                is ApkInstallHandoff.Rejected -> {
                    installerHandoffInProgress = false
                    launcherUpdateAction = LauncherUpdateAction.CHECK
                    updateLauncherActionUi()
                    setLauncherUpdateStatus(tr("Downloaded APK rejected: ${handoff.reason}", "Загруженный APK отклонён: ${handoff.reason}"))
                }
                ApkInstallHandoff.MissingDownload -> {
                    installerHandoffInProgress = false
                    launcherUpdateAction = LauncherUpdateAction.CHECK
                    updateLauncherActionUi()
                    setLauncherUpdateStatus(tr("Downloaded launcher APK is no longer available.", "Загруженный APK лаунчера больше недоступен."))
                }
            }
        }
    }

    private enum class ServerUiState {
        EXTRACTING,
        STOPPED,
        WARMING,
        READY,
        FAILED,
        FOREIGN,
    }

    private enum class LauncherUpdateAction {
        CHECK,
        DOWNLOADING,
        INSTALL,
    }

    private companion object {
        const val PREFS = "vibe_tavern_launcher"
        const val PREF_PAYLOAD_VERSION = "installed_payload_version"
        const val PREF_LEGACY_INSTALLED_ONCE = "installed_once"
        const val PREF_MIGRATION_COMPLETED = "legacy_migration_completed"
        const val PREF_MIGRATION_DISMISSED = "legacy_migration_dismissed"
        const val PREF_LANGUAGE = "language"
        const val PREF_BATTERY_EXEMPTION_PROMPTED = "battery_exemption_prompted"
        const val PAYLOAD_DIRECTORY = "payload"
        const val MAX_LOG_CLIPBOARD_BYTES = 400_000L
        const val NOTIFICATION_PERMISSION_REQUEST = 1
        const val SERVER_STOP_WAIT_SECONDS = 10
        const val SERVER_READY_WAIT_SECONDS = 120
        const val MIGRATION_COMMAND = "proot-distro login ubuntu -- bash -lc 'set -eu; test -f \"\$HOME/.local/share/vibe-tavern/vibe-tavern.db\"; tar -czf /sdcard/Download/vt-migration.tar.gz -C \"\$HOME/.local/share\" vibe-tavern'"
        private var automaticUpdateCheckStarted = false
    }
}

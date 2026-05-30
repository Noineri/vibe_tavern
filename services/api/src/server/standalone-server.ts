/**
 * Standalone server entry point for Vibe Tavern .exe distribution.
 *
 * Uses resolveStandalonePaths() for all directory resolution.
 * Data lives in %LOCALAPPDATA%\VibeTavern (Windows) or OS-equivalent.
 * Program files (exe + web/) live in the installation directory.
 *
 * Usage:
 *   vibe-tavern.exe          (compiled with bun build --compile)
 *   bun services/api/src/standalone-server.ts
 */

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { resolveStandalonePaths } from "./standalone-paths.js";
import { createRuntimeStore } from "../session/session-runtime-store.js";
import { warmupTokenizers, countTokens } from "../ai/tokenizer-service.js";
import { SessionRuntime } from "../session/session-runtime.js";
import { createProviderProfileService } from "../providers/provider-profile-service.js";
import { PromptPresetService } from "../prompt/prompt-preset-service.js";
import { ProviderOrchestrator } from "../providers/provider-orchestrator.js";
import { LiveChatOrchestrator } from "../chat/live-chat-orchestrator.js";
import { ChatSummaryService } from "../chat/chat-summary-service.js";
import { AssetService } from "../asset-service.js";
import { RuntimeApiAdapter } from "../runtime-api-adapter.js";
import { createApp } from "./app-factory.js";
import { resolveTlsConfig } from "../mobile-auth.js";
import { MobileAccessService } from "../mobile-access-service.js";
import { configureLogDir } from "../send-debug-log.js";
import { runStartupFileChecks } from "./startup-checks.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const paths = await resolveStandalonePaths();
const tlsConfig = resolveTlsConfig();

console.log(`[standalone] Starting Vibe Tavern...`);
console.log(`[standalone] Data:  ${paths.dataDir}`);
console.log(`[standalone] Web:   ${paths.webEnabled ? paths.webDir : "(not found — API-only mode)"}`);
console.log(`[standalone] Host:  ${paths.host}:${paths.port}`);

// ─── Ensure data directories ─────────────────────────────────────────────────

// ─── Ensure data directories ─────────────────────────────────────────────────

await mkdir(paths.dataDir, { recursive: true });
await mkdir(paths.assetsDir, { recursive: true });
await mkdir(paths.traceDir, { recursive: true });
await mkdir(paths.logsDir, { recursive: true });
configureLogDir(paths.logsDir);

// ─── Bootstrap ───────────────────────────────────────────────────────────────

(async () => {
	await runStartupFileChecks({
		mode: "standalone",
		dataDir: paths.dataDir,
		staticDir: paths.webDir,
	});

	// Stores
	const stores = await createRuntimeStore(paths.dataDir);

	// Seed
	await Promise.all([
		stores.characters.getSystemCharacter(),
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	console.log("[standalone] Seed data ensured.");

	// Tokenizers
	await warmupTokenizers();
	setTokenCountFn(countTokens);
	console.log("[standalone] Tokenizers ready.");

	// Services
	const providerProfileService = createProviderProfileService(stores.providers);
	const promptPresetService = new PromptPresetService(stores.presets);
	const sessionRuntime = new SessionRuntime(stores, {
		getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
		dataDir: paths.dataDir,
	});
	const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
	const chatSummaryService = new ChatSummaryService(stores, sessionRuntime, providerProfileService);
	const liveChatOrchestrator = new LiveChatOrchestrator(sessionRuntime.chatRuntime, providerOrchestrator, {
		onAssistantAppended: (chatId) => chatSummaryService.triggerAutoSummary(chatId),
	});
	const assetService = new AssetService(paths.assetsDir);
	const mobileAccessService = new MobileAccessService(paths.dataDir);

	// Resolve listen host: 0.0.0.0 when mobile access is active, else default
	// Explicit RP_PLATFORM_HOST always wins.
	const resolvedHost = process.env.RP_PLATFORM_HOST ?? "0.0.0.0";

	// RuntimeApi adapter
	const runtime = new RuntimeApiAdapter(
		stores,
		providerProfileService,
		liveChatOrchestrator,
		chatSummaryService,
		sessionRuntime,
		promptPresetService,
		assetService,
		mobileAccessService,
	);

	// Hono app — with static frontend if available
	const app = await createApp({
		runtime,
		staticDir: paths.webEnabled ? paths.webDir : undefined,
		mobileAccessToken: mobileAccessService.getToken() ?? undefined,
	});

	const tlsOptions = tlsConfig ? { tls: tlsConfig } : {};
	const server = Bun.serve({
		fetch: app.fetch,
		port: paths.port,
		hostname: resolvedHost,
		idleTimeout: 255,
		...tlsOptions,
	});

	const proto = tlsConfig ? "https" : "http";
	console.log(`[standalone] Listening on ${proto}://${resolvedHost}:${paths.port}`);
	if (tlsConfig) {
		console.log(`[standalone] TLS enabled.`);
	}
	if (resolvedHost === "0.0.0.0") {
		console.log(`[standalone] Mobile access enabled — accepting connections from all interfaces.`);
	}

	// Open browser — always use 127.0.0.1 even when bound to 0.0.0.0
	if (paths.webEnabled && process.env.RP_PLATFORM_OPEN_BROWSER !== "0") {
		const browserUrl = `http://127.0.0.1:${paths.port}`;
		console.log(`[standalone] Opening browser at ${browserUrl}`);
		const args =
			process.platform === "win32" ? ["cmd", "/c", "start", "", browserUrl]
			: process.platform === "darwin" ? ["open", browserUrl]
			: ["xdg-open", browserUrl];
		Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
	} else if (paths.webEnabled) {
		console.log(`[standalone] Open http://127.0.0.1:${paths.port} in your browser.`);
	} else {
		console.log(`[standalone] Frontend not found. Install the web/ directory next to the executable.`);
	}

	// Graceful shutdown on Ctrl+C / SIGTERM / window close
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			console.log(`\n[standalone] Received ${signal}, shutting down...`);
			server.stop(true);
			process.exit(0);
		});
	}
})();

/**
 * Standalone server entry point for Claw Tavern .exe distribution.
 *
 * Uses resolveStandalonePaths() for all directory resolution.
 * Data lives in %LOCALAPPDATA%\ClawTavern (Windows) or OS-equivalent.
 * Program files (exe + web/) live in the installation directory.
 *
 * Usage:
 *   claw-tavern.exe          (compiled with bun build --compile)
 *   bun services/api/src/standalone-server.ts
 */

import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { setTokenCountFn } from "@rp-platform/prompt-pipeline";
import { resolveStandalonePaths } from "./standalone-paths.js";
import { createRuntimeStore } from "./session-runtime-store.js";
import { warmupTokenizers, countTokensDefault } from "./ai/tokenizer-service.js";
import { SessionRuntime } from "./session-runtime.js";
import { createProviderProfileService } from "./provider-profile-service.js";
import { PromptPresetService } from "./prompt-preset-service.js";
import { ProviderOrchestrator } from "./provider-orchestrator.js";
import { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import { ChatSummaryService } from "./chat-summary-service.js";
import { AssetService } from "./asset-service.js";
import { RuntimeApiAdapter } from "./runtime-api-adapter.js";
import { createApp } from "./app-factory.js";
import { configureLogDir } from "./send-debug-log.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const paths = resolveStandalonePaths();

console.log(`[standalone] Starting Claw Tavern...`);
console.log(`[standalone] Data:  ${paths.dataDir}`);
console.log(`[standalone] Web:   ${paths.webEnabled ? paths.webDir : "(not found — API-only mode)"}`);
console.log(`[standalone] Host:  ${paths.host}:${paths.port}`);

// ─── Ensure data directories ─────────────────────────────────────────────────

mkdirSync(paths.dataDir, { recursive: true });
mkdirSync(paths.assetsDir, { recursive: true });
mkdirSync(paths.traceDir, { recursive: true });
mkdirSync(paths.logsDir, { recursive: true });
configureLogDir(paths.logsDir);

// ─── Bootstrap ───────────────────────────────────────────────────────────────

(async () => {
	// Stores
	const stores = createRuntimeStore(paths.dataDir);

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
	setTokenCountFn(countTokensDefault);
	console.log("[standalone] Tokenizers ready.");

	// Services
	const providerProfileService = createProviderProfileService(stores.providers);
	const promptPresetService = new PromptPresetService(stores.presets);
	const sessionRuntime = new SessionRuntime(stores, {
		getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
		dataDir: paths.dataDir,
	});
	const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
	const liveChatOrchestrator = new LiveChatOrchestrator(sessionRuntime.chatRuntime, providerOrchestrator);
	const chatSummaryService = new ChatSummaryService(sessionRuntime, providerProfileService);
	const assetService = new AssetService(paths.assetsDir);

	// RuntimeApi adapter
	const runtime = new RuntimeApiAdapter(
		stores,
		providerProfileService,
		liveChatOrchestrator,
		chatSummaryService,
		sessionRuntime,
		promptPresetService,
		assetService,
	);

	// Hono app — with static frontend if available
	const app = createApp({
		runtime,
		staticDir: paths.webEnabled ? paths.webDir : undefined,
	});

	const server = Bun.serve({
		fetch: app.fetch,
		port: paths.port,
		hostname: paths.host,
		idleTimeout: 255,
	});

	console.log(`[standalone] Listening on http://${paths.host}:${paths.port}`);

	// Open browser
	if (paths.webEnabled && process.env.RP_PLATFORM_OPEN_BROWSER !== "0") {
		const url = `http://${paths.host}:${paths.port}`;
		console.log(`[standalone] Opening browser at ${url}`);
		const args =
			process.platform === "win32" ? ["cmd", "/c", "start", "", url]
			: process.platform === "darwin" ? ["open", url]
			: ["xdg-open", url];
		Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
	} else if (paths.webEnabled) {
		console.log(`[standalone] Open http://${paths.host}:${paths.port} in your browser.`);
	} else {
		console.log(`[standalone] Frontend not found. Install the web/ directory next to the executable.`);
	}

	// Graceful shutdown on Ctrl+C / SIGTERM
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			console.log(`\n[standalone] Received ${signal}, shutting down...`);
			server.stop(true);
			process.exit(0);
		});
	}
})();

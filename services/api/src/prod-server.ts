/**
 * Production server entry point.
 *
 * Builds on the same DI wiring as dev-server but serves the built frontend
 * from dist/ via Hono's serveStatic, so the whole app runs on a single port.
 *
 * Usage:
 *   bun services/api/src/prod-server.ts
 *
 * Environment:
 *   RP_PLATFORM_ROOT_DIR   — project root (default: two levels up)
 *   RP_PLATFORM_HOST       — listen host  (default: 127.0.0.1)
 *   RP_PLATFORM_PORT       — listen port  (default: 8787)
 */

import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { setTokenCountFn } from "@rp-platform/prompt-pipeline";
import { createRuntimeStore } from "./session-runtime-store.js";
import { warmupTokenizers, countTokens } from "./ai/tokenizer-service.js";
import { SessionRuntime } from "./session-runtime.js";
import { createProviderProfileService } from "./provider-profile-service.js";
import { PromptPresetService } from "./prompt-preset-service.js";
import { ProviderOrchestrator } from "./provider-orchestrator.js";
import { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import { ChatSummaryService } from "./chat-summary-service.js";
import { AssetService } from "./asset-service.js";
import { RuntimeApiAdapter } from "./runtime-api-adapter.js";
import { createApp } from "./app-factory.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const rootDir = process.env.RP_PLATFORM_ROOT_DIR ?? resolve(import.meta.dir, '..', '..', '..');
const host = process.env.RP_PLATFORM_HOST ?? "127.0.0.1";
const port = Number(process.env.RP_PLATFORM_PORT ?? "8787");

const staticDir = resolve(import.meta.dir, '..', '..', '..', 'apps', 'web', 'dist');

// ─── Bootstrap ───────────────────────────────────────────────────────────────

console.log(`[prod] Starting RP Platform...`);
console.log(`[prod] Root: ${rootDir}`);

mkdirSync(resolve(rootDir, "data"), { recursive: true });
mkdirSync(resolve(rootDir, "data", "assets"), { recursive: true });

// ─── DB init ─────────────────────────────────────────────────────────────────

(async () => {
	const staticEnabled = await Bun.file(resolve(staticDir, "index.html")).exists();
	console.log(`[prod] Static: ${staticEnabled ? staticDir : "(not built — API-only mode)"}`);
	// Stores
	const stores = await createRuntimeStore();

	// Seed
	await Promise.all([
		stores.characters.getSystemCharacter(),
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	console.log("[prod] Seed data ensured.");

	// Tokenizers
	await warmupTokenizers();
	setTokenCountFn(countTokens);
	console.log("[prod] Tokenizers ready.");

	// Services
	const providerProfileService = createProviderProfileService(stores.providers);
	const promptPresetService = new PromptPresetService(stores.presets);
	const sessionRuntime = new SessionRuntime(stores, {
		getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
	});
	const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
	const liveChatOrchestrator = new LiveChatOrchestrator(sessionRuntime.chatRuntime, providerOrchestrator);
	const chatSummaryService = new ChatSummaryService(sessionRuntime, providerProfileService);
	const assetService = new AssetService(resolve(rootDir, "data", "assets"));

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
	const app = await createApp({
		runtime,
		staticDir: staticEnabled ? staticDir : undefined,
	});

	const server = Bun.serve({
		fetch: app.fetch,
		port,
		hostname: host,
		idleTimeout: 255,
	});

	console.log(`[prod] Listening on http://${host}:${port}`);

	// Open browser (like dev-supervisor does)
	if (staticEnabled && process.env.RP_PLATFORM_OPEN_BROWSER !== "0") {
		const url = `http://${host}:${port}`;
		console.log(`[prod] Opening browser at ${url}`);
		const args =
			process.platform === "win32" ? ["cmd", "/c", "start", "", url]
			: process.platform === "darwin" ? ["open", url]
			: ["xdg-open", url];
		Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
	} else if (staticEnabled) {
		console.log(`[prod] Open http://${host}:${port} in your browser.`);
	} else {
		console.log(`[prod] Frontend not built. Run "bun run build:web" first, or use dev mode.`);
	}

	// Graceful shutdown on Ctrl+C / SIGTERM
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			console.log(`\n[prod] Received ${signal}, shutting down...`);
			server.stop(true);
			process.exit(0);
		});
	}
})().catch((err) => {
	console.error(`[prod] Fatal error:`, err);
	process.exit(1);
});

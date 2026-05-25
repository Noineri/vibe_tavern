/**
 * Production server entry point.
 *
 * Production server — serves built frontend + API from a single Bun process
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
import { mkdir } from "node:fs/promises";
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
import { resolveTlsConfig } from "./mobile-auth.js";
import { MobileAccessService } from "./mobile-access-service.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const rootDir = process.env.RP_PLATFORM_ROOT_DIR ?? resolve(import.meta.dir, '..', '..', '..');
const explicitHost = process.env.RP_PLATFORM_HOST;
const port = Number(process.env.RP_PLATFORM_PORT ?? "8787");
// Always listen on all interfaces — mobile access needs LAN reachability.
// Auth middleware protects /api/* when a token is set.
const defaultHost = "0.0.0.0";

const staticDir = resolve(import.meta.dir, '..', '..', '..', 'apps', 'web', 'dist');
const tlsConfig = resolveTlsConfig();

// ─── Bootstrap ───────────────────────────────────────────────────────────────

console.log(`[prod] Starting RP Platform...`);
console.log(`[prod] Root: ${rootDir}`);

await mkdir(resolve(rootDir, "data"), { recursive: true });
await mkdir(resolve(rootDir, "data", "assets"), { recursive: true });

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
	const mobileAccessService = new MobileAccessService(resolve(rootDir, "data"));

	// Resolve listen host: 0.0.0.0 when mobile access is active, else 127.0.0.1
	// Explicit RP_PLATFORM_HOST always wins.
	const host = explicitHost ?? defaultHost;

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
		staticDir: staticEnabled ? staticDir : undefined,
		mobileAccessToken: mobileAccessService.getToken() ?? undefined,
	});

	const tlsOptions = tlsConfig ? { tls: tlsConfig } : {};
	const server = Bun.serve({
		fetch: app.fetch,
		port,
		hostname: host,
		idleTimeout: 255,
		...tlsOptions,
	});

	const proto = tlsConfig ? "https" : "http";
	console.log(`[prod] Listening on ${proto}://${host}:${port}`);
	if (host === "0.0.0.0") {
		console.log(`[prod] Mobile access enabled — accepting connections from all interfaces.`);
	}
	if (tlsConfig) {
		console.log(`[prod] TLS enabled.`);
	}

	// Open browser — always use 127.0.0.1 even when bound to 0.0.0.0
	if (staticEnabled && process.env.RP_PLATFORM_OPEN_BROWSER !== "0") {
		const browserUrl = `http://127.0.0.1:${port}`;
		console.log(`[prod] Opening browser at ${browserUrl}`);
		const args =
			process.platform === "win32" ? ["cmd", "/c", "start", "", browserUrl]
			: process.platform === "darwin" ? ["open", browserUrl]
			: ["xdg-open", browserUrl];
		Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
	} else if (staticEnabled) {
		console.log(`[prod] Open http://127.0.0.1:${port} in your browser.`);
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

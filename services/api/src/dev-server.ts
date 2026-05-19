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
const host = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const port = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");

// ─── Bootstrap ───────────────────────────────────────────────────────────────

console.log("[bootstrap] Starting RP Platform API...");

mkdirSync(resolve(rootDir, "data"), { recursive: true });
mkdirSync(resolve(rootDir, "data", "assets"), { recursive: true });

// ─── DI wiring + server start ────────────────────────────────────────────────
// DB migrations run automatically inside createDb() — no separate drizzle-kit step needed.

(async () => {
	// Stores
	const stores = await createRuntimeStore();

	// Seed
	await Promise.all([
		stores.characters.getSystemCharacter(),
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	console.log("[bootstrap] Seed data ensured.");

	// Tokenizers
	await warmupTokenizers();
	setTokenCountFn(countTokens);
	console.log("[bootstrap] Tokenizers ready.");

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

	// RuntimeApi adapter (single facade for all routes)
	const runtime = new RuntimeApiAdapter(
		stores,
		providerProfileService,
		liveChatOrchestrator,
		chatSummaryService,
		sessionRuntime,
		promptPresetService,
		assetService,
	);

	// Hono app
	const app = await createApp({ runtime });

	// Start
	Bun.serve({
		fetch: app.fetch,
		port,
		hostname: host,
		idleTimeout: 255,
	});

	console.log(`RP Platform API listening on http://${host}:${port}`);
})().catch((err) => {
	console.error(`[bootstrap] Fatal error:`, err);
	process.exit(1);
});

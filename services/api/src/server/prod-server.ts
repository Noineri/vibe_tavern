/**
 * Production server entry point.
 *
 * Production server — serves built frontend + API from a single Bun process
 * from out/apps/web via Hono's serveStatic, so the whole app runs on a single port.
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
import { EventBus } from "@vibe-tavern/domain";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { createRuntimeStore } from "../session/session-runtime-store.js";
import { warmupTokenizers, countTokens } from "../ai/tokenizer-service.js";
import { SessionRuntime } from "../session/session-runtime.js";
import { createProviderProfileService } from "../providers/provider-profile-service.js";
import { PromptPresetService } from "../prompt/prompt-preset-service.js";
import { ProviderOrchestrator } from "../providers/provider-orchestrator.js";
import { LiveChatOrchestrator } from "../chat/live-chat-orchestrator.js";
import { ChatSummaryService } from "../chat/chat-summary-service.js";
import { getChatModeStrategy } from "../chat/chat-mode-strategy.js";
import { createChatSummaryFeature } from "../chat/chat-summary-feature.js";
import { FeatureRegistry } from "../feature-registry.js";
import { AssetService } from "../asset-service.js";
import { RuntimeApiAdapter } from "../runtime-api-adapter.js";
import { createApp } from "./app-factory.js";
import { resolveTlsConfig } from "../mobile-auth.js";
import { MobileAccessService } from "../mobile-access-service.js";
import { runStartupFileChecks } from "./startup-checks.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const rootDir = resolve(process.env.RP_PLATFORM_ROOT_DIR ?? process.cwd());
const explicitHost = process.env.RP_PLATFORM_HOST;
const port = Number(process.env.RP_PLATFORM_PORT ?? "8787");
// Always listen on all interfaces — mobile access needs LAN reachability.
// Auth middleware protects /api/* when a token is set.
const defaultHost = "0.0.0.0";

const staticDir = resolve(rootDir, 'out', 'apps', 'web');
const dataDir = resolve(process.env.RP_PLATFORM_DATA_DIR ?? resolve(rootDir, "data"));
const tlsConfig = resolveTlsConfig();

// ─── Bootstrap ───────────────────────────────────────────────────────────────

console.log(`[prod] Starting RP Platform...`);
console.log(`[prod] Root: ${rootDir}`);
console.log(`[prod] Data: ${dataDir}`);

await mkdir(dataDir, { recursive: true });
await mkdir(resolve(dataDir, "assets"), { recursive: true });

// ─── DB init ─────────────────────────────────────────────────────────────────

(async () => {
	const staticEnabled = await Bun.file(resolve(staticDir, "index.html")).exists();
	console.log(`[prod] Static: ${staticEnabled ? staticDir : "(not built — API-only mode)"}`);
	await runStartupFileChecks({ mode: "prod", rootDir, dataDir, staticDir });
	// Stores
	const stores = await createRuntimeStore(dataDir);

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
	const events = new EventBus();
	const chatSummaryService = new ChatSummaryService(stores, sessionRuntime, providerProfileService);
	const liveChatOrchestrator = new LiveChatOrchestrator(sessionRuntime.chatRuntime, providerOrchestrator, events, getChatModeStrategy("rp"));

	// Feature registry — features subscribe to events and mount routes
	const features = new FeatureRegistry();
	features.register(createChatSummaryFeature({ stores, sessionRuntime, providerProfileService }));
	const assetService = new AssetService(resolve(dataDir, "assets"));
	const mobileAccessService = new MobileAccessService(dataDir);

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
		mobileAccessToken: () => mobileAccessService.getToken(),
		enforceMobileAuth: true,
	});

	// Activate features after app is created (they may mount routes)
	features.activateAll({ events, router: app });

	// Проверяем, не занят ли порт, и предлагаем убить старый процесс
	try {
		const testServer = Bun.serve({
			fetch: () => new Response(),
			port,
			hostname: host,
		});
		testServer.stop(true);
	} catch (err: any) {
		if (err?.code === "EADDRINUSE") {
			console.error(`\n[prod] Port ${port} is already in use.`);

			// Находим PID процесса, занимающего порт
			let oldPid: string | null = null;
			try {
				if (process.platform === "win32") {
					const result = Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe" });
					const lines = new TextDecoder().decode(result.stdout).split("\n");
					for (const line of lines) {
						if (line.includes(`:${port}`) && line.includes("LISTENING")) {
							oldPid = line.trim().split(/\s+/).pop() ?? null;
							break;
						}
					}
				} else {
					// Linux/macOS/Android (Termux)
					const result = Bun.spawnSync(["ss", "-tlnp"], { stdout: "pipe" });
					const lines = new TextDecoder().decode(result.stdout).split("\n");
					for (const line of lines) {
						if (line.includes(`:${port}`)) {
							const match = line.match(/pid=(\d+)/);
							oldPid = match?.[1] ?? null;
							break;
						}
					}
				}
			} catch {}

			if (oldPid) {
				console.error(`[prod] Occupied by PID ${oldPid}.`);

				// В неинтерактивном режиме (Android/Termux) — убиваем автоматически
				if (!process.stdin?.isTTY) {
					console.log(`[prod] Non-interactive mode — killing PID ${oldPid}...`);
					try {
						process.kill(Number(oldPid), "SIGTERM");
						// Ждём освобождения порта
						for (let i = 0; i < 20; i++) {
							await new Promise(r => setTimeout(r, 250));
							try {
								const t = Bun.serve({ fetch: () => new Response(), port, hostname: host });
								t.stop(true);
								console.log(`[prod] Port ${port} freed.`);
								break;
							} catch {}
						}
					} catch {
						console.error(`[prod] Failed to kill PID ${oldPid}. Exiting.`);
						process.exit(1);
					}
				} else {
					// Интерактивный — спрашиваем Y/n
					console.log(`[prod] Kill PID ${oldPid}? [Y/n]`);
					const input = await new Promise<string>((resolve) => {
						process.stdin.resume();
						process.stdin.once("data", (data: Buffer) => {
							process.stdin.pause();
							resolve(data.toString().trim());
						});
					});
					if (input === "" || input.toLowerCase() === "y") {
						process.kill(Number(oldPid), "SIGTERM");
						for (let i = 0; i < 20; i++) {
							await new Promise(r => setTimeout(r, 250));
							try {
								const t = Bun.serve({ fetch: () => new Response(), port, hostname: host });
								t.stop(true);
								console.log(`[prod] Port ${port} freed.`);
								break;
							} catch {}
						}
					} else {
						console.error(`[prod] Cancelled. Exiting.`);
						process.exit(1);
					}
				}
			} else {
				console.error(`[prod] Could not find the process. Please kill it manually and try again.`);
				process.exit(1);
			}
		} else {
			throw err;
		}
	}

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

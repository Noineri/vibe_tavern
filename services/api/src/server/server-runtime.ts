import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { EventBus } from "@vibe-tavern/domain";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { countTokens, warmupTokenizers } from "../infrastructure/ai/tokenizer-service.js";
import { AssetService } from "../domain/asset/asset-service.js";
import { createChatSummaryFeature } from "../domain/chat/chat-summary-feature.js";
import { createChatEventsFeature } from "../domain/chat/chat-events-feature.js";
import { ChatSummaryService } from "../domain/chat/chat-summary-service.js";
import { ObjectiveService } from "../domain/insights/objective-service.js";
import { SceneTrackerService } from "../domain/insights/tracker-service.js";
import { createInsightsFeature, composeForwardStateWait } from "../domain/insights/insights-feature.js";
import { LiveChatOrchestrator } from "../domain/chat/live-chat-orchestrator.js";
import { FeatureRegistry } from "../shared/feature-registry.js";
import { MobileAccessService } from "../domain/mobile-access/mobile-access-service.js";
import { resolveTlsConfig } from "../domain/mobile-access/mobile-auth.js";
import { PromptPresetService } from "../domain/prompt/prompt-preset-service.js";
import { ProviderOrchestrator } from "../domain/providers/provider-orchestrator.js";
import { createProviderProfileService } from "../domain/providers/provider-profile-service.js";
import {
	setProviderFetchFactory,
	createProviderFetchFactory,
} from "../domain/providers/provider-fetch-factory.js";
import { createProxyService } from "../domain/providers/proxy-service.js";
import { QuotaService } from "../domain/quota/quota-service.js";
import { createQuotaFeature } from "../domain/quota/quota-feature.js";
import { RuntimeApiAdapter } from "../api/adapters/runtime-api-adapter.js";
import { SessionRuntime } from "../runtime/session/session-runtime.js";
import { createAiAssistantFeature } from "../domain/ai-assistant/ai-assistant-feature.js";
import { createRuntimeStore } from "../runtime/session/session-runtime-store.js";
import { SkillLibraryService } from "../domain/coauthor/skills/skill-library.js";
import { DiceService } from "../domain/dice/dice-service.js";
import type { RandomSource } from "@vibe-tavern/domain";
import { resolveBuiltinSkillsRoot, resolveUserSkillsRoot } from "../domain/coauthor/skills/skill-scanner.js";
import { configureLogDir } from "../shared/send-debug-log.js";
import { createApp } from "./app-factory.js";
import { addRuntimeTeardown, runRuntimeTeardowns, setRuntimeShutdownHook } from "./runtime-shutdown.js";
import { createLoadingHandler } from "./loading-placeholder.js";
import { closeAllSocksBridges } from "../domain/providers/socks-bridge.js";

export { apiNotReadyResponse } from "./loading-placeholder.js";
import { runStartupFileChecks } from "./startup-checks.js";

/**
 * Everything needed to build the live Hono application: data dirs, startup
 * file checks, stores, seed, tokenizers, domain services, feature registry.
 * Shared by the network-facing servers (prod/standalone, which wrap it in
 * `startServerRuntime`'s bind-first bootstrap) and the web dev server, which
 * mounts the returned app in-process next to the HMR frontend.
 */
export interface RuntimeAppConfig {
	readonly mode: "prod" | "standalone" | "dev";
	readonly rootDir?: string;
	readonly dataDir: string;
	readonly assetsDir: string;
	/** Built frontend directory to serve. Omit for API-only mode (dev server,
	 *  `prod-server --api-only`) — the web-bundle startup checks are skipped. */
	readonly staticDir?: string;
	readonly logsDir?: string;
	readonly extraDataDirs?: readonly string[];
	/** Embedded frontend files baked into the standalone .exe. When non-empty,
	 *  the SPA is served from the binary itself; no on-disk web/ folder is
	 *  required. Sourced from embedded-web-manifest.ts. */
	readonly embeddedWebFiles?: Record<string, string>;
}

export interface ServerRuntimeConfig {
	readonly mode: "prod" | "standalone";
	readonly rootDir?: string;
	readonly dataDir: string;
	readonly assetsDir: string;
	readonly staticDir: string;
	readonly staticEnabled: boolean;
	readonly host: string;
	readonly port: number;
	readonly logsDir?: string;
	readonly extraDataDirs?: readonly string[];
	readonly checkPortBeforeListen?: boolean;
	readonly shutdownSignals?: readonly NodeJS.Signals[];
	readonly missingFrontendMessage: string;
	readonly embeddedWebFiles?: Record<string, string>;
}

export async function createRuntimeApp(config: RuntimeAppConfig): Promise<Hono> {
	const tag = `[${config.mode}]`;

	await mkdir(config.dataDir, { recursive: true });
	await mkdir(config.assetsDir, { recursive: true });
	for (const dir of config.extraDataDirs ?? []) {
		await mkdir(dir, { recursive: true });
	}
	if (config.logsDir) {
		await mkdir(config.logsDir, { recursive: true });
		configureLogDir(config.logsDir);
	}

	await runStartupFileChecks({
		mode: config.mode,
		rootDir: config.rootDir,
		dataDir: config.dataDir,
		staticDir: config.staticDir,
		embeddedWebFiles: config.embeddedWebFiles,
	});

	// Stores
	const stores = await createRuntimeStore(config.dataDir);

	// Seed
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	console.log(`${tag} Seed data ensured.`);

	// Tokenizers
	await warmupTokenizers();
	setTokenCountFn(countTokens);
	console.log(`${tag} Tokenizers ready.`);

	// Provider proxy transport — bind the process-wide fetch factory so every
	// outbound provider request resolves the profile's proxy policy in one place.
	// Pre-bind direct/inherit callers preserve existing behavior; explicit proxy
	// intent fails closed until the live store-backed factory is available.
	setProviderFetchFactory(createProviderFetchFactory(stores.proxies));
	console.log(`${tag} Provider proxy transport bound.`);

	// Services
	// The bus is created first: the provider profile service announces profile
	// mutations on it, which the quota poller consumes without either module
	// importing the other.
	const events = new EventBus();
	const providerProfileService = createProviderProfileService(stores.providers, stores.proxies, events);
	const proxyService = createProxyService(stores.proxies);
	const promptPresetService = new PromptPresetService(stores.presets, stores.chats);
	// Skill library is constructed before SessionRuntime so the catalog can be
	// injected (CTX-S4): the co-author prompt shows a metadata-only catalog
	// and the model reads skill files on demand via read_skill_file.
	const skillLibraryService = new SkillLibraryService(
		resolveUserSkillsRoot(config.dataDir),
		await resolveBuiltinSkillsRoot(),
	);
	const sessionRuntime = new SessionRuntime(stores, {
		getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
		dataDir: config.dataDir,
		getSkillCatalog: async () => (await skillLibraryService.listCatalog()).entries,
	});
	const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
	const chatSummaryService = new ChatSummaryService(stores, sessionRuntime, providerProfileService);
	const objectiveService = new ObjectiveService(stores, sessionRuntime, providerProfileService);
	const trackerService = new SceneTrackerService(stores, sessionRuntime, providerProfileService);
	const liveChatOrchestrator = new LiveChatOrchestrator(
		sessionRuntime.chatRuntime,
		sessionRuntime.chatApp,
		providerOrchestrator,
		events,
		(chatId: string) => sessionRuntime.resolveChatModeStrategy(chatId as never),
		composeForwardStateWait(objectiveService, trackerService),
	);

	// Feature registry — features subscribe to events and mount routes
	const features = new FeatureRegistry();
	features.register(createChatSummaryFeature({ stores, sessionRuntime, providerProfileService, events }));
	features.register(createChatEventsFeature());
	features.register(createInsightsFeature({ objectiveService, trackerService }));

	const assetService = new AssetService(config.assetsDir, stores.content, (id) => stores.characters.resolveFolderName(id));
	const mobileAccessService = await MobileAccessService.create(config.dataDir);

	// RuntimeApi adapter
	// Production randomness source for dice rolls. Uses crypto.getRandomValues
	// for server-authoritative random numbers. Tests inject deterministic values.
	const cryptoRng: RandomSource = {
		intBelow(maxExclusive: number): number {
			const buf = new Uint32Array(1);
			crypto.getRandomValues(buf);
			return buf[0]! % maxExclusive;
		},
	};
	const diceService = new DiceService(stores, cryptoRng);
	const runtime = new RuntimeApiAdapter(
		stores,
		providerProfileService,
		proxyService,
		liveChatOrchestrator,
		chatSummaryService,
		sessionRuntime,
		promptPresetService,
		assetService,
		mobileAccessService,
		objectiveService,
		trackerService,
		skillLibraryService,
		diceService,
	);

	features.register(createAiAssistantFeature(runtime.aiAssistant));

	// Provider quota poller — automatic, per-profile, no manual refresh surface.
	// Started after the feature registry so its events have subscribers.
	const quotaService = new QuotaService({
		quota: stores.quota,
		profiles: providerProfileService,
		events,
	});
	features.register(createQuotaFeature({
		quota: stores.quota,
		profiles: providerProfileService,
		quotaService,
	}));

	const app = await createApp({
		runtime,
		staticDir: config.staticDir,
		embeddedWebFiles: config.embeddedWebFiles,
		mobileAccessToken: () => mobileAccessService.getToken(),
		enforceMobileAuth: true,
		configureFeatures: (router) => features.activateAll({ events, router }),
	});

	addRuntimeTeardown(() => quotaService.stop());
	await quotaService.start();

	console.log(`${tag} Application ready.`);
	return app;
}

export async function startServerRuntime(config: ServerRuntimeConfig): Promise<void> {
	const tag = `[${config.mode}]`;
	const tlsConfig = resolveTlsConfig();

	console.log(`${tag} Starting Vibe Tavern...`);
	if (config.rootDir) console.log(`${tag} Root: ${config.rootDir}`);
	console.log(`${tag} Data: ${config.dataDir}`);
	console.log(`${tag} Static: ${config.staticEnabled ? config.staticDir : "(not built — API-only mode)"}`);
	console.log(`${tag} Host: ${config.host}:${config.port}`);

	// ─── Early bind ───────────────────────────────────────────────────
	// Bind the port immediately with a loading placeholder so the user's
	// browser gets a branded "Vibe Tavern is loading..." page within
	// milliseconds of launch instead of "connection refused" for several
	// seconds while the DB / tokenizers / services initialize.
	if (config.checkPortBeforeListen) {
		await ensurePortAvailable({ host: config.host, port: config.port, tag });
	}

	const tlsOptions = tlsConfig ? { tls: tlsConfig } : {};

	let alegreyaFont: ArrayBuffer | null = null;
	const fontCandidates = [
		resolve(config.staticDir, 'fonts', 'Alegreya-VariableFont_wght.ttf'),
		...(config.rootDir
			? [resolve(config.rootDir, 'apps', 'web', 'public', 'fonts', 'Alegreya-VariableFont_wght.ttf')]
			: []),
	];
	for (const candidate of fontCandidates) {
		try {
			const fontFile = Bun.file(candidate);
			if (await fontFile.exists()) {
				alegreyaFont = await fontFile.arrayBuffer();
				break;
			}
		} catch { /* font file unreadable/missing — try next candidate, fall back to the default font */ }
	}

	// Mutable handler reference — swapped to the real Hono app once init
	// completes. Using a closure (rather than Bun's server.reload) keeps
	// the swap atomic and avoids the reported reload() bugs.
	let fetchHandler: (
		req: Request,
		server: Bun.Server<undefined>,
	) => Response | Promise<Response> = createLoadingHandler({ alegreyaFont });

	const server = Bun.serve({
		fetch: (req, s) => fetchHandler(req, s),
		port: config.port,
		hostname: config.host,
		idleTimeout: 255,
		...tlsOptions,
	});

	const proto = tlsConfig ? "https" : "http";
	console.log(`${tag} Listening on ${proto}://${config.host}:${config.port} (initializing...)`);
	if (config.host === "0.0.0.0") {
		console.log(`${tag} Mobile access enabled — accepting connections from all interfaces.`);
	}
	if (tlsConfig) {
		console.log(`${tag} TLS enabled.`);
	}

	openBrowserOrPrintMessage({
		mode: config.mode,
		staticEnabled: config.staticEnabled,
		port: config.port,
		missingFrontendMessage: config.missingFrontendMessage,
	});

	// Let the updater release the port without reaching into runtime internals.
	// The hook is async and awaited by `stopRuntimeServer` (and thus by
	// `shutdownAfterUpdate`), so the updater's exit path actually waits for the
	// loopback SOCKS5 bridges to close instead of racing a synchronous exit.
	setRuntimeShutdownHook(async () => {
		server.stop(true);
		await runRuntimeTeardowns();
		await closeAllSocksBridges();
	});

	// Register shutdown handlers early so Ctrl+C works even during init. The
	// guard makes signal-driven shutdown idempotent: a second SIGINT/SIGTERM
	// while the first cleanup is still in flight cannot launch overlapping
	// teardown or a duplicate exit.
	let isShuttingDown = false;
	const handleShutdownSignal = (signal: string): void => {
		console.log(`\n${tag} Received ${signal}, shutting down...`);
		if (isShuttingDown) return;
		isShuttingDown = true;
		void gracefulShutdown(server, tag);
	};
	for (const signal of config.shutdownSignals ?? ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => handleShutdownSignal(signal));
	}

	// ─── Background initialization ────────────────────────────────────
	// All heavy init runs AFTER the port is bound. The placeholder handler
	// serves loading HTML + 503 for API routes until this completes.
	try {
		const app = await createRuntimeApp({
			mode: config.mode,
			rootDir: config.rootDir,
			dataDir: config.dataDir,
			assetsDir: config.assetsDir,
			staticDir: config.staticEnabled ? config.staticDir : undefined,
			logsDir: config.logsDir,
			extraDataDirs: config.extraDataDirs,
			embeddedWebFiles: config.embeddedWebFiles,
		});

		// ─── Swap handler — real app is now serving all requests ───────
		fetchHandler = (req, s) => app.fetch(req, s);
	} catch (err) {
		console.error(`${tag} Initialization failed:`, err);
		// Serve a static error page instead of hanging on the loading
		// placeholder forever. The process stays alive so the user can
		// read the error in their browser; Ctrl+C still exits cleanly.
		fetchHandler = () =>
			new Response(STARTUP_ERROR_HTML, {
				status: 500,
				headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
			});
	}
}

/** Graceful shutdown: stop the HTTP server and close every SOCKS5 bridge before
 *  exiting. Bridges bind loopback ports that should not linger across a rapid
 *  restart; awaiting their close makes the teardown deterministic. Called on the
 *  signal path; the updater path goes through the async runtime-shutdown hook.
 *  The thrown/aggregate bridge error is credential-free, so logging it is safe. */
async function gracefulShutdown(server: Bun.Server<undefined>, tag: string): Promise<void> {
	server.stop(true);
	await runRuntimeTeardowns();
	try {
		await closeAllSocksBridges();
	} catch (err) {
		console.error(`${tag} Error closing SOCKS5 bridges during shutdown:`, err);
	}
	process.exit(0);
}

async function ensurePortAvailable(options: {
	readonly host: string;
	readonly port: number;
	readonly tag: string;
}): Promise<void> {
	try {
		const testServer = Bun.serve({
			fetch: () => new Response(),
			port: options.port,
			hostname: options.host,
		});
		testServer.stop(true);
	} catch (err) {
		const code = typeof err === "object" && err && "code" in err ? (err as { code?: unknown }).code : undefined;
		if (code !== "EADDRINUSE") throw err;

		console.error(`\n${options.tag} Port ${options.port} is already in use.`);
		const oldPid = findProcessOnPort(options.port);

		if (!oldPid) {
			console.error(`${options.tag} Could not find the process. Please kill it manually and try again.`);
			process.exit(1);
		}

		console.error(`${options.tag} Occupied by PID ${oldPid}.`);

		if (!process.stdin?.isTTY) {
			console.log(`${options.tag} Non-interactive mode — killing PID ${oldPid}...`);
			await killProcessAndWaitForPort(oldPid, options);
			return;
		}

		console.log(`${options.tag} Kill PID ${oldPid}? [Y/n]`);
		const input = await new Promise<string>((resolveInput) => {
			process.stdin.resume();
			process.stdin.once("data", (data: Buffer) => {
				process.stdin.pause();
				resolveInput(data.toString().trim());
			});
		});
		if (input === "" || input.toLowerCase() === "y") {
			await killProcessAndWaitForPort(oldPid, options);
		} else {
			console.error(`${options.tag} Cancelled. Exiting.`);
			process.exit(1);
		}
	}
}

function findProcessOnPort(port: number): string | null {
	try {
		if (process.platform === "win32") {
			const result = Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe" });
			const lines = new TextDecoder().decode(result.stdout).split("\n");
			for (const line of lines) {
				if (line.includes(`:${port}`) && line.includes("LISTENING")) {
					return line.trim().split(/\s+/).pop() ?? null;
				}
			}
		} else {
			const result = Bun.spawnSync(["ss", "-tlnp"], { stdout: "pipe" });
			const lines = new TextDecoder().decode(result.stdout).split("\n");
			for (const line of lines) {
				if (line.includes(`:${port}`)) {
					const match = line.match(/pid=(\d+)/);
					return match?.[1] ?? null;
				}
			}
		}
	} catch { /* port detection is best-effort; returning null just means "do not pre-kill" */ }
	return null;
}

async function killProcessAndWaitForPort(
	pid: string,
	options: {
		readonly host: string;
		readonly port: number;
		readonly tag: string;
	},
): Promise<void> {
	try {
		process.kill(Number(pid), "SIGTERM");
		for (let i = 0; i < 20; i++) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
			try {
				const testServer = Bun.serve({ fetch: () => new Response(), port: options.port, hostname: options.host });
				testServer.stop(true);
				console.log(`${options.tag} Port ${options.port} freed.`);
				return;
			} catch { /* port still bound — keep polling until it frees or we time out */ }
		}
	} catch {
		console.error(`${options.tag} Failed to kill PID ${pid}. Exiting.`);
		process.exit(1);
	}
}

const STARTUP_ERROR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vibe Tavern — Startup Failed</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{
    display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;
    background:#141210;color:#d1d0ba;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  .wrap{text-align:center;max-width:480px}
  .glyph{font-size:2.5rem;margin-bottom:1.25rem;opacity:.5}
  h1{font-size:1.2rem;font-weight:500;margin-bottom:.75rem}
  p{font-size:.95rem;line-height:1.6;color:#a3988f}
  code{font-family:ui-monospace,"SF Mono",Monaco,monospace;font-size:.85rem;
       background:#1f1d1a;padding:.15em .4em;border-radius:3px;color:#d1d0ba}
</style>
</head>
<body>
  <div class="wrap">
    <div class="glyph" aria-hidden="true">\u26A0\uFE0F</div>
    <h1>Vibe Tavern failed to start</h1>
    <p>Check the server console for error details. Press <code>Ctrl+C</code> to exit and try again.</p>
  </div>
</body>
</html>`;

function openBrowserOrPrintMessage(options: {
	readonly mode: ServerRuntimeConfig["mode"];
	readonly staticEnabled: boolean;
	readonly port: number;
	readonly missingFrontendMessage: string;
}): void {
	const tag = `[${options.mode}]`;
	if (options.staticEnabled && process.env.VIBE_TAVERN_OPEN_BROWSER !== "0") {
		const browserUrl = `http://127.0.0.1:${options.port}`;
		console.log(`${tag} Opening browser at ${browserUrl}`);
		const args =
			process.platform === "win32" ? ["cmd", "/c", "start", "", browserUrl]
			: process.platform === "darwin" ? ["open", browserUrl]
			: ["xdg-open", browserUrl];
		Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
	} else if (options.staticEnabled) {
		console.log(`${tag} Open http://127.0.0.1:${options.port} in your browser.`);
	} else {
		console.log(`${tag} ${options.missingFrontendMessage}`);
	}
}

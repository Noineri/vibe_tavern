import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { EventBus } from "@vibe-tavern/domain";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { countTokens, warmupTokenizers } from "../infrastructure/ai/tokenizer-service.js";
import { AssetService } from "../domain/asset/asset-service.js";
import { createChatSummaryFeature } from "../domain/chat/chat-summary-feature.js";
import { ChatSummaryService } from "../domain/chat/chat-summary-service.js";
import { getChatModeStrategy } from "../domain/chat/chat-mode-strategy.js";
import { LiveChatOrchestrator } from "../domain/chat/live-chat-orchestrator.js";
import { FeatureRegistry } from "../shared/feature-registry.js";
import { MobileAccessService } from "../domain/mobile-access/mobile-access-service.js";
import { resolveTlsConfig } from "../domain/mobile-access/mobile-auth.js";
import { PromptPresetService } from "../domain/prompt/prompt-preset-service.js";
import { ProviderOrchestrator } from "../domain/providers/provider-orchestrator.js";
import { createProviderProfileService } from "../domain/providers/provider-profile-service.js";
import { RuntimeApiAdapter } from "../api/adapters/runtime-api-adapter.js";
import { SessionRuntime } from "../session/session-runtime.js";
import { createAiAssistantFeature } from "../domain/ai-assistant/ai-assistant-feature.js";
import { createRuntimeStore } from "../session/session-runtime-store.js";
import { configureLogDir } from "../shared/send-debug-log.js";
import { createApp } from "./app-factory.js";
import { createLoadingHandler } from "./loading-placeholder.js";
import { runStartupFileChecks } from "./startup-checks.js";

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
		} catch {}
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

	// Register shutdown handlers early so Ctrl+C works even during init.
	for (const signal of config.shutdownSignals ?? ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			console.log(`\n${tag} Received ${signal}, shutting down...`);
			server.stop(true);
			process.exit(0);
		});
	}

	// ─── Background initialization ────────────────────────────────────
	// All heavy init runs AFTER the port is bound. The placeholder handler
	// serves loading HTML + 503 for API routes until this completes.
	try {
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

		// Services
		const providerProfileService = createProviderProfileService(stores.providers);
		const promptPresetService = new PromptPresetService(stores.presets, stores.chats);
		const sessionRuntime = new SessionRuntime(stores, {
			getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
			dataDir: config.dataDir,
		});
		const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
		const events = new EventBus();
		const chatSummaryService = new ChatSummaryService(stores, sessionRuntime, providerProfileService);
		const liveChatOrchestrator = new LiveChatOrchestrator(
			sessionRuntime.chatRuntime,
			sessionRuntime.chatApp,
			providerOrchestrator,
			events,
			getChatModeStrategy("rp"),
		);

		// Feature registry — features subscribe to events and mount routes
		const features = new FeatureRegistry();
		features.register(createChatSummaryFeature({ stores, sessionRuntime, providerProfileService }));

		const assetService = new AssetService(config.assetsDir);
		const mobileAccessService = new MobileAccessService(config.dataDir);

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

		features.register(createAiAssistantFeature(runtime.aiAssistant));

		// Hono app — with static frontend if available
		const app = await createApp({
			runtime,
			staticDir: config.staticEnabled ? config.staticDir : undefined,
			mobileAccessToken: () => mobileAccessService.getToken(),
			enforceMobileAuth: true,
			configureFeatures: (router) => features.activateAll({ events, router }),
		});

		// ─── Swap handler — real app is now serving all requests ───────
		fetchHandler = (req, s) => app.fetch(req, s);
		console.log(`${tag} Application ready.`);
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
	} catch {}
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
			} catch {}
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
	if (options.staticEnabled && process.env.RP_PLATFORM_OPEN_BROWSER !== "0") {
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

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { EventBus } from "@vibe-tavern/domain";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { countTokens, warmupTokenizers } from "../ai/tokenizer-service.js";
import { AssetService } from "../asset-service.js";
import { createChatSummaryFeature } from "../chat/chat-summary-feature.js";
import { ChatSummaryService } from "../chat/chat-summary-service.js";
import { getChatModeStrategy } from "../chat/chat-mode-strategy.js";
import { LiveChatOrchestrator } from "../chat/live-chat-orchestrator.js";
import { FeatureRegistry } from "../feature-registry.js";
import { MobileAccessService } from "../mobile-access-service.js";
import { resolveTlsConfig } from "../mobile-auth.js";
import { PromptPresetService } from "../prompt/prompt-preset-service.js";
import { ProviderOrchestrator } from "../providers/provider-orchestrator.js";
import { createProviderProfileService } from "../providers/provider-profile-service.js";
import { RuntimeApiAdapter } from "../runtime-api-adapter.js";
import { SessionRuntime } from "../session/session-runtime.js";
import { createScriptAiFeature } from "../scripts-engine/script-ai-feature.js";
import { createRuntimeStore } from "../session/session-runtime-store.js";
import { configureLogDir } from "../send-debug-log.js";
import { createApp } from "./app-factory.js";
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
		stores.characters.getSystemCharacter(),
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
	const promptPresetService = new PromptPresetService(stores.presets);
	const sessionRuntime = new SessionRuntime(stores, {
		getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
		dataDir: config.dataDir,
	});
	const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
	const events = new EventBus();
	const chatSummaryService = new ChatSummaryService(stores, sessionRuntime, providerProfileService);
	const liveChatOrchestrator = new LiveChatOrchestrator(
		sessionRuntime.chatRuntime,
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

	features.register(createScriptAiFeature(runtime));

	// Hono app — with static frontend if available
	const app = await createApp({
		runtime,
		staticDir: config.staticEnabled ? config.staticDir : undefined,
		mobileAccessToken: () => mobileAccessService.getToken(),
		enforceMobileAuth: true,
		configureFeatures: (router) => features.activateAll({ events, router }),
	});

	if (config.checkPortBeforeListen) {
		await ensurePortAvailable({ host: config.host, port: config.port, tag });
	}

	const tlsOptions = tlsConfig ? { tls: tlsConfig } : {};
	const server = Bun.serve({
		fetch: app.fetch,
		port: config.port,
		hostname: config.host,
		idleTimeout: 255,
		...tlsOptions,
	});

	const proto = tlsConfig ? "https" : "http";
	console.log(`${tag} Listening on ${proto}://${config.host}:${config.port}`);
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

	// Graceful shutdown on Ctrl+C / SIGTERM / optional window close signal
	for (const signal of config.shutdownSignals ?? ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			console.log(`\n${tag} Received ${signal}, shutting down...`);
			server.stop(true);
			process.exit(0);
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

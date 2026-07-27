/**
 * Dev server — the everyday `bun run dev`.
 *
 * One process, one port (default :4173): Bun's HTML dev server with HMR for
 * the frontend, plus the full API mounted IN-PROCESS via createRuntimeApp().
 * No proxy, no second server, no static prod bundle — requests to /api,
 * /assets and /health are handed straight to the Hono app, everything else
 * is the hot-reloading frontend. API initialization (DB, tokenizers,
 * services) runs in the background; API calls get a structured 503 until it
 * completes, exactly like the prod bind-first bootstrap.
 *
 * Flags:
 *   --no-api   Standalone frontend, no backend mounted — for pure-UI
 *              surfaces like the theme tuner (`bun run dev:web`).
 *
 * Environment:
 *   VIBE_TAVERN_WEB_DEV_PORT   — listen port (default: 4173)
 *   VIBE_TAVERN_OPEN_BROWSER=0 — don't auto-open the browser
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import indexHtml from "./index.html";
import { createRuntimeApp, apiNotReadyResponse } from "@vibe-tavern/api/server-runtime";

const PUBLIC_DIR = join(import.meta.dir, "public");
const ROOT = resolve(import.meta.dir, "..", "..");

const { values: cli } = parseArgs({
	args: process.argv.slice(2),
	options: { "no-api": { type: "boolean" } },
	strict: true,
});
const apiEnabled = cli["no-api"] !== true;

const PORT = Number(process.env.VIBE_TAVERN_WEB_DEV_PORT ?? "4173");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
	throw new RangeError("VIBE_TAVERN_WEB_DEV_PORT must be an integer from 1 to 65535");
}

type ApiHandler = (req: Request, server: Bun.Server<undefined>) => Response | Promise<Response>;

let apiHandler: ApiHandler = () => apiNotReadyResponse();

if (apiEnabled) {
	createRuntimeApp({
		mode: "dev",
		rootDir: ROOT,
		dataDir: resolve(ROOT, "data"),
		assetsDir: resolve(ROOT, "data", "assets"),
	}).then(
		(app) => {
			apiHandler = (req, server) => app.fetch(req, server);
		},
		(err: unknown) => {
			console.error("[dev] API initialization failed:", err);
			const message = err instanceof Error ? err.message : String(err);
			apiHandler = () =>
				new Response(`API initialization failed: ${message}`, {
					status: 500,
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
		},
	);
}

function isApiPath(pathname: string): boolean {
	return (
		pathname === "/api" ||
		pathname.startsWith("/api/") ||
		pathname.startsWith("/assets/") ||
		pathname === "/health"
	);
}

const server = Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",

	routes: {
		"/": indexHtml,
	},

	development: {
		hmr: true,
		console: true,
	},

	async fetch(req, serverInstance) {
		const url = new URL(req.url);
		const pathname = url.pathname;

		if (apiEnabled && isApiPath(pathname)) {
			return apiHandler(req, serverInstance);
		}

		const publicPath = join(PUBLIC_DIR, pathname);
		const publicRelativePath = relative(PUBLIC_DIR, publicPath);
		if (
			!publicRelativePath.startsWith("..") &&
			!isAbsolute(publicRelativePath)
		) {
			const publicFile = Bun.file(publicPath);
			if (await publicFile.exists()) {
				return new Response(publicFile);
			}
		}

		const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
		if (!hasExtension) {
			return fetch(new URL("/", req.url));
		}

		return new Response("Not Found", { status: 404 });
	},

	error(err) {
		console.error("[dev-server] error:", err);
		return new Response(`Internal Server Error: ${err.message}`, {
			status: 500,
		});
	},
});

console.log("");
console.log("  \x1b[1mVibe Tavern — Dev Server\x1b[0m");
console.log("  ────────────────────────────────────────────");
console.log(`  \x1b[36mLocal:\x1b[0m    http://localhost:${server.port}`);
console.log(`  \x1b[36mAPI:\x1b[0m      ${apiEnabled ? "in-process (503 until ready)" : "\x1b[33mdisabled\x1b[0m (--no-api)"}`);
console.log("  \x1b[36mHMR:\x1b[0m      enabled");
console.log("");

if (process.env.VIBE_TAVERN_OPEN_BROWSER !== "0") {
	const url = `http://localhost:${server.port}`;
	const args =
		process.platform === "win32" ? ["cmd", "/c", "start", "", url]
		: process.platform === "darwin" ? ["open", url]
		: ["xdg-open", url];
	Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
}

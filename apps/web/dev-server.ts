/**
 * Dev server — the everyday `bun run dev`.
 *
 * One process, one port (default :4173): Bun's HTML dev server with HMR for
 * the frontend, plus the full API mounted IN-PROCESS via createRuntimeApp().
 * No proxy, no second server, no static prod bundle — requests to /api and
 * /health are handed straight to the Hono app, everything else is the
 * hot-reloading frontend. API initialization (DB, tokenizers,
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
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import indexHtml from "./index.html";
import { createRuntimeApp, apiNotReadyResponse, serveErrorResponse } from "@vibe-tavern/api/server-runtime";

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
type PublicRoute = ReturnType<typeof Bun.file> | { readonly dir: string };

function resolvePublicRoutes(publicDir: string): Readonly<Record<string, PublicRoute>> {
	const routes: Record<string, PublicRoute> = {};
	for (const entry of readdirSync(publicDir, { withFileTypes: true })) {
		const path = join(publicDir, entry.name);
		if (entry.isDirectory()) {
			routes[`/${entry.name}/*`] = { dir: path };
		} else if (entry.isFile()) {
			routes[`/${entry.name}`] = Bun.file(path);
		}
	}
	return routes;
}

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

function handleApiRequest(
	req: Request,
	server: Bun.Server<undefined>,
): Response | Promise<Response> {
	return apiHandler(req, server);
}

// /assets/* deliberately stays on the frontend side. The dev API has no
// static directory, while public assets and HTML-bundle chunks belong here.
const apiRoutes = apiEnabled
	? {
			"/api": handleApiRequest,
			"/api/*": handleApiRequest,
			"/health": handleApiRequest,
		}
	: {
			"/api": indexHtml,
			"/api/*": indexHtml,
			"/health": indexHtml,
		};

const server = Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",
	// Prod parity (server-runtime.ts): Bun's default 10s idleTimeout kills slow
	// non-streaming API responses (model effect runs routinely take 9–60s with
	// zero bytes flowing) — the connection dies, the request signal aborts, and
	// the effect persists as `cancelled`. 255s matches the prod server.
	idleTimeout: 255,

	routes: {
		...resolvePublicRoutes(PUBLIC_DIR),
		...apiRoutes,
		"/": indexHtml,
		"/*": indexHtml,
	},

	development: {
		hmr: true,
		console: true,
	},

	error(err) {
		return serveErrorResponse("[dev-server]", err);
	},
});

const ansi = Bun.enableANSIColors
	? { bold: "\x1b[1m", cyan: "\x1b[36m", yellow: "\x1b[33m", reset: "\x1b[0m" }
	: { bold: "", cyan: "", yellow: "", reset: "" };

console.log("");
console.log(`  ${ansi.bold}Vibe Tavern — Dev Server${ansi.reset}`);
console.log("  ────────────────────────────────────────────");
console.log(`  ${ansi.cyan}Local:${ansi.reset}    http://localhost:${server.port}`);
console.log(`  ${ansi.cyan}API:${ansi.reset}      ${apiEnabled ? "in-process (503 until ready)" : `${ansi.yellow}disabled${ansi.reset} (--no-api)`}`);
console.log(`  ${ansi.cyan}HMR:${ansi.reset}      enabled`);
console.log("");

if (process.env.VIBE_TAVERN_OPEN_BROWSER !== "0") {
	const url = `http://localhost:${server.port}`;
	const args =
		process.platform === "win32" ? ["cmd", "/c", "start", "", url]
		: process.platform === "darwin" ? ["open", url]
		: ["xdg-open", url];
	Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
}

/**
 * Bun HTML-import development server for Vibe Tavern frontend.
 *
 * Replaces Vite for the frontend dev experience (task 5.2 of the Bun-native
 * frontend migration). Provides:
 *
 *   - HTML entry point with Bun's built-in HMR / Fast Refresh
 *   - JSX / TSX transpilation (Bun native)
 *   - Tailwind 4 CSS processing via @tailwindcss/node + @tailwindcss/oxide
 *   - data-component attribute injection (dev only, from task 5.1)
 *   - Define injection (__APP_VERSION__, __UPDATE_API_BASE__)
 *   - Static asset serving from public/ (fonts, icons, logos)
 *   - SPA fallback (non-file routes return index.html)
 *   - Debug mode: /api + /assets proxy to localhost:8787
 *
 * Usage:
 *   bun apps/web/dev-server.ts           # normal mode (no proxy)
 *   bun apps/web/dev-server.ts --debug   # debug mode (proxy to :8787)
 *   VT_DEV_DEBUG=1 bun apps/web/dev-server.ts
 *
 * Port: 4173
 *
 * Plugins are registered via bunfig.toml [serve.static] (see apps/web/dev-plugins.ts).
 * This is the only way to configure plugins for Bun's HTML-import dev server —
 * Bun.plugin() does not affect the dev server's internal bundler.
 *
 * This is a throwaway spike — Vite remains the rollback baseline until task 5.7.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import indexHtml from "./index.html";

// ─── Paths ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = __dirname;
const PUBLIC_DIR = path.join(WEB_DIR, "public");

// ─── CLI args ────────────────────────────────────────────────────────────────

const isDebug =
	process.argv.includes("--debug") || process.env.VT_DEV_DEBUG === "1";
const PORT = 4173;

// ─── HTTP fetch handler (static assets, SPA fallback, debug proxy) ───────────

/**
 * Proxy a request to the API server on localhost:8787 (debug mode only).
 */
async function proxyToApi(req: Request, pathname: string): Promise<Response> {
	const url = new URL(req.url);
	const targetUrl = `http://localhost:8787${pathname}${url.search}`;
	const headers = new Headers(req.headers);
	headers.set("host", "localhost:8787");

	try {
		return await fetch(targetUrl, {
			method: req.method,
			headers,
			body: req.body ?? undefined,
			redirect: "manual",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(
			`Debug proxy error — API server not reachable on :8787.\n${message}\n\n` +
				`Start the API server: RP_PLATFORM_PORT=8787 bun run dev`,
			{
				status: 502,
				headers: { "Content-Type": "text/plain" },
			},
		);
	}
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",

	// HTML-import route: Bun bundles index.html and its referenced assets
	routes: {
		"/": indexHtml,
	},

	// Development mode: HMR, Fast Refresh, detailed errors, console mirroring
	development: {
		hmr: true,
		console: true,
	},

	// Fallback handler for everything not matched by routes:
	//   - Debug proxy (/api, /assets → :8787)
	//   - Public assets (fonts, icons, logos)
	//   - SPA fallback (non-file routes → index.html)
	async fetch(req) {
		const url = new URL(req.url);
		const pathname = url.pathname;

		// ── Debug proxy ──────────────────────────────────────────────────
		if (
			isDebug &&
			(pathname.startsWith("/api/") ||
				pathname === "/api" ||
				pathname.startsWith("/assets/"))
		) {
			return proxyToApi(req, pathname);
		}

		// ── Public assets (fonts, icons, logos) ──────────────────────────
		// Prevent path traversal: reject any ".." in the pathname
		if (!pathname.includes("..")) {
			const publicPath = path.join(PUBLIC_DIR, pathname);
			const publicFile = Bun.file(publicPath);
			if (await publicFile.exists()) {
				return new Response(publicFile);
			}
		}

		// ── SPA fallback ─────────────────────────────────────────────────
		// Non-file routes (no extension) return the raw index.html.
		// The browser then requests /src/main.tsx which the HTML-import dev
		// server handles with full HMR.
		const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
		if (!hasExtension) {
			return new Response(Bun.file(path.join(WEB_DIR, "index.html")), {
				headers: { "Content-Type": "text/html" },
			});
		}

		// File with extension but not found
		return new Response("Not Found", { status: 404 });
	},

	error(err) {
		console.error("[dev-server] error:", err);
		return new Response(`Internal Server Error: ${err.message}`, {
			status: 500,
		});
	},
});

// ─── Startup banner ──────────────────────────────────────────────────────────

console.log("");
console.log("  \x1b[1mVibe Tavern — Bun Dev Server\x1b[0m");
console.log("  ────────────────────────────────────────────");
console.log(`  \x1b[36mLocal:\x1b[0m    http://localhost:${server.port}`);
console.log(
	`  \x1b[36mMode:\x1b[0m     ${isDebug ? "\x1b[33mDEBUG\x1b[0m (proxy → :8787)" : "normal (standalone)"}`,
);
console.log("  \x1b[36mHMR:\x1b[0m      enabled");
console.log("  \x1b[36mPlugins:\x1b[0m  data-component, tailwind, defines");
console.log("");
if (isDebug) {
	console.log(
		"  \x1b[33m⚠ Debug mode:\x1b[0m /api and /assets proxy to localhost:8787",
	);
	console.log(
		"    Make sure the API server is running: RP_PLATFORM_PORT=8787 bun run dev",
	);
	console.log("");
}

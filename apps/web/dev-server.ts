import { isAbsolute, join, relative } from "node:path";
import indexHtml from "./index.html";

const PUBLIC_DIR = join(import.meta.dir, "public");
const isDebug =
	process.argv.includes("--debug") || process.env.VT_DEV_DEBUG === "1";
const PORT = Number(process.env.RP_WEB_DEV_PORT ?? "4173");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
	throw new RangeError("RP_WEB_DEV_PORT must be an integer from 1 to 65535");
}

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

	async fetch(req) {
		const url = new URL(req.url);
		const pathname = url.pathname;

		if (
			isDebug &&
			(pathname.startsWith("/api/") ||
				pathname === "/api" ||
				pathname.startsWith("/assets/"))
		) {
			return proxyToApi(req, pathname);
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
console.log("  \x1b[1mVibe Tavern — Bun Dev Server\x1b[0m");
console.log("  ────────────────────────────────────────────");
console.log(`  \x1b[36mLocal:\x1b[0m    http://localhost:${server.port}`);
console.log(
	`  \x1b[36mMode:\x1b[0m     ${isDebug ? "\x1b[33mDEBUG\x1b[0m (proxy → :8787)" : "normal (standalone)"}`,
);
console.log("  \x1b[36mHMR:\x1b[0m      enabled");
console.log("  \x1b[36mPlugins:\x1b[0m  data-component, tailwind, build-config");
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

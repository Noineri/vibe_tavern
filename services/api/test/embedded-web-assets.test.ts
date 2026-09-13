import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app-factory.js";
import { embeddedWebUrlPath, loadEmbeddedWebFiles } from "../src/server/embedded-web-assets.js";
import { resolveFrontendSource } from "../src/server/server-runtime.js";
import type { RuntimeApi } from "../src/api/routes/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function webDirWith(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "vibe-tavern-embedded-web-"));
	temporaryDirectories.push(root);
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(root, ...relativePath.split("/"));
		await mkdir(join(target, ".."), { recursive: true });
		await Bun.write(target, content);
	}
	return root;
}

function embeddedMap(files: Record<string, { content: string; type: string }>): ReadonlyMap<string, Blob> {
	const map = new Map<string, Blob>();
	for (const [urlPath, { content, type }] of Object.entries(files)) {
		map.set(urlPath, new Blob([content], { type }));
	}
	return map;
}

const runtime = {} as RuntimeApi;

describe("embedded asset names", () => {
	// Bun names every file of an embedded directory after the directory's
	// BASENAME plus the path inside it — the parent path handed to the compile
	// step is dropped, whatever `--asset`'s help text says. The server maps
	// those names back to the URL pathnames the browser asks for.
	test("maps a frontend asset name to the URL pathname it answers", () => {
		expect(embeddedWebUrlPath("web/index.html")).toBe("/index.html");
		expect(embeddedWebUrlPath("web/assets/index-A1b2C3.js")).toBe("/assets/index-A1b2C3.js");
		expect(embeddedWebUrlPath("web/fonts/inter.woff2")).toBe("/fonts/inter.woff2");
	});

	// The name is a path produced on the build machine, so a Windows-built
	// binary may spell it with backslashes; both spellings must land on the
	// same URL.
	test("accepts either path separator", () => {
		expect(embeddedWebUrlPath("web\\assets\\index-A1b2C3.js")).toBe("/assets/index-A1b2C3.js");
	});

	// The binary can carry other embedded files (a second asset directory, a
	// `with { type: "file" }` import). Anything outside the frontend tree must
	// not become a servable URL.
	test("ignores files outside the frontend tree", () => {
		expect(embeddedWebUrlPath("drizzle/meta/_journal.json")).toBeNull();
		expect(embeddedWebUrlPath("web")).toBeNull();
		expect(embeddedWebUrlPath("webpack/index.html")).toBeNull();
	});

	// Outside a compiled binary there is nothing embedded, which is what makes
	// dev and tests fall through to the on-disk web/ directory.
	test("reports no embedded files when the process is not a compiled binary", () => {
		expect(Bun.isStandaloneExecutable).toBe(false);
		expect(loadEmbeddedWebFiles().size).toBe(0);
	});
});

describe("serving the embedded frontend", () => {
	test("serves embedded files with their own content type and no web/ folder", async () => {
		// Given
		const app = await createApp({
			runtime,
			embeddedWebFiles: embeddedMap({
				"/index.html": { content: "<main>embedded</main>", type: "text/html;charset=utf-8" },
				"/assets/app.js": { content: "export const from = 'embed';", type: "text/javascript;charset=utf-8" },
			}),
		});

		// When
		const script = await app.request("/assets/app.js");
		const spa = await app.request("/chats/chat_1");

		// Then
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toContain("text/javascript");
		expect(await script.text()).toBe("export const from = 'embed';");
		// Any non-asset route falls back to the embedded index.html so deep
		// links into the SPA work.
		expect(spa.status).toBe(200);
		expect(await spa.text()).toContain("<main>embedded</main>");
	});

	// A missing bundle chunk must not be answered with index.html: the browser
	// rejects HTML where it expects a module and the real failure (a chunk that
	// never shipped, or that antivirus quarantined) shows up as a frozen splash
	// with nothing in the console.
	test("answers a missing asset with 404, never with index.html", async () => {
		// Given
		const app = await createApp({
			runtime,
			embeddedWebFiles: embeddedMap({
				"/index.html": { content: "<main>embedded</main>", type: "text/html;charset=utf-8" },
			}),
		});

		// When
		const missing = await app.request("/assets/gone.js");

		// Then
		expect(missing.status).toBe(404);
		expect(await missing.text()).toBe("Asset not found: /assets/gone.js");
	});

	// The build ships both: the bundle inside the binary and a web/ folder next
	// to it. The folder wins so a frontend can be hot-patched without
	// recompiling — losing that silently would make patched installs serve the
	// stale embedded copy.
	test("prefers an on-disk frontend over the embedded copy", async () => {
		// Given
		const staticDir = await webDirWith({ "index.html": "<main>on disk</main>" });
		const app = await createApp({
			runtime,
			staticDir,
			embeddedWebFiles: embeddedMap({
				"/index.html": { content: "<main>embedded</main>", type: "text/html;charset=utf-8" },
			}),
		});

		// When
		const spa = await app.request("/chats/chat_1");

		// Then
		expect(await spa.text()).toContain("<main>on disk</main>");
	});

	// With neither source the server must stay an API: no static route may
	// swallow unknown paths.
	test("keeps the API 404 when nothing is embedded and nothing is on disk", async () => {
		// Given
		const app = await createApp({ runtime, embeddedWebFiles: new Map() });

		// When
		const missing = await app.request("/chats/chat_1");

		// Then
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "Route not found: GET /chats/chat_1" });
	});
});

describe("frontend source reported at startup", () => {
	// A user who extracted only the .exe has no web/ directory, and the startup
	// path used to read that as API-only: it printed "Frontend not found.
	// Install the web/ directory next to the executable." and skipped the
	// browser launch, while the binary was serving the SPA from inside itself.
	test("counts an embedded frontend as present when no web/ folder exists", () => {
		const source = resolveFrontendSource({
			staticEnabled: false,
			staticDir: "/opt/vibe-tavern/web",
			embeddedWebFiles: embeddedMap({
				"/index.html": { content: "<main>embedded</main>", type: "text/html;charset=utf-8" },
			}),
		});

		expect(source.available).toBe(true);
		expect(source.label).toContain("embedded in the executable");
	});

	test("reports the on-disk directory when one is enabled", () => {
		const source = resolveFrontendSource({ staticEnabled: true, staticDir: "/opt/vibe-tavern/web" });

		expect(source.available).toBe(true);
		expect(source.label).toBe("/opt/vibe-tavern/web");
	});

	// API-only runs (dev API, `prod-server --api-only`) must still say so —
	// that message is how the operator learns no UI will come up.
	test("stays API-only when there is neither an embedded nor an on-disk frontend", () => {
		const source = resolveFrontendSource({
			staticEnabled: false,
			staticDir: "/opt/vibe-tavern/web",
			embeddedWebFiles: new Map(),
		});

		expect(source.available).toBe(false);
		expect(source.label).toContain("API-only");
	});
});

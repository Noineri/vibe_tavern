/**
 * Conditional requests for the static frontend.
 *
 * Before this, no static response carried a validator, so a reload always
 * re-downloaded the bundle: measured on the built frontend, 10.0 MB over 5
 * requests, every time. Files on disk are now served by Bun `{dir}` routes
 * (which tag them), and the two sources that have no file to validate — the
 * copy embedded in the single-file binary and index.html — are tagged here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app-factory.js";
import { resolveStaticDirRoutes } from "../src/server/server-runtime.js";
import { weakEtag, withStaticValidator } from "../src/server/static-conditional.js";
import type { RuntimeApi } from "../src/api/routes/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function webDirWith(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "vibe-tavern-static-cond-"));
	temporaryDirectories.push(root);
	for (const [relativePath, content] of Object.entries(files)) {
		const absolute = join(root, relativePath);
		await mkdir(join(absolute, ".."), { recursive: true });
		await Bun.write(absolute, content);
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

describe("weak validators", () => {
	test("changes with the content and not with anything else", () => {
		expect(weakEtag("<main>a</main>")).toBe(weakEtag("<main>a</main>"));
		expect(weakEtag("<main>a</main>")).not.toBe(weakEtag("<main>b</main>"));
		// Same length, different bytes — a size-only validator would collide here.
		expect(weakEtag("abcd")).not.toBe(weakEtag("abce"));
		expect(weakEtag("abc")).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
	});

	test("a matching If-None-Match answers 304 with no body", async () => {
		const etag = weakEtag("payload");
		const request = new Request("http://localhost/x", { headers: { "If-None-Match": etag } });

		const response = withStaticValidator(request, etag, () => new Response("payload"));

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(etag);
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(await response.text()).toBe("");
	});

	test("accepts a list and the wildcard, rejects a different tag", () => {
		const etag = weakEtag("payload");
		const ask = (value: string): number =>
			withStaticValidator(
				new Request("http://localhost/x", { headers: { "If-None-Match": value } }),
				etag,
				() => new Response("payload"),
			).status;

		expect(ask(etag)).toBe(304);
		expect(ask("*")).toBe(304);
		expect(ask(`W/"other", ${etag}`)).toBe(304);
		// Weak comparison: the same entity-tag sent strong still matches.
		expect(ask(etag.replace(/^W\//, ""))).toBe(304);
		expect(ask('W/"1-2"')).toBe(200);
	});

	test("tags the built response when there is no validator to match", () => {
		const etag = weakEtag("payload");

		const response = withStaticValidator(
			new Request("http://localhost/x"),
			etag,
			() => new Response("payload", { headers: { "Content-Type": "text/plain" } }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("ETag")).toBe(etag);
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(response.headers.get("Content-Type")).toBe("text/plain");
	});
});

describe("static frontend responses", () => {
	test("an embedded asset revalidates into a 304 instead of resending the bundle", async () => {
		const app = await createApp({
			runtime,
			embeddedWebFiles: embeddedMap({
				"/index.html": { content: "<main>embedded</main>", type: "text/html;charset=utf-8" },
				"/assets/app.js": { content: "export const from = 'embed';", type: "text/javascript;charset=utf-8" },
			}),
		});

		const first = await app.request("/assets/app.js");
		const etag = first.headers.get("etag");
		expect(first.status).toBe(200);
		expect(etag).not.toBeNull();

		const second = await app.request("/assets/app.js", { headers: { "If-None-Match": etag ?? "" } });
		expect(second.status).toBe(304);
		expect(await second.text()).toBe("");
		// The content type still comes from the embedded blob on a full send.
		expect(first.headers.get("content-type")).toContain("text/javascript");
	});

	test("the SPA document revalidates on `/`, `/index.html` and a deep link alike", async () => {
		const staticDir = await webDirWith({ "index.html": "<main>on disk</main>" });
		const app = await createApp({ runtime, staticDir });

		for (const path of ["/", "/index.html", "/chats/chat_1"]) {
			const full = await app.request(path);
			expect(full.status, path).toBe(200);
			expect(await full.text()).toContain("<main>on disk</main>");
			const etag = full.headers.get("etag");
			expect(etag, path).not.toBeNull();

			const revalidated = await app.request(path, { headers: { "If-None-Match": etag ?? "" } });
			expect(revalidated.status, path).toBe(304);
			expect(await revalidated.text()).toBe("");
		}
	});

	test("a patched index.html on disk invalidates the old validator without a restart", async () => {
		const staticDir = await webDirWith({ "index.html": "<main>first</main>" });
		const app = await createApp({ runtime, staticDir });

		const before = await app.request("/");
		const staleEtag = before.headers.get("etag") ?? "";
		await Bun.write(join(staticDir, "index.html"), "<main>patched</main>");

		const afterPatch = await app.request("/", { headers: { "If-None-Match": staleEtag } });
		expect(afterPatch.status).toBe(200);
		expect(await afterPatch.text()).toContain("<main>patched</main>");
		const patchedEtag = afterPatch.headers.get("etag");
		expect(patchedEtag).not.toBeNull();
		expect(patchedEtag).not.toBe(staleEtag);
	});
});

describe("asset directory routes", () => {
	test("serves the built asset directories that exist", async () => {
		const staticDir = await webDirWith({
			"index.html": "<main>app</main>",
			"assets/app.js": "export const x = 1;",
			"fonts/Inter.ttf": "ttf",
		});

		const routes = resolveStaticDirRoutes({ staticEnabled: true, staticDir });

		expect(Object.keys(routes).sort()).toEqual(["/assets/*", "/fonts/*"]);
		expect(routes["/assets/*"]).toEqual({ dir: join(staticDir, "assets") });
	});

	test("skips a directory that is not there — Bun.serve throws on a missing dir route", async () => {
		const staticDir = await webDirWith({ "index.html": "<main>app</main>", "assets/app.js": "x" });

		const routes = resolveStaticDirRoutes({ staticEnabled: true, staticDir });

		expect(Object.keys(routes)).toEqual(["/assets/*"]);
		// Proof of the constraint the skip exists for.
		expect(() =>
			Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				routes: { "/fonts/*": { dir: join(staticDir, "fonts") } },
				fetch: () => new Response("fallback"),
			}),
		).toThrow();
	});

	test("declines to route when the binary carries an embedded frontend", async () => {
		const staticDir = await webDirWith({ "index.html": "<main>app</main>", "assets/app.js": "x" });

		const routes = resolveStaticDirRoutes({
			staticEnabled: true,
			staticDir,
			embeddedWebFiles: embeddedMap({
				"/index.html": { content: "<main>embedded</main>", type: "text/html;charset=utf-8" },
			}),
		});

		// A {dir} 404 does not fall through to fetch, so a chunk that ships only
		// inside the executable would 404 instead of being served.
		expect(routes).toEqual({});
	});

	test("declines to route in API-only mode", async () => {
		const staticDir = await webDirWith({ "index.html": "<main>app</main>", "assets/app.js": "x" });

		expect(resolveStaticDirRoutes({ staticEnabled: false, staticDir })).toEqual({});
	});

	test("Bun answers those routes with a validator, and a miss never reaches the app", async () => {
		const staticDir = await webDirWith({ "index.html": "<main>app</main>", "assets/app.js": "export const x = 1;" });
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			routes: resolveStaticDirRoutes({ staticEnabled: true, staticDir }),
			fetch: () => new Response("reached the app", { status: 418 }),
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;

			const full = await fetch(`${base}/assets/app.js`);
			const etag = full.headers.get("etag");
			expect(full.status).toBe(200);
			expect(etag).not.toBeNull();
			expect(full.headers.get("last-modified")).not.toBeNull();
			expect(await full.text()).toBe("export const x = 1;");

			const revalidated = await fetch(`${base}/assets/app.js`, {
				headers: { "If-None-Match": etag ?? "" },
			});
			expect(revalidated.status).toBe(304);
			expect(await revalidated.text()).toBe("");

			// This is the constraint that keeps the SPA fallback in the app: the
			// directory route answers its own misses.
			const missing = await fetch(`${base}/assets/gone.js`);
			expect(missing.status).toBe(404);

			// A path outside the routed prefixes still reaches the app.
			const app = await fetch(`${base}/chats/chat_1`);
			expect(app.status).toBe(418);
		} finally {
			server.stop(true);
		}
	});
});

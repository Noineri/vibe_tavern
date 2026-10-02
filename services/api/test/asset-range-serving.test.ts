/**
 * Asset serving over a real Bun.serve: Range support and the delete→fetch race.
 *
 * Asset responses carry a BunFile body, so the byte-range work is Bun's, not
 * ours — which is exactly why it has to be pinned at the socket and not at the
 * Response object: `app.request()` never runs Bun's range machinery, and a
 * BunFile body only fails (or streams a slice) when it is actually sent.
 *
 * The race is forced rather than raced: the file is unlinked after
 * AssetService.serve() has stat'ed it and before the response leaves the
 * handler, which is the same ordering a concurrent cleanup() produces.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore, createFileStore } from "@vibe-tavern/db";
import { Hono } from "hono";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { createAssetRoutes } from "../src/api/routes/asset.js";
import { serveErrorResponse } from "../src/server/serve-error.js";

const ASSET_ID = "asset_range_fixture";
const RACE_ID = "asset_race_fixture";
const EMPTY_ID = "asset_empty_fixture";
const SIZE = 4096;

const bytes = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) bytes[i] = i % 251;

let service: AssetService;
let server: Bun.Server<undefined>;
let base: string;
let assetsDir: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-asset-range-"));
	assetsDir = join(dataRoot, "assets");
	await mkdir(assetsDir, { recursive: true });
	await writeFile(join(assetsDir, `${ASSET_ID}.png`), bytes);
	await writeFile(join(assetsDir, `${RACE_ID}.png`), bytes);
	await writeFile(join(assetsDir, `${EMPTY_ID}.png`), new Uint8Array(0));

	service = new AssetService(assetsDir, new ContentStore({ fileStore: createFileStore(dataRoot) }));
	await service.writeGalleryImage(
		"char_1",
		"row_1",
		new File([bytes], "g.png", { type: "image/png" }),
	);

	const app = new Hono()
		.route("/", createAssetRoutes({
			uploadAsset: (file) => service.upload(file),
			serveAsset: (assetId) => service.serve(assetId),
		}))
		.get("/gallery/:rowId", async (c) => {
			const res = await service.serveGalleryImage("char_1", c.req.param("rowId"), "png");
			return res ?? c.json({ error: "not found" }, 404);
		})
		// Forces the delete→fetch ordering: serve() has already stat'ed the file
		// when the unlink lands, so the body fails on send, not in the handler.
		.get("/race/:assetId", async (c) => {
			const res = await service.serve(c.req.param("assetId"));
			if (!res) return c.json({ error: "not found" }, 404);
			await Bun.file(join(assetsDir, `${c.req.param("assetId")}.png`)).unlink();
			return res;
		})
		.get("/boom", () => {
			throw new TypeError("handler exploded");
		});

	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: app.fetch,
		error: (err) => serveErrorResponse("[test]", err),
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

describe("asset serving over Bun.serve", () => {
	test("serves the whole asset with its immutable cache headers", async () => {
		const res = await fetch(`${base}/api/assets/${ASSET_ID}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
	});

	test("answers a byte range with 206 + content-range and only those bytes", async () => {
		const res = await fetch(`${base}/api/assets/${ASSET_ID}`, {
			headers: { Range: "bytes=10-19" },
		});
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe(`bytes 10-19/${SIZE}`);
		expect(res.headers.get("Accept-Ranges")).toBe("bytes");
		// Range responses keep the headers the service set.
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(10, 20));
	});

	test("answers a suffix range from the tail of the file", async () => {
		const res = await fetch(`${base}/api/assets/${ASSET_ID}`, {
			headers: { Range: "bytes=-16" },
		});
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe(`bytes ${SIZE - 16}-${SIZE - 1}/${SIZE}`);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(SIZE - 16));
	});

	test("rejects an unsatisfiable range with 416", async () => {
		const res = await fetch(`${base}/api/assets/${ASSET_ID}`, {
			headers: { Range: `bytes=${SIZE + 10}-` },
		});
		expect(res.status).toBe(416);
		expect(res.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
	});

	test("folder-resident images are range-capable too", async () => {
		const res = await fetch(`${base}/gallery/row_1`, { headers: { Range: "bytes=0-3" } });
		expect(res.status).toBe(206);
		expect(res.headers.get("Content-Range")).toBe(`bytes 0-3/${SIZE}`);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(0, 4));
	});

	test("an unknown asset id is still a clean 404 from the route", async () => {
		const res = await fetch(`${base}/api/assets/asset_does_not_exist`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Asset not found" });
	});

	test("a zero-byte asset file is treated as absent", async () => {
		const res = await fetch(`${base}/api/assets/${EMPTY_ID}`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Asset not found" });
	});

	test("a file deleted mid-response is a 404, and the server survives it", async () => {
		const raced = await fetch(`${base}/race/${RACE_ID}`);
		expect(raced.status).toBe(404);
		expect(await raced.json()).toEqual({ error: "Not found" });

		const after = await fetch(`${base}/api/assets/${ASSET_ID}`);
		expect(after.status).toBe(200);
		expect((await after.arrayBuffer()).byteLength).toBe(SIZE);
	});

	test("a handler throw is answered by Hono, not by the error hook — and leaks nothing either way", async () => {
		const res = await fetch(`${base}/boom`);
		expect(res.status).toBe(500);
		const body = await res.text();
		// Bun's built-in error page is a ~50 KB HTML document carrying the server
		// cwd and absolute source paths. Neither layer may produce it.
		expect(body).not.toContain("<html");
		expect(body).not.toContain(process.cwd());
		expect(body.length).toBeLessThan(1000);
	});
});

describe("serveErrorResponse", () => {
	test("maps a vanished-file error to 404 and anything else to 500", async () => {
		const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/x'"), {
			code: "ENOENT",
		});
		const notFound = serveErrorResponse("[test]", enoent);
		expect(notFound.status).toBe(404);
		expect(await notFound.json()).toEqual({ error: "Not found" });

		const other = serveErrorResponse("[test]", Object.assign(new Error("disk on fire"), {
			code: "EIO",
		}));
		expect(other.status).toBe(500);
		expect(await other.json()).toEqual({ error: "Internal Server Error" });
	});

	test("never caches an error response", () => {
		const res = serveErrorResponse("[test]", new Error("plain"));
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});
});

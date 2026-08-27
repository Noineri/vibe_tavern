import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	buildHuggingFaceUrl,
	KokoroMirrorService,
	validateKokoroFilePath,
	type KokoroMirrorDeps,
} from "../src/domain/tts/kokoro-mirror.js";
import { createKokoroMirrorRoutes } from "../src/api/routes/kokoro-mirror.js";

const tmpRoot = await mkdtemp(join(tmpdir(), "kokoro-mirror-test-"));
afterAll(async () => {
	// Windows EBUSY: a just-closed cache file handle can linger a beat
	// (AV scan / delayed close). Retry; if it still fails, the OS temp
	// cleaner owns it — say so rather than failing the suite.
	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			await rm(tmpRoot, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 3) {
				console.warn("kokoro-mirror test cleanup failed (temp dir left for the OS):", error);
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
});

/** Build a service with a scripted transport (never touches the proxy factory). */
function makeService(script: (url: string) => Promise<Response>): {
	service: KokoroMirrorService;
	calls: string[];
} {
	const calls: string[] = [];
	const deps: KokoroMirrorDeps = {
		resolveFetch: async () => {
			return (input: Parameters<typeof fetch>[0]) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				calls.push(url);
				return script(url);
			};
		},
	};
	return { service: new KokoroMirrorService(tmpRoot, deps), calls };
}

/** Poll until the async disk-cache branch has landed a file (tee writes
 *  concurrently with the client stream, so existence is eventually-true). */
async function pollUntilFileExists(path: string, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await Bun.file(path).exists()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`cache file never appeared: ${path}`);
}

const okResponse = (body: string) =>
	new Response(body, {
		status: 200,
		headers: { "content-type": "application/octet-stream", "content-length": String(body.length) },
	});

describe("validateKokoroFilePath", () => {
	test("accepts real repo paths", () => {
		expect(validateKokoroFilePath("onnx/model_q4f16.onnx")).toBe("onnx/model_q4f16.onnx");
		expect(validateKokoroFilePath("config.json")).toBe("config.json");
		expect(validateKokoroFilePath("voices/af_heart.bin")).toBe("voices/af_heart.bin");
		expect(validateKokoroFilePath("onnx/tokenizer.json")).toBe("onnx/tokenizer.json");
	});

	test("rejects traversal and absolute shapes", () => {
		expect(validateKokoroFilePath("../etc/passwd")).toBeNull();
		expect(validateKokoroFilePath("onnx/../../etc/passwd")).toBeNull();
		expect(validateKokoroFilePath("a/./b.json")).toBeNull();
		expect(validateKokoroFilePath("/etc/passwd")).toBeNull();
		expect(validateKokoroFilePath("")).toBeNull();
	});

	test("rejects hostile characters (percent/backslash/space/control)", () => {
		expect(validateKokoroFilePath("a%2fb.json")).toBeNull();
		expect(validateKokoroFilePath("a\\b.json")).toBeNull();
		expect(validateKokoroFilePath("a b.json")).toBeNull();
		expect(validateKokoroFilePath("a\u0000.json")).toBeNull();
		expect(validateKokoroFilePath("a?x=1")).toBeNull();
	});

	test("rejects overlong paths", () => {
		expect(validateKokoroFilePath("a/".repeat(150) + "x.json")).toBeNull();
	});
});

describe("KokoroMirrorService", () => {
	test("streams an upstream 200 and caches it to disk", async () => {
		const { service, calls } = makeService(async () => okResponse("MODEL-BYTES"));
		const result = await service.handle("onnx/model_q4f16.onnx");
		expect(result.status).toBe(200);
		if (result.status !== 200) throw new Error("unreachable");
		expect(calls).toEqual([buildHuggingFaceUrl("onnx/model_q4f16.onnx")]);
		const text = await new Response(result.body).text();
		expect(text).toBe("MODEL-BYTES");
		// The disk branch writes concurrently — wait until it lands AND pin the
		// bytes (guards the BunFile.write streaming path against silent
		// stringification — see the comment in kokoro-mirror.ts).
		const cachePath = join(tmpRoot, "kokoro-model-cache", "onnx", "model_q4f16.onnx");
		await pollUntilFileExists(cachePath);
		expect(await Bun.file(cachePath).text()).toBe("MODEL-BYTES");
	});

	test("second request is served from cache without a new upstream fetch", async () => {
		let fetched = 0;
		const { service } = makeService(async () => {
			fetched += 1;
			return okResponse("CACHED-ONCE");
		});
		const first = await service.handle("from-cache.onnx");
		expect(first.status).toBe(200);
		// The disk write is concurrent with the client stream — make sure it
		// landed BEFORE the second request, or it would legitimately re-fetch.
		await pollUntilFileExists(join(tmpRoot, "kokoro-model-cache", "from-cache.onnx"));
		const second = await service.handle("from-cache.onnx");
		if (second.status !== 200) throw new Error("expected 200");
		expect(await new Response(second.body).text()).toBe("CACHED-ONCE");
		expect(second.status).toBe(200);
		expect(fetched).toBe(1);
	});

	test("concurrent requests share one in-flight fetch", async () => {
		let fetched = 0;
		const { service } = makeService(async () => {
			fetched += 1;
			await new Promise((resolve) => setTimeout(resolve, 30));
			return okResponse("SHARED");
		});
		const [a, b] = await Promise.all([service.handle("shared.onnx"), service.handle("shared.onnx")]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(fetched).toBe(1);
	});

	test("upstream 404 passes through as 404 and is not cached", async () => {
		const { service } = makeService(async () => new Response("nope", { status: 404 }));
		const result = await service.handle("missing.json");
		expect(result.status).toBe(404);
	});

	test("upstream failure maps to 502 without internals", async () => {
		const { service } = makeService(async () => {
			throw new Error("secret internal detail");
		});
		const result = await service.handle("broken.onnx");
		expect(result.status).toBe(502);
		if (result.status !== 200) {
			expect(result.error).not.toContain("secret");
		}
	});

	test("follows redirect chains to HTTPS targets (SOCKS-bridge manual mode)", async () => {
		let hop = 0;
		const { service, calls } = makeService(async () => {
			hop += 1;
			if (hop === 1) {
				return new Response(null, {
					status: 302,
					headers: { location: "https://cas-bridge.example.net/real-file" },
				});
			}
			return okResponse("REDIRECTED-BYTES");
		});
		const result = await service.handle("redirect.onnx");
		expect(result.status).toBe(200);
		expect(calls).toEqual([
			buildHuggingFaceUrl("redirect.onnx"),
			"https://cas-bridge.example.net/real-file",
		]);
	});

	test("rejects redirects that leave HTTPS", async () => {
		const { service } = makeService(async () => {
			return new Response(null, {
				status: 302,
				headers: { location: "http://plain.example.net/leak" },
			});
		});
		const result = await service.handle("http-redirect.onnx");
		expect(result.status).toBe(502);
	});

	test("invalid paths are rejected before any fetch", async () => {
		const { service, calls } = makeService(async () => okResponse("x"));
		const result = await service.handle("onnx/../../escape");
		expect(result.status).toBe(400);
		expect(calls).toEqual([]);
	});
});

describe("kokoro mirror route (HTTP layer)", () => {
	test("GET /api/tts/kokoro/model/* streams a file with no-store", async () => {
		const { service } = makeService(async () => okResponse("ROUTE-BYTES"));
		const app = createKokoroMirrorRoutes(service);
		// Distinct path: the service tests share tmpRoot, and this one must
		// exercise the UPSTREAM path, not an earlier test's disk cache hit.
		const res = await app.request("/api/tts/kokoro/model/route-check/model.onnx");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(await res.text()).toBe("ROUTE-BYTES");
	});

	test("traversal in the URL wildcard → 400", async () => {
		const { service } = makeService(async () => okResponse("x"));
		const app = createKokoroMirrorRoutes(service);
		// Encoded traversal reaches the route as a raw path segment.
		const res = await app.request("/api/tts/kokoro/model/onnx%2F..%2F..%2Fescape");
		expect(res.status).toBe(400);
	});

	test("upstream miss → 404 JSON error", async () => {
		const { service } = makeService(async () => new Response("nope", { status: 404 }));
		const app = createKokoroMirrorRoutes(service);
		const res = await app.request("/api/tts/kokoro/model/missing.json");
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(typeof body.error).toBe("string");
	});
});

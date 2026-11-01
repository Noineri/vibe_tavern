import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { precompressWebAssets } from "./precompress-web-assets.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("precompresses bundle, public assets and raw fonts without recompressing packed formats", async () => {
	const root = await mkdtemp(join(tmpdir(), "vibe-precompress-"));
	roots.push(root);
	const content = "compressible asset data ".repeat(256);
	const supported = ["assets/app.js", "assets/app.css", "assets/icon.svg", "assets/nested/data.json", "fonts/font.ttf", "assets/font.otf"];
	const excluded = ["index.html", "assets/app.js.map", "assets/photo.png", "fonts/font.woff2", "fonts/font.woff", "assets/model.wasm", "assets/existing.js.br", "assets/existing.js.gz"];
	for (const path of [...supported, ...excluded]) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await Bun.write(join(root, path), content);
	}
	expect(await precompressWebAssets(root)).toBe(supported.length * 2);
	for (const path of supported) {
		const br = await Bun.file(join(root, `${path}.br`)).arrayBuffer();
		const gz = await Bun.file(join(root, `${path}.gz`)).arrayBuffer();
		expect(brotliDecompressSync(br).toString()).toBe(content);
		expect(new TextDecoder().decode(Bun.gunzipSync(gz))).toBe(content);
		expect(br.byteLength).toBeLessThan(content.length);
		expect(gz.byteLength).toBeLessThan(content.length);
	}
	for (const path of excluded) {
		expect(await Bun.file(join(root, `${path}.br`)).exists()).toBe(false);
		expect(await Bun.file(join(root, `${path}.gz`)).exists()).toBe(false);
	}
});

test("missing asset directories and files too small to benefit need no siblings", async () => {
	const root = await mkdtemp(join(tmpdir(), "vibe-precompress-small-"));
	roots.push(root);
	expect(await precompressWebAssets(root)).toBe(0);
	await mkdir(join(root, "assets"));
	await Bun.write(join(root, "assets/tiny.js"), "x");
	expect(await precompressWebAssets(root)).toBe(0);
	expect(await Bun.file(join(root, "assets/tiny.js.br")).exists()).toBe(false);
	expect(await Bun.file(join(root, "assets/tiny.js.gz")).exists()).toBe(false);
});

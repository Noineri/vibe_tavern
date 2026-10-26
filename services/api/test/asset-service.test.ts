import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { ContentStore, createFileStore, STORAGE_FOLDERS } from "@vibe-tavern/db";
import { createAssetRoutes } from "../src/api/routes/asset.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { countTokensDefault } from "../src/infrastructure/ai/tokenizer-service.js";
import { minimalPng } from "./image-bytes.js";

const CHARS = STORAGE_FOLDERS.characters;
const PERSONAS = STORAGE_FOLDERS.personas;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-asset-test-"));
	const assetsDir = join(dataRoot, "assets");
	await mkdir(assetsDir, { recursive: true });
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const service = new AssetService(assetsDir, content);
	return { dataRoot, assetsDir, content, service };
}

describe("AssetService folder-resident avatars (B3)", () => {
	test("writeCharacterAvatar writes {id}/avatar.{ext} and returns ext", async () => {
		const { dataRoot, service } = await setup();
		const file = new File([PNG_BYTES], "ava.png", { type: "image/png" });
		const { ext } = await service.writeCharacterAvatar("char_1", file);
		expect(ext).toBe("png");
		const onDisk = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.png")).arrayBuffer());
		expect(onDisk).toEqual(Buffer.from(PNG_BYTES));
	});

	test("writePersonaAvatar writes under personas/", async () => {
		const { dataRoot, service } = await setup();
		const { ext } = await service.writePersonaAvatar("pers_1", new File([WEBP_BYTES], "a.webp", { type: "image/webp" }));
		expect(ext).toBe("webp");
		const onDisk = Buffer.from(await Bun.file(join(dataRoot, PERSONAS, "pers_1", "avatar.webp")).arrayBuffer());
		expect(onDisk).toEqual(Buffer.from(WEBP_BYTES));
	});

	test("write rejects unsupported mime", async () => {
		const { service } = await setup();
		await expect(
			service.writeCharacterAvatar("char_1", new File([new Uint8Array(1)], "a.bmp", { type: "image/bmp" })),
		).rejects.toThrow(/Unsupported image type/);
	});

	test("writeCharacterAvatar normalizes a real PNG to a ≤ 512 webp and reports the verdict (LB-1B)", async () => {
		const { dataRoot, service } = await setup();
		const big = minimalPng(600, 600);
		const r = await service.writeCharacterAvatar("char_1", new File([big], "a.png", { type: "image/png" }));
		expect(r).toEqual({ ext: "webp", changed: true, originalExt: "png" });
		const onDisk = new Uint8Array(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.webp")).arrayBuffer());
		const meta = await new Bun.Image(onDisk).metadata();
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(512);
	});

	test("the write no longer deletes sibling leaves; deleteCharacterAvatarLeaf does it (LB-1B follow-up)", async () => {
		const { dataRoot, service } = await setup();
		// First write: corrupt PNG bytes → the normalizer falls back → avatar.png.
		await service.writeCharacterAvatar("char_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));
		// Second write: a real PNG → avatar.webp. The write itself must NOT touch
		// the stale leaf anymore (callers delete it AFTER the store update).
		await service.writeCharacterAvatar("char_1", new File([minimalPng(600, 600)], "b.png", { type: "image/png" }));
		expect(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.png")).exists()).toBe(true);
		expect(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.webp")).exists()).toBe(true);
		// The explicit leaf delete removes only the stale leaf (never throws;
		// a missing leaf is a silent no-op).
		await service.deleteCharacterAvatarLeaf("char_1", "png");
		expect(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.png")).exists()).toBe(false);
		expect(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.webp")).exists()).toBe(true);
		await service.deleteCharacterAvatarLeaf("char_1", "png");
	});

	test("serveCharacterAvatar returns the bytes + Content-Type; null when missing", async () => {
		const { service } = await setup();
		await service.writeCharacterAvatar("char_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));

		const res = await service.serveCharacterAvatar("char_1", "png");
		expect(res).not.toBeNull();
		expect(res!.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(PNG_BYTES);

		// wrong ext → file not found → null (no probing at serve time)
		expect(await service.serveCharacterAvatar("char_1", "webp")).toBeNull();
		// unknown entity → null
		expect(await service.serveCharacterAvatar("char_missing", "png")).toBeNull();
	});

	test("loadCharacterAvatarBuffer round-trips a Buffer (for vision describe)", async () => {
		const { service } = await setup();
		await service.writeCharacterAvatar("char_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));
		const buf = await service.loadCharacterAvatarBuffer("char_1", "png");
		expect(buf).not.toBeNull();
		expect(new Uint8Array(buf!)).toEqual(PNG_BYTES);
		expect(await service.loadCharacterAvatarBuffer("char_1", "gif")).toBeNull();
	});

	test("migrateFlatAvatarToFolder copies the flat asset into {id}/avatar.{ext} and returns ext; leaves the source", async () => {
		const { dataRoot, assetsDir, service } = await setup();
		// Simulate a legacy flat asset uploaded via the old /api/assets path.
		const assetId = "asset_abc123";
		await Bun.write(join(assetsDir, `${assetId}.png`), PNG_BYTES);

		const result = await service.migrateFlatAvatarToFolder({ kind: "character", id: "char_1" }, assetId);
		expect(result).toEqual({ ext: "png" });

		// Copied into the folder
		const copied = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.png")).arrayBuffer());
		expect(copied).toEqual(Buffer.from(PNG_BYTES));

		// Flat source preserved (copy-forward)
		const source = Buffer.from(await Bun.file(join(assetsDir, `${assetId}.png`)).arrayBuffer());
		expect(source).toEqual(Buffer.from(PNG_BYTES));
	});

	test("migrateFlatAvatarToFolder returns null when the flat asset is gone (caller leaves avatarAssetId as-is)", async () => {
		const { service } = await setup();
		const result = await service.migrateFlatAvatarToFolder({ kind: "persona", id: "pers_1" }, "asset_nope");
		expect(result).toBeNull();
	});

	test("migrateFlatAvatarToFolder rejects path-traversal assetIds", async () => {
		const { service } = await setup();
		expect(await service.migrateFlatAvatarToFolder({ kind: "character", id: "c1" }, "../escape")).toBeNull();
		expect(await service.migrateFlatAvatarToFolder({ kind: "character", id: "c1" }, "a/b")).toBeNull();
	});

	test("folder methods throw / no-op when contentStore is unset (bare helper)", async () => {
		const { assetsDir } = await setup();
		const bare = new AssetService(assetsDir); // no contentStore
		await expect(
			bare.writeCharacterAvatar("c1", new File([PNG_BYTES], "a.png", { type: "image/png" })),
		).rejects.toThrow(/folder storage/);
		expect(await bare.serveCharacterAvatar("c1", "png")).toBeNull();
		expect(await bare.loadCharacterAvatarBuffer("c1", "png")).toBeNull();
		expect(await bare.migrateFlatAvatarToFolder({ kind: "character", id: "c1" }, "asset_x")).toBeNull();
	});
});

describe("AssetService full-avatar overwrite (Bug #2 characterization)", () => {
	// Repro: the user reports that swapping/updating a character avatar changes
	// the thumbnail (avatar.{ext}) but NOT the full (avatar-full.{ext}) — and the
	// stale full survives a page reload AND a server restart. Restart-resilience
	// rules out in-memory state, so the question is whether the backend actually
	// overwrites {id}/avatar-full.{ext} on the second write. These tests pin the
	// backend write+serve path in isolation (no gallery, no salvage, no UI).
	const FULL_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xaa, 0xaa, 0xaa]);
	const FULL_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb]);

	test("writeCharacterAvatarFull overwrites the prior full on a second write", async () => {
		const { dataRoot, service } = await setup();
		await service.writeCharacterAvatarFull("char_1", new File([FULL_A], "a.png", { type: "image/png" }));
		let onDisk = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar-full.png")).arrayBuffer());
		expect(onDisk).toEqual(Buffer.from(FULL_A));

		// Second write with different bytes + different length — must overwrite, not append/no-op.
		await service.writeCharacterAvatarFull("char_1", new File([FULL_B], "b.png", { type: "image/png" }));
		onDisk = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar-full.png")).arrayBuffer());
		expect(onDisk).toEqual(Buffer.from(FULL_B));
		expect(onDisk.length).toBe(FULL_B.length);
	});

	test("serveCharacterAvatarFull returns the SECOND bytes after overwrite", async () => {
		const { service } = await setup();
		await service.writeCharacterAvatarFull("char_1", new File([FULL_A], "a.png", { type: "image/png" }));
		await service.writeCharacterAvatarFull("char_1", new File([FULL_B], "b.png", { type: "image/png" }));
		const res = await service.serveCharacterAvatarFull("char_1", "png");
		expect(res).not.toBeNull();
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(FULL_B);
	});

	test("writeCharacterAvatarFull and writeCharacterAvatar are independent leaves", async () => {
		// The crop (avatar.png) and full (avatar-full.png) must not alias each other.
		const { dataRoot, service } = await setup();
		await service.writeCharacterAvatar("char_1", new File([PNG_BYTES], "crop.png", { type: "image/png" }));
		await service.writeCharacterAvatarFull("char_1", new File([FULL_B], "full.png", { type: "image/png" }));
		const crop = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar.png")).arrayBuffer());
		const full = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "avatar-full.png")).arrayBuffer());
		expect(crop).toEqual(Buffer.from(PNG_BYTES));
		expect(full).toEqual(Buffer.from(FULL_B));
	});
});

describe("AssetService character media gallery (A4)", () => {
	test("writeGalleryImage writes {charId}/gallery/{rowId}.{ext} and returns {ext, mimeType}", async () => {
		const { dataRoot, service } = await setup();
		const result = await service.writeGalleryImage("char_1", "row_7", new File([PNG_BYTES], "p.png", { type: "image/png" }));
		expect(result).toEqual({ ext: "png", mimeType: "image/png" });
		const onDisk = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "gallery", "row_7.png")).arrayBuffer());
		expect(onDisk).toEqual(Buffer.from(PNG_BYTES));
	});

	test("writeGalleryImage rejects unsupported mime", async () => {
		const { service } = await setup();
		await expect(
			service.writeGalleryImage("char_1", "row_1", new File([new Uint8Array(1)], "a.bmp", { type: "image/bmp" })),
		).rejects.toThrow(/Unsupported image type/);
	});

	test("serveGalleryImage returns bytes + Content-Type; null when wrong ext / missing", async () => {
		const { service } = await setup();
		await service.writeGalleryImage("char_1", "row_1", new File([WEBP_BYTES], "a.webp", { type: "image/webp" }));

		const res = await service.serveGalleryImage("char_1", "row_1", "webp");
		expect(res).not.toBeNull();
		expect(res!.headers.get("Content-Type")).toBe("image/webp");
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(WEBP_BYTES);

		// wrong ext → file not found → null (no serve-time probing)
		expect(await service.serveGalleryImage("char_1", "row_1", "png")).toBeNull();
		// unknown row → null
		expect(await service.serveGalleryImage("char_1", "row_missing", "webp")).toBeNull();
	});

	test("loadGalleryImageBuffer round-trips a Buffer (for vision describe)", async () => {
		const { service } = await setup();
		await service.writeGalleryImage("char_1", "row_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));
		const buf = await service.loadGalleryImageBuffer("char_1", "row_1", "png");
		expect(buf).not.toBeNull();
		expect(new Uint8Array(buf!)).toEqual(PNG_BYTES);
		expect(await service.loadGalleryImageBuffer("char_1", "row_1", "gif")).toBeNull();
	});

	test("deleteGalleryImage removes the single leaf and leaves siblings; no-op when missing", async () => {
		const { dataRoot, service } = await setup();
		await service.writeGalleryImage("char_1", "row_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));
		await service.writeGalleryImage("char_1", "row_2", new File([WEBP_BYTES], "b.webp", { type: "image/webp" }));

		await service.deleteGalleryImage("char_1", "row_1", "png");

		// targeted leaf gone
		await expect(Bun.file(join(dataRoot, CHARS, "char_1", "gallery", "row_1.png")).arrayBuffer()).rejects.toThrow();
		// sibling untouched
		const sibling = Buffer.from(await Bun.file(join(dataRoot, CHARS, "char_1", "gallery", "row_2.webp")).arrayBuffer());
		expect(sibling).toEqual(Buffer.from(WEBP_BYTES));

		// no-op when already missing
		await expect(service.deleteGalleryImage("char_1", "row_1", "png")).resolves.toBeUndefined();
		// no-op when wrong ext (file not present at that path)
		await expect(service.deleteGalleryImage("char_1", "row_2", "png")).resolves.toBeUndefined();
	});

	test("gallery methods throw / no-op when contentStore is unset (bare helper)", async () => {
		const { assetsDir } = await setup();
		const bare = new AssetService(assetsDir); // no contentStore
		await expect(
			bare.writeGalleryImage("c1", "row_1", new File([PNG_BYTES], "a.png", { type: "image/png" })),
		).rejects.toThrow(/folder storage/);
		expect(await bare.serveGalleryImage("c1", "row_1", "png")).toBeNull();
		expect(await bare.loadGalleryImageBuffer("c1", "row_1", "png")).toBeNull();
		// delete is a silent no-op (consistent with avatar serve/load)
		await expect(bare.deleteGalleryImage("c1", "row_1", "png")).resolves.toBeUndefined();
	});
});

describe("AssetService.upload - text attachments (CA-1a)", () => {
	const TEXT = "# Notes\nA short note about lighthouses, with some words.\n";
	const textBytes = (text: string) => new TextEncoder().encode(text);

	const CASES: ReadonlyArray<{ name: string; type: string; ext: string; servedMime: string }> = [
		{ name: "a.txt", type: "text/plain", ext: "txt", servedMime: "text/plain" },
		{ name: "a.md", type: "text/markdown", ext: "md", servedMime: "text/markdown" },
		{ name: "a.json", type: "application/json", ext: "json", servedMime: "application/json" },
		{ name: "a.jsonl", type: "application/x-ndjson", ext: "jsonl", servedMime: "application/x-ndjson" },
		{ name: "a.jsonl", type: "text/x-jsonl", ext: "jsonl", servedMime: "application/x-ndjson" },
		{ name: "a.csv", type: "text/csv", ext: "csv", servedMime: "text/csv" },
	];

	test.each(CASES)("accepts $type ($name): stores .$ext, returns tokenCount, serves $servedMime", async ({ name, type, ext, servedMime }) => {
		const { assetsDir, service } = await setup();
		const result = await service.upload(new File([textBytes(TEXT)], name, { type }));
		expect(Object.keys(result).sort()).toEqual(["assetId", "tokenCount", "url"]);
		expect(result.tokenCount).toBe(countTokensDefault(TEXT));
		expect(result.url).toBe(`/api/assets/${result.assetId}`);
		const onDisk = Buffer.from(await Bun.file(join(assetsDir, `${result.assetId}.${ext}`)).arrayBuffer());
		expect(onDisk).toEqual(Buffer.from(textBytes(TEXT)));
		const served = await service.serve(result.assetId);
		expect(served?.headers.get("Content-Type")).toBe(servedMime);
		expect(await served?.text()).toBe(TEXT);
		const loaded = await service.loadBuffer(result.assetId);
		expect(loaded?.toString("utf-8")).toBe(TEXT);
	});

	test("an empty or generic browser MIME is resolved from the file extension", async () => {
		const { service } = await setup();
		for (const type of ["", "application/octet-stream", "Application/Octet-Stream; charset=binary"]) {
			for (const [name, servedMime] of [
				["notes.md", "text/markdown"],
				["rows.jsonl", "application/x-ndjson"],
				["table.csv", "text/csv"],
				["plain.txt", "text/plain"],
				["data.json", "application/json"],
			] as const) {
				const result = await service.upload(new File([textBytes(TEXT)], name, { type }));
				expect(result.tokenCount).toBe(countTokensDefault(TEXT));
				const served = await service.serve(result.assetId);
				expect(served?.headers.get("Content-Type")).toBe(servedMime);
			}
		}
	});

	test("the extension is matched case-insensitively", async () => {
		const { service } = await setup();
		const result = await service.upload(new File([textBytes(TEXT)], "NOTES.MD", { type: "" }));
		expect(result.tokenCount).toBe(countTokensDefault(TEXT));
		expect((await service.serve(result.assetId))?.headers.get("Content-Type")).toBe("text/markdown");
	});

	test("an unknown extension with an empty or generic MIME is still refused", async () => {
		const { service } = await setup();
		for (const [name, type] of [["notes.xyz", ""], ["notes.xyz", "application/octet-stream"], ["README", ""], ["a.yaml", ""]] as const) {
			await expect(service.upload(new File([textBytes(TEXT)], name, { type }))).rejects.toThrow(/Unsupported attachment type/);
		}
	});

	test("a known text extension wins over any non-media reported MIME (OS-registry types)", async () => {
		const { assetsDir, service } = await setup();
		const cases = [
			{ name: "data.csv", type: "application/vnd.ms-excel", ext: "csv", servedMime: "text/csv" },
			{ name: "notes.md", type: "text/x-markdown", ext: "md", servedMime: "text/markdown" },
			// behavior change: was refused -> now accepted, basis: OS-reported MIMEs for text extensions vary (owner works on Windows)
			{ name: "notes.md", type: "application/yaml", ext: "md", servedMime: "text/markdown" },
		] as const;
		for (const { name, type, ext, servedMime } of cases) {
			const result = await service.upload(new File([textBytes(TEXT)], name, { type }));
			expect(result.tokenCount).toBe(countTokensDefault(TEXT));
			expect(await Bun.file(join(assetsDir, `${result.assetId}.${ext}`)).exists()).toBe(true);
			expect((await service.serve(result.assetId))?.headers.get("Content-Type")).toBe(servedMime);
		}
	});

	test("an image or audio MIME keeps its meaning whatever the file name says", async () => {
		const { assetsDir, service } = await setup();
		const image = await service.upload(new File([PNG_BYTES], "x.txt", { type: "image/png" }));
		expect(Object.keys(image).sort()).toEqual(["assetId", "url"]);
		expect(await Bun.file(join(assetsDir, `${image.assetId}.png`)).exists()).toBe(true);
		expect((await service.serve(image.assetId))?.headers.get("Content-Type")).toBe("image/png");
		// An unlisted media type is not rescued by a text extension either.
		await expect(service.upload(new File([PNG_BYTES], "x.md", { type: "video/mp4" }))).rejects.toThrow(/Unsupported attachment type/);
	});

	test("a non-text extension with a non-allowed MIME is still refused", async () => {
		const { service } = await setup();
		await expect(
			service.upload(new File([new Uint8Array(4)], "setup.exe", { type: "application/x-msdownload" })),
		).rejects.toThrow(/Unsupported attachment type/);
	});

	test("an empty MIME never turns an image or audio extension into an upload", async () => {
		const { service } = await setup();
		await expect(service.upload(new File([PNG_BYTES], "a.png", { type: "" }))).rejects.toThrow(/Unsupported attachment type/);
		await expect(service.upload(new File([PNG_BYTES], "a.webm", { type: "application/octet-stream" }))).rejects.toThrow(/Unsupported attachment type/);
	});

	test("a multi-MB text file is accepted whole and its token count returned", async () => {
		const { assetsDir, service } = await setup();
		const lines: string[] = [];
		let size = 0;
		for (let j = 0; size < 4 * 1024 * 1024; j++) {
			const line = `row ${j}: the quick brown fox ${j * 7919} jumps over the lazy dog`;
			lines.push(line);
			size += line.length + 1;
		}
		const big = lines.join("\n");
		const bytes = textBytes(big);
		expect(bytes.length).toBeGreaterThan(3 * 1024 * 1024);
		const result = await service.upload(new File([bytes], "big.txt", { type: "text/plain" }));
		expect(result.tokenCount).toBe(countTokensDefault(big));
		expect(result.tokenCount).toBeGreaterThan(500_000);
		const stored = Bun.file(join(assetsDir, `${result.assetId}.txt`));
		expect(stored.size).toBe(bytes.length);
	});

	test("a leading UTF-8 BOM is stripped before counting (same count with and without)", async () => {
		const { assetsDir, service } = await setup();
		const plain = await service.upload(new File([textBytes(TEXT)], "a.md", { type: "text/markdown" }));
		const withBom = await service.upload(
			new File([new Uint8Array([0xef, 0xbb, 0xbf]), textBytes(TEXT)], "b.md", { type: "text/markdown" }),
		);
		expect(withBom.tokenCount).toBe(plain.tokenCount);
		// The stored bytes stay the original upload, BOM included.
		const stored = new Uint8Array(await Bun.file(join(assetsDir, `${withBom.assetId}.md`)).arrayBuffer());
		expect([...stored.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	});

	test("an empty text file is accepted with tokenCount 0", async () => {
		const { service } = await setup();
		const result = await service.upload(new File([new Uint8Array(0)], "empty.txt", { type: "text/plain" }));
		expect(result.tokenCount).toBe(0);
	});

	test("the same 20 MB limit applies to text (no separate cap); the message keeps the 'too large' substring", async () => {
		const { service } = await setup();
		const over = new Uint8Array(20 * 1024 * 1024 + 1).fill(0x61);
		await expect(service.upload(new File([over], "huge.txt", { type: "text/plain" }))).rejects.toThrow(/too large/);
	});

	test("image and audio results stay exactly { assetId, url } (no tokenCount key)", async () => {
		const { service } = await setup();
		const image = await service.upload(new File([PNG_BYTES], "a.png", { type: "image/png" }));
		const audio = await service.upload(new File([new Uint8Array(8)], "n.webm", { type: "audio/webm;codecs=opus" }));
		for (const result of [image, audio]) {
			expect(Object.keys(result).sort()).toEqual(["assetId", "url"]);
			expect("tokenCount" in result).toBe(false);
		}
	});
});

describe("POST /api/assets/upload - text attachments (CA-1a)", () => {
	async function makeApp() {
		const { service } = await setup();
		return new Hono().route("/", createAssetRoutes({
			uploadAsset: (file) => service.upload(file),
			serveAsset: (assetId) => service.serve(assetId),
		}));
	}
	function form(file: File): FormData {
		const body = new FormData();
		body.set("file", file);
		return body;
	}

	test("passes tokenCount through unchanged with 201", async () => {
		const app = await makeApp();
		const text = "alpha beta gamma\n";
		const res = await app.request("/api/assets/upload", {
			method: "POST",
			body: form(new File([new TextEncoder().encode(text)], "n.md", { type: "" })),
		});
		expect(res.status).toBe(201);
		const json = await res.json() as { assetId: string; url: string; tokenCount: number };
		expect(json.tokenCount).toBe(countTokensDefault(text));
		expect(json.url).toBe(`/api/assets/${json.assetId}`);
		const served = await app.request(json.url);
		expect(served.headers.get("Content-Type")).toBe("text/markdown");
	});

	test("an image upload response carries no tokenCount", async () => {
		const app = await makeApp();
		const res = await app.request("/api/assets/upload", {
			method: "POST",
			body: form(new File([PNG_BYTES], "a.png", { type: "image/png" })),
		});
		expect(res.status).toBe(201);
		expect(Object.keys(await res.json() as object).sort()).toEqual(["assetId", "url"]);
	});

	test("unknown extension with an empty MIME maps to 415", async () => {
		const app = await makeApp();
		const res = await app.request("/api/assets/upload", {
			method: "POST",
			body: form(new File([new Uint8Array(4)], "x.bin", { type: "" })),
		});
		expect(res.status).toBe(415);
	});
});

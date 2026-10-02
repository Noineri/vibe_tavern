import { describe, expect, test } from "bun:test";

import { normalizeAvatarThumbnail } from "../src/domain/asset/avatar-thumbnail.js";
import { minimalPng } from "./image-bytes.js";

// ---------------------------------------------------------------------------
// Image factories — all inputs are generated in memory (no fixtures, nothing
// from the owner's data/). The PNG encoder lives in ./image-bytes.ts (one
// source, shared with the adapter/scanner tests since LB-1B); the webp
// container builders below are avatar-specific (animation detector surface).
// ---------------------------------------------------------------------------


/** A RIFF/WEBP header carrying the given chunks — enough surface for the
 *  animation detector, which reads the container before any decode. */
function webpContainer(chunks: Array<{ fourcc: string; payload: Uint8Array }>): Uint8Array {
	const riffSize = 4 + chunks.reduce((sum, chunk) => sum + 8 + chunk.payload.length + (chunk.payload.length % 2), 0);
	const out = new Uint8Array(8 + riffSize);
	const view = new DataView(out.buffer);
	out.set(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 0); // "RIFF"
	view.setUint32(4, riffSize, true);
	out.set(new Uint8Array([0x57, 0x45, 0x42, 0x50]), 8); // "WEBP"
	let off = 12;
	for (const chunk of chunks) {
		out.set(new Uint8Array([...chunk.fourcc].map((ch) => ch.charCodeAt(0))), off);
		view.setUint32(off + 4, chunk.payload.length, true);
		out.set(chunk.payload, off + 8);
		off += 8 + chunk.payload.length + (chunk.payload.length % 2);
	}
	return out;
}

/** VP8X payload: flags byte (bit 1 = animation) + reserved + 24-bit
 *  canvas size (stored as size-1, little-endian). */
function vp8xPayload(animationFlag: boolean, canvasWidth = 1, canvasHeight = 1): Uint8Array {
	const payload = new Uint8Array(10);
	payload[0] = animationFlag ? 0b10 : 0;
	const w = canvasWidth - 1;
	const h = canvasHeight - 1;
	payload[4] = w & 0xff;
	payload[5] = (w >> 8) & 0xff;
	payload[6] = (w >> 16) & 0xff;
	payload[7] = h & 0xff;
	payload[8] = (h >> 8) & 0xff;
	payload[9] = (h >> 16) & 0xff;
	return payload;
}

async function metadataOf(bytes: Uint8Array) {
	return await new Bun.Image(bytes).metadata();
}

// Real decodable images, built once per module (each is deterministic).
const PNG_600 = minimalPng(600, 600);
const PNG_300 = minimalPng(300, 300, [60, 120, 200]);
const PNG_800x200 = minimalPng(800, 200, [90, 90, 160]);
const JPEG_600 = await new Bun.Image(PNG_600).jpeg({ quality: 90 }).bytes();
const WEBP_300 = await new Bun.Image(PNG_300).webp({ quality: 85 }).bytes();
const WEBP_600 = await new Bun.Image(PNG_600).webp({ quality: 85 }).bytes();

describe("normalizeAvatarThumbnail", () => {
	test("large PNG re-encodes to ≤ 512 webp with changed: true", async () => {
		const result = await normalizeAvatarThumbnail(PNG_600, "png");
		expect(result.changed).toBe(true);
		expect(result.ext).toBe("webp");
		const meta = await metadataOf(result.bytes);
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(512);
		expect(result.bytes.length).toBeLessThan(PNG_600.length);
	});

	test("large JPEG re-encodes the same way", async () => {
		const result = await normalizeAvatarThumbnail(JPEG_600, "jpg");
		expect(result.changed).toBe(true);
		expect(result.ext).toBe("webp");
		const meta = await metadataOf(result.bytes);
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(512);
	});

	test("large webp source resizes too", async () => {
		const result = await normalizeAvatarThumbnail(WEBP_600, "webp");
		expect(result.changed).toBe(true);
		expect(result.ext).toBe("webp");
		const meta = await metadataOf(result.bytes);
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(512);
	});

	test("resize keeps the aspect ratio and never upscales the short side (800x200 → 512x128)", async () => {
		const result = await normalizeAvatarThumbnail(PNG_800x200, "png");
		expect(result.changed).toBe(true);
		const meta = await metadataOf(result.bytes);
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(128);
	});

	test("small PNG re-encodes to webp WITHOUT upscaling — same dimensions, changed: true", async () => {
		const result = await normalizeAvatarThumbnail(PNG_300, "png");
		expect(result.changed).toBe(true);
		expect(result.ext).toBe("webp");
		const meta = await metadataOf(result.bytes);
		expect(meta.width).toBe(300);
		expect(meta.height).toBe(300);
	});

	test("already-small webp comes back unchanged (same byte reference)", async () => {
		const result = await normalizeAvatarThumbnail(WEBP_300, "webp");
		expect(result.changed).toBe(false);
		expect(result.ext).toBe("webp");
		expect(result.bytes).toBe(WEBP_300);
	});

	test("gif is skipped before any decode (case-insensitive ext, arbitrary bytes)", async () => {
		const notAnImage = new Uint8Array([1, 2, 3, 4, 5]);
		for (const ext of ["gif", "GIF"]) {
			const result = await normalizeAvatarThumbnail(notAnImage, ext);
			expect(result.changed).toBe(false);
			expect(result.ext).toBe(ext);
			expect(result.bytes).toBe(notAnImage);
		}
	});

	test("animated webp (ANIM chunk) is skipped before any decode", async () => {
		const animated = webpContainer([
			{ fourcc: "VP8X", payload: vp8xPayload(true) },
			{ fourcc: "ANIM", payload: new Uint8Array(6) },
		]);
		const result = await normalizeAvatarThumbnail(animated, "webp");
		expect(result.changed).toBe(false);
		expect(result.bytes).toBe(animated);
	});

	test("VP8X animation flag alone (no ANIM fourcc) also marks the file animated", async () => {
		const flagOnly = webpContainer([{ fourcc: "VP8X", payload: vp8xPayload(true) }]);
		const result = await normalizeAvatarThumbnail(flagOnly, "webp");
		expect(result.changed).toBe(false);
		expect(result.bytes).toBe(flagOnly);
	});

	test("static webp container header (VP8X without the animation flag) is not mistaken for animated", async () => {
		// A static VP8X header with a > 512 canvas but no frame data: the
		// animation shortcut does NOT fire (no ANIM chunk, flag clear), so the
		// canvas dims read large, the re-encode is attempted, the missing frame
		// decode fails, and the warn branch returns the input. Had the detector
		// misfired, this would return unchanged WITHOUT a warning.
		const staticHeader = webpContainer([{ fourcc: "VP8X", payload: vp8xPayload(false, 600, 600) }]);
		const warns: unknown[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warns.push(args);
		try {
			const result = await normalizeAvatarThumbnail(staticHeader, "webp");
			expect(result.changed).toBe(false);
			expect(result.bytes).toBe(staticHeader);
		} finally {
			console.warn = originalWarn;
		}
		expect(warns.length).toBe(1);
	});

	test("corrupt bytes return the input unchanged with a warning, without throwing", async () => {
		const corrupt = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const warns: unknown[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warns.push(args);
		try {
			const result = await normalizeAvatarThumbnail(corrupt, "png");
			expect(result.changed).toBe(false);
			expect(result.ext).toBe("png");
			expect(result.bytes).toBe(corrupt);
		} finally {
			console.warn = originalWarn;
		}
		expect(warns.length).toBe(1);
	});

	test("non-RIFF bytes labeled webp fall through to decode (not the animation branch)", async () => {
		const fakeWebp = new Uint8Array(16).fill(0xab);
		const warns: unknown[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warns.push(args);
		try {
			const result = await normalizeAvatarThumbnail(fakeWebp, "webp");
			expect(result.changed).toBe(false);
			expect(result.bytes).toBe(fakeWebp);
		} finally {
			console.warn = originalWarn;
		}
		expect(warns.length).toBe(1);
	});
});

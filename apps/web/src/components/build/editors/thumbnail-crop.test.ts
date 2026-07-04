import { describe, expect, mock, test } from "bun:test";
import { promoteSourceAsFull } from "./thumbnail-crop.js";

describe("promoteSourceAsFull", () => {
	test("returns undefined when a separate full already exists (no promotion needed)", async () => {
		const fetchImpl = mock(() => Promise.resolve(new Response("x")));
		const result = await promoteSourceAsFull({
			sourceUrl: "http://x/api/characters/c/avatar/full?v=1",
			hasSeparateFull: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toBeUndefined();
		// Must not fetch when a full exists — the source is already preserved server-side.
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("returns undefined when sourceUrl is null", async () => {
		const fetchImpl = mock(() => Promise.resolve(new Response("x")));
		const result = await promoteSourceAsFull({ sourceUrl: null, hasSeparateFull: false, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(result).toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("promotes the source as a File when no separate full exists (single-image character)", async () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const fetchImpl = mock(() =>
			Promise.resolve(new Response(pngBytes, { headers: { "Content-Type": "image/png" } })),
		);
		const result = await promoteSourceAsFull({
			sourceUrl: "http://x/api/characters/c/avatar/full?v=1",
			hasSeparateFull: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toBeInstanceOf(File);
		expect(result!.type).toBe("image/png");
		expect(result!.name).toBe("avatar-full.png");
		// Byte-for-byte preservation of the uncropped source.
		expect(new Uint8Array(await result!.arrayBuffer())).toEqual(pngBytes);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test("returns undefined when the fetch fails (network) — degrades to crop-only", async () => {
		const fetchImpl = mock(() => Promise.reject(new Error("network")));
		const result = await promoteSourceAsFull({
			sourceUrl: "http://x/api/characters/c/avatar/full?v=1",
			hasSeparateFull: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toBeUndefined();
	});

	test("returns undefined on non-OK response", async () => {
		const fetchImpl = mock(() => Promise.resolve(new Response("nope", { status: 404 })));
		const result = await promoteSourceAsFull({
			sourceUrl: "http://x/api/characters/c/avatar/full?v=1",
			hasSeparateFull: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toBeUndefined();
	});

	test("returns undefined when the served content is not an image", async () => {
		const fetchImpl = mock(() =>
			Promise.resolve(new Response("plain", { headers: { "Content-Type": "text/plain" } })),
		);
		const result = await promoteSourceAsFull({
			sourceUrl: "http://x/api/characters/c/avatar/full?v=1",
			hasSeparateFull: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toBeUndefined();
	});
});

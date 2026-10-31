import { describe, expect, test } from "bun:test";
import { splitTraceString, TRACE_BLOCK_MIN, TRACE_BLOCK_MAX } from "../src/trace-blocks.js";
import { compressTraceText, decodeTraceText, isCompressedTraceText } from "../src/trace-storage-codec.js";
import { collectMarkerIds, deflateTraceValue, hashTraceChunk, inflateTraceValue } from "../src/trace-chunking.js";

/** Trace-shaped, synthetic fixture: no private conversation text is committed. */
function prose(): string {
	const words = ["the", "window", "opened", "quietly", "beside", "a", "table", "while", "another", "visitor", "waited", "outside"];
	let state = 12345;
	return Array.from({ length: 6000 }, (_, paragraph) => {
		const sentence = Array.from({ length: 18 }, () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return words[state >>> 16 & 11];
		}).join(" ");
		return `${paragraph}: ${sentence}.\n`;
	}).join("");
}

describe("trace storage v2 format", () => {
	test("persisted cut rule has a fixed cross-process golden vector", () => {
		const text = Array.from({ length: 1000 }, (_, i) => `${i}: The visitor opened a window and waited by the table.\n`).join("");
		expect(splitTraceString(text).map(hashTraceChunk)).toEqual([
			"61d4a8f85c48a5538f73c372951c56fc0e72f94dcd3d3bd905c23102e40361f3",
			"b07cc307d8181a5192949150778b7b22f7bc3d296d64acf18efedee6a602ce2e",
			"fa91fb89aba3f30ddf1bd9a73836cf0bcae345ac729114b008fff1049fe21a96",
			"83806a628bfbad6fd1ff54b66661ecff7a14156908c8363a9d634f08baa2c2e3",
			"b3bdd04cd58b397809df720b528dfc2f2c0b7d772311f25b42fc68e4e33faf24",
			"039042f3df57872c2ac638c7bbfeebb724e89fa8e779094327732836af329f9f",
			"a8f3bcb9bbd6f74d60e73f78e9f22bcdd7f3debc12094f046b5bed2bc5ba3b1a",
		]);
	});

	test("CDC is deterministic, bounded, content-defined and preserves UTF-16 boundaries", () => {
		const text = prose();
		const blocks = splitTraceString(text);
		expect(blocks.join("")).toBe(text);
		expect(splitTraceString(text)).toEqual(blocks);
		for (const block of blocks.slice(0, -1)) {
			expect(block.length).toBeGreaterThanOrEqual(TRACE_BLOCK_MIN);
			expect(block.length).toBeLessThanOrEqual(TRACE_BLOCK_MAX);
		}
		const average = text.length / blocks.length;
		expect(average).toBeGreaterThan(2500);
		expect(average).toBeLessThan(6500);
		const shifted = new Set(splitTraceString(`An inserted opening line.\n${text}`).map(hashTraceChunk));
		expect(blocks.filter((block) => shifted.has(hashTraceChunk(block))).length).toBeGreaterThan(blocks.length * 0.9);
		const emoji = "\u{1f600}".repeat(25000);
		for (const block of splitTraceString(emoji)) {
			expect(block.isWellFormed()).toBe(true);
			expect(block.length).toBeLessThanOrEqual(TRACE_BLOCK_MAX);
		}
	});

	test("v1, v2 and mixed compressed chunks inflate byte-identically", () => {
		const text = prose().slice(0, 70000);
		const trace = {
			assembledLayers: [{ sourceType: "history", text, tokenCount: 17000 }],
			finalPayload: { messages: [{ role: "user", content: "short" }, { role: "assistant", content: text }] },
			providerResponse: { mode: "stream", steps: [{ text, headers: { requestId: "fixture" } }] },
			unicode: "\u041f\u0440\u0438\u0432\u0435\u0442 \u{1f600}",
		};
		for (const version of [1, 2] as const) {
			const deflated = deflateTraceValue(trace, version);
			const chunks = new Map(deflated.chunks.map((chunk, index) => [chunk.id, index % 2 ? chunk.content : compressTraceText(chunk.content)]));
			const compressed = compressTraceText(JSON.stringify(deflated.skeleton));
			expect(isCompressedTraceText(compressed)).toBe(true);
			const skeleton = JSON.parse(decodeTraceText(compressed));
			expect(JSON.stringify(inflateTraceValue(skeleton, (id) => chunks.get(id)))).toBe(JSON.stringify(trace));
			expect(new Set(collectMarkerIds(compressed))).toEqual(new Set(deflated.chunks.map((chunk) => chunk.id)));
		}
		const id = hashTraceChunk(text);
		const mixed = { old: { $vtchunk: id }, next: { $vtlist: [id, id] } };
		expect(inflateTraceValue(mixed, () => compressTraceText(text))).toEqual({ old: text, next: text + text });
	});

	test("threshold and repeated blocks keep ordered references and plaintext hashes", () => {
		const text = "x".repeat(256);
		const deflated = deflateTraceValue({ small: text.slice(1), text, twice: text }, 2);
		expect(deflated.chunks).toEqual([{ id: hashTraceChunk(text), content: text }]);
		expect(deflated.skeleton).toEqual({ small: text.slice(1), text: { $vtlist: [hashTraceChunk(text)] }, twice: { $vtlist: [hashTraceChunk(text)] } });
		expect(() => inflateTraceValue(deflated.skeleton, () => undefined)).toThrow(/missing/);
		expect(inflateTraceValue({ $vtlist: ["not-a-hash"] }, () => undefined)).toEqual({ $vtlist: ["not-a-hash"] });
	});

	test("codec accepts legacy text/raw bytes and rejects corrupt compressed data", () => {
		expect(decodeTraceText("legacy text")).toBe("legacy text");
		expect(decodeTraceText(Buffer.from("legacy text"))).toBe("legacy text");
		expect(() => decodeTraceText(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0]))).toThrow();
	});
});

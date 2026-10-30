/**
 * Tokenizer cache (LC-5, LONG_CHAT_PERFORMANCE_REPORT step 5) — countTokens
 * memoizes counts in a bounded LRU keyed by the EXACT text. Pins:
 * - a repeated text encodes ONCE (spy on the encoder);
 * - different texts always get their OWN count (near-collider set) — the
 *   cache can never answer for another string;
 * - the displayed count stays identical to a direct encode (today's value).
 *
 * T0 pure logic plus a spy on the shared encoder: countTokens goes through
 * getTokenizer().encode(text), so an own-property shadow on the singleton
 * intercepts every encode while still running the real BPE (counts stay
 * real). The shadow is removed in afterAll (R2/R3 hygiene). No paths, no
 * globalThis patches, no waits, no platform assumptions.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { configureTokenCountCacheForTests, countTokens, getTokenizer, resetTokenCountCacheForTests } from "./tokenizer.js";

const tokenizer = getTokenizer();
const realEncode = tokenizer.encode.bind(tokenizer);
const encodedTexts: string[] = [];
const encodeSpy = mock((text: string) => {
	encodedTexts.push(text);
	return realEncode(text);
});
tokenizer.encode = encodeSpy;
afterAll(() => {
	delete (tokenizer as { encode?: unknown }).encode;
});

beforeEach(() => {
	encodedTexts.length = 0;
	resetTokenCountCacheForTests();
});

describe("token count cache (LC-5)", () => {
	test("a repeated text encodes once — later counts are cache hits", () => {
		const text = "the same displayed text is recounted on every remount";
		const first = countTokens(text);
		expect(countTokens(text)).toBe(first);
		expect(countTokens(text)).toBe(first);
		expect(encodedTexts).toEqual([text]);
	});

	test("different texts always get their own count — never another string's", () => {
		const texts = [
			"abc",
			"abcd",
			"abd",
			"abc ",
			" abc",
			"abc\ndef",
			"emoji 😀 and ascii mix",
			"a".repeat(64),
		];
		const expected = texts.map((t) => realEncode(t).length);
		for (const t of texts) countTokens(t);
		// Interleave a second pass: every text must still return ITS count.
		for (let i = 0; i < texts.length; i++) {
			expect(countTokens(texts[i])).toBe(expected[i]);
		}
		// Each distinct text encoded exactly once.
		expect([...encodedTexts].sort()).toEqual([...texts].sort());
	});

	test("countTokens stays identical to a direct encode (today's displayed count)", () => {
		const fixtures = [
			"",
			"plain ascii sentence.",
			"\n\n",
			"tabs\tand  double spaces",
			"unicode 😀🎆 and latin",
			`long paragraph text. `.repeat(200),
		];
		for (const fixture of fixtures) {
			expect(countTokens(fixture)).toBe(realEncode(fixture).length);
		}
	});

	test("empty input stays 0 without touching the encoder", () => {
		expect(countTokens("")).toBe(0);
		expect(encodedTexts).toEqual([]);
	});

	test("evicts at the entry bound, least-recent first; a hit refreshes recency", () => {
		configureTokenCountCacheForTests({ maxEntries: 2, maxTotalChars: 1_000_000 });
		const a = "entry A content";
		const b = "entry B content";
		const c = "entry C content";
		countTokens(a);
		countTokens(b);
		countTokens(a); // touch A — B becomes the least-recent entry
		encodedTexts.length = 0;

		countTokens(c); // fills the bound → evicts B
		expect(encodedTexts).toEqual([c]);
		countTokens(a); // still cached
		expect(encodedTexts).toEqual([c]);
		countTokens(b); // evicted → re-encoded
		expect(encodedTexts).toEqual([c, b]);
	});

	test("evicts at the total-size bound (UTF-16 code units)", () => {
		configureTokenCountCacheForTests({ maxEntries: 100, maxTotalChars: 40 });
		const x = "x".repeat(20);
		const y = "y".repeat(20);
		const z = "z".repeat(20);
		countTokens(x);
		countTokens(y); // 40 chars = at the bound
		encodedTexts.length = 0;

		countTokens(z); // 60 > 40 → evicts x (least-recent), y+z fit
		expect(encodedTexts).toEqual([z]);
		countTokens(y); // still cached
		countTokens(z);
		expect(encodedTexts).toEqual([z]);
		countTokens(x); // evicted → re-encoded
		expect(encodedTexts).toEqual([z, x]);
	});

	test("a single text larger than the size bound is never cached", () => {
		configureTokenCountCacheForTests({ maxEntries: 100, maxTotalChars: 10 });
		const big = "b".repeat(11);
		countTokens(big);
		countTokens(big);
		expect(encodedTexts).toEqual([big, big]);
	});
});

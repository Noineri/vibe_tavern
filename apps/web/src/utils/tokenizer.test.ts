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
import { getEncoding } from "js-tiktoken";
import {
	addKnownTokenCounts,
	configureTokenCountCacheForTests,
	countTokens,
	getTokenizer,
	replaceKnownTokenCounts,
	resetTokenCountCacheForTests,
} from "./tokenizer.js";

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
	resetTokenCountCacheForTests();
});

beforeEach(() => {
	encodedTexts.length = 0;
	resetTokenCountCacheForTests();
});

describe("token count cache (LC-5)", () => {
	test("the single-table encoder matches the root-import cl100k encoder", () => {
		const reference = getEncoding("cl100k_base");
		const fixtures = [
			"", "ASCII sentence with punctuation: 1234!",
			"\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440!",
			"\u{1f600}\u{1f469}\u200d\u{1f4bb}\u{1f3fd}\u2764\ufe0f",
			"   \t\t\n\n\r\n     ",
			"A long paragraph with numbers 123 and symbols <>.\n".repeat(500),
		];
		for (const text of fixtures) {
			const expected = reference.encode(text);
			expect(countTokens(text)).toBe(expected.length);
			expect(realEncode(text)).toEqual(expected);
		}
		expect(getTokenizer()).toBe(tokenizer);
	});

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

/**
 * Known token counts (TC-5, TOKEN_COUNT_ONCE_PLAN Wave 3): the map the
 * snapshot store seeds from server DTOs sits IN FRONT of the LC-5 LRU.
 * Pins:
 * - a seeded count is served without encoding and WINS over an existing
 *   LRU entry (server count is authoritative for its exact texts);
 * - `replace` swaps the whole map (a new chat's snapshot drops the previous
 *   chat's entries); `add` extends without dropping;
 * - the map is not LRU-bounded and does not leak into the LRU.
 */
describe("known token counts from server DTOs (TC-5)", () => {
	test("a known count is served before the LRU and without encoding", () => {
		replaceKnownTokenCounts([["server-counted text", 4242]]);
		expect(countTokens("server-counted text")).toBe(4242);
		expect(encodedTexts).toEqual([]);
		// Precedence over an existing LRU entry: the known value wins even
		// after the same text was already encoded (and cached) locally.
		countTokens("locally counted first");
		expect(encodedTexts).toEqual(["locally counted first"]);
		addKnownTokenCounts([["locally counted first", 999]]);
		expect(countTokens("locally counted first")).toBe(999);
		expect(encodedTexts).toEqual(["locally counted first"]);
	});

	test("replace swaps the whole map — the previous snapshot's entries drop", () => {
		replaceKnownTokenCounts([
			["chat A message one", 11],
			["chat A message two", 22],
		]);
		expect(countTokens("chat A message one")).toBe(11);
		expect(encodedTexts).toEqual([]);
		replaceKnownTokenCounts([["chat B message one", 33]]);
		expect(countTokens("chat B message one")).toBe(33);
		expect(encodedTexts).toEqual([]);
		// A's dropped text now encodes again — and serves the real count.
		expect(countTokens("chat A message one")).toBe(realEncode("chat A message one").length);
		expect(encodedTexts).toEqual(["chat A message one"]);
	});

	test("add keeps existing entries while adding new ones", () => {
		replaceKnownTokenCounts([["ingested earlier", 7]]);
		addKnownTokenCounts([["patched in later", 8]]);
		expect(countTokens("ingested earlier")).toBe(7);
		expect(countTokens("patched in later")).toBe(8);
		expect(encodedTexts).toEqual([]);
	});

	test("the known map is not LRU-bounded", () => {
		configureTokenCountCacheForTests({ maxEntries: 2, maxTotalChars: 40 });
		const entries = Array.from({ length: 12 }, (_, i) => [
			`known text ${i} — ${"k".repeat(i)}`,
			100 + i,
		] as [string, number]);
		replaceKnownTokenCounts(entries);
		for (const [text, count] of entries) {
			expect(countTokens(text)).toBe(count);
		}
		expect(encodedTexts).toEqual([]);
	});

	test("a known entry does not leak into the LRU — dropping it re-encodes", () => {
		replaceKnownTokenCounts([["transient known text", 5]]);
		expect(countTokens("transient known text")).toBe(5);
		expect(encodedTexts).toEqual([]);
		replaceKnownTokenCounts([]);
		// If the known path had also stored into the LRU this would be a hit.
		expect(countTokens("transient known text")).toBe(realEncode("transient known text").length);
		expect(encodedTexts).toEqual(["transient known text"]);
	});

	test("empty text stays 0 even when an empty key was seeded", () => {
		addKnownTokenCounts([["", 77]]);
		expect(countTokens("")).toBe(0);
		expect(encodedTexts).toEqual([]);
	});
});

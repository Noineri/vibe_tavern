/**
 * computeTokenEstimate — savings arithmetic for the Summary memory strategy.
 *
 * Pure fn (lives next to the TokenEstimate presentational component). total =
 * summary + history; history excludes summarized ranges then slices to the
 * limit (historyLimit 0 = no limit); saved/pct floor at 0 with no
 * divide-by-zero on an empty selected range; no negative savings when the
 * summary exceeds the range.
 *
 * Token counts are supplied by the caller (SummaryTab counts once per message
 * set so slider drags stay cheap), so the fixtures below run the real
 * tokenizer themselves — the arithmetic stays pinned against genuine cl100k
 * counts rather than invented integers.
 */
import { describe, expect, test } from "bun:test";
import { computeTokenEstimate } from "./TokenEstimate.js";
import { countTokens } from "../../utils/tokenizer.js";

describe("computeTokenEstimate — savings arithmetic", () => {
	const tokens = (s: string) => countTokens(s);
	const msg = (position: number, content: string) => ({ position, tokens: tokens(content) });

	test("summary + history tokens add to total; savings computed from selected range", () => {
		const draft = "A compact summary.";
		const messages = [msg(0, "hello world"), msg(1, "another message here"), msg(2, "third one")];
		const selected = [messages[0], messages[1]];
		const out = computeTokenEstimate(tokens(draft), [], 100, messages, selected);
		expect(out.summaryTokens).toBe(tokens(draft));
		expect(out.historyTokens).toBe(tokens("hello world") + tokens("another message here") + tokens("third one"));
		expect(out.total).toBe(out.summaryTokens + out.historyTokens);
		const selectedRaw = tokens("hello world") + tokens("another message here");
		expect(out.selectedRawTokens).toBe(selectedRaw);
		expect(out.saved).toBe(Math.max(0, selectedRaw - out.summaryTokens));
		expect(out.pct).toBe(Math.round((out.saved / selectedRaw) * 100));
	});

	test("history excludes messages inside an excluded range, then slices to the limit", () => {
		// Five messages (positions 0..4 → 1-indexed 1..5). Exclude the two
		// middle ones (1-indexed 3,4 = original positions 2,3). historyLimit = 2 →
		// tail-2 of the remaining [pos0,pos1,pos4] is [pos1,pos4] = bbbb, eeee.
		const messages = [
			msg(0, "aaaa"), msg(1, "bbbb"), msg(2, "excluded one"), msg(3, "excluded two"), msg(4, "eeee"),
		];
		const out = computeTokenEstimate(0, [{ from: 3, to: 4 }], 2, messages, []);
		expect(out.historyTokens).toBe(tokens("bbbb") + tokens("eeee"));
	});

	test("historyLimit 0 means ‘no limit’ — all non-excluded messages count", () => {
		const messages = [msg(0, "a"), msg(1, "b"), msg(2, "c")];
		const out = computeTokenEstimate(0, [], 0, messages, []);
		expect(out.historyTokens).toBe(tokens("a") + tokens("b") + tokens("c"));
	});

	test("selectedRawTokens 0 → saved 0, pct 0 (no divide-by-zero)", () => {
		const out = computeTokenEstimate(tokens("summary"), [], 10, [msg(0, "x")], []);
		expect(out.selectedRawTokens).toBe(0);
		expect(out.saved).toBe(0);
		expect(out.pct).toBe(0);
	});

	test("summary longer than the selected range → saved floored at 0 (no negative savings)", () => {
		const out = computeTokenEstimate(tokens("x".repeat(2000)), [], 10, [], [{ tokens: tokens("short") }]);
		expect(out.saved).toBe(0);
		expect(out.pct).toBe(0);
	});
});

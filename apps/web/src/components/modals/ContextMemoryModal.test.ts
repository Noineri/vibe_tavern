/**
 * computeRangeAfterChange — message-range reset logic for the memory modal.
 *
 * The range (from..to) is BRANCH-scoped: each branch has its own independent
 * message set. The helper resets the range to the full span (1..maxMessage)
 * on any chat OR branch switch (`scopeChanged`), and clamps within the same
 * scope (preserving the user's selection when messages are added/removed).
 *
 * Regression coverage for two reported bugs:
 *  - "always shows 1" after switching chats (clearMessages dip collapses the
 *    range, clamp cannot extend back).
 *  - "shows 12 where there are 2 / 2 where there are 12" jumble after
 *    switching branches within the same chat (clamp shrinks large→small but
 *    cannot extend small→large, so the range freezes near a stale value).
 */
import { describe, expect, test } from "vitest";
import { computeRangeAfterChange, upsertSummary, computeTokenEstimate } from "./ContextMemoryModal.js";
import { countTokens } from "../../utils/tokenizer.js";
import type { ChatSummaryRecord } from "../../app-client.js";

describe("upsertSummary — archive list ordering", () => {
	const base = (over: Partial<ChatSummaryRecord> = {}): ChatSummaryRecord => ({
		id: "x", chatId: "c", branchId: "b", label: "L", content: "", summarizedFrom: 1, summarizedTo: 1,
		includeInContext: true, excludeSummarized: true, source: "manual", sortOrder: 0, contentHash: null,
		createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
	});

	test("inserts into an empty list", () => {
		const out = upsertSummary([], base({ id: "a" }));
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("a");
	});

	test("inserts sorted ascending by summarizedFrom (stable by createdAt on tie)", () => {
		// Pre-existing entry spanning T5..T8; inserting a T1..T3 entry lands first.
		const out = upsertSummary([base({ id: "b", summarizedFrom: 5, summarizedTo: 8 })], base({ id: "a", summarizedFrom: 1, summarizedTo: 3 }));
		expect(out.map((s) => s.id)).toEqual(["a", "b"]);
	});

	test("replaces an existing entry in place (keeps position by summarizedFrom)", () => {
		const a = base({ id: "a", summarizedFrom: 1, content: "old" });
		const b = base({ id: "b", summarizedFrom: 5 });
		const updated = base({ id: "a", summarizedFrom: 1, content: "new" });
		const out = upsertSummary([a, b], updated);
		expect(out).toHaveLength(2);
		expect(out.map((s) => s.id)).toEqual(["a", "b"]);
		expect(out[0].content).toBe("new");
	});

	test("does not mutate the input list", () => {
		const orig = [base({ id: "a" })];
		const snapshot = [...orig];
		upsertSummary(orig, base({ id: "b" }));
		expect(orig).toEqual(snapshot);
	});
});

describe("computeTokenEstimate — savings arithmetic", () => {
	const msg = (position: number, content: string) => ({ position, content });
	const tokens = (s: string) => countTokens(s);

	test("summary + history tokens add to total; savings computed from selected range", () => {
		const draft = "A compact summary.";
		const messages = [msg(0, "hello world"), msg(1, "another message here"), msg(2, "third one")];
		const selected = [messages[0], messages[1]];
		const out = computeTokenEstimate(draft, [], 100, messages, selected);
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
		const out = computeTokenEstimate("", [{ from: 3, to: 4 }], 2, messages, []);
		expect(out.historyTokens).toBe(tokens("bbbb") + tokens("eeee"));
	});

	test("historyLimit 0 means ‘no limit’ — all non-excluded messages count", () => {
		const messages = [msg(0, "a"), msg(1, "b"), msg(2, "c")];
		const out = computeTokenEstimate("", [], 0, messages, []);
		expect(out.historyTokens).toBe(tokens("a") + tokens("b") + tokens("c"));
	});

	test("selectedRawTokens 0 → saved 0, pct 0 (no divide-by-zero)", () => {
		const out = computeTokenEstimate("summary", [], 10, [msg(0, "x")], []);
		expect(out.selectedRawTokens).toBe(0);
		expect(out.saved).toBe(0);
		expect(out.pct).toBe(0);
	});

	test("summary longer than the selected range → saved floored at 0 (no negative savings)", () => {
		const out = computeTokenEstimate("x".repeat(2000), [], 10, [], [{ content: "short" }]);
		expect(out.saved).toBe(0);
		expect(out.pct).toBe(0);
	});
});

describe("computeRangeAfterChange — scope change resets range", () => {
	test("scope change resets the range to the full span (1..maxMessage)", () => {
		// Switch from chat A (range was 5..12) to chat B with 68 messages.
		const result = computeRangeAfterChange(5, 12, true, 67);
		expect(result).toEqual({ from: 1, to: 67 });
	});

	test("scope change recovers from a range collapsed to 1 by the clearMessages dip", () => {
		// The exact "always shows 1" bug: prev range = 1..1 (collapsed when
		// messageCount dipped to 0), new chat has maxMessage = 12.
		const result = computeRangeAfterChange(1, 1, true, 12);
		expect(result).toEqual({ from: 1, to: 12 });
	});

	test("BRANCH switch (same chat) resets the range — small branch → large branch", () => {
		// The reported jumble bug. On a 2-msg branch the range collapsed to
		// 1..1; switching to a 68-msg branch (same chatId, different branch)
		// must reset to 1..67, NOT stay clamped at 1..1.
		const result = computeRangeAfterChange(1, 1, true, 67);
		expect(result).toEqual({ from: 1, to: 67 });
	});

	test("BRANCH switch — large branch → small branch resets to the small span", () => {
		// From 68-msg branch (range 5..67) to 2-msg branch (maxMessage = 1):
		// reset to 1..1, not clamp-to-1 (same result here, but via reset).
		const result = computeRangeAfterChange(5, 67, true, 1);
		expect(result).toEqual({ from: 1, to: 1 });
	});

	test("same scope, larger messageCount: clamp keeps selection (messages added)", () => {
		// Same chat+branch, user had range 5..10, now 15 messages arrived.
		const result = computeRangeAfterChange(5, 10, false, 14);
		expect(result).toEqual({ from: 5, to: 10 });
	});

	test("same scope, smaller messageCount: clamp brings out-of-bounds back", () => {
		// Same scope, messages deleted. prev range 8..12, now maxMessage = 4.
		const result = computeRangeAfterChange(8, 12, false, 4);
		expect(result).toEqual({ from: 4, to: 4 });
	});

	test("same scope with messageCount dip: clamp collapses (documented limitation)", () => {
		// Same-scope clamp cannot distinguish "dip then recover" from a real
		// shrink. The scope-change path (chat/branch switch) is what handles
		// cross-branch recovery; this pins same-scope clamp behavior.
		const afterDip = computeRangeAfterChange(5, 10, false, 1);
		expect(afterDip).toEqual({ from: 1, to: 1 });
	});
});

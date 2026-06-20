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
import { describe, expect, test } from "bun:test";
import { computeRangeAfterChange } from "./ContextMemoryModal.js";

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

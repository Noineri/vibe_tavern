/**
 * computeRangeAfterChange — message-range reset logic for the memory modal.
 *
 * Regression tests for the "always shows 1" bug: switchChat briefly nulls
 * messageOrder (clearMessages) before the new chat loads, so messageCount
 * dips to 0 and the range gets clamped to 1; when the real (larger) count
 * arrives, clamp cannot extend back, leaving the range stuck at 1 for the
 * new chat. The fix resets the range on a chat switch instead of clamping.
 */
import { describe, expect, test } from "bun:test";
import { computeRangeAfterChange } from "./ContextMemoryModal.js";

describe("computeRangeAfterChange — range reset on chat switch", () => {
	test("chat switch resets the range to the full new-chat span (1..maxMessage)", () => {
		// Simulate: chat A had 13 messages (range was 5..12), user switches to
		// chat B with 68 messages (maxMessage = 67). The range must become 1..67,
		// NOT stay clamped at the old 5..12.
		const result = computeRangeAfterChange(5, 12, "chat-a", "chat-b", 67);
		expect(result).toEqual({ from: 1, to: 67 });
	});

	test("chat switch recovers from a range collapsed to 1 by the clearMessages dip", () => {
		// The exact reported bug: after switching chats the modal showed
		// "1 сообщений" because the range was stuck at 1..1.
		// prev range = 1..1 (collapsed by the messageCount=0 dip), new chat has
		// maxMessage = 12 → range must extend to 1..12, not stay at 1..1.
		const result = computeRangeAfterChange(1, 1, "chat-a", "chat-b", 12);
		expect(result).toEqual({ from: 1, to: 12 });
	});

	test("same chat, larger messageCount: clamp extends the upper bound (messages added)", () => {
		// Same chat (no switch), user had range 5..10, now 15 messages arrived
		// (maxMessage = 14). Clamp keeps the selection but does not reset it.
		const result = computeRangeAfterChange(5, 10, "chat-a", "chat-a", 14);
		expect(result).toEqual({ from: 5, to: 10 });
	});

	test("same chat, smaller messageCount: clamp brings out-of-bounds selection back", () => {
		// Same chat, messages were deleted. prev range 8..12, now only 5 messages
		// (maxMessage = 4). Clamp shrinks the range into bounds.
		const result = computeRangeAfterChange(8, 12, "chat-a", "chat-a", 4);
		expect(result).toEqual({ from: 4, to: 4 });
	});

	test("same chat, messageCount dip to 0 then back: clamp collapses then cannot extend", () => {
		// This documents the BUG behavior the fix works around. The effect does
		// NOT call computeRangeAfterChange across the dip — it sees the final
		// state. But if the SAME chat (no switch) experiences the clearMessages
		// dip (e.g. re-fetch of the current chat), clamp-only would collapse to
		// 1 and not extend back. The chat-switch branch of the function is what
		// saves the real switchChat case; this test pins that same-chat clamp
		// stays correct for genuine in-chat count changes.
		const afterDip = computeRangeAfterChange(5, 10, "chat-a", "chat-a", 1);
		expect(afterDip).toEqual({ from: 1, to: 1 });
		// Note: same-chat cannot distinguish "dip then recover" from a real
		// shrink — clamp is the only safe behavior. The chat-switch path is
		// what handles the cross-chat case correctly.
	});

	test("null prevChatId (first open) with a real chatId resets to full span", () => {
		const result = computeRangeAfterChange(1, 1, null, "chat-a", 12);
		expect(result).toEqual({ from: 1, to: 12 });
	});

	test("both chats null (bootstrap, no chat yet): clamp keeps within bounds", () => {
		const result = computeRangeAfterChange(5, 10, null, null, 12);
		expect(result).toEqual({ from: 5, to: 10 });
	});
});

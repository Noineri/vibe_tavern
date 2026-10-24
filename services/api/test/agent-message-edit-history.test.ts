import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { storeMessagesToHistory } from "../src/domain/agent/agent-stream.js";
import { resolveDigestBoundary } from "../src/domain/agent/agent-prompt.js";

/**
 * AP-30 (AGENT_SHELL_POLISH Wave 7) — the history pin: after an in-place
 * edit, the model history built for the NEXT turn carries the edited text,
 * not the old one. `storeMessagesToHistory` reads `content`, so an edit
 * flows into the next turn with no special path; this test rebuilds the
 * history EXACTLY the way the generic loop does before assembly
 * (agent-stream.ts "Pre-split at the digest boundary": the LAST digest
 * re-placed at the front, then the kept window folded) over rows from a
 * REAL store container — the edit goes through the real store method, and
 * the digest-boundary interaction is part of the pin: an edited KEPT row
 * (at/after the anchor, before the digest row's own position) reaches the
 * model window, while the covered prefix the digest replaces stays absent.
 */

let stores: StoreContainer;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-message-edit-history-"));
	stores = await createStoreContainer(join(dataRoot, "edit-history.db"), dataRoot);
});

/** The loop's own history build (agent-stream.ts, "Pre-split at the digest
 *  boundary"): the last digest first, then the kept window. */
function buildNextTurnHistory(rows: Parameters<typeof storeMessagesToHistory>[0]) {
	const boundary = resolveDigestBoundary(rows);
	return [
		...(boundary.lastDigest ? storeMessagesToHistory([boundary.lastDigest]) : []),
		...storeMessagesToHistory(boundary.kept),
	];
}

/** True when `text` appears as a message content in the history. */
function historyCarries(history: ReturnType<typeof storeMessagesToHistory>, text: string): boolean {
	return history.some((m) => m.role !== "tool" && m.content === text);
}

describe("an edited assistant row reaches the next turn's model history (AP-30)", () => {
	test("digest-less thread: the history contains the new text and not the old", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap30_hist_plain", "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "old answer" });

		const result = await stores.experienceCopilot.updateAssistantContent(thread.id, a1.id, "new answer");
		expect(result.status).toBe("edited");

		const history = buildNextTurnHistory(await stores.experienceCopilot.listMessages(thread.id));
		expect(historyCarries(history, "new answer")).toBe(true);
		expect(historyCarries(history, "old answer")).toBe(false);
		// The user row still leads the window.
		expect(history[0]).toMatchObject({ role: "user", content: "one" });
	});

	test("digested thread: an edited KEPT row (before the digest row's own position) reaches the window; the digest replaces the covered prefix as before", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap30_hist_digest", "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "covered answer" });
		const u2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "two" });
		const a2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "old kept answer" });
		// The digest exactly as the compaction service persists it: the
		// anchor (u2, the first KEPT message) in toolCallId, appended at the
		// compaction moment — AFTER a2's position.
		await stores.experienceCopilot.appendMessage(thread.id, {
			role: "digest",
			content: "Summary of the early turns.",
			toolCallId: u2.id,
		});

		const result = await stores.experienceCopilot.updateAssistantContent(thread.id, a2.id, "new kept answer");
		expect(result.status).toBe("edited");

		const history = buildNextTurnHistory(await stores.experienceCopilot.listMessages(thread.id));
		// The edited text is in the model window; the old text is gone.
		expect(historyCarries(history, "new kept answer")).toBe(true);
		expect(historyCarries(history, "old kept answer")).toBe(false);
		// The digest still rides at the front with its own text, and the
		// covered prefix stays replaced (the edit changed none of that).
		expect(history[0]).toMatchObject({ role: "digest", content: "Summary of the early turns." });
		expect(historyCarries(history, "covered answer")).toBe(false);
		expect(historyCarries(history, "one")).toBe(false);
	});
});

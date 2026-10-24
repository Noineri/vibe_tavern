import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";

/**
 * AP-30 (AGENT_SHELL_POLISH Wave 7) — the edit-an-assistant-message HTTP
 * route: PATCH /api/experience-copilot/:threadId/messages/:messageId. The
 * REAL adapter (store-only harness shape — an edit never calls a provider)
 * behind the REAL route module, over a REAL store container in a temp data
 * dir. Pins the path wiring, the request-body validation, and the
 * store-result → DomainError mapping as observable at the route:
 *
 * - the allowed case runs once per kind's thread owner (script, mini-app,
 *   chat-owned sidechat) — every kind calls the same route, there is no
 *   kind dispatch;
 * - the fold boundary mirrors AP-11's delete floor through the digest's
 *   ANCHOR: a kept row BEFORE the digest row's own chronological position
 *   is editable, the covered prefix and the digest row are not;
 * - every refusal family is a 400 Validation carrying a machine-readable
 *   `details.reason` (not_assistant_row / tool_call_row / empty_content /
 *   empty_row / folded_row); the missing families are 404s;
 * - an empty/blank replacement never reaches the store.
 *
 * The seam-level matrix (the exact refusal statuses, seq/reasoning
 * preservation, the transaction) is pinned in packages/db/test/
 * experience-copilot-store.test.ts — the store half.
 */

/** Mount the production DomainError → status mapping (shared helpers, not
 *  duplicated logic) so the adapter's 400/404s are observable at the route —
 *  the same pattern as the turn-delete route test. */
function mountDomainErrorMapping(app: Hono): Hono {
	app.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
	return app;
}

let stores: StoreContainer;
let app: Hono;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-copilot-message-edit-"));
	stores = await createStoreContainer(join(dataRoot, "message-edit.db"), dataRoot);
	app = mountDomainErrorMapping(createExperienceCopilotRoutes(new ExperienceCopilotAdapter(stores)));
});

async function editMessage(threadId: string, messageId: string, body: unknown): Promise<Response> {
	return app.request(`/api/experience-copilot/${threadId}/messages/${messageId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Assert a 400 Validation whose `details.reason` is the typed refusal code. */
async function expectRefusal(res: Response, reason: string): Promise<void> {
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: { kind: string; details?: { reason?: string } } };
	expect(body.error.kind).toBe("Validation");
	expect(body.error.details?.reason).toBe(reason);
}

describe("PATCH /api/experience-copilot/:threadId/messages/:messageId (AP-30)", () => {
	test("script owner (prompt script): an assistant text row edits in place; user / tool / tool-call-carrier rows are refused", async () => {
		const script = await stores.scripts.create({ name: "AP-30 script owner", scriptKind: "prompt" });
		const thread = await stores.experienceCopilot.startNewSession(script.id, "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer one" });
		const carrier = await stores.experienceCopilot.appendMessage(thread.id, {
			role: "assistant",
			content: "",
			toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: "tc_1", toolName: "plan", input: {} }]),
		});
		const toolRow = await stores.experienceCopilot.appendMessage(thread.id, {
			role: "tool",
			content: JSON.stringify({ toolName: "plan", output: { ok: true } }),
			toolCallId: "tc_1",
		});
		const seed = (await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id);

		// The allowed edit: 200, the updated message wire, exactly one row rewritten.
		const res = await editMessage(thread.id, a1.id, { content: "edited answer" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ id: a1.id, threadId: thread.id, role: "assistant", content: "edited answer" });
		expect(body.createdAt).toBe(a1.createdAt);

		const rows = await stores.experienceCopilot.listMessages(thread.id);
		expect(rows.map((m) => m.id)).toEqual(seed); // order + neighbors untouched
		expect(rows.find((m) => m.id === a1.id)!.content).toBe("edited answer");

		// The refusal families, each a typed 400 reason code, nothing written.
		await expectRefusal(await editMessage(thread.id, u1.id, { content: "x" }), "not_assistant_row");
		await expectRefusal(await editMessage(thread.id, toolRow.id, { content: "x" }), "not_assistant_row");
		await expectRefusal(await editMessage(thread.id, carrier.id, { content: "x" }), "tool_call_row");
		const after = await stores.experienceCopilot.listMessages(thread.id);
		expect(after.find((m) => m.id === a1.id)!.content).toBe("edited answer");
		expect(after.find((m) => m.id === u1.id)!.content).toBe("one");
	});

	test("mini-app owner (interactive script): the fold boundary reads the digest's ANCHOR — kept rows edit, covered rows and the digest row do not", async () => {
		const script = await stores.scripts.create({ name: "AP-30 mini-app owner", scriptKind: "interactive" });
		const thread = await stores.experienceCopilot.startNewSession(script.id, "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "covered answer" });
		const u2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "two" });
		const a2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "kept answer" });
		// The digest exactly as the compaction service persists it: role
		// "digest", toolCallId carrying the first KEPT message's id (u2) —
		// its own row sits AFTER a2 (appended when compaction ran).
		const digest = await stores.experienceCopilot.appendMessage(thread.id, {
			role: "digest",
			content: "Summary of the early turns.",
			toolCallId: u2.id,
		});
		const u3 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "three" });
		const a3 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "post-digest answer" });
		const seed = (await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id);

		// a2 is BEFORE the digest row's own position but at/after the ANCHOR —
		// the kept tail edits (never "after the digest row itself").
		const kept = await editMessage(thread.id, a2.id, { content: "kept answer (edited)" });
		expect(kept.status).toBe(200);
		expect(((await kept.json()) as { content: string }).content).toBe("kept answer (edited)");
		// So does the row after the digest row.
		const post = await editMessage(thread.id, a3.id, { content: "post-digest answer (edited)" });
		expect(post.status).toBe(200);

		// The covered prefix is folded — the model sees the digest, not a1.
		await expectRefusal(await editMessage(thread.id, a1.id, { content: "x" }), "folded_row");
		// The digest row itself and the anchor's user row are not assistant rows.
		await expectRefusal(await editMessage(thread.id, digest.id, { content: "x" }), "not_assistant_row");
		await expectRefusal(await editMessage(thread.id, u2.id, { content: "x" }), "not_assistant_row");

		// The refusals wrote nothing; the two edits are the only changes.
		const rows = await stores.experienceCopilot.listMessages(thread.id);
		expect(rows.map((m) => m.id)).toEqual(seed);
		expect(rows.find((m) => m.id === a1.id)!.content).toBe("covered answer");
		expect(rows.find((m) => m.id === digest.id)!.content).toBe("Summary of the early turns.");
		expect(rows.find((m) => m.id === u3.id)!.content).toBe("three");
	});

	test("chat-owned sidechat owner: a seq-bearing assistant row edits in place keeping seq and the reasoning pair; wrong thread / missing thread are 404s", async () => {
		const character = await stores.characters.create({ name: "AP-30 sidechat fixture" });
		const chat = await stores.chats.createChat({ characterId: character.id, title: "AP-30", promptPresetId: null });
		const thread = await stores.experienceCopilot.startNewChatSession(
			chat.id,
			chat.activeBranchId as string,
			"sidechat-ooc",
		);
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, {
			role: "assistant",
			content: "answer one",
			reasoning: "thinking about it",
			reasoningDurationMs: 1_500,
		});

		const res = await editMessage(thread.id, a1.id, { content: "answer one (edited)" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ id: a1.id, role: "assistant", content: "answer one (edited)" });

		// The wire carries the reasoning pair untouched; the store keeps the
		// SC-1 seq and the row's identity (id, createdAt).
		expect(body.reasoning).toBe("thinking about it");
		expect(body.reasoningDurationMs).toBe(1_500);
		const row = (await stores.experienceCopilot.listMessages(thread.id)).find((m) => m.id === a1.id)!;
		expect(row.seq).toBe(a1.seq);
		expect(row.reasoning).toBe("thinking about it");
		expect(row.reasoningDurationMs).toBe(1_500);
		expect(row.createdAt).toBe(a1.createdAt);

		// A message of ANOTHER thread is a 404 (missing-message), as is an
		// unknown thread — the wrong-thread / not-found family.
		const other = await editMessage("thr_missing_ap30", a1.id, { content: "x" });
		expect(other.status).toBe(404);
		expect(((await other.json()) as { error: { kind: string } }).error.kind).toBe("NotFound");

		const foreignThread = await stores.experienceCopilot.startNewSession("script_ap30_foreign", "T");
		const foreign = await editMessage(foreignThread.id, u1.id, { content: "x" });
		expect(foreign.status).toBe(404);
		expect(((await foreign.json()) as { error: { kind: string } }).error.kind).toBe("NotFound");
	});

	test("validation: empty / blank / missing content and an empty row are 400s that never write", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap30_validation", "T");
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer" });
		// A degenerate assistant row persistTurn never writes (empty text, no
		// tool calls) — seeded directly to pin its refusal.
		const blank = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "" });

		// An empty string is refused by the body validator before the adapter.
		const empty = await editMessage(thread.id, a1.id, { content: "" });
		expect(empty.status).toBe(400);
		// Blank-only text passes the schema but is refused by the seam with
		// the typed reason code.
		await expectRefusal(await editMessage(thread.id, a1.id, { content: "   " }), "empty_content");
		// A missing field never passes the validator.
		const missing = await editMessage(thread.id, a1.id, {});
		expect(missing.status).toBe(400);
		// The degenerate row has no text to edit.
		await expectRefusal(await editMessage(thread.id, blank.id, { content: "x" }), "empty_row");

		const rows = await stores.experienceCopilot.listMessages(thread.id);
		expect(rows.find((m) => m.id === a1.id)!.content).toBe("answer");
		expect(rows.find((m) => m.id === blank.id)!.content).toBe("");
	});
});

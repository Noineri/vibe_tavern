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
 * AP-8 (AGENT_SHELL_POLISH Wave 3) — the delete-a-turn HTTP route: the REAL
 * adapter (store-only harness shape, no provider profile service needed —
 * delete never calls a provider) behind the REAL route module, over a REAL
 * store container in a temp data dir. Pins the path wiring, the request-body
 * validation, and the store-result → DomainError mapping as observable at
 * the route (200 / 409 digest floor / 400 user-row semantics / 404s), plus
 * the persisted outcome. The turn-resolution matrix itself (continuation
 * turns, permission rows, chat-owned event preservation) is pinned in
 * packages/db/test/experience-copilot-turn-delete.test.ts — the store half.
 */

/** Mount the production DomainError → status mapping (shared helpers, not
 *  duplicated logic) so the adapter's 400/404/409s are observable at the
 *  route — the same pattern as agent-thread-proposals.test.ts. */
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
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-copilot-turn-delete-"));
	stores = await createStoreContainer(join(dataRoot, "turn-delete.db"), dataRoot);
	app = mountDomainErrorMapping(createExperienceCopilotRoutes(new ExperienceCopilotAdapter(stores)));
});

function deleteUrl(threadId: string): string {
	return `/api/experience-copilot/${threadId}/turns/delete`;
}

async function deleteTurn(threadId: string, body: unknown): Promise<Response> {
	return app.request(deleteUrl(threadId), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/experience-copilot/:threadId/turns/delete (AP-8)", () => {
	test("200: deleting an assistant turn returns the deleted ids and the rows leave the store", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap8_route", "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer one" });
		const u2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "two" });
		const a2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer two" });

		const res = await deleteTurn(thread.id, { messageId: a2.id, includeUserMessage: false });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deletedMessageIds: [a2.id], deletedUserMessageId: null });
		expect((await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id))
			.toEqual([u1.id, a1.id, u2.id]);
	});

	test("200 with the exchange: includeUserMessage=true deletes the user row with its turn", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap8_route_exchange", "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer one" });
		const u2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "two" });
		const a2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer two" });

		const res = await deleteTurn(thread.id, { messageId: u2.id, includeUserMessage: true });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deletedMessageIds: [u2.id, a2.id], deletedUserMessageId: u2.id });
		expect((await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id))
			.toEqual([u1.id, a1.id]);
	});

	test("409: a turn folded into a digest is refused (the digest is a floor) — nothing deleted", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap8_route_digest", "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer one" });
		const u2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "two" });
		// The digest exactly as the compaction service persists it: role
		// "digest", toolCallId carrying the first KEPT message's id (u2).
		await stores.experienceCopilot.appendMessage(thread.id, {
			role: "digest",
			content: "Summary of the early turns.",
			toolCallId: u2.id,
		});
		const u3 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "three" });
		const a3 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer three" });
		const seed = (await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id);

		// The covered turn (before the anchor u2) is a 409 Conflict…
		const refused = await deleteTurn(thread.id, { messageId: a1.id, includeUserMessage: false });
		expect(refused.status).toBe(409);
		const refusedBody = (await refused.json()) as { error: { kind: string; message: string } };
		expect(refusedBody.error.kind).toBe("Conflict");
		// …and the store is untouched by the refusal.
		expect((await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id)).toEqual(seed);

		// The post-digest turn still deletes fine (200) — newest-turn-backward.
		const ok = await deleteTurn(thread.id, { messageId: u3.id, includeUserMessage: true });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ deletedMessageIds: [u3.id, a3.id], deletedUserMessageId: u3.id });
		expect((await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id)).toEqual(seed.slice(0, 4));
		// The digest row and its floor survived.
		expect((await stores.experienceCopilot.listMessages(thread.id)).some((m) => m.role === "digest")).toBe(true);
	});

	test("400: messageId on a user row without includeUserMessage is refused with Validation", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap8_route_user", "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "answer one" });

		const res = await deleteTurn(thread.id, { messageId: u1.id, includeUserMessage: false });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { kind: string } };
		expect(body.error.kind).toBe("Validation");
		expect((await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id)).toEqual([u1.id, a1.id]);
	});

	test("404: a missing thread and a missing message are NotFound", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap8_route_missing", "T");
		const u1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });

		const noThread = await deleteTurn("thr_missing_ap8_route", { messageId: u1.id, includeUserMessage: true });
		expect(noThread.status).toBe(404);
		expect(((await noThread.json()) as { error: { kind: string } }).error.kind).toBe("NotFound");

		const noMessage = await deleteTurn(thread.id, { messageId: "msg_missing_ap8_route", includeUserMessage: true });
		expect(noMessage.status).toBe(404);
		expect(((await noMessage.json()) as { error: { kind: string } }).error.kind).toBe("NotFound");
	});

	test("400: the body validator rejects a missing/ill-typed field before the adapter runs", async () => {
		const thread = await stores.experienceCopilot.startNewSession("script_ap8_route_body", "T");
		await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const seed = (await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id);

		for (const bad of [{ messageId: "x" }, { messageId: "x", includeUserMessage: "yes" }, { includeUserMessage: true }]) {
			const res = await deleteTurn(thread.id, bad);
			expect(res.status).toBe(400);
		}
		// Nothing reached the store through any rejected body.
		expect((await stores.experienceCopilot.listMessages(thread.id)).map((m) => m.id)).toEqual(seed);
	});
});

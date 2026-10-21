import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createStoreContainer, type StoreContainer, type ExperienceCopilotThread, type AgentThreadTimelineEntry } from "@vibe-tavern/db";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createAgentThreadEventsRoutes } from "../src/api/routes/agent-thread-events.js";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";
import { mapTimelineEvent } from "../src/domain/sidechat/sidechat-context.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";

/**
 * SC-19a — `GET /api/agent/threads/:threadId/events`: the REAL adapter (a
 * store-only instance over a REAL store container in a temp data dir)
 * behind the REAL route module, with the messages route mounted beside it:
 *
 * 1. events in merged-timeline order with the right anchors — before the
 *    first message (two consecutive events anchor the SAME next message),
 *    between messages, and after the last message (the newest row → null);
 * 2. payloads equal the loader's own mapping (`mapTimelineEvent` run over
 *    the same timeline rows — one derivation, no second parser);
 * 3. a script thread → []; a fresh chat-owned thread with no events → [];
 * 4. the messages route response is unchanged (the Wave-5 review's premise:
 *    the message wire carries no `seq` and nothing else leaked into it);
 * 5. a missing thread → 404 NotFound (the sibling SC-11 convention);
 * 6. the loader's corrupt-payload refusal is inherited — a JSON-valid
 *    wrong-shape payload surfaces as a 500, never a silent drop.
 */

/** Mount the production DomainError → status mapping (shared helpers, not
 *  duplicated logic) so the adapter's 404s are observable at the route —
 *  the same pattern as agent-thread-proposals.test.ts. */
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
/** The store-only copilot adapter behind BOTH mounted route modules. */
let copilotWire: ExperienceCopilotAdapter;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-thread-events-"));
	stores = await createStoreContainer(join(dataRoot, "agent-events.db"), dataRoot);
	const character = await stores.characters.create({ name: "SC-19a thread events fixture" });
	characterId = character.id;

	copilotWire = new ExperienceCopilotAdapter(stores);
	app = mountDomainErrorMapping(
		new Hono()
			.route("/", createExperienceCopilotRoutes(copilotWire))
			.route("/", createAgentThreadEventsRoutes(copilotWire)),
	);
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A fresh chat-owned `sidechat-ooc` thread on its own chat. */
async function seedSidechatThread(): Promise<ExperienceCopilotThread> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-19a events fixture",
		promptPresetId: null,
	});
	return stores.experienceCopilot.startNewChatSession(
		chat.id,
		chat.activeBranchId as string,
		"sidechat-ooc",
	);
}

// Valid frozen payloads (the shapes the loader's parser accepts — one per
// kind that seeds the interleaved layout below).
const rpSyncPayload = {
	fromPosition: 0,
	toPosition: 0,
	messages: [
		{
			id: "m_seed_1",
			position: 0,
			role: "assistant",
			authorName: "Fixture Hero",
			variantId: null,
			text: "The ravine bridge is out.",
		},
	],
};
const branchForkedPayload = { at: 0 };
const variantsAttachedPayload = {
	position: 0,
	variants: [{ text: "She crosses first.", selected: true }],
};
const selectionChangedPayload = {
	messageId: "m_seed_1",
	position: 0,
	previous: { variantId: "v_a", text: "She waits." },
	current: { variantId: "v_b", text: "She crosses." },
};

interface EventsResponseItem {
	id: string;
	kind: string;
	payload: unknown;
	beforeMessageId: string | null;
}

/** The merged timeline's EVENT rows (SC-1's union narrowed to the event
 *  arm — the shape `mapTimelineEvent` takes). */
type TimelineEventRow = Extract<AgentThreadTimelineEntry, { rowType: "event" }>;

async function getEvents(threadId: string): Promise<Response> {
	return app.request(`/api/agent/threads/${threadId}/events`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/agent/threads/:threadId/events (SC-19a)", () => {
	test("events in merged-timeline order with the right anchors (before-first / between / after-last)", async () => {
		const thread = await seedSidechatThread();
		// The append order IS the merged-timeline order (messages and events
		// draw seq from the same counter in the same transaction).
		const evA = await stores.experienceCopilot.appendContextEvent(thread.id, "rp_sync", rpSyncPayload);
		const evA2 = await stores.experienceCopilot.appendContextEvent(thread.id, "branch_forked", branchForkedPayload);
		const msg1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "status?" });
		const evB = await stores.experienceCopilot.appendContextEvent(thread.id, "variants_attached", variantsAttachedPayload);
		const msg2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "the bridge is out" });
		const evC = await stores.experienceCopilot.appendContextEvent(thread.id, "selection_changed", selectionChangedPayload);

		const response = await getEvents(thread.id);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			// Before the first message — BOTH consecutive events anchor the
			// same next message.
			{ id: evA.id, kind: "rp_sync", payload: rpSyncPayload, beforeMessageId: msg1.id },
			{ id: evA2.id, kind: "branch_forked", payload: branchForkedPayload, beforeMessageId: msg1.id },
			// Between messages — the first message row after the event.
			{ id: evB.id, kind: "variants_attached", payload: variantsAttachedPayload, beforeMessageId: msg2.id },
			// After the last message (the newest row) — null.
			{ id: evC.id, kind: "selection_changed", payload: selectionChangedPayload, beforeMessageId: null },
		]);
	});

	test("payloads equal the loader's own mapping over the same timeline rows", async () => {
		const thread = await seedSidechatThread();
		await stores.experienceCopilot.appendContextEvent(thread.id, "rp_sync", rpSyncPayload);
		await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		await stores.experienceCopilot.appendContextEvent(thread.id, "variants_attached", variantsAttachedPayload);
		await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "two" });
		await stores.experienceCopilot.appendContextEvent(thread.id, "selection_changed", selectionChangedPayload);

		const response = await getEvents(thread.id);
		expect(response.status).toBe(200);
		const items = (await response.json()) as EventsResponseItem[];

		// The SAME parser the context loader runs, over the SAME rows the
		// route walked (listTimeline's merged order) — the wire items must be
		// its output verbatim (kind + payload, index for index).
		const timeline = await stores.experienceCopilot.listTimeline(thread.id);
		const loaderMapped = timeline
			.filter((entry): entry is TimelineEventRow => entry.rowType === "event")
			.map((entry) => mapTimelineEvent(thread.id, entry));

		expect(items.map((item) => item.kind)).toEqual(loaderMapped.map((mapped) => mapped.kind));
		expect(items.map((item) => item.payload)).toEqual(loaderMapped.map((mapped) => mapped.payload));
		// And the round trip is lossless against the seeded frozen payloads.
		expect(items.map((item) => item.payload)).toEqual([
			rpSyncPayload,
			variantsAttachedPayload,
			selectionChangedPayload,
		]);
	});

	test("a script thread → []; a fresh chat-owned thread with no events → []", async () => {
		const scriptThread = await stores.experienceCopilot.startNewSession("script_fixture_sc19a");
		const scriptResponse = await getEvents(scriptThread.id);
		expect(scriptResponse.status).toBe(200);
		expect(await scriptResponse.json()).toEqual([]);

		// A chat-owned thread with messages but no frozen events is the same
		// empty outcome (a different reason, the same wire).
		const chatThread = await seedSidechatThread();
		await stores.experienceCopilot.appendMessage(chatThread.id, { role: "user", content: "hello" });
		const chatResponse = await getEvents(chatThread.id);
		expect(chatResponse.status).toBe(200);
		expect(await chatResponse.json()).toEqual([]);
	});

	test("the messages route response is unchanged (no seq, no event fields)", async () => {
		const thread = await seedSidechatThread();
		await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "status?" });
		await stores.experienceCopilot.appendContextEvent(thread.id, "branch_forked", branchForkedPayload);

		const response = await app.request(`/api/experience-copilot/${thread.id}/messages`);
		expect(response.status).toBe(200);
		const rows = (await response.json()) as Record<string, unknown>[];
		// Exactly the adapter member's output — the route keeps delegating to
		// the same member it always did.
		expect(rows).toEqual(await copilotWire.experienceCopilotListMessages(thread.id));
		// The wire field set is the canonical seven — no `seq` and nothing the
		// events route introduced leaked into it.
		expect(rows).toHaveLength(1);
		// Lexicographic order: content, createdAt, id, role, threadId,
		// toolCallId, toolCallsJson.
		expect(Object.keys(rows[0]).sort()).toEqual([
			"content",
			"createdAt",
			"id",
			"role",
			"threadId",
			"toolCallId",
			"toolCallsJson",
		]);
	});

	test("a missing thread → 404 NotFound (the sibling convention)", async () => {
		const response = await getEvents("never_born_sc19a");
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { kind: string; resource?: string } };
		expect(body.error.kind).toBe("NotFound");
		expect(body.error.resource).toBe("ExperienceCopilotThread");
	});

	test("the loader's corrupt-payload refusal is inherited — surfaced, never dropped", async () => {
		const thread = await seedSidechatThread();
		// JSON-valid but NOT the frozen rp_sync shape: the store keeps the row
		// (its payload_json parses), and the loader's parser refuses it.
		await stores.experienceCopilot.appendContextEvent(thread.id, "rp_sync", { bogus: true });

		const response = await getEvents(thread.id);
		// mapTimelineEvent's refusal is an Error (not a DomainError) — the
		// app-level Internal mapping: 500, the corrupt event never silently
		// skipped (the same refusal the context loader shows).
		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: { kind: string; message: string } };
		expect(body.error.kind).toBe("Internal");
		expect(body.error.message).toContain("frozen shape");
	});
});

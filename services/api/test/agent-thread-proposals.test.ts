import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createStoreContainer, type StoreContainer, type Chat } from "@vibe-tavern/db";
import { brandId, OBJECTIVE_MODE, type ChatId } from "@vibe-tavern/domain";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { AgentThreadProposalAdapter } from "../src/api/adapters/agent-thread-proposal-adapter.js";
import { InsightsAdapter } from "../src/api/adapters/insights-adapter.js";
import { ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { SceneTrackerService } from "../src/domain/insights/tracker-service.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createAgentThreadProposalRoutes } from "../src/api/routes/agent-thread-proposals.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";

/**
 * SC-11 — the objective-proposal apply/reject routes. The REAL dedicated
 * adapter (wired with the REAL InsightsAdapter + REAL ObjectiveService over
 * a REAL store container in a temp data dir) behind the REAL route module:
 *
 * 1. apply in ROUTE mode adds ONE task (through the insights runtime's
 *    add-task member — the service behind POST
 *    /api/chats/:chatId/insights/objective/tasks, never re-implemented);
 * 2. apply in GOALS mode adds ONE short-term goal
 *    (ObjectiveService.addShortTermGoal) and no route task;
 * 3. reject writes NOTHING to the tracker, only the row's status;
 * 4. tracker off at Accept time → typed 409 `objective_tracker_disabled`,
 *    nothing written anywhere;
 * 5. a second apply (sequential AND racing) → typed 409
 *    `objective_proposal_already_resolved`, still ONE task;
 * 6. the Accept-time mode wins over the proposal-time one;
 * 7. foreign / non-proposal / missing toolCallIds and non-sidechat threads
 *    are 404s;
 * 8. the status survives a reload: the wire message row (the reload path
 *    SC-13 reads) still parses as `{ toolName, output }` with the final
 *    status.
 *
 * The tool-side pins (served-ness through the stream's buildTools seam, the
 * exact proposal shape, the toggle-off refusal) live in
 * sidechat-ooc-stream.test.ts's SC-11 block.
 */

/** The only stub: the InsightsAdapter's snapshot refresh (never asserted —
 *  the tracker assertions read the store directly; `buildConfigPatchResponse`
 *  is session-runtime surface this unit does not own). */
const stubSessionRuntime = {
	buildConfigPatchResponse: async () => ({}),
} as unknown as SessionRuntime;
/** The never-called seams of the two reused services (providers for the
 *  ObjectiveService, tracker for the InsightsAdapter) — nothing in the
 *  add-task / add-short-term-goal paths reads them. Typed per site (the
 *  hygiene budget ratchets never-casts down, so the stubs name their
 *  target interfaces instead). */
const stubUncalledProviders = {} as unknown as ProviderProfileService;
const stubUncalledTracker = {} as unknown as SceneTrackerService;

/** Mount the production DomainError → status mapping (shared helpers, not
 *  duplicated logic) so the adapter's 404/409s are observable at the route —
 *  the same pattern as agent-chat-sessions.test.ts. */
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
let adapter: AgentThreadProposalAdapter;
/** The copilot wire read (the reload path SC-13 consumes) over the SAME
 *  stores — a store-only instance; the lifecycle-only harness shape. */
let copilotWire: ExperienceCopilotAdapter;
let characterId: string;
let toolCallSeq = 0;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-thread-proposals-"));
	stores = await createStoreContainer(join(dataRoot, "agent-proposals.db"), dataRoot);
	const character = await stores.characters.create({ name: "SC-11 objective proposals fixture" });
	characterId = character.id;

	// The REAL reused services: the ObjectiveService itself, and the insights
	// runtime member the insights routes serve (addObjectiveTask = ensureChat +
	// addTask + snapshot refresh — the refresh stubbed above, nothing else).
	const objectiveService = new ObjectiveService(stores, stubSessionRuntime, stubUncalledProviders);
	const insights = new InsightsAdapter(stores, stubSessionRuntime, objectiveService, stubUncalledTracker);
	adapter = new AgentThreadProposalAdapter(stores, {
		addObjectiveTask: (chatId, body) => insights.addObjectiveTask(chatId, body),
		addShortTermGoal: (chatId, description) =>
			objectiveService.addShortTermGoal(brandId<ChatId>(chatId), description),
	});
	app = mountDomainErrorMapping(createAgentThreadProposalRoutes(adapter));
	copilotWire = new ExperienceCopilotAdapter(stores);
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A fresh chat with an explicit tracker setup: `enabled` writes
 *  `objectiveEnabled` (the store default is OFF — every tracker-on test says
 *  so), `mode` defaults to the store's route. */
async function newTrackerChat(enabled: boolean, mode?: "route" | "goals"): Promise<Chat> {
	let chat = await stores.chats.createChat({ characterId, title: "SC-11 fixture", promptPresetId: null });
	if (enabled) {
		chat = await stores.chats.updateInsightsConfig(chat.id, {
			insightsConfig: { ...chat.insightsConfig, objectiveEnabled: true },
		});
	}
	if (mode === "goals") {
		chat = await stores.chats.updateInsightsObjectiveState(chat.id, {
			insightsObjectiveState: { ...chat.insightsObjectiveState, mode: OBJECTIVE_MODE.goals },
		});
	}
	return chat;
}

function makeProposal(id: string): RecordProposal {
	return {
		kind: "record",
		id,
		recordType: "objective",
		op: "create",
		payload: { description: "Cross the ravine before dawn", reason: "The bridge is out" },
		status: "pending",
	};
}

/** A chat-owned sidechat thread + ONE persisted proposal tool row, exactly
 *  the shape the generic loop persists for a propose_objective result
 *  (`{ toolName, output }` on a role-"tool" row keyed by toolCallId). */
async function seedProposal(chat: Chat): Promise<{ threadId: string; toolCallId: string }> {
	const thread = await stores.experienceCopilot.startNewChatSession(
		chat.id,
		chat.activeBranchId as string,
		"sidechat-ooc",
	);
	const toolCallId = `tc_prop_${++toolCallSeq}`;
	await stores.experienceCopilot.appendMessage(thread.id, {
		role: "tool",
		content: JSON.stringify({ toolName: "propose_objective", output: makeProposal(toolCallId) }),
		toolCallId,
	});
	return { threadId: thread.id, toolCallId };
}

function applyUrl(threadId: string, toolCallId: string): string {
	return `/api/agent/threads/${threadId}/proposals/${toolCallId}/apply`;
}
function rejectUrl(threadId: string, toolCallId: string): string {
	return `/api/agent/threads/${threadId}/proposals/${toolCallId}/reject`;
}

async function post(url: string): Promise<Response> {
	return app.request(url, { method: "POST" });
}

async function trackerState(chatId: string) {
	const chat = await stores.chats.getById(chatId);
	if (!chat) throw new Error(`fixture: chat ${chatId} vanished`);
	return chat.insightsObjectiveState;
}

interface ErrorWire {
	error: { details?: { code?: string }; message: string };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/agent/threads/:threadId/proposals/:toolCallId/{apply,reject} (SC-11)", () => {
	test("apply in route mode adds ONE task through the insights add-task service and marks the row applied", async () => {
		const chat = await newTrackerChat(true);
		const { threadId, toolCallId } = await seedProposal(chat);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		// The response is the resolved proposal — the same record shape, only
		// the status changed (SC-13 re-renders the card from it).
		expect(await response.json()).toEqual({
			proposal: { ...makeProposal(toolCallId), status: "applied" },
		});

		const state = await trackerState(chat.id);
		expect(state.mode).toBe(OBJECTIVE_MODE.route);
		expect(state.tasks.map((task) => [task.description, task.status])).toEqual([
			["Cross the ravine before dawn", "pending"],
		]);
	});

	test("apply in goals mode adds ONE short-term goal and no route task", async () => {
		const chat = await newTrackerChat(true, "goals");
		const { threadId, toolCallId } = await seedProposal(chat);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);

		const state = await trackerState(chat.id);
		expect(state.shortTermGoals.map((goal) => [goal.description, goal.status])).toEqual([
			["Cross the ravine before dawn", "pending"],
		]);
		expect(state.tasks).toEqual([]);
	});

	test("reject writes nothing to the tracker and marks the row rejected", async () => {
		const chat = await newTrackerChat(true);
		const { threadId, toolCallId } = await seedProposal(chat);

		const response = await post(rejectUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			proposal: { ...makeProposal(toolCallId), status: "rejected" },
		});

		const state = await trackerState(chat.id);
		expect(state.tasks).toEqual([]);
		expect(state.shortTermGoals).toEqual([]);
	});

	test("tracker off at Accept time → typed 409 objective_tracker_disabled; nothing written", async () => {
		const chat = await newTrackerChat(false);
		const { threadId, toolCallId } = await seedProposal(chat);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(409);
		const body = (await response.json()) as ErrorWire;
		expect(body.error.details?.code).toBe("objective_tracker_disabled");

		// The refusal changes nothing anywhere: no tracker item, and the row
		// stays pending (a later enable-and-accept still works).
		const state = await trackerState(chat.id);
		expect(state.tasks).toEqual([]);
		const row = (await stores.experienceCopilot.listMessages(threadId)).find(
			(message) => message.toolCallId === toolCallId,
		);
		expect((JSON.parse(row!.content as string) as { output: RecordProposal }).output.status).toBe("pending");
	});

	test("a second apply → typed 409 objective_proposal_already_resolved and still ONE task", async () => {
		const chat = await newTrackerChat(true);
		const { threadId, toolCallId } = await seedProposal(chat);

		const first = await post(applyUrl(threadId, toolCallId));
		expect(first.status).toBe(200);

		const second = await post(applyUrl(threadId, toolCallId));
		expect(second.status).toBe(409);
		const body = (await second.json()) as ErrorWire;
		expect(body.error.details?.code).toBe("objective_proposal_already_resolved");
		// Never a second task — and a reject-after-apply is the same refusal.
		expect((await trackerState(chat.id)).tasks).toHaveLength(1);
		const lateReject = await post(rejectUrl(threadId, toolCallId));
		expect(lateReject.status).toBe(409);
		expect((await trackerState(chat.id)).tasks).toHaveLength(1);
	});

	test("two racing applies resolve sequentially: one 200, one typed 409, ONE task", async () => {
		const chat = await newTrackerChat(true);
		const { threadId, toolCallId } = await seedProposal(chat);

		const [a, b] = await Promise.all([post(applyUrl(threadId, toolCallId)), post(applyUrl(threadId, toolCallId))]);
		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual([200, 409]);
		const conflictBody = (await (a.status === 409 ? a : b).json()) as ErrorWire;
		expect(conflictBody.error.details?.code).toBe("objective_proposal_already_resolved");
		expect((await trackerState(chat.id)).tasks).toHaveLength(1);
	});

	test("the Accept-time mode wins: a route-mode proposal lands as a short-term goal after the switch", async () => {
		const chat = await newTrackerChat(true, "route");
		const { threadId, toolCallId } = await seedProposal(chat);

		// The user flips the mode BETWEEN the proposal and Accept — the
		// tracker is re-read when Accept is pressed, never cached in the row.
		await stores.chats.updateInsightsObjectiveState(chat.id, {
			insightsObjectiveState: { ...(await trackerState(chat.id)), mode: OBJECTIVE_MODE.goals },
		});

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const state = await trackerState(chat.id);
		expect(state.shortTermGoals.map((goal) => goal.description)).toEqual(["Cross the ravine before dawn"]);
		expect(state.tasks).toEqual([]);
	});

	test("a foreign toolCallId, a non-proposal row, a missing id and a non-sidechat thread are 404s", async () => {
		const own = await newTrackerChat(true);
		const own1 = await seedProposal(own);

		// A DIFFERENT thread's proposal — the row lookup is thread-scoped.
		const other = await newTrackerChat(true);
		const other1 = await seedProposal(other);
		const foreign = await post(applyUrl(own1.threadId, other1.toolCallId));
		expect(foreign.status).toBe(404);

		// A search tool row of the RIGHT thread: toolName-gated, not just
		// any-toolCallId-shaped.
		await stores.experienceCopilot.appendMessage(own1.threadId, {
			role: "tool",
			content: JSON.stringify({ toolName: "search_context", output: { results: [] } }),
			toolCallId: "tc_search_row",
		});
		const nonProposal = await post(applyUrl(own1.threadId, "tc_search_row"));
		expect(nonProposal.status).toBe(404);

		// A toolCallId no row carries at all.
		const missing = await post(applyUrl(own1.threadId, "tc_never_born"));
		expect(missing.status).toBe(404);

		// A script-owned thread is not this route's proposal source (the kind
		// guard — a thread that is not a chat-owned sidechat-ooc row).
		const scriptThread = await stores.experienceCopilot.startNewSession("script_fixture_sc11");
		const scriptRow = await stores.experienceCopilot.appendMessage(scriptThread.id, {
			role: "tool",
			content: JSON.stringify({ toolName: "propose_objective", output: makeProposal("tc_script_row") }),
			toolCallId: "tc_script_row",
		});
		expect(scriptRow).toBeDefined();
		const wrongKind = await post(applyUrl(scriptThread.id, "tc_script_row"));
		expect(wrongKind.status).toBe(404);
	});

	test("the status survives a reload — the wire row parses back with the final status", async () => {
		const chat = await newTrackerChat(true);
		const { threadId, toolCallId } = await seedProposal(chat);
		await post(applyUrl(threadId, toolCallId));

		// The reload path SC-13 reads: the adapter's list-messages wire. The
		// row keeps its parseable `{ toolName, output }` wrapper; only the
		// proposal's status changed.
		const messages = await copilotWire.experienceCopilotListMessages(threadId);
		const row = messages.find((message) => message.toolCallId === toolCallId);
		expect(row?.role).toBe("tool");
		const parsed = JSON.parse(row!.content) as { toolName: string; output: RecordProposal };
		expect(parsed.toolName).toBe("propose_objective");
		expect(parsed.output).toEqual({ ...makeProposal(toolCallId), status: "applied" });
	});
});

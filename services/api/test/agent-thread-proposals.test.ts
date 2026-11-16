import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createStoreContainer, type StoreContainer, type Chat, type Message as DbMessage, type MessageVariant as DbMessageVariant } from "@vibe-tavern/db";
import {
	brandId,
	OBJECTIVE_MODE,
	STORY_CLOCK_SCENE_FIELDS,
	type ChatBranchId,
	type ChatId,
} from "@vibe-tavern/domain";
import {
	DIRECTOR_MESSAGE_RECORD_TYPES,
	DIRECTOR_MESSAGE_TOOLS,
	type DirectorMessageEditProposal,
	type DirectorMessageVariantProposal,
	type RecordProposal,
} from "@vibe-tavern/api-contracts";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { AgentThreadProposalAdapter } from "../src/api/adapters/agent-thread-proposal-adapter.js";
import { InsightsAdapter } from "../src/api/adapters/insights-adapter.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import { ObjectiveService } from "../src/domain/insights/objective-service.js";
import { StoryPlanSync } from "../src/domain/director/story-plan-sync.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { SIDECHAT_RECORD_PROPOSAL_REGISTRY } from "../src/domain/sidechat/sidechat-objective-proposal.js";
import { createAgentThreadProposalRoutes } from "../src/api/routes/agent-thread-proposals.js";
import {
	SIDECHAT_PROPOSE_DECK_TOOL_NAME,
	SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
	SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
	STORY_DECK_RECORD_TYPE,
} from "../src/domain/agent/kinds/sidechat/sidechat-director-tools.js";
import { SIDECHAT_OBJECTIVE_TOOL_NAME } from "../src/domain/agent/kinds/sidechat/sidechat-objective-tools.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../src/shared/errors.js";
import { makeSceneTracker, makeSessionRuntime } from "./insights-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

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
 *  is session-runtime surface this unit does not own). `{}` is a valid
 *  ConfigPatchResponse — every member of the patch is optional. */
const stubSessionRuntime = makeSessionRuntime({
	buildConfigPatchResponse: async () => ({}),
});
/** The never-called seams of the two reused services (providers for the
 *  ObjectiveService, tracker for the InsightsAdapter) — nothing in the
 *  add-task / add-short-term-goal paths reads them. Strict doubles: if a
 *  path ever starts reading them, the miss throws a labeled error instead of
 *  silently returning `undefined`. */
const stubUncalledProviders = strictTestDouble<ProviderProfileService>(
	{},
	"provider profiles (uncalled seam)",
);
const stubUncalledTracker = makeSceneTracker({});

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
/** The REAL story-plan sync behind the DR-5 seams (same construction as
 *  server-runtime.ts, minus the observer/wiring halves this suite does not
 *  exercise — applyPlan + insertNextEvent only). */
let storyPlanSync: StoryPlanSync;
let objectiveService: ObjectiveService;
let insights: InsightsAdapter;
/** The REAL chat application service behind the DMT-22 message seams (the
 *  ordinary guarded edit + add-variant path — the same construction
 *  SessionRuntime uses). */
let chatApp: ChatApplicationService;
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
	// DR-5: the same real services back the new seams — StoryPlanSync (the
	// story-plan apply + R3's next-event insert), ObjectiveService's config
	// updater (A6), the insights adapter's shared template tail (tracker-scene)
	// and the session runtime's config patch (the reject companion, stubbed
	// above). DMT-22: the message handlers run the REAL ChatApplicationService
	// (the guarded edit with the base-content guard + the add-variant path),
	// the same construction SessionRuntime uses. The branded ids enter at
	// these seam closures, as in production.
	objectiveService = new ObjectiveService(stores, stubSessionRuntime, stubUncalledProviders);
	insights = new InsightsAdapter(stores, stubSessionRuntime, objectiveService, stubUncalledTracker);
	storyPlanSync = new StoryPlanSync(stores, objectiveService);
	chatApp = new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls, stores.experiences, stores);
	adapter = new AgentThreadProposalAdapter(stores, {
		addObjectiveTask: (chatId, body) => insights.addObjectiveTask(chatId, body),
		addShortTermGoal: (chatId, description) =>
			objectiveService.addShortTermGoal(brandId<ChatId>(chatId), description),
		insertNextStoryEvent: (chatId, branchId, event) =>
			storyPlanSync.insertNextEvent(brandId<ChatId>(chatId), brandId<ChatBranchId>(branchId), event),
		applyStoryPlan: (chatId, branchId, plan) =>
			storyPlanSync.applyPlan(brandId<ChatId>(chatId), brandId<ChatBranchId>(branchId), plan),
		updateObjectiveConfig: (chatId, patch) =>
			objectiveService.updateObjectiveConfig(brandId<ChatId>(chatId), patch),
		applyTrackerScene: (chatId, scene) => insights.applyTrackerSceneTemplate(chatId, scene),
		readInsightsPatch: (chatId) =>
			stubSessionRuntime.buildConfigPatchResponse(brandId<ChatId>(chatId), { activeChat: true }),
		editMessage: (messageId, content, expectedVariantId, expectedBaseContent) =>
			chatApp.editMessage(messageId, content, expectedVariantId, expectedBaseContent),
		addEditorVariant: (messageId, input) => chatApp.addEditorVariant(messageId, input),
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

/** The chat's tracker DSL — a loud fixture error when absent, so the clock
 *  assertions index a real schema instead of guarding every read. */
async function trackerSchema(chatId: string) {
	const chat = await stores.chats.getById(chatId);
	if (!chat) throw new Error(`fixture: chat ${chatId} vanished`);
	const schema = chat.insightsConfig.tracker?.schema;
	if (!schema) throw new Error(`fixture: chat ${chatId} carries no tracker schema`);
	return schema;
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

// ─── DR-5 — the record-proposal dispatch (story-plan + tracker-scene) ───────

/** A two-event branch plan (the first active — the plan the DR-3 tests use):
 *  the projection's goal texts are title+body for `task_a` (A3) and the bare
 *  title for `task_b` (empty body contributes nothing). */
const PLAN = {
	goal: "Escape the valley",
	constraints: ["No anachronisms"],
	tasks: [
		{ id: "task_a", title: "Find the pass", body: "The pass opens at dawn", status: "active" },
		{ id: "task_b", title: "Cross the ravine", body: "", status: "pending" },
	],
};

/** A scene half (the tracker-scene payload) — the same shape the CT-3 suite's
 *  template scene part carries. */
const SCENE = { enabled: true, config: { schema: { location: { $type: "string" } } } };

function makeStoryPlanProposal(id: string, branchId: string, plan: unknown): RecordProposal {
	return {
		kind: "record",
		id,
		recordType: "story-plan",
		op: "update",
		targetId: branchId,
		payload: { plan },
		status: "pending",
	};
}

function makeTrackerSceneProposal(id: string, chatId: string, scene: unknown): RecordProposal {
	return {
		kind: "record",
		id,
		recordType: "tracker-scene",
		op: "update",
		targetId: chatId,
		payload: { scene },
		status: "pending",
	};
}

/** Seed ONE proposal tool row of ANY type on a fresh chat-owned sidechat
 *  thread — the same persisted shape the generic loop writes for a proposal
 *  tool result (`{ toolName, output }` keyed by the proposal's own id). */
async function seedRecordProposal(
	chat: Chat,
	toolName: string,
	proposal: RecordProposal,
): Promise<{ threadId: string; toolCallId: string }> {
	const thread = await stores.experienceCopilot.startNewChatSession(
		chat.id,
		chat.activeBranchId as string,
		"sidechat-ooc",
	);
	await stores.experienceCopilot.appendMessage(thread.id, {
		role: "tool",
		content: JSON.stringify({ toolName, output: proposal }),
		toolCallId: proposal.id,
	});
	return { threadId: thread.id, toolCallId: proposal.id };
}

/** Save a branch plan through the REAL sync (the branch-plan PUT's own
 *  path — normalize + save + ACTIVE-branch projection). */
async function savePlan(chat: Chat, plan: unknown) {
	return storyPlanSync.applyPlan(
		brandId<ChatId>(chat.id),
		brandId<ChatBranchId>(chat.activeBranchId as string),
		plan,
	);
}

async function storedPlan(chat: Chat) {
	return stores.agentPlans.get({
		kind: "chatBranch",
		chatId: chat.id,
		branchId: chat.activeBranchId as string,
	});
}

async function postJson(url: string, body: unknown): Promise<Response> {
	return app.request(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function rowStatus(threadId: string, toolCallId: string): Promise<string> {
	const row = (await stores.experienceCopilot.listMessages(threadId)).find(
		(message) => message.toolCallId === toolCallId,
	);
	return (JSON.parse(row!.content as string) as { output: RecordProposal }).output.status;
}

describe("POST /api/agent/threads/:threadId/proposals/:toolCallId/{apply,reject} (DR-5 dispatch)", () => {
	test("objective apply under a plan with events lands as the NEXT plan event, never a tracker item (R3)", async () => {
		const chat = await newTrackerChat(true);
		await savePlan(chat, PLAN);
		const { threadId, toolCallId } = await seedProposal(chat);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { proposal: RecordProposal; plan: { tasks: Array<{ id: string; title: string; status: string }> } };
		// The objective row resolved as today — only the status changed.
		expect(body.proposal).toEqual({ ...makeProposal(toolCallId), status: "applied" });
		// The refreshed plan: the new event sits right AFTER the current one.
		expect(body.plan.tasks.map((task) => [task.title, task.status])).toEqual([
			["Find the pass", "active"],
			["Cross the ravine before dawn", "pending"],
			["Cross the ravine", "pending"],
		]);

		// The stored plan carries the event; the tracker carries ONLY the plan's
		// projected events (three goals) — the proposal never became a separate
		// tracker item (R3: insertNextEvent, not addShortTermGoal).
		expect((await storedPlan(chat))?.tasks).toHaveLength(3);
		const state = await trackerState(chat.id);
		expect(state.mode).toBe(OBJECTIVE_MODE.goals);
		expect(state.shortTermGoals.map((goal) => goal.description)).toEqual([
			"Find the pass\nThe pass opens at dawn",
			"Cross the ravine before dawn",
			"Cross the ravine",
		]);
		expect(state.tasks).toEqual([]);
	});

	test("objective apply under an EMPTY plan stays today's behavior — a tracker item, no companion", async () => {
		const chat = await newTrackerChat(true);
		// An empty plan projects to empty goals (A8) — no events, so the
		// proposal stays a tracker add and the response keeps today's shape.
		await savePlan(chat, { goal: "", constraints: [], tasks: [] });
		const { threadId, toolCallId } = await seedProposal(chat);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		// Byte-identical no-plan response: exactly `{ proposal }`.
		expect(await response.json()).toEqual({
			proposal: { ...makeProposal(toolCallId), status: "applied" },
		});
		const state = await trackerState(chat.id);
		expect(state.mode).toBe(OBJECTIVE_MODE.goals);
		expect(state.shortTermGoals.map((goal) => goal.description)).toEqual(["Cross the ravine before dawn"]);
	});

	test("story-plan apply saves and projects the plan on the active branch, returns the refreshed plan, and leaves the auto-check config untouched without the flag", async () => {
		const chat = await newTrackerChat(true);
		const branchId = chat.activeBranchId as string;
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
			makeStoryPlanProposal("tc_plan_1", branchId, PLAN),
		);

		// Body-less POST — today's caller shape parses as {}.
		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { proposal: RecordProposal; plan: { goal: string; tasks: unknown[] } };
		expect(body.proposal).toEqual({ ...makeStoryPlanProposal("tc_plan_1", branchId, PLAN), status: "applied" });
		expect(body.plan.goal).toBe("Escape the valley");
		expect(body.plan.tasks).toHaveLength(2);
		// The stored branch plan IS the returned (normalized) plan.
		expect(await storedPlan(chat)).toEqual(body.plan);

		// The projection (active branch): goals mode, one goal per event (A3:
		// title+body when the body is non-blank, bare title otherwise — A2:
		// the premise never reaches the tracker).
		const state = await trackerState(chat.id);
		expect(state.mode).toBe(OBJECTIVE_MODE.goals);
		expect(state.longTermGoal).toBe(null);
		expect(state.shortTermGoals.map((goal) => [goal.id, goal.description, goal.status])).toEqual([
			["task_a", "Find the pass\nThe pass opens at dawn", "active"],
			["task_b", "Cross the ravine", "pending"],
		]);
		// Without the flag the auto-check config is untouched (A6).
		expect(state.autoCheckFrequency).toBe(0);
	});

	test("story-plan apply with enableAutoCheck turns the tracker's auto-check on (A6: frequency 1)", async () => {
		const chat = await newTrackerChat(true);
		const branchId = chat.activeBranchId as string;
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
			makeStoryPlanProposal("tc_plan_2", branchId, PLAN),
		);

		const response = await postJson(applyUrl(threadId, toolCallId), { enableAutoCheck: true });
		expect(response.status).toBe(200);
		expect((await trackerState(chat.id)).autoCheckFrequency).toBe(1);
	});

	test("tracker-scene apply runs the shared template tail scene-only — the tracker config changes, goals and the objective toggle survive", async () => {
		const chat = await newTrackerChat(true, "goals");
		// A FOREIGN goal proves A9 (scene only — the objective half passes
		// through `objective: null` untouched, never replaced).
		await objectiveService.addShortTermGoal(brandId<ChatId>(chat.id), "A foreign goal");
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
			makeTrackerSceneProposal("tc_scene_1", chat.id, SCENE),
		);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { proposal: RecordProposal; patch: unknown };
		expect(body.proposal).toEqual({ ...makeTrackerSceneProposal("tc_scene_1", chat.id, SCENE), status: "applied" });
		// The insights patch companion rides the response (the stubbed refresh).
		expect(body.patch).toEqual({});

		const updated = await stores.chats.getById(chat.id);
		expect(updated?.insightsConfig.trackerEnabled).toBe(true);
		expect(Object.keys(updated?.insightsConfig.tracker?.schema ?? {})).toEqual(["location"]);
		expect((await trackerState(chat.id)).shortTermGoals.map((goal) => goal.description)).toEqual(["A foreign goal"]);
		expect(updated?.insightsConfig.objectiveEnabled).toBe(true);
	});

	test("tracker-scene apply with withClock adds the three canonical clock fields exactly once — never duplicating what the schema already carries (DK-5a)", async () => {
		const chat = await newTrackerChat(true, "goals");
		// Case 1 — a bare schema: all three canonical fields land verbatim,
		// once each, after the scene's own fields.
		const plain = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
			{
				...makeTrackerSceneProposal("tc_scene_clock", chat.id, SCENE),
				payload: { scene: SCENE, withClock: true },
			},
		);
		const plainApply = await post(applyUrl(plain.threadId, plain.toolCallId));
		expect(plainApply.status).toBe(200);
		const schema = await trackerSchema(chat.id);
		expect(Object.keys(schema)).toEqual([
			"location",
			STORY_CLOCK_SCENE_FIELDS.day.key,
			STORY_CLOCK_SCENE_FIELDS.part.key,
			STORY_CLOCK_SCENE_FIELDS.label.key,
		]);
		expect(schema[STORY_CLOCK_SCENE_FIELDS.day.key]).toEqual(STORY_CLOCK_SCENE_FIELDS.day.node);
		expect(schema[STORY_CLOCK_SCENE_FIELDS.part.key]).toEqual(STORY_CLOCK_SCENE_FIELDS.part.node);
		expect(schema[STORY_CLOCK_SCENE_FIELDS.label.key]).toEqual(STORY_CLOCK_SCENE_FIELDS.label.node);

		// Case 2 — a scene that ALREADY carries clock-ish fields: a plain user
		// node on the canonical `story_time` key is never overwritten, and the
		// adder leaves no duplicate markers behind.
		const occupiedScene = {
			enabled: true,
			config: {
				schema: {
					story_time: { $type: "string", label: "Time of day" },
					mood: { $type: "string" },
				},
			},
		};
		const occupied = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
			{
				...makeTrackerSceneProposal("tc_scene_clock_twice", chat.id, occupiedScene),
				payload: { scene: occupiedScene, withClock: true },
			},
		);
		const occupiedApply = await post(applyUrl(occupied.threadId, occupied.toolCallId));
		expect(occupiedApply.status).toBe(200);
		const schemaTwice = await trackerSchema(chat.id);
		expect(Object.keys(schemaTwice).sort()).toEqual(
			["mood", "story_date", "story_day", "story_time"].sort(),
		);
		// The user's node on the canonical key survived byte-identical.
		expect(schemaTwice.story_time).toEqual({ $type: "string", label: "Time of day" });
		// Exactly one node per clock marker — never duplicated (the part
		// canonical field was skipped: the user's node holds its key).
		const markers = Object.values(schemaTwice)
			.map((node) => ("clock" in node ? node.clock : undefined))
			.filter((clock) => clock !== undefined);
		expect(markers.sort()).toEqual(["day", "label"]);
	});

	test("reject writes status only for the new types — the stored plan and the tracker stay untouched", async () => {
		const chat = await newTrackerChat(true);
		const branchId = chat.activeBranchId as string;
		await savePlan(chat, PLAN);
		const planSeed = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
			makeStoryPlanProposal("tc_plan_rej", branchId, { ...PLAN, goal: "A rejected goal" }),
		);
		const planReject = await post(rejectUrl(planSeed.threadId, planSeed.toolCallId));
		expect(planReject.status).toBe(200);
		const planBody = (await planReject.json()) as { proposal: RecordProposal; plan: { goal: string } };
		expect(planBody.proposal.status).toBe("rejected");
		// The companion is the CURRENT stored plan — the proposal's plan never landed.
		expect(planBody.plan.goal).toBe("Escape the valley");
		expect((await storedPlan(chat))?.goal).toBe("Escape the valley");
		expect((await trackerState(chat.id)).shortTermGoals).toHaveLength(2);

		const sceneSeed = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
			makeTrackerSceneProposal("tc_scene_rej", chat.id, SCENE),
		);
		const sceneReject = await post(rejectUrl(sceneSeed.threadId, sceneSeed.toolCallId));
		expect(sceneReject.status).toBe(200);
		const sceneBody = (await sceneReject.json()) as { proposal: RecordProposal; patch: unknown };
		expect(sceneBody.proposal.status).toBe("rejected");
		expect(sceneBody.patch).toEqual({});
		const after = await stores.chats.getById(chat.id);
		expect(after?.insightsConfig.trackerEnabled).toBe(false);

		// Objective reject under a plan: the plan companion comes back, but
		// nothing is inserted (R3 fires only on Accept).
		const objectiveSeed = await seedProposal(chat);
		const objectiveReject = await post(rejectUrl(objectiveSeed.threadId, objectiveSeed.toolCallId));
		expect(objectiveReject.status).toBe(200);
		const objectiveBody = (await objectiveReject.json()) as { proposal: RecordProposal; plan: { tasks: unknown[] } };
		expect(objectiveBody.proposal.status).toBe("rejected");
		expect(objectiveBody.plan.tasks).toHaveLength(2);
		expect((await storedPlan(chat))?.tasks).toHaveLength(2);
	});

	test("an unknown recordType is refused with the typed 422 before any write", async () => {
		const chat = await newTrackerChat(true);
		const unknown: RecordProposal = {
			kind: "record",
			id: "tc_mystery",
			recordType: "mystery-type",
			op: "update",
			payload: {},
			status: "pending",
		};
		const { threadId, toolCallId } = await seedRecordProposal(chat, "propose_plan", unknown);

		const applyAttempt = await post(applyUrl(threadId, toolCallId));
		expect(applyAttempt.status).toBe(422);
		const applyBody = (await applyAttempt.json()) as ErrorWire;
		expect(applyBody.error.details?.code).toBe("unknown_proposal_record_type");

		const rejectAttempt = await post(rejectUrl(threadId, toolCallId));
		expect(rejectAttempt.status).toBe(422);

		// No writes anywhere: the row stays pending, the tracker untouched.
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
		expect((await trackerState(chat.id)).tasks).toEqual([]);
	});

	test("a failed story-plan domain write leaves the row pending — the status write follows the domain write", async () => {
		const chat = await newTrackerChat(true);
		const branchId = chat.activeBranchId as string;
		// An invalid plan (two active events) — the shared normalize-or-422.
		const invalid = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
			makeStoryPlanProposal("tc_plan_bad", branchId, {
				goal: "X",
				constraints: [],
				tasks: [
					{ id: "t1", title: "One", body: "", status: "active" },
					{ id: "t2", title: "Two", body: "", status: "active" },
				],
			}),
		);
		const invalidApply = await post(applyUrl(invalid.threadId, invalid.toolCallId));
		expect(invalidApply.status).toBe(422);
		expect(((await invalidApply.json()) as ErrorWire).error.details?.code).toBe("agent_plan_multiple_active");
		expect(await rowStatus(invalid.threadId, invalid.toolCallId)).toBe("pending");
		expect(await storedPlan(chat)).toBe(null);

		// A foreign target branch — applyPlan's ownership 404, same ordering.
		const foreign = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
			makeStoryPlanProposal("tc_plan_foreign", "branch_never_born", PLAN),
		);
		const foreignApply = await post(applyUrl(foreign.threadId, foreign.toolCallId));
		expect(foreignApply.status).toBe(404);
		expect(await rowStatus(foreign.threadId, foreign.toolCallId)).toBe("pending");
	});

	test("a second story-plan apply is refused as today (already resolved)", async () => {
		const chat = await newTrackerChat(true);
		const branchId = chat.activeBranchId as string;
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
			makeStoryPlanProposal("tc_plan_twice", branchId, PLAN),
		);
		const first = await post(applyUrl(threadId, toolCallId));
		expect(first.status).toBe(200);

		const second = await post(applyUrl(threadId, toolCallId));
		expect(second.status).toBe(409);
		expect(((await second.json()) as ErrorWire).error.details?.code).toBe("objective_proposal_already_resolved");
		// Still exactly the one applied plan.
		expect((await storedPlan(chat))?.tasks).toHaveLength(2);
	});
});

// ─── DK-5a — the story-deck resolutions ─────────────────────────────────────

/** The proposed twist cards (the wire card shape; suits typed as their
 *  literal union). The `id`s are what the MODEL proposed — the apply must
 *  never reuse them. */
const PROPOSED_CARDS: Array<{ id: string; suit: "threat" | "mystery"; title: string; body: string }> = [
	{
		id: "model_threat",
		suit: "threat",
		title: "The harbour watch turns hostile",
		body: "The guards demand the ledger at dusk.",
	},
	{
		id: "model_mystery",
		suit: "mystery",
		title: "A tide map under the floorboards",
		body: "Marked with the pact seal.",
	},
];

function makeDeckProposal(id: string, branchId: string, cards: unknown, summary?: string): RecordProposal {
	return {
		kind: "record",
		id,
		recordType: STORY_DECK_RECORD_TYPE,
		op: "update",
		targetId: branchId,
		payload: summary === undefined ? { cards } : { cards, summary },
		status: "pending",
	};
}

async function storedDeck(chat: Chat) {
	return stores.storyDecks.get(chat.id, chat.activeBranchId as string);
}

describe("story-deck apply — append with fresh ids through the registry (DK-5a)", () => {
	test("apply appends the proposed cards to the branch deck with FRESH ids — the proposed ids are never reused, the response is the bare proposal", async () => {
		const chat = await newPlainChat();
		const branchId = chat.activeBranchId as string;
		await stores.storyDecks.save(chat.id, branchId, {
			cards: [{ id: "deck_existing", suit: "discovery", title: "An older card", body: "Drawn long ago." }],
		});
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_DECK_TOOL_NAME,
			makeDeckProposal("tc_deck_ok", branchId, PROPOSED_CARDS, "Two twists"),
		);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { proposal: RecordProposal };
		// No companion — the bare `{ proposal }` response (the objective
		// handler's no-plan convention).
		expect(body.proposal).toEqual({
			...makeDeckProposal("tc_deck_ok", branchId, PROPOSED_CARDS, "Two twists"),
			status: "applied",
		});

		const deck = await storedDeck(chat);
		expect(deck?.cards).toHaveLength(3);
		const appended = deck?.cards.slice(1) ?? [];
		// Cards keep suit/title/body verbatim, in proposal order.
		expect(appended.map((card) => [card.suit, card.title, card.body])).toEqual(
			PROPOSED_CARDS.map((card) => [card.suit, card.title, card.body]),
		);
		// FRESH ids only: the model's proposed ids are never reused; every
		// minted id is the deck twin of the plan event's `task_` convention,
		// and they are unique.
		expect(appended.map((card) => card.id)).not.toContain("model_threat");
		expect(appended.map((card) => card.id)).not.toContain("model_mystery");
		for (const id of appended.map((card) => card.id)) {
			expect(id).toMatch(/^card_/);
		}
		expect(new Set(appended.map((card) => card.id)).size).toBe(2);
		// The pre-existing card is untouched — append, never replace.
		expect(deck?.cards[0]).toEqual({
			id: "deck_existing",
			suit: "discovery",
			title: "An older card",
			body: "Drawn long ago.",
		});
	});

	test("a second apply is refused the standard 409 — the deck gains nothing more", async () => {
		const chat = await newPlainChat();
		const branchId = chat.activeBranchId as string;
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_DECK_TOOL_NAME,
			makeDeckProposal("tc_deck_twice", branchId, PROPOSED_CARDS),
		);
		const first = await post(applyUrl(threadId, toolCallId));
		expect(first.status).toBe(200);

		const second = await post(applyUrl(threadId, toolCallId));
		expect(second.status).toBe(409);
		expect(((await second.json()) as ErrorWire).error.details?.code).toBe(
			"objective_proposal_already_resolved",
		);
		expect((await storedDeck(chat))?.cards).toHaveLength(2);
	});

	test("reject leaves the deck unchanged — the status write is the only effect", async () => {
		const chat = await newPlainChat();
		const branchId = chat.activeBranchId as string;
		await stores.storyDecks.save(chat.id, branchId, {
			cards: [{ id: "deck_existing", suit: "change", title: "A storm rolls in", body: "" }],
		});
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_DECK_TOOL_NAME,
			makeDeckProposal("tc_deck_rej", branchId, PROPOSED_CARDS),
		);

		const response = await post(rejectUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { proposal: RecordProposal };
		expect(body.proposal.status).toBe("rejected");
		// No deck write, no companion: the stored deck is byte-identical.
		expect(await storedDeck(chat)).toEqual({
			cards: [{ id: "deck_existing", suit: "change", title: "A storm rolls in", body: "" }],
		});
	});

	test("a foreign target branch is the pair-check 404 — nothing written anywhere", async () => {
		const chat = await newPlainChat();
		const foreign = await seedRecordProposal(
			chat,
			SIDECHAT_PROPOSE_DECK_TOOL_NAME,
			makeDeckProposal("tc_deck_foreign", "branch_never_born", PROPOSED_CARDS),
		);
		const foreignApply = await post(applyUrl(foreign.threadId, foreign.toolCallId));
		expect(foreignApply.status).toBe(404);
		// The row stays pending (nothing resolved) and the branch's deck
		// (the thread's OWN branch) is untouched.
		expect(await rowStatus(foreign.threadId, foreign.toolCallId)).toBe("pending");
		expect((await storedDeck(chat))?.cards ?? []).toEqual([]);
	});
});

// ─── DMT-22 — the message-edit / message-variant resolutions ─────────────────
//
// The Director's two reviewable tools resolve through the SAME pipeline and
// registry (no parallel system): apply runs the ordinary chat edit /
// add-variant services over the THREAD's own branch with the frozen
// identities; the store's transactional selected-variant + reviewed-base
// guards refuse stale/moved/foreign targets; reject changes only the status;
// the per-proposal FIFO serializes double applies.

/** A plain RP chat (no tracker state needed — the message handlers read the
 *  thread's own branch, not the insights config). */
async function newPlainChat(): Promise<Chat> {
	return stores.chats.createChat({ characterId, title: "DMT-22 fixture", promptPresetId: null });
}

/** An assistant reply on the chat's active branch with the given swipe texts
 *  (the same store path the RP send path uses). */
async function addReply(chat: Chat, variants: string[], selectedVariantIndex = 0): Promise<DbMessage> {
	return stores.messages.addMessage({
		chatId: chat.id,
		branchId: chat.activeBranchId as string,
		role: "assistant",
		authorType: "assistant",
		content: variants[selectedVariantIndex] ?? variants[0]!,
		variants,
		selectedVariantIndex,
	});
}

const EDIT_CANDIDATE = "She opened the door quietly.";
const VARIANT_SAVE_TEXT = "The Director's own alternative reply.";

/** A `message-edit` proposal frozen from a real swipe row — the exact payload
 *  shape the DMT-21 tool persists (identity + diff base + candidate + editor
 *  provenance). */
function makeEditProposal(id: string, message: DbMessage, variant: DbMessageVariant): RecordProposal {
	const payload: DirectorMessageEditProposal = {
		source: {
			messageId: message.id,
			variantId: variant.id,
			position: message.position,
			variantNumber: variant.variantIndex + 1,
		},
		sourceText: variant.content,
		instruction: "Fix the adverb.",
		candidate: EDIT_CANDIDATE,
		editor: { modelId: "editor_model_1" },
	};
	return {
		kind: "record",
		id,
		recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit,
		op: "update",
		targetId: message.id,
		payload,
		status: "pending",
	};
}

/** A `message-variant` proposal frozen from real swipe rows — the DMT-21
 *  shape: frozen source identities + the complete Director-written text. */
function makeVariantProposal(
	id: string,
	message: DbMessage,
	sources: readonly DbMessageVariant[],
	content: string,
): RecordProposal {
	const payload: DirectorMessageVariantProposal = {
		sources: sources.map((variant) => ({
			messageId: message.id,
			variantId: variant.id,
			position: message.position,
			variantNumber: variant.variantIndex + 1,
		})),
		content,
	};
	return {
		kind: "record",
		id,
		recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant,
		op: "create",
		targetId: message.id,
		payload,
		status: "pending",
	};
}

/** The reply's swipe rows as the tools froze them (variantIndex order). */
async function replyVariants(message: DbMessage): Promise<DbMessageVariant[]> {
	return stores.messages.getVariants(message.id);
}

describe("the one record-proposal registry (DMT-22 registration)", () => {
	test("carries exactly the six record types — the two message types and the deck included, no parallel table", () => {
		// Behavior change (DK-5a): was the five DMT-22 types → now six,
		// `story-deck` appended (DIRECTOR_DECK_CALENDAR_PLAN DK-5a) — one
		// dispatch table, still no parallel one.
		expect(Object.keys(SIDECHAT_RECORD_PROPOSAL_REGISTRY).sort()).toEqual([
			DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit,
			DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant,
			"objective",
			"story-deck",
			"story-plan",
			"tracker-scene",
		]);
		expect(SIDECHAT_RECORD_PROPOSAL_REGISTRY[DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit]?.toolName).toBe(
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
		);
		expect(SIDECHAT_RECORD_PROPOSAL_REGISTRY[DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant]?.toolName).toBe(
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
		);
		expect(SIDECHAT_RECORD_PROPOSAL_REGISTRY[STORY_DECK_RECORD_TYPE]?.toolName).toBe(
			SIDECHAT_PROPOSE_DECK_TOOL_NAME,
		);
	});
});

describe("message-edit apply — the ordinary guarded edit through the registry (DMT-22)", () => {
	test("applies the candidate to the selected swipe and returns the target-scoped message companion", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["She opened the door slowly.", "She pushed the door open."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_ok", reply, v0!),
		);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			proposal: RecordProposal;
			message?: {
				chatId: string;
				branchId: string;
				message: { id: string; content: string; position: number; updatedAt: string };
				variants: Array<{ id: string; content: string; isSelected: boolean }>;
			};
		};
		expect(body.proposal).toEqual({ ...makeEditProposal("tc_edit_ok", reply, v0!), status: "applied" });
		// The companion is TARGET-SCOPED: the affected message + its full
		// variant list, with the chat/branch scope attached (a client refuses
		// to ingest it into a different open conversation).
		expect(body.message?.chatId).toBe(chat.id);
		expect(body.message?.branchId).toBe(chat.activeBranchId);
		const stored = await stores.messages.getMessageById(reply.id);
		expect(body.message?.message).toEqual({
			id: reply.id,
			content: EDIT_CANDIDATE,
			position: reply.position,
			updatedAt: stored?.updatedAt,
		});
		expect(body.message?.variants).toHaveLength(2);
		expect(body.message?.variants[0]).toMatchObject({ id: v0!.id, content: EDIT_CANDIDATE, isSelected: true });
		expect(body.message?.variants[1]).toMatchObject({ content: "She pushed the door open.", isSelected: false });

		// Store level: the ordinary edit path rewrote the selected swipe (and
		// the mirrored row content), the sibling swipe untouched.
		const after = await stores.messages.getVariants(reply.id);
		expect(after[0]?.content).toBe(EDIT_CANDIDATE);
		expect(after[0]?.isSelected).toBeTrue();
		expect(after[1]?.content).toBe("She pushed the door open.");
		expect((await stores.messages.getMessageById(reply.id))?.content).toBe(EDIT_CANDIDATE);
	});

	test("a newer edit to the SAME still-selected swipe refuses the apply (stale base) and writes nothing", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["She opened the door slowly."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_stale", reply, v0!),
		);
		// The variant id did NOT change, but its content moved on after the
		// user reviewed the proposal — the exact overwrite the base guard
		// exists to refuse.
		await stores.messages.editMessage(reply.id, "She opened the door slowly, hesitating.");

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(409);
		expect(((await response.json()) as ErrorWire).error.message).toContain("content changed");
		// The proposal stays pending (a failed apply resolves nothing) and the
		// newer text stands.
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
		expect((await stores.messages.getMessageById(reply.id))?.content).toBe("She opened the door slowly, hesitating.");
	});

	test("a moved selection refuses the apply (the guard names the selected source) and writes nothing", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["first swipe", "second swipe"], 0);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_moved", reply, v0!),
		);
		// The user swiped to the sibling between proposal and Accept.
		await stores.messages.selectVariant(reply.id, 1);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(409);
		expect(((await response.json()) as ErrorWire).error.message).toContain("variant changed");
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
		const after = await stores.messages.getVariants(reply.id);
		expect(after[0]?.content).toBe("first swipe");
		expect(after[1]?.content).toBe("second swipe");
	});

	test("a deleted target refuses the apply with 404 — the proposal never resurrects or redirects", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["Doomed reply."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_deleted", reply, v0!),
		);
		await stores.messages.deleteMessage(reply.id);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(404);
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
	});

	test("a target from ANOTHER chat refuses the apply with 404 — the frozen identity never retargets", async () => {
		const chat = await newPlainChat();
		const ownReply = await addReply(chat, ["Own reply."]);
		const foreignChat = await newPlainChat();
		const foreignReply = await addReply(foreignChat, ["Foreign reply."]);
		const [foreignVariant] = await replyVariants(foreignReply);
		// The proposal row lives in the OWN thread but names the FOREIGN chat's
		// message identity (a hand-corrupted or reused row): the thread-branch
		// ownership check refuses before any write.
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_foreign", foreignReply, foreignVariant!),
		);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(404);
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
		// The foreign message's bytes were never touched; the own reply is
		// untouched too (never a fallback to a different source).
		const foreignAfter = await stores.messages.getVariants(foreignReply.id);
		expect(foreignAfter[0]?.content).toBe("Foreign reply.");
		expect((await stores.messages.getVariants(ownReply.id))[0]?.content).toBe("Own reply.");
	});

	test("two racing applies of ONE proposal serialize: one 200, one typed 409, exactly one edit", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["She opened the door slowly."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_race", reply, v0!),
		);

		const [a, b] = await Promise.all([post(applyUrl(threadId, toolCallId)), post(applyUrl(threadId, toolCallId))]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		const conflictBody = (await (a.status === 409 ? a : b).json()) as ErrorWire;
		expect(conflictBody.error.details?.code).toBe("objective_proposal_already_resolved");
		const after = await stores.messages.getVariants(reply.id);
		expect(after[0]?.content).toBe(EDIT_CANDIDATE);
	});

	test("two proposals for the SAME source resolve sequentially: the second apply hits the stale-base 409, never an overwrite", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["She opened the door slowly."]);
		const [v0] = await replyVariants(reply);
		// Two tabs, two pending rows, one frozen source identity.
		const first = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_tab1", reply, v0!),
		);
		const second = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_tab2", reply, v0!),
		);

		const firstApply = await post(applyUrl(first.threadId, first.toolCallId));
		expect(firstApply.status).toBe(200);

		// The second tab's apply addresses a PENDING row (no already-resolved
		// refusal possible) — the base-content guard inside the store
		// transaction is what refuses it.
		const secondApply = await post(applyUrl(second.threadId, second.toolCallId));
		expect(secondApply.status).toBe(409);
		expect(((await secondApply.json()) as ErrorWire).error.message).toContain("content changed");
		expect(await rowStatus(second.threadId, second.toolCallId)).toBe("pending");
		// Exactly the first tab's candidate stands.
		const after = await stores.messages.getVariants(reply.id);
		expect(after[0]?.content).toBe(EDIT_CANDIDATE);
	});

	test("corrupt payloads (missing candidate / foreign toolName) are the parse-gate 404 — nothing written", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["She opened the door slowly."]);
		const [v0] = await replyVariants(reply);
		const broken = makeEditProposal("tc_edit_bad", reply, v0!);
		delete (broken.payload as Record<string, unknown>).candidate;
		const brokenSeed = await seedRecordProposal(chat, DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit, broken);
		const brokenApply = await post(applyUrl(brokenSeed.threadId, brokenSeed.toolCallId));
		expect(brokenApply.status).toBe(404);
		expect(await rowStatus(brokenSeed.threadId, brokenSeed.toolCallId)).toBe("pending");
		expect((await stores.messages.getVariants(reply.id))[0]?.content).toBe("She opened the door slowly.");

		// A well-formed message-edit payload under ANOTHER tool's name — the
		// toolName gate refuses before the recordType dispatch could apply it.
		const mismatched = await seedRecordProposal(
			chat,
			SIDECHAT_OBJECTIVE_TOOL_NAME,
			makeEditProposal("tc_edit_mismatch", reply, v0!),
		);
		const mismatchedApply = await post(applyUrl(mismatched.threadId, mismatched.toolCallId));
		expect(mismatchedApply.status).toBe(404);
		expect(await rowStatus(mismatched.threadId, mismatched.toolCallId)).toBe("pending");
	});

	test("reject changes ONLY the status — no message companion, the reply bytes untouched", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["She opened the door slowly."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_rej", reply, v0!),
		);

		const response = await post(rejectUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { proposal: RecordProposal; message?: unknown };
		expect(body.proposal.status).toBe("rejected");
		expect(body.message).toBeUndefined();
		const after = await stores.messages.getVariants(reply.id);
		expect(after[0]?.content).toBe("She opened the door slowly.");
		expect(after[0]?.isSelected).toBeTrue();
	});
});

describe("message-variant apply (Save) — the ordinary add-variant path through the registry (DMT-22)", () => {
	test("save appends and selects a separate swipe, leaves every source byte intact, records no RP provenance, attaches no trace", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["Original reply."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
			makeVariantProposal("tc_var_ok", reply, [v0!], VARIANT_SAVE_TEXT),
		);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			proposal: RecordProposal;
			message?: {
				chatId: string;
				branchId: string;
				message: { id: string; content: string };
				variants: Array<{ id: string; content: string; isSelected: boolean; modelId: string | null; presetName: string | null }>;
			};
		};
		expect(body.proposal.status).toBe("applied");
		expect(body.message?.chatId).toBe(chat.id);
		expect(body.message?.branchId).toBe(chat.activeBranchId);

		// The appended swipe: content verbatim, selected, and NO model/preset
		// provenance — Director authorship, never an RP-model or preset claim.
		const after = await stores.messages.getVariants(reply.id);
		expect(after).toHaveLength(2);
		expect(after[0]).toMatchObject({ id: v0!.id, content: "Original reply.", isSelected: false });
		expect(after[1]).toMatchObject({
			content: VARIANT_SAVE_TEXT,
			isSelected: true,
			modelId: null,
			presetName: null,
			finishReason: null,
		});
		// The message row mirrors the newly selected swipe.
		expect((await stores.messages.getMessageById(reply.id))?.content).toBe(VARIANT_SAVE_TEXT);
		// The companion carries the FULL post-save variant list.
		expect(body.message?.variants).toHaveLength(2);
		expect(body.message?.variants[1]).toMatchObject({
			content: VARIANT_SAVE_TEXT,
			isSelected: true,
			modelId: null,
			presetName: null,
		});
		// No prompt trace of any kind was attached to the chat by the save
		// (the add-variant service path never touches pending RP traces).
		expect(await stores.traces.listTraceIds({ chatId: chat.id })).toEqual([]);
	});

	test("a save whose source swipe was deleted refuses with 404 and appends nothing", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["first source", "second source"]);
		const variants = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
			makeVariantProposal("tc_var_missing", reply, variants, VARIANT_SAVE_TEXT),
		);
		// One frozen source swipe is deleted before Accept.
		await stores.messages.deleteVariant(reply.id, 0);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(404);
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
		// Nothing appended by the failed save — the surviving swipe count is
		// the post-delete state's.
		expect(await stores.messages.getVariants(reply.id)).toHaveLength(1);
	});

	test("a save whose target message was deleted refuses with 404", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["Doomed reply."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
			makeVariantProposal("tc_var_deleted", reply, [v0!], VARIANT_SAVE_TEXT),
		);
		await stores.messages.deleteMessage(reply.id);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(404);
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
	});

	test("a save targeting another chat's message refuses with 404 — the thread branch owns the resolution", async () => {
		const chat = await newPlainChat();
		const ownReply = await addReply(chat, ["Own reply."]);
		const foreignChat = await newPlainChat();
		const foreignReply = await addReply(foreignChat, ["Foreign reply."]);
		const [foreignVariant] = await replyVariants(foreignReply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
			makeVariantProposal("tc_var_foreign", foreignReply, [foreignVariant!], VARIANT_SAVE_TEXT),
		);

		const response = await post(applyUrl(threadId, toolCallId));
		expect(response.status).toBe(404);
		expect(await rowStatus(threadId, toolCallId)).toBe("pending");
		const foreignAfter = await stores.messages.getVariants(foreignReply.id);
		expect(foreignAfter).toHaveLength(1);
		expect(foreignAfter[0]?.content).toBe("Foreign reply.");
		expect((await stores.messages.getVariants(ownReply.id))[0]?.content).toBe("Own reply.");
	});

	test("double apply of the same save is the already-resolved 409 with exactly one appended swipe", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["Original reply."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
			makeVariantProposal("tc_var_twice", reply, [v0!], VARIANT_SAVE_TEXT),
		);
		expect((await post(applyUrl(threadId, toolCallId))).status).toBe(200);

		const second = await post(applyUrl(threadId, toolCallId));
		expect(second.status).toBe(409);
		expect(((await second.json()) as ErrorWire).error.details?.code).toBe("objective_proposal_already_resolved");
		expect(await stores.messages.getVariants(reply.id)).toHaveLength(2);
	});

	test("reject changes ONLY the status — the swipe count is unchanged", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["Original reply."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
			makeVariantProposal("tc_var_rej", reply, [v0!], VARIANT_SAVE_TEXT),
		);

		const response = await post(rejectUrl(threadId, toolCallId));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { proposal: RecordProposal; message?: unknown };
		expect(body.proposal.status).toBe("rejected");
		expect(body.message).toBeUndefined();
		const after = await stores.messages.getVariants(reply.id);
		expect(after).toHaveLength(1);
		expect(after[0]?.content).toBe("Original reply.");
	});

	test("the resolved status survives a reload for the message types — the wire row parses back applied", async () => {
		const chat = await newPlainChat();
		const reply = await addReply(chat, ["She opened the door slowly."]);
		const [v0] = await replyVariants(reply);
		const { threadId, toolCallId } = await seedRecordProposal(
			chat,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			makeEditProposal("tc_edit_reload", reply, v0!),
		);
		await post(applyUrl(threadId, toolCallId));

		// The reload path SC-13/DMT-32 reads: the row keeps its parseable
		// `{ toolName, output }` wrapper with the final status.
		const messages = await copilotWire.experienceCopilotListMessages(threadId);
		const row = messages.find((message) => message.toolCallId === toolCallId);
		const parsed = JSON.parse(row!.content as string) as { toolName: string; output: RecordProposal };
		expect(parsed.toolName).toBe(DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit);
		expect(parsed.output.status).toBe("applied");
	});
});

/**
 * IR-43 (Wave 4): experience model-effect service tests.
 *
 * Full-path through the REAL DB + REAL session lifecycle + REAL VM (the test
 * experiences emit `kind: "model"` effects from `reduce`, exactly as a real
 * package does). The provider execution + active-profile resolution are injected
 * seams — the provider CALL is ChatSummaryService's boundary (tested there), so
 * here we pin the durable failure/retry semantics, the acceptance (stale
 * completion), the prompt layering, and executor-boundary injection.
 *
 * Pins (per the plan self-check): cancellation (cancelled, no feed-back), stale
 * completion (succeeded effect but session keeps newer state — the IR-22 rule),
 * no-provider / no-model (failed with reason), invalid output (action + text),
 * per-model settings (overlay reaches the call), executor-boundary injection,
 * exact prompt order + model-view isolation, and idempotent re-run.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, experienceSessions, type StoreContainer } from "@vibe-tavern/db";
import type { AssemblePromptResponse, ChatBranchId, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderModelSettingsRecord } from "@vibe-tavern/api-contracts";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import {
	ExperienceContextService,
	type ExperienceChatLifecycleSeam,
} from "../src/domain/interactive/experience-context-service.js";
import { ExperienceModelEffectService } from "../src/domain/interactive/experience-model-effect-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { ExperienceEffectRow } from "@vibe-tavern/db";

// ─── Test experiences ────────────────────────────────────────────────────────

/** Messenger-style: the human's "say" asks the model seat for an in-character reply. */
const TEXT_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "msg", name: "Messenger" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { log: [] }; },
  project(c) { return { log: c.state.log }; },
  actions() { return [{ type: "say", label: "Say", allowsText: true }]; },
  reduce(c, a) {
    if (a.type === "say") {
      const isModel = a.participantId === "model";
      const next = { log: [...c.state.log, { who: a.participantId, text: a.payload?.text ?? "" }] };
      if (isModel) return { state: next, status: "active", events: [] };
      return {
        state: next, status: "active", events: [],
        effects: [{ kind: "model", request: { viewer: "model", mode: "text", actionType: "say", instruction: "Reply in character." } }],
      };
    }
    return { state: c.state, status: "active", events: [] };
  },
});
`;

/** Game-style: the human's "play" asks the model seat to choose a legal action. */
const COMPLETING_TEXT_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "complete-msg", name: "Completing Messenger" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { log: [] }; },
  project(c) { return { log: c.state.log }; },
  actions() { return [{ type: "say", label: "Say", allowsText: true }]; },
  reduce(c, a) {
    const next = { log: [...c.state.log, { who: a.participantId, text: a.payload?.text ?? "" }] };
    if (a.participantId === "model") return { state: next, status: "completed", events: [{ visibility: "public", type: "model_finished" }] };
    return {
      state: next, status: "active", events: [],
      effects: [{ kind: "model", request: { viewer: "model", mode: "text", actionType: "say", instruction: "Reply in character." } }],
    };
  },
});
`;

const ACTION_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "game", name: "Model Game" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { round: 0, moves: [] }; },
  project(c) { return { round: c.state.round }; },
  actions() { return [{ type: "play", label: "Play" }, { type: "pass", label: "Pass" }]; },
  reduce(c, a) {
    const isModel = a.participantId === "model";
    const next = { round: c.state.round + 1, moves: [...c.state.moves, { who: a.participantId, move: a.type }] };
    if (isModel) return { state: next, status: "active", events: [] };
    return {
      state: next, status: "active", events: [],
      effects: [{ kind: "model", request: { viewer: "model", mode: "action" } }],
    };
  },
});
`;

/** Action-mode game whose `play` action declares a payloadSchema (fix step 1b). */
const SCHEMA_ACTION_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "schema-game", name: "Schema Game" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { round: 0, moves: [] }; },
  project(c) { return { round: c.state.round }; },
  actions() {
    return [
      { type: "go", label: "Go" },
      { type: "play", label: "Play", payloadSchema: { type: "object", properties: { card: { type: "integer" } }, required: ["card"], additionalProperties: false } },
      { type: "pass", label: "Pass" },
    ];
  },
  reduce(c, a) {
    const isModel = a.participantId === "model";
    const next = { round: c.state.round + 1, moves: [...c.state.moves, { who: a.participantId, move: a.type }] };
    if (isModel) return { state: next, status: "active", events: [] };
    return {
      state: next, status: "active", events: [],
      effects: [{ kind: "model", request: { viewer: "model", mode: "action" } }],
    };
  },
});
`;

const GRANTS = ["participants", "model"];
const PARTICIPANTS = [
	{ id: "human", label: "You", controller: "human" as const },
	{ id: "model", label: "AI", controller: "model" as const, providerProfileId: "pp1", modelId: "test-model" },
];

/** A two-model-seat experience: the human's "ask" emits two effects (one per seat). */
const TWO_MODEL_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "two-model", name: "Two Model" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { log: [] }; },
  project(c) { return { log: c.state.log }; },
  actions() { return [{ type: "ask", label: "Ask both", allowsText: true }]; },
  reduce(c, a) {
    if (a.type === "ask" && a.participantId !== "alice" && a.participantId !== "bob") {
      return {
        state: c.state, status: "active", events: [],
        effects: [
          { kind: "model", request: { viewer: "alice", mode: "text", actionType: "say", instruction: "Alice replies." } },
          { kind: "model", request: { viewer: "bob", mode: "text", actionType: "say", instruction: "Bob replies." } },
        ],
      };
    }
    return { state: { log: [...c.state.log, { who: a.participantId, text: a.payload?.text ?? "" }] }, status: "active", events: [] };
  },
});
`;

const TWO_MODEL_PARTICIPANTS = [
	{ id: "human", label: "You", controller: "human" as const },
	{ id: "alice", label: "Alice", controller: "model" as const, providerProfileId: "pp_alice", modelId: "model-a" },
	{ id: "bob", label: "Bob", controller: "model" as const, providerProfileId: "pp_bob", modelId: "model-b" },
];

// ─── Setup ───────────────────────────────────────────────────────────────────

let stores: StoreContainer;
let resources: ExperienceResourceService;
let experienceService: ExperienceService;

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-xmeff-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	resources = new ExperienceResourceService(stores);
	experienceService = new ExperienceService(stores, resources, { generateSeed: () => "seed" });
	return stores;
}

async function seedSession(source: string, participants = PARTICIPANTS) {
	const character = await stores.characters.create({ name: "Aria", description: "Mage." } as never);
	const chat = await stores.chats.createChat({ characterId: character.id, title: "T" } as never);
	const branchId = chat.activeBranchId as string;
	await stores.personas.create({ name: "Olya", description: "Scholar.", defaultForNewChats: true } as never);
	const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source } as never);
	await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: GRANTS as never } as never);
	const started = await experienceService.startSession({ chatId: chat.id, branchId, settings: {}, participants });
	if (!started.ok) throw new Error(`startSession failed: ${started.error.code}`);
	return { chatId: chat.id, branchId, sessionId: started.data.sessionId };
}

/** Seed a two-model-seat session (IR-70E) using TWO_MODEL_PARTICIPANTS. */
async function seedTwoModelSession() {
	return seedSession(TWO_MODEL_SOURCE, TWO_MODEL_PARTICIPANTS);
}

/** Map pending model-effect ids by their request viewer (participantId). */
async function pendingEffectsByViewer(sessionId: string): Promise<Record<string, string>> {
	const effects = await stores.experiences.getEffectsForSession(sessionId);
	const byViewer: Record<string, string> = {};
	for (const e of effects) {
		if (e.status !== "pending") continue;
		const parsed = JSON.parse(e.requestJson) as { request?: { viewer?: string } };
		const viewer = parsed.request?.viewer;
		if (typeof viewer === "string") byViewer[viewer] = e.id;
	}
	return byViewer;
}

/** Submit the human's opening move, which emits exactly one pending model effect. */
async function emitModelEffect(sessionId: string, actionType: string): Promise<string> {
	const session = await stores.experiences.getSessionById(sessionId);
	const res = await experienceService.submitAction(sessionId, {
		type: actionType,
		requestId: `human-${sessionId}-${session?.revision ?? 0}`,
		expectedRevision: session?.revision ?? 0,
		participantId: "human",
		payload: { text: "hello" },
	});
	if (!res.ok) throw new Error(`submitAction failed: ${res.error.code}`);
	const effects = await stores.experiences.getEffectsForSession(sessionId);
	const pending = effects.filter((e) => e.status === "pending");
	if (pending.length !== 1) throw new Error(`expected 1 pending effect, got ${pending.length}`);
	return pending[0].id;
}

// ─── Mock seams ──────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
	return {
		id: "pp1", name: "Test", providerPreset: "ollama", coauthorTransport: "openai" as never,
		endpoint: "http://x", apiKey: null, defaultModel: "test-model", contextBudget: 8000,
		pinContextBudget: false, bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false,
		maxTokens: 4096, temperature: 1, topP: 1, topK: 0, minP: 0, topA: 0, typicalP: 1, tfsZ: 1,
		repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1, dryMultiplier: 0, dryBase: 0,
		dryAllowedLength: 0, drySequenceBreakers: [], xtcThreshold: 0, xtcProbability: 0,
		frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1, stopSequences: [], logitBias: [],
		seed: null, reasoningEffort: "medium", showReasoning: false, streamResponse: true,
		customSamplers: false, proxyMode: "off" as never, proxyId: null, isActive: true, visionModel: null,
		createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
		...overrides,
	};
}

function minimalPrompt(): AssemblePromptResponse {
	return { layers: [], tokenAccounting: {}, activatedLoreEntries: [], scriptInjections: [], retrievedMemories: [], finalPayload: { messages: [] }, prefill: null };
}

interface ExecuteSpy {
	calls: Array<{ profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse }>;
}

function makeServices(opts: {
	profile?: StoredProviderProfileRecord | null;
	profiles?: StoredProviderProfileRecord[];
	modelSettings?: ProviderModelSettingsRecord | null;
	executeReturn?: (spy: ExecuteSpy) => Promise<{ text: string }> | Promise<{ text: string }>;
} = {}) {
	const profile = opts.profile === undefined ? makeProfile() : opts.profile;
	const profiles = opts.profiles ?? (profile ? [profile] : []);
	const providerProfiles: Pick<ProviderProfileService, "resolveActiveProviderProfile" | "getProviderProfile" | "getProviderModelSettings"> = {
		resolveActiveProviderProfile: async () => profile,
		getProviderProfile: async (id: string) => profiles.find((candidate) => candidate.id === id) ?? null,
		getProviderModelSettings: async (providerProfileId: string, modelId: string) => {
			const settings = opts.modelSettings;
			return settings?.providerProfileId === providerProfileId && settings.modelId === modelId ? settings : null;
		},
	};
	const chatLifecycle: ExperienceChatLifecycleSeam = {
		assembleSummaryPrompt: async () => ({ prompt: minimalPrompt(), branchId: "b" as ChatBranchId }),
	};
	const contextService = new ExperienceContextService({
		stores,
		providerProfiles: providerProfiles as ProviderProfileService,
		chatLifecycle,
		execute: (async () => ({ text: "" })) as never,
	});
	const spy: ExecuteSpy = { calls: [] };
	const execute = async (input: { profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse; signal?: AbortSignal }) => {
		spy.calls.push({ profile: input.profile, model: input.model, prompt: input.prompt });
		const ret = opts.executeReturn;
		if (typeof ret === "function") {
			const r = (ret as (s: ExecuteSpy) => Promise<{ text: string }>)(spy);
			return await r;
		}
		return ret ?? { text: "A model reply." };
	};
	const modelEffectService = new ExperienceModelEffectService({
		stores,
		experienceService,
		contextService,
		providerProfiles: providerProfiles as ProviderProfileService,
		execute: execute as never,
	});
	return { modelEffectService, contextService, spy, providerProfiles };
}

// ─── Tests: success paths ────────────────────────────────────────────────────

describe("ExperienceModelEffectService — resolution + feed-back", () => {
	test("a model effect reducer completion waits for explicit report finalization", async () => {
		await setup();
		const { sessionId, branchId } = await seedSession(COMPLETING_TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: "Farewell." }) });

		const result = await modelEffectService.runEffect(effectId);
		expect(result.ok && result.data.delivered).toBe(true);
		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.status).toBe("completed");
		expect(session?.activeSlot).toBe(0);
		expect(session?.reportFrontier).toBe(0);
		expect((await stores.experiences.getActiveSessionForBranch(branchId))?.id).toBe(sessionId);
		const frozen = await stores.experiences.getQueuedAttachmentForSession(sessionId);
		expect(frozen?.queueRevision).toBe(1);
		expect(JSON.parse(frozen?.publicEventsJson ?? "{}").events.map((event: { type: string }) => event.type)).toEqual(["experience_started"]);
		const status = await experienceService.getReportStatus(sessionId);
		expect(status.ok && status.data.pendingPublicEventCount).toBe(1);
		const queued = await experienceService.finishWithReport(sessionId, 2);
		expect(queued.ok && queued.data?.queueRevision).toBe(2);
		expect(queued.ok && queued.data?.publicReport?.events.map((event) => event.type)).toEqual(["experience_started", "model_finished"]);
		const finalized = await stores.experiences.getSessionById(sessionId);
		expect(finalized?.status).toBe("completed");
		expect(finalized?.activeSlot).toBeNull();
		expect(finalized?.revision).toBe(2);
	});

	test("text mode: model reply completes, feeds back, session advances", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: "Greetings, traveler." }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.status).toBe("succeeded");
		expect(result.data.result).toEqual({ mode: "text", text: "Greetings, traveler." });
		expect(result.data.delivered).toBe(true);
		expect(result.data.projection).toBeDefined();
		// The effect row is terminal succeeded.
		const effect = await stores.experiences.getEffectById(effectId);
		expect(effect?.status).toBe("succeeded");
		// The feed-back advanced the session + stored the model's reply.
		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.revision).toBe(2); // 1 (human say) + 1 (model feed-back)
		const state = JSON.parse(session?.currentStateJson ?? "{}");
		expect(state.log).toHaveLength(2);
		expect(state.log[1]).toEqual({ who: "model", text: "Greetings, traveler." });
	});

	test("action mode: model picks a legal action, validated + fed back", async () => {
		await setup();
		const { sessionId } = await seedSession(ACTION_SOURCE);
		const effectId = await emitModelEffect(sessionId, "play");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: '{"actionId":"play","args":{"card":1}}' }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.status).toBe("succeeded");
		expect(result.data.result).toEqual({ mode: "action", actionId: "play", args: { card: 1 } });
		expect(result.data.delivered).toBe(true);
		// Bare legal action type is also accepted.
		const effectId2 = await emitModelEffectAfterAdvance(sessionId, "play");
		const svc2 = makeServices({ executeReturn: async () => ({ text: "pass" }) });
		const result2 = await svc2.modelEffectService.runEffect(effectId2);
		expect(result2.ok && result2.data.result).toEqual({ mode: "action", actionId: "pass" });
	});

	test("executor-boundary injection: execute receives the effective profile + an AssemblePromptResponse prompt", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService, spy } = makeServices({ executeReturn: async () => ({ text: "Hi." }) });

		await modelEffectService.runEffect(effectId);

		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0].profile.id).toBe("pp1");
		expect(spy.calls[0].model).toBe("test-model");
		// The prompt is a normal AssemblePromptResponse (the executor reads finalPayload.messages).
		expect(Array.isArray(spy.calls[0].prompt.layers)).toBe(true);
		expect(spy.calls[0].prompt.finalPayload.messages).toBeDefined();
	});
});

// ─── Tests: interruption + failure ───────────────────────────────────────────

describe("ExperienceModelEffectService — durable failure / cancellation", () => {
	test("cancel: an aborted signal persists cancelled, no feed-back", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const revBefore = (await stores.experiences.getSessionById(sessionId))!.revision;
		const { modelEffectService } = makeServices({
			executeReturn: async () => { throw new Error("aborted by client"); },
		});

		const controller = new AbortController();
		controller.abort();
		const result = await modelEffectService.runEffect(effectId, controller.signal);

		expect(result.ok && result.data.status).toBe("cancelled");
		const effect = await stores.experiences.getEffectById(effectId);
		expect(effect?.status).toBe("cancelled");
		// No feed-back: session revision unchanged.
		const revAfter = (await stores.experiences.getSessionById(sessionId))!.revision;
		expect(revAfter).toBe(revBefore);
	});

	test("executor failure: a thrown error persists failed with the message", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService } = makeServices({
			executeReturn: async () => { throw new Error("rate limited"); },
		});

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("rate limited");
		const effect = await stores.experiences.getEffectById(effectId);
		expect(effect?.status).toBe("failed");
		expect(effect?.error).toBe("rate limited");
	});

	test("no-provider: unresolvable active profile persists failed (no_provider)", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService, spy } = makeServices({ profile: null });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("no_provider");
		expect(spy.calls).toHaveLength(0); // never called the provider
		expect((await stores.experiences.getEffectById(effectId))?.status).toBe("failed");
	});

	test("no-model: a legacy participant with no active-profile defaultModel persists failed (no_model)", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		// Simulate a legacy persisted participant (neither pinned field) so the
		// active-profile default model is consulted (the pre-IR-70E fallback).
		await rewriteModelParticipant(sessionId, (p) => { delete p.providerProfileId; delete p.modelId; });
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService } = makeServices({ profile: makeProfile({ defaultModel: null }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("no_model");
	});

	test("invalid output (action mode): an illegal actionId persists failed (invalid_output)", async () => {
		await setup();
		const { sessionId } = await seedSession(ACTION_SOURCE);
		const effectId = await emitModelEffect(sessionId, "play");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: '{"actionId":"cheat"}' }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("invalid_output");
		// A malformed JSON is also invalid.
		const effectId2 = await emitModelEffectAfterAdvance(sessionId, "play");
		const svc2 = makeServices({ executeReturn: async () => ({ text: "not json and not a legal type" }) });
		const r2 = await svc2.modelEffectService.runEffect(effectId2);
		expect(r2.ok && r2.data.error).toBe("invalid_output");
	});

	test("invalid output (text mode): empty output persists failed (invalid_output)", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: "   " }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("invalid_output");
	});

	test("idempotent re-run: a terminal effect returns its status without calling execute again", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService, spy } = makeServices({ executeReturn: async () => ({ text: "reply" }) });
		await modelEffectService.runEffect(effectId);
		expect(spy.calls).toHaveLength(1);

		const again = await modelEffectService.runEffect(effectId);

		expect(again.ok && again.data.status).toBe("succeeded");
		expect(spy.calls).toHaveLength(1); // NOT re-run
	});
});

// ─── Tests: stale completion (IR-22 invariant) ───────────────────────────────

describe("ExperienceModelEffectService — stale completion never overwrites", () => {
	test("a completion whose session advanced delivers false; effect stays succeeded", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		// The execute mock simulates a DELAYED completion racing with another
		// action: while the model "thinks", another turn advances the session
		// past the effect's originatingRevision.
		const { modelEffectService } = makeServices({
			executeReturn: async () => {
				// Race: a concurrent action lands at the originating revision.
				const advanced = await experienceService.submitAction(sessionId, {
					type: "say",
					requestId: `race-${effectId}`,
					expectedRevision: 1, // the originating revision
					participantId: "human",
					payload: { text: "another" },
				});
				expect(advanced.ok).toBe(true);
				return { text: "delayed reply" };
			},
		});

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.status).toBe("succeeded");
		expect(result.data.result).toEqual({ mode: "text", text: "delayed reply" });
		// The feed-back was REJECTED (stale): session is at 2 (the racing action),
		// NOT 3 (which a successful feed-back would have produced).
		expect(result.data.delivered).toBe(false);
		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.revision).toBe(2);
		// The effect is terminal succeeded but undelivered.
		const effect = await stores.experiences.getEffectById(effectId);
		expect(effect?.status).toBe("succeeded");
		expect(effect?.originatingRevision).toBe(1);
	});
});

// ─── Tests: prompt assembly + per-model settings ─────────────────────────────

describe("ExperienceModelEffectService — prompt layering + model-view isolation", () => {
	test("private view is the FINAL user message; host protocol precedes it", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService, spy } = makeServices({ executeReturn: async () => ({ text: "hi" }) });

		await modelEffectService.runEffect(effectId);

		const prompt = spy.calls[0].prompt;
		const layerIds = prompt.layers.map((l) => l.id);
		// Host protocol before the private view.
		expect(layerIds.indexOf("xp_host_protocol")).toBeLessThan(layerIds.indexOf("xp_private_view"));
		expect(layerIds.indexOf("xp_package_prompt")).toBeLessThan(layerIds.indexOf("xp_private_view"));
		// The private view is the final user message (model-view isolation).
		const messages = prompt.finalPayload.messages as Array<{ role: string; content: string }>;
		const last = messages[messages.length - 1];
		expect(last.role).toBe("user");
		expect(last.content).toContain("[Your projected view]");
	});

	test("prompt overrides layer in: global before character, both before the private view", async () => {
		await setup();
		const { sessionId, chatId } = await seedSession(TEXT_SOURCE);
		const characterId = (await stores.chats.getById(chatId))?.characterId;
		expect(characterId).toBeTruthy();
		await stores.experienceResources.setGlobalOverride("Global experience instruction.");
		await stores.experienceResources.setOverrideForCharacter(characterId!, "Character-specific instruction.");
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService, spy } = makeServices({ executeReturn: async () => ({ text: "hi" }) });

		await modelEffectService.runEffect(effectId);

		const layerIds = spy.calls[0].prompt.layers.map((l) => l.id);
		expect(layerIds).toContain("xp_global_override");
		expect(layerIds).toContain("xp_character_override");
		expect(layerIds.indexOf("xp_global_override")).toBeLessThan(layerIds.indexOf("xp_character_override"));
		expect(layerIds.indexOf("xp_character_override")).toBeLessThan(layerIds.indexOf("xp_private_view"));
	});

	test("per-model settings: a bound model's overlay reaches the execute call", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const boundProfile = makeProfile({ bindPerModel: true });
		const providerProfiles = {
			resolveActiveProviderProfile: async () => boundProfile,
			getProviderProfile: async (id: string) => (id === boundProfile.id ? boundProfile : null),
			getProviderModelSettings: async () => ({ settings: { contextBudget: 4096, temperature: 0.3 } } as never),
		};
		const contextService = new ExperienceContextService({
			stores, providerProfiles: providerProfiles as ProviderProfileService,
			chatLifecycle: { assembleSummaryPrompt: async () => ({ prompt: minimalPrompt(), branchId: "b" as ChatBranchId }) },
			execute: (async () => ({ text: "" })) as never,
		});
		const spy: ExecuteSpy = { calls: [] };
		const modelEffectService = new ExperienceModelEffectService({
			stores, experienceService, contextService,
			providerProfiles: providerProfiles as ProviderProfileService,
			execute: (async (input: { profile: StoredProviderProfileRecord }) => {
				spy.calls.push({ profile: input.profile, model: "test-model", prompt: minimalPrompt() });
				return { text: "hi" };
			}) as never,
		});

		await modelEffectService.runEffect(effectId);

		// The overlay merged over the base: contextBudget overridden to 4096.
		expect(spy.calls[0].profile.contextBudget).toBe(4096);
		expect(spy.calls[0].profile.temperature).toBe(0.3);
	});
});

// ─── Tests: pinned seat binding (IR-70E) ─────────────────────────────────────

describe("ExperienceModelEffectService — pinned seat binding (IR-70E)", () => {
	test("two model seats with different pinned provider/model pairs call executor with the exact pair selected by effect viewer", async () => {
		await setup();
		const { sessionId } = await seedTwoModelSession();
		// Emit two effects (one per model seat) via the human's opening move.
		const session = await stores.experiences.getSessionById(sessionId);
		await experienceService.submitAction(sessionId, {
			type: "ask", requestId: "h1", expectedRevision: session?.revision ?? 0,
			participantId: "human", payload: { text: "hello" },
		});
		const byViewer = await pendingEffectsByViewer(sessionId);
		expect(Object.keys(byViewer).sort()).toEqual(["alice", "bob"]);

		const profileAlice = makeProfile({ id: "pp_alice", name: "Alice", defaultModel: "alice-default" });
		const profileBob = makeProfile({ id: "pp_bob", name: "Bob", defaultModel: "bob-default" });
		const activeProfile = makeProfile({ id: "pp_active", defaultModel: "active-default" });
		const { modelEffectService, spy } = makeServices({
			profile: activeProfile,
			profiles: [profileAlice, profileBob],
			executeReturn: async () => ({ text: "reply" }),
		});

		await modelEffectService.runEffect(byViewer.alice!);
		expect(spy.calls[0]!.profile.id).toBe("pp_alice");
		expect(spy.calls[0]!.model).toBe("model-a");

		await modelEffectService.runEffect(byViewer.bob!);
		expect(spy.calls[1]!.profile.id).toBe("pp_bob");
		expect(spy.calls[1]!.model).toBe("model-b");
	});

	test("pinned selection ignores a different active provider/default model", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		// The active profile is deliberately different from the pinned one.
		const activeProfile = makeProfile({ id: "pp_active", defaultModel: "active-default" });
		const pinnedProfile = makeProfile({ id: "pp1", defaultModel: "pinned-default" });
		const { modelEffectService, spy } = makeServices({
			profile: activeProfile,
			profiles: [pinnedProfile],
			executeReturn: async () => ({ text: "reply" }),
		});

		await modelEffectService.runEffect(effectId);

		// The executor received the PINNED provider + model, not the active one.
		expect(spy.calls[0]!.profile.id).toBe("pp1");
		expect(spy.calls[0]!.model).toBe("test-model");
	});

	test("pinned model's settings overlay reaches the executor", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		const pinnedProfile = makeProfile({ id: "pp1", bindPerModel: true });
		const activeProfile = makeProfile({ id: "pp_other", defaultModel: "other" });
		const modelSettings: ProviderModelSettingsRecord = {
			id: "pms_1",
			providerProfileId: "pp1",
			modelId: "test-model",
			settings: { contextBudget: 2048, temperature: 0.7 },
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
		};
		const { modelEffectService, spy } = makeServices({
			profile: activeProfile,
			profiles: [pinnedProfile],
			modelSettings,
			executeReturn: async () => ({ text: "reply" }),
		});

		await modelEffectService.runEffect(effectId);

		// The overlay for the PINNED model reached the executor.
		expect(spy.calls[0]!.profile.contextBudget).toBe(2048);
		expect(spy.calls[0]!.profile.temperature).toBe(0.7);
	});

	test("missing pinned provider (active exists) → durable failed/no_provider/no executor", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		const effectId = await emitModelEffect(sessionId, "say");
		// The active profile EXISTS, but the pinned provider does not.
		const { modelEffectService, spy } = makeServices({
			profile: makeProfile({ id: "pp_active", defaultModel: "active-default" }),
			executeReturn: async () => ({ text: "should not reach" }),
		});

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("no_provider");
		expect(spy.calls).toHaveLength(0);
		expect((await stores.experiences.getEffectById(effectId))?.status).toBe("failed");
	});

	test("malformed one-field historical seat → durable failed/no_model/no fallback/no executor", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		// Simulate a malformed historical participant: keep providerProfileId,
		// drop modelId (exactly one field present).
		await rewriteModelParticipant(sessionId, (p) => { delete p.modelId; });
		const effectId = await emitModelEffect(sessionId, "say");
		// The active profile + default model exist, but the malformed seat must
		// NOT fall back to them.
		const { modelEffectService, spy } = makeServices({
			executeReturn: async () => ({ text: "should not reach" }),
		});

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("no_model");
		expect(spy.calls).toHaveLength(0);
		expect((await stores.experiences.getEffectById(effectId))?.status).toBe("failed");
	});

	test("malformed historical seat with a blank pinned model is no_model, not legacy fallback", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		// Both fields exist, but a blank value is malformed rather than legacy.
		await rewriteModelParticipant(sessionId, (p) => { p.modelId = ""; });
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService, spy } = makeServices({
			executeReturn: async () => ({ text: "should not reach" }),
		});

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("no_model");
		expect(spy.calls).toHaveLength(0);
	});

	test("legacy no-field participant continues active-profile/default-model fallback", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
		// Simulate a legacy participant: strip BOTH pinned fields.
		await rewriteModelParticipant(sessionId, (p) => { delete p.providerProfileId; delete p.modelId; });
		const effectId = await emitModelEffect(sessionId, "say");
		const { modelEffectService, spy } = makeServices({ executeReturn: async () => ({ text: "legacy reply." }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("succeeded");
		expect(result.ok && result.data.result).toEqual({ mode: "text", text: "legacy reply." });
		// The executor was called with the ACTIVE profile + default model.
		expect(spy.calls[0]!.profile.id).toBe("pp1");
		expect(spy.calls[0]!.model).toBe("test-model");
	});
});

// ─── Tests: payloadSchema enforcement on the model path (fix step 1b) ───────

describe("ExperienceModelEffectService — action-mode payloadSchema enforcement", () => {
	test("legal actionId + args satisfying the payloadSchema → succeeds and the mapped action carries args", async () => {
		await setup();
		const { sessionId } = await seedSession(SCHEMA_ACTION_SOURCE);
		const effectId = await emitModelEffect(sessionId, "go");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: '{"actionId":"play","args":{"card":7}}' }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.status).toBe("succeeded");
		expect(result.data.result).toEqual({ mode: "action", actionId: "play", args: { card: 7 } });
		expect(result.data.delivered).toBe(true);
	});

	test("args violating the payloadSchema → failed invalid_payload and no feed-back", async () => {
		await setup();
		const { sessionId } = await seedSession(SCHEMA_ACTION_SOURCE);
		const effectId = await emitModelEffect(sessionId, "go");
		const revBefore = (await stores.experiences.getSessionById(sessionId))!.revision;
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: '{"actionId":"play","args":{"card":1.5}}' }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("invalid_payload");
		expect((await stores.experiences.getEffectById(effectId))?.status).toBe("failed");
		// No feed-back: session revision unchanged.
		expect((await stores.experiences.getSessionById(sessionId))!.revision).toBe(revBefore);
	});

	test("descriptor declares payloadSchema but model omits args → invalid_payload", async () => {
		await setup();
		const { sessionId } = await seedSession(SCHEMA_ACTION_SOURCE);
		const effectId = await emitModelEffect(sessionId, "go");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: '{"actionId":"play"}' }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("invalid_payload");
	});

	test("bare legal action type with a schema-declaring descriptor → invalid_payload (mirrors kernel)", async () => {
		await setup();
		const { sessionId } = await seedSession(SCHEMA_ACTION_SOURCE);
		const effectId = await emitModelEffect(sessionId, "go");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: "play" }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("invalid_payload");
	});

	test("descriptor WITHOUT payloadSchema → args pass through unvalidated (characterization)", async () => {
		await setup();
		const { sessionId } = await seedSession(SCHEMA_ACTION_SOURCE);
		const effectId = await emitModelEffect(sessionId, "go");
		const { modelEffectService } = makeServices({ executeReturn: async () => ({ text: '{"actionId":"pass","args":{"anything":[1,2,3]}}' }) });

		const result = await modelEffectService.runEffect(effectId);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.result).toEqual({ mode: "action", actionId: "pass", args: { anything: [1, 2, 3] } });
	});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Emit a second model effect after a feed-back advanced the session. */
async function emitModelEffectAfterAdvance(sessionId: string, actionType: string): Promise<string> {
	// The prior effect's feed-back already advanced the revision; submit a fresh
	// human action at the current revision to emit a new pending effect.
	return emitModelEffect(sessionId, actionType);
}

/**
 * Rewrite the persisted model participant(s) for a session to simulate a
 * historical/legacy persisted snapshot (IR-70E). Each test uses a fresh DB
 * containing exactly one session; the callback mutates its model participant.
 */
async function rewriteModelParticipant(
	sessionId: string,
	mutate: (p: Record<string, unknown>) => void,
): Promise<void> {
	const session = await stores.experiences.getSessionById(sessionId);
	if (session === null) throw new Error(`session '${sessionId}' not found`);
	const participants = JSON.parse(session.participantsJson) as Array<Record<string, unknown>>;
	for (const p of participants) {
		if (p.controller === "model") mutate(p);
	}
	stores.db.update(experienceSessions).set({ participantsJson: JSON.stringify(participants) }).run();
}

// Keep the imported type referenced for the cast boundaries above.
export type { ExperienceEffectRow };

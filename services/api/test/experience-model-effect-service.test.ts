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

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import type { AssemblePromptResponse, ChatBranchId, StoredProviderProfileRecord } from "@vibe-tavern/domain";

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

const GRANTS = ["participants", "model"];
const PARTICIPANTS = [
	{ id: "human", label: "You", controller: "human" as const },
	{ id: "model", label: "AI", controller: "model" as const },
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

async function seedSession(source: string) {
	const character = await stores.characters.create({ name: "Aria", description: "Mage." } as never);
	const chat = await stores.chats.createChat({ characterId: character.id, title: "T" } as never);
	const branchId = chat.activeBranchId as string;
	await stores.personas.create({ name: "Olya", description: "Scholar.", defaultForNewChats: true } as never);
	const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source } as never);
	await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: GRANTS as never } as never);
	const started = await experienceService.startSession({ chatId: chat.id, branchId, settings: {}, participants: PARTICIPANTS });
	if (!started.ok) throw new Error(`startSession failed: ${started.error.code}`);
	return { chatId: chat.id, branchId, sessionId: started.data.sessionId };
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
	executeReturn?: (spy: ExecuteSpy) => Promise<{ text: string }> | Promise<{ text: string }>;
} = {}) {
	const profile = opts.profile === undefined ? makeProfile() : opts.profile;
	const providerProfiles: Pick<ProviderProfileService, "resolveActiveProviderProfile" | "getProviderProfile" | "getProviderModelSettings"> = {
		resolveActiveProviderProfile: async () => profile,
		getProviderProfile: async (id: string) => (profile?.id === id ? profile : null),
		getProviderModelSettings: async () => null,
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

	test("no-model: a profile without a defaultModel persists failed (no_model)", async () => {
		await setup();
		const { sessionId } = await seedSession(TEXT_SOURCE);
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Emit a second model effect after a feed-back advanced the session. */
async function emitModelEffectAfterAdvance(sessionId: string, actionType: string): Promise<string> {
	// The prior effect's feed-back already advanced the revision; submit a fresh
	// human action at the current revision to emit a new pending effect.
	return emitModelEffect(sessionId, actionType);
}

// Keep the imported type referenced for the cast boundaries above.
export type { ExperienceEffectRow };

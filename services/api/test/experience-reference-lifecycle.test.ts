/**
 * IR-91B — privacy / model continuation / replay / safe-stop.
 *
 * One focused integration suite that pins the four IR-91B proofs through the
 * REAL service + VM + temp-DB path (real `createStoreContainer` SQLite, real
 * node:vm sandbox, real kernel, real ExperienceService / ContextService /
 * ReplayService / ModelEffectService). The ONLY injection seam is the provider
 * `execute` function (a plain stub on `ExperienceModelEffectServiceDeps.execute`
 * + `ProviderProfileService`), exactly as `experience-model-effect-service.test`
 * does. No `mock.module` replaces any service, store, sandbox, kernel, or
 * provider module.
 *
 * Proofs:
 *  - P1 — hidden authoritative state never reaches the projection, legal-action,
 *    public-event, model-effect-request, OR model-prompt surfaces. The model
 *    PROMPT seam (the string the executor receives) is pinned here — IR-91A only
 *    pinned the projection/event/action + effect-request SHAPE.
 *  - P2 — structured (action-mode) model continuation through runEffect +
 *    applyEffectResult drives the game to completion; re-running a terminal
 *    effect never double-applies.
 *  - P3 — action replay reproduces an identical state/event sequence + stable
 *    SHA-256 hash across independent runs; undo is append-only; recalculation
 *    preview is deterministic; a different seed diverges.
 *  - P4 — a thrown executor / aborted signal leaves the session consistent (no
 *    orphaned pending effect, revision unchanged) and an explicit retry
 *    succeeds; run as separately-named tests, never interleaved with the happy
 *    path.
 *
 * Reuses the IR-91A reference fixtures (HIDDEN_STATE / MODEL_STRUCTURED /
 * DETERMINISTIC_RANDOM / COUNTER). Scope is test-only: no production edits.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import {
	EXPERIENCE_CAPABILITY,
	type AssemblePromptResponse,
	type ChatBranchId,
	type ExperienceCapability,
	type ExperienceParticipant,
	type StoredProviderProfileRecord,
} from "@vibe-tavern/domain";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import { ExperienceReplayService } from "../src/domain/interactive/experience-replay-service.js";
import {
	ExperienceContextService,
	type ExperienceChatLifecycleSeam,
} from "../src/domain/interactive/experience-context-service.js";
import { ExperienceModelEffectService } from "../src/domain/interactive/experience-model-effect-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type {
	GenerationResult,
	ProviderExecutionInput,
} from "../src/infrastructure/ai/provider-execution-types.js";

import {
	HIDDEN_STATE_REFERENCE_SOURCE,
	MODEL_STRUCTURED_REFERENCE_SOURCE,
	DETERMINISTIC_RANDOM_REFERENCE_SOURCE,
	COUNTER_REFERENCE_SOURCE,
} from "./fixtures/experience-reference-fixtures.js";

// ─── Deterministic canonicalization + hashing (mirrors IR-91A kernel test) ──

/** Recursively sort object keys so JSON.stringify is stable across runs. */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		return Object.keys(obj)
			.sort()
			.reduce<Record<string, unknown>>((acc, key) => {
				acc[key] = canonicalize(obj[key]);
				return acc;
			}, {});
	}
	return value;
}

/** SHA-256 of the canonicalized value — stable across independent runs. */
function stableHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

// ─── Shared rosters / grants ─────────────────────────────────────────────────

const SECRET = "buried-at-the-old-oak-tree";

const HUMAN_MODEL_ROSTER: ExperienceParticipant[] = [
	{ id: "human", label: "You", controller: "human" },
	{ id: "model", label: "AI", controller: "model", providerProfileId: "pp1", modelId: "test-model" },
];

const HUMAN_MODEL_GRANTS: ExperienceCapability[] = [
	EXPERIENCE_CAPABILITY.participants,
	EXPERIENCE_CAPABILITY.model,
];

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
	stores: StoreContainer;
	resources: ExperienceResourceService;
	service: ExperienceService;
	replay: ExperienceReplayService;
}

async function setup(seed = "ir91b-seed"): Promise<Harness> {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-ir91b-"));
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const resources = new ExperienceResourceService(stores);
	const service = new ExperienceService(stores, resources, { generateSeed: () => seed });
	const replay = new ExperienceReplayService(stores, resources);
	return { stores, resources, service, replay };
}

async function seedAndStart(
	h: Harness,
	source: string,
	grants: ExperienceCapability[],
	roster: ExperienceParticipant[],
): Promise<string> {
	const character = await h.stores.characters.create({ name: "Hero" });
	const chat = await h.stores.chats.createChat({ characterId: character.id, title: "T" });
	const script = await h.stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source });
	await h.resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: grants });
	const started = await h.service.startSession({
		chatId: chat.id,
		branchId: chat.activeBranchId,
		settings: {},
		participants: roster,
	});
	if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
	return started.data.sessionId;
}

/** The single pending effect id for a session (throws if there isn't exactly one). */
async function solePendingEffectId(h: Harness, sid: string): Promise<string> {
	const res = await h.service.getPendingEffects(sid);
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error("getPendingEffects failed");
	expect(res.data).toHaveLength(1);
	return res.data[0]!.id;
}

// ─── Mock seams (the ONLY injection boundary) ────────────────────────────────

function makeProfile(overrides: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
	return {
		id: "pp1",
		name: "Test",
		providerPreset: "ollama",
		coauthorTransport: "chat_completions",
		endpoint: "http://x",
		apiKey: null,
		defaultModel: "test-model",
		contextBudget: 8000,
		pinContextBudget: false,
		bindPerModel: false,
		modelFreeOnly: false,
		modelGroupByOwner: false,
		maxTokens: 4096,
		temperature: 1,
		topP: 1,
		topK: 0,
		minP: 0,
		topA: 0,
		typicalP: 1,
		tfsZ: 1,
		repeatLastN: 0,
		mirostat: 0,
		mirostatTau: 5,
		mirostatEta: 0.1,
		dryMultiplier: 0,
		dryBase: 0,
		dryAllowedLength: 0,
		drySequenceBreakers: [],
		xtcThreshold: 0,
		xtcProbability: 0,
		frequencyPenalty: 0,
		presencePenalty: 0,
		repetitionPenalty: 1,
		stopSequences: [],
		logitBias: [],
		seed: null,
		reasoningEffort: "medium",
		showReasoning: false,
		streamResponse: true,
		customSamplers: false,
		proxyMode: "inherit",
		proxyId: null,
		isActive: true,
		visionModel: null,
		createdAt: "2024-01-01T00:00:00Z",
		updatedAt: "2024-01-01T00:00:00Z",
		...overrides,
	};
}

function minimalPrompt(): AssemblePromptResponse {
	return {
		layers: [],
		tokenAccounting: {},
		activatedLoreEntries: [],
		scriptInjections: [],
		retrievedMemories: [],
		finalPayload: { messages: [] },
		prefill: null,
	};
}

function genResult(text: string): GenerationResult {
	return { text, providerResponse: { mode: "nonstream", steps: [] } };
}

interface ExecuteSpy {
	calls: Array<{ profile: StoredProviderProfileRecord; model: string; prompt: AssemblePromptResponse }>;
}

/**
 * Build a ModelEffectService stack with the `execute` provider-executor seam
 * injected. The prompt captured by the spy is the EXACT assembled prompt the
 * model executor receives (host protocol + overrides + the model seat's private
 * view). Everything else is the real service path.
 */
function makeModelStack(
	h: Harness,
	opts: {
		executeReturn?: string;
		executeThrow?: Error;
		profile?: StoredProviderProfileRecord | null;
	} = {},
): { modelEffectService: ExperienceModelEffectService; spy: ExecuteSpy } {
	const profile = opts.profile === undefined ? makeProfile() : opts.profile;
	const providerProfiles: Pick<
		ProviderProfileService,
		"resolveActiveProviderProfile" | "getProviderProfile" | "getProviderModelSettings"
	> = {
		resolveActiveProviderProfile: async () => profile,
		getProviderProfile: async (id: string) => (profile !== null && id === profile.id ? profile : null),
		getProviderModelSettings: async () => null,
	};
	const chatLifecycle: ExperienceChatLifecycleSeam = {
		assembleSummaryPrompt: async () => ({ prompt: minimalPrompt(), branchId: "b" as ChatBranchId }),
	};
	// The context service's own execute seam is never invoked for a `none` /
	// uncaptured bundle; it still must satisfy the constructor contract.
	const contextExecute = async (_input: ProviderExecutionInput): Promise<GenerationResult> => genResult("");
	const contextService = new ExperienceContextService({
		stores: h.stores,
		providerProfiles: providerProfiles as ProviderProfileService,
		chatLifecycle,
		execute: contextExecute,
	});
	const spy: ExecuteSpy = { calls: [] };
	const execute = async (input: ProviderExecutionInput): Promise<GenerationResult> => {
		spy.calls.push({ profile: input.profile, model: input.model, prompt: input.prompt });
		if (opts.executeThrow) throw opts.executeThrow;
		return genResult(opts.executeReturn ?? "ok");
	};
	const modelEffectService = new ExperienceModelEffectService({
		stores: h.stores,
		experienceService: h.service,
		contextService,
		providerProfiles: providerProfiles as ProviderProfileService,
		execute,
	});
	return { modelEffectService, spy };
}

// ─── Replay fingerprint (deterministic reconstruction) ───────────────────────

/** Stable SHA-256 over the replayed checkpoints + final state + cursor + the
 *  public events emitted by ACTION steps only (the replay engine replays action
 *  steps; system undo steps are host-recorded and excluded so the fingerprint is
 *  stable across an append-only rewind). Stable across independent runs given
 *  the same seed + history; excludes ids/timestamps. */
async function replayFingerprint(h: Harness, sid: string): Promise<string> {
	const r = await h.replay.replaySession(sid);
	if (!r.ok || !r.data.ok) throw new Error("replay did not complete cleanly");
	const steps = await h.stores.experiences.getSteps(sid);
	const events = steps
		.filter((s) => s.kind === "action")
		.slice()
		.sort((a, b) => a.sequence - b.sequence)
		.flatMap((s): unknown[] => {
			try {
				return JSON.parse(s.emittedEventsJson) as unknown[];
			} catch {
				return [];
			}
		});
	return stableHash({
		checkpoints: r.data.checkpoints,
		finalState: r.data.finalState,
		cursor: r.data.cursor,
		events,
	});
}

// =============================================================================
//  THE SUITE
// =============================================================================

describe("IR-91B — privacy / model continuation / replay / safe-stop (real-service path)", () => {
	// ── P1: hidden-state privacy through the model-prompt surface ───────────

	describe("P1 — hidden authoritative state never reaches the model-prompt surface", () => {
		test("the secret is absent from projections, actions, public events, the effect request, and the assembled model prompt", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, HIDDEN_STATE_REFERENCE_SOURCE, HUMAN_MODEL_GRANTS, HUMAN_MODEL_ROSTER);

			// Positive control: the authoritative state holds the secret.
			const session = await h.stores.experiences.getSessionById(sid);
			expect(session?.currentStateJson).toContain(SECRET);

			// Projection seam — every viewer projection excludes the secret.
			const obs = await h.service.getProjectedView(sid, { kind: "observer" });
			expect(obs.ok).toBe(true);
			if (!obs.ok) return;
			expect(JSON.stringify(obs.data.state)).not.toContain(SECRET);
			const human = await h.service.getProjectedView(sid, { kind: "human", participantId: "human" });
			expect(human.ok).toBe(true);
			if (!human.ok) return;
			expect(JSON.stringify(human.data.state)).not.toContain(SECRET);
			expect((human.data.state as { clues: number }).clues).toBe(0);

			// Legal actions never echo the secret.
			const legal = await h.service.getLegalActions(sid, { kind: "observer" });
			expect(legal.ok).toBe(true);
			if (!legal.ok) return;
			expect(JSON.stringify(legal.data)).not.toContain(SECRET);

			// Public events (start report + later steps) never echo the secret.
			const steps = await h.stores.experiences.getSteps(sid);
			expect(JSON.stringify(steps.map((s) => s.emittedEventsJson))).not.toContain(SECRET);

			// A human `search` advances the clue count and asks the model seat for
			// a hint (text-mode model effect). The effect REQUEST never echoes it.
			const search = await h.service.submitAction(sid, {
				type: "search", requestId: "search1", expectedRevision: 0, participantId: "human",
			});
			expect(search.ok).toBe(true);
			const effectId = await solePendingEffectId(h, sid);
			const effect = await h.stores.experiences.getEffectById(effectId);
			expect(effect?.requestJson).not.toContain(SECRET);

			// IR-91B — the model-PROMPT seam. resolveModelEffectContext projects
			// ONLY the model seat's private view (no secret)…
			const vmCtx = await h.service.resolveModelEffectContext(effectId);
			expect(vmCtx.ok).toBe(true);
			if (!vmCtx.ok) return;
			expect(JSON.stringify(vmCtx.data.projectedView)).not.toContain(SECRET);
			expect((vmCtx.data.projectedView as { clues: number }).clues).toBe(1);

			// …and the string the model executor receives (the assembled prompt) also
			// excludes the secret. This is the boundary IR-91A deliberately did NOT pin.
			const stack = makeModelStack(h, { executeReturn: "Look near the old roots." });
			const run = await stack.modelEffectService.runEffect(effectId);
			expect(run.ok && run.data.status).toBe("succeeded");
			expect(stack.spy.calls).toHaveLength(1);
			const prompt = stack.spy.calls[0]!.prompt;
			expect(JSON.stringify(prompt)).not.toContain(SECRET);
			// The private view is the FINAL user message the executor reads.
			const messages = prompt.finalPayload.messages as Array<{ role: string; content: string }>;
			const last = messages[messages.length - 1]!;
			expect(last.role).toBe("user");
			expect(last.content).toContain("[Your projected view]");
			expect(last.content).not.toContain(SECRET);
		});
	});

	// ── P2: structured model continuation + idempotency ─────────────────────

	describe("P2 — structured model continuation drives the game to completion", () => {
		test("a human pick emits an action-mode effect; the validated structured pick is fed back and the game completes", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, MODEL_STRUCTURED_REFERENCE_SOURCE, HUMAN_MODEL_GRANTS, HUMAN_MODEL_ROSTER);
			const stack = makeModelStack(h, { executeReturn: '{"actionId":"pick","args":{"door":2}}' });

			// Round 1..3: human pick (emits effect) → model picks door 2 (feed-back).
			for (let round = 1; round <= 3; round += 1) {
				const session = await h.stores.experiences.getSessionById(sid);
				const rev = session?.revision ?? 0;
				const humanPick = await h.service.submitAction(sid, {
					type: "pick", requestId: `human-${round}`, expectedRevision: rev, participantId: "human",
				});
				expect(humanPick.ok).toBe(true);
				const effectId = await solePendingEffectId(h, sid);
				const run = await stack.modelEffectService.runEffect(effectId);
				expect(run.ok && run.data.delivered).toBe(true);
				expect(run.ok && run.data.result).toEqual({ mode: "action", actionId: "pick", args: { door: 2 } });
			}

			const final = await h.stores.experiences.getSessionById(sid);
			expect(final?.status).toBe("completed");
			expect(final?.revision).toBe(6);
			const state = JSON.parse(final?.currentStateJson ?? "{}") as { round: number; picks: number[] };
			expect(state.round).toBe(3);
			expect(state.picks).toEqual([2, 2, 2]);
		});

		test("re-running a terminal effect returns its status without double-applying", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, MODEL_STRUCTURED_REFERENCE_SOURCE, HUMAN_MODEL_GRANTS, HUMAN_MODEL_ROSTER);
			const stack = makeModelStack(h, { executeReturn: '{"actionId":"pick","args":{"door":5}}' });

			await h.service.submitAction(sid, { type: "pick", requestId: "h1", expectedRevision: 0, participantId: "human" });
			const effectId = await solePendingEffectId(h, sid);
			const first = await stack.modelEffectService.runEffect(effectId);
			expect(first.ok && first.data.delivered).toBe(true);

			const revAfter = (await h.stores.experiences.getSessionById(sid))!.revision;
			const picksAfter = (JSON.parse((await h.stores.experiences.getSessionById(sid))!.currentStateJson) as { picks: number[] }).picks;

			// Re-run the terminal effect: idempotent — stays succeeded, no second delivery.
			const again = await stack.modelEffectService.runEffect(effectId);
			expect(again.ok && again.data.status).toBe("succeeded");
			expect(again.ok && again.data.delivered).toBeUndefined();
			expect(stack.spy.calls).toHaveLength(1); // execute NOT called a second time

			const revReRun = (await h.stores.experiences.getSessionById(sid))!.revision;
			const picksReRun = (JSON.parse((await h.stores.experiences.getSessionById(sid))!.currentStateJson) as { picks: number[] }).picks;
			expect(revReRun).toBe(revAfter);
			expect(picksReRun).toEqual(picksAfter);
		});
	});

	// ── P3: replay / undo / recalculation stability + stable SHA-256 ────────

	describe("P3 — replay / undo / recalculation stability", () => {
		test("COUNTER action replay reproduces an identical state/event sequence + a stable hash across independent runs", async () => {
			async function playCounter(): Promise<Harness & { sid: string }> {
				const h = await setup();
				const sid = await seedAndStart(h, COUNTER_REFERENCE_SOURCE, [], []);
				await h.service.submitAction(sid, { type: "inc", requestId: "c1", expectedRevision: 0 });
				await h.service.submitAction(sid, { type: "inc", requestId: "c2", expectedRevision: 1 });
				return { ...h, sid };
			}
			const run1 = await playCounter();
			const run2 = await playCounter();
			const hash1 = await replayFingerprint(run1, run1.sid);
			const hash2 = await replayFingerprint(run2, run2.sid);
			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64);

			// The replayed state EQUALS the live authoritative state.
			const replay = await run1.replay.replaySession(run1.sid);
			expect(replay.ok && replay.data.ok).toBe(true);
			if (!replay.ok || !replay.data.ok) return;
			expect(replay.data.finalState).toEqual({ count: 2 });
			const live = await run1.stores.experiences.getSessionById(run1.sid);
			expect(replay.data.finalState).toEqual(JSON.parse(live!.currentStateJson));
		});

		test("DETERMINISTIC_RANDOM replay is stable for a fixed seed and diverges for a different seed", async () => {
			async function playDice(seed: string): Promise<Harness & { sid: string }> {
				const h = await setup(seed);
				const sid = await seedAndStart(h, DETERMINISTIC_RANDOM_REFERENCE_SOURCE, [EXPERIENCE_CAPABILITY.deterministicRandom], []);
				await h.service.submitAction(sid, { type: "draw", requestId: "d1", expectedRevision: 0 });
				await h.service.submitAction(sid, { type: "draw", requestId: "d2", expectedRevision: 1 });
				return { ...h, sid };
			}
			const a1 = await playDice("ir91b-dice-stable");
			const a2 = await playDice("ir91b-dice-stable");
			const b = await playDice("ir91b-dice-other");
			const hashA1 = await replayFingerprint(a1, a1.sid);
			const hashA2 = await replayFingerprint(a2, a2.sid);
			const hashB = await replayFingerprint(b, b.sid);
			expect(hashA1).toBe(hashA2);
			expect(hashA1).not.toBe(hashB);

			// Replayed draws equal the live authoritative draws for the same seed.
			const replay = await a1.replay.replaySession(a1.sid);
			const live = await a1.stores.experiences.getSessionById(a1.sid);
			expect(replay.ok && replay.data.ok && replay.data.finalState).toEqual(JSON.parse(live!.currentStateJson));
		});

		test("undo is append-only history + a new revision; replay stays stable across the rewind", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, COUNTER_REFERENCE_SOURCE, [], []);
			await h.service.submitAction(sid, { type: "inc", requestId: "u1", expectedRevision: 0 });
			await h.service.submitAction(sid, { type: "inc", requestId: "u2", expectedRevision: 1 }); // rev 2, count 2

			const fingerprintBefore = await replayFingerprint(h, sid);

			const undo = await h.replay.undoToRevision(sid, 1);
			expect(undo.ok).toBe(true);
			if (!undo.ok) return;
			expect(undo.data.session.revision).toBe(3); // a NEW revision
			expect((undo.data.projection.state as { count: number }).count).toBe(1); // rewound state

			// Append-only: the two original action steps remain + one system undo step.
			const steps = await h.stores.experiences.getSteps(sid);
			expect(steps).toHaveLength(3);
			expect(steps.filter((s) => s.kind === "system")).toHaveLength(1);
			expect(steps.filter((s) => s.kind === "action")).toHaveLength(2);

			// Replay replays action steps only, so its fingerprint is unchanged by the
			// append-only rewind (the rewind is recorded as a system step, not an action).
			const fingerprintAfter = await replayFingerprint(h, sid);
			expect(fingerprintAfter).toBe(fingerprintBefore);
		});

		test("recalculation preview is deterministic for the same inputs and never commits", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, COUNTER_REFERENCE_SOURCE, [], []);
			await h.service.submitAction(sid, { type: "inc", requestId: "r1", expectedRevision: 0 });
			await h.service.submitAction(sid, { type: "inc", requestId: "r2", expectedRevision: 1 });
			const revBefore = (await h.stores.experiences.getSessionById(sid))!.revision;

			const preview1 = await h.replay.previewRecalculation(sid, COUNTER_REFERENCE_SOURCE);
			const preview2 = await h.replay.previewRecalculation(sid, COUNTER_REFERENCE_SOURCE);
			expect(preview1.ok && preview2.ok).toBe(true);
			if (!preview1.ok || !preview2.ok) return;
			expect(stableHash(preview1.data)).toBe(stableHash(preview2.data));
			expect(preview1.data.outcome.ok).toBe(true);

			// No commit: the persisted session is byte-identical.
			const revAfter = (await h.stores.experiences.getSessionById(sid))!.revision;
			expect(revAfter).toBe(revBefore);
		});
	});

	// ── P4: safe-stop / failure injection (separately-named tests) ──────────

	describe("P4 — safe-stop / failure injection", () => {
		test("a thrown executor error persists the effect failed and leaves the session consistent (not blocked)", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, MODEL_STRUCTURED_REFERENCE_SOURCE, HUMAN_MODEL_GRANTS, HUMAN_MODEL_ROSTER);
			await h.service.submitAction(sid, { type: "pick", requestId: "f1", expectedRevision: 0, participantId: "human" });
			const effectId = await solePendingEffectId(h, sid);
			const revBefore = (await h.stores.experiences.getSessionById(sid))!.revision;

			const failing = makeModelStack(h, { executeThrow: new Error("provider crashed") });
			const failed = await failing.modelEffectService.runEffect(effectId);
			expect(failed.ok && failed.data.status).toBe("failed");
			expect(failed.ok && failed.data.error).toBe("provider crashed");

			// Terminal failed — never an orphaned pending/running effect.
			expect((await h.stores.experiences.getEffectById(effectId))?.status).toBe("failed");
			const pending = await h.service.getPendingEffects(sid);
			expect(pending.ok && pending.data).toHaveLength(0);
			// No feed-back applied: revision unchanged from the failed attempt.
			expect((await h.stores.experiences.getSessionById(sid))!.revision).toBe(revBefore);
			// The session is not blocked: a fresh legal human action is still accepted.
			const probe = await h.service.submitAction(sid, {
				type: "pick", requestId: "probe", expectedRevision: revBefore, participantId: "human",
			});
			expect(probe.ok).toBe(true);
		});

		test("an explicit retry of the failed effect resets to pending and succeeds on a working executor", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, MODEL_STRUCTURED_REFERENCE_SOURCE, HUMAN_MODEL_GRANTS, HUMAN_MODEL_ROSTER);
			await h.service.submitAction(sid, { type: "pick", requestId: "f2", expectedRevision: 0, participantId: "human" });
			const effectId = await solePendingEffectId(h, sid);

			const failing = makeModelStack(h, { executeThrow: new Error("transient") });
			await failing.modelEffectService.runEffect(effectId);
			expect((await h.stores.experiences.getEffectById(effectId))?.status).toBe("failed");
			const revAfterFail = (await h.stores.experiences.getSessionById(sid))!.revision;

			// Explicit user retry: a failed effect returns to pending (attempt count advances
			// from the initial 0; claim does not increment, so one failed attempt + one retry = 1).
			const retried = await h.stores.experiences.retryEffect(effectId);
			expect(retried?.status).toBe("pending");
			expect(retried?.attemptCount).toBe(1);
			// Retry itself does not advance the session.
			expect((await h.stores.experiences.getSessionById(sid))!.revision).toBe(revAfterFail);

			// A working executor now runs the retried effect to completion + delivery.
			const working = makeModelStack(h, { executeReturn: '{"actionId":"pick","args":{"door":7}}' });
			const run = await working.modelEffectService.runEffect(effectId);
			expect(run.ok && run.data.status).toBe("succeeded");
			expect(run.ok && run.data.delivered).toBe(true);
			const state = JSON.parse((await h.stores.experiences.getSessionById(sid))!.currentStateJson) as { round: number; picks: number[] };
			expect(state.round).toBe(1);
			expect(state.picks).toEqual([7]);
		});

		test("an aborted signal persists cancelled with no feed-back and no orphaned pending effect", async () => {
			const h = await setup();
			const sid = await seedAndStart(h, MODEL_STRUCTURED_REFERENCE_SOURCE, HUMAN_MODEL_GRANTS, HUMAN_MODEL_ROSTER);
			await h.service.submitAction(sid, { type: "pick", requestId: "f3", expectedRevision: 0, participantId: "human" });
			const effectId = await solePendingEffectId(h, sid);
			const revBefore = (await h.stores.experiences.getSessionById(sid))!.revision;

			const cancelling = makeModelStack(h, { executeThrow: new Error("aborted by client") });
			const controller = new AbortController();
			controller.abort();
			const result = await cancelling.modelEffectService.runEffect(effectId, controller.signal);
			expect(result.ok && result.data.status).toBe("cancelled");
			expect((await h.stores.experiences.getEffectById(effectId))?.status).toBe("cancelled");
			// No feed-back applied + no orphaned pending effect.
			expect((await h.stores.experiences.getSessionById(sid))!.revision).toBe(revBefore);
			const pending = await h.service.getPendingEffects(sid);
			expect(pending.ok && pending.data).toHaveLength(0);
		});
	});
});

/**
 * Experience timer-effect service tests (fix step 2b).
 *
 * Full-path through the REAL DB + REAL session lifecycle + REAL VM: the test
 * experiences emit `kind: "timer"` effects from `reduce`, exactly as a real
 * package does. The sleep seam is injected so tests never wait wall-clock time;
 * the provider-call and active-profile machinery of the model path is absent
 * here (a timer fires a fixed action, not a model reply).
 *
 * Pins: fire + delivery, idempotent re-entry, early typed failures
 * (illegal_action / validation_error / invalid_payload) without sleeping,
 * cancellation, stale completion (CAS rejection → succeeded-but-undelivered),
 * and args passthrough into the applied step.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import { ExperienceTimerEffectService } from "../src/domain/interactive/experience-timer-effect-service.js";

// ─── Test experiences ────────────────────────────────────────────────────────

/** A timer game: the human's "play" emits a tick that fires 250ms later. */
const TIMER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "timer-game", name: "Timer Game" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { rounds: 0 }; },
  project(c) { return { rounds: c.state.rounds }; },
  actions() { return [{ type: "play", label: "Play" }, { type: "tick", label: "Tick" }]; },
  reduce(c, a) {
    if (a.type === "play") {
      return { state: c.state, status: "active", events: [], effects: [{ kind: "timer", request: { viewer: "model", actionType: "tick", afterMs: 250 } }] };
    }
    if (a.type === "tick") {
      return { state: { rounds: c.state.rounds + 1 }, status: "active", events: [] };
    }
    return { state: c.state, status: "active", events: [] };
  },
});
`;

/** A timer whose tick action type is NOT in the legal set. */
const ILLEGAL_TIMER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "illegal-timer", name: "Illegal Timer" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { rounds: 0 }; },
  project(c) { return { rounds: c.state.rounds }; },
  actions() { return [{ type: "play", label: "Play" }]; },
  reduce(c, a) {
    if (a.type === "play") {
      return { state: c.state, status: "active", events: [], effects: [{ kind: "timer", request: { viewer: "model", actionType: "detonate", afterMs: 250 } }] };
    }
    return { state: c.state, status: "active", events: [] };
  },
});
`;

/** A timer whose request payload is malformed (missing actionType/afterMs). */
const MALFORMED_TIMER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "malformed-timer", name: "Malformed Timer" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { rounds: 0 }; },
  project(c) { return { rounds: c.state.rounds }; },
  actions() { return [{ type: "play", label: "Play" }]; },
  reduce(c, a) {
    if (a.type === "play") {
      return { state: c.state, status: "active", events: [], effects: [{ kind: "timer", request: { viewer: "model" } }] };
    }
    return { state: c.state, status: "active", events: [] };
  },
});
`;

/** A timer whose `tick` declares a payloadSchema and the request carries args. */
const SCHEMA_TIMER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "schema-timer", name: "Schema Timer" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { rounds: 0 }; },
  project(c) { return { rounds: c.state.rounds }; },
  actions() {
    return [
      { type: "play", label: "Play" },
      { type: "tick", label: "Tick", payloadSchema: { type: "object", properties: { card: { type: "integer" } }, required: ["card"], additionalProperties: false } },
    ];
  },
  reduce(c, a) {
    if (a.type === "play") {
      return { state: c.state, status: "active", events: [], effects: [{ kind: "timer", request: { viewer: "model", actionType: "tick", afterMs: 250, args: { card: 3 } } }] };
    }
    if (a.type === "tick") {
      return { state: { rounds: c.state.rounds + 1 }, status: "active", events: [] };
    }
    return { state: c.state, status: "active", events: [] };
  },
});
`;

const GRANTS = ["participants", "model"];
const PARTICIPANTS = [
	{ id: "human", label: "You", controller: "human" as const },
	{ id: "model", label: "AI", controller: "model" as const, providerProfileId: "pp1", modelId: "test-model" },
];

// ─── Setup ───────────────────────────────────────────────────────────────────

let stores: StoreContainer;
let resources: ExperienceResourceService;
let experienceService: ExperienceService;

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-xtimer-"));
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

/** Submit the human's opening move, which emits exactly one pending timer effect. */
async function emitTimerEffect(sessionId: string): Promise<string> {
	const session = await stores.experiences.getSessionById(sessionId);
	const res = await experienceService.submitAction(sessionId, {
		type: "play",
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

/** Build the service with a recording sleep stub (custom behavior layered on top). */
function makeTimerService(opts: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}) {
	const sleepSpy: { calls: number[] } = { calls: [] };
	const sleep = async (ms: number, signal?: AbortSignal) => {
		sleepSpy.calls.push(ms);
		if (opts.sleep) return opts.sleep(ms, signal);
	};
	const timerService = new ExperienceTimerEffectService({ stores, experienceService, sleep });
	return { timerService, sleepSpy };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceTimerEffectService", () => {
	test("fires the tick after the declared delay and feeds it back", async () => {
		await setup();
		const { sessionId } = await seedSession(TIMER_SOURCE);
		const effectId = await emitTimerEffect(sessionId);
		const { timerService, sleepSpy } = makeTimerService();

		const result = await timerService.runEffect(effectId);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.status).toBe("succeeded");
		expect(result.data.delivered).toBe(true);
		expect(sleepSpy.calls).toEqual([250]);
		// The tick advanced the session (human play + tick = 2 revisions).
		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.revision).toBe(2);
		const state = JSON.parse(session?.currentStateJson ?? "{}");
		expect(state.rounds).toBe(1);
	});

	test("idempotent re-entry: a non-pending effect is not re-run and does not sleep again", async () => {
		await setup();
		const { sessionId } = await seedSession(TIMER_SOURCE);
		const effectId = await emitTimerEffect(sessionId);
		const { timerService, sleepSpy } = makeTimerService();

		const first = await timerService.runEffect(effectId);
		expect(first.ok && first.data.status).toBe("succeeded");
		expect(sleepSpy.calls).toHaveLength(1);

		const second = await timerService.runEffect(effectId);
		expect(second.ok && second.data.status).toBe("succeeded");
		expect(sleepSpy.calls).toHaveLength(1); // no second sleep
	});

	test("illegal tick action type → failed 'illegal_action' without sleeping", async () => {
		await setup();
		const { sessionId } = await seedSession(ILLEGAL_TIMER_SOURCE);
		const effectId = await emitTimerEffect(sessionId);
		const { timerService, sleepSpy } = makeTimerService();

		const result = await timerService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("illegal_action");
		expect(sleepSpy.calls).toHaveLength(0);
	});

	test("malformed request → failed 'validation_error' without sleeping", async () => {
		await setup();
		const { sessionId } = await seedSession(MALFORMED_TIMER_SOURCE);
		const effectId = await emitTimerEffect(sessionId);
		const { timerService, sleepSpy } = makeTimerService();

		const result = await timerService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("failed");
		expect(result.ok && result.data.error).toBe("validation_error");
		expect(sleepSpy.calls).toHaveLength(0);
	});

	test("abort during sleep → cancelled", async () => {
		await setup();
		const { sessionId } = await seedSession(TIMER_SOURCE);
		const effectId = await emitTimerEffect(sessionId);
		const controller = new AbortController();
		const { timerService } = makeTimerService({
			sleep: async () => {
				controller.abort();
				throw new Error("aborted");
			},
		});

		const result = await timerService.runEffect(effectId, controller.signal);

		expect(result.ok && result.data.status).toBe("cancelled");
		const effect = await stores.experiences.getEffectById(effectId);
		expect(effect?.status).toBe("cancelled");
	});

	test("a tick whose session advanced delivers false; effect stays succeeded", async () => {
		await setup();
		const { sessionId } = await seedSession(TIMER_SOURCE);
		const effectId = await emitTimerEffect(sessionId);
		const { timerService } = makeTimerService({
			sleep: async () => {
				// Race: a concurrent action lands at the originating revision while
				// the timer sleeps.
				const advanced = await experienceService.submitAction(sessionId, {
					type: "play",
					requestId: `race-${effectId}`,
					expectedRevision: 1, // the originating revision
					participantId: "human",
					payload: { text: "another" },
				});
				expect(advanced.ok).toBe(true);
			},
		});

		const result = await timerService.runEffect(effectId);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.status).toBe("succeeded");
		expect(result.data.delivered).toBe(false);
		// The racing action (revision 2) is NOT overwritten by the tick.
		const session = await stores.experiences.getSessionById(sessionId);
		expect(session?.revision).toBe(2);
		const effect = await stores.experiences.getEffectById(effectId);
		expect(effect?.status).toBe("succeeded");
		expect(effect?.originatingRevision).toBe(1);
	});

	test("tick args pass through as the applied step's payload", async () => {
		await setup();
		const { sessionId } = await seedSession(SCHEMA_TIMER_SOURCE);
		const effectId = await emitTimerEffect(sessionId);
		const { timerService } = makeTimerService();

		const result = await timerService.runEffect(effectId);

		expect(result.ok && result.data.status).toBe("succeeded");
		expect(result.ok && result.data.delivered).toBe(true);
		const steps = await stores.experiences.getSteps(sessionId);
		const tick = steps.find((s) => s.kind === "effect_result");
		expect(tick).toBeDefined();
		expect(JSON.parse(tick?.inputJson ?? "{}").payload).toEqual({ card: 3 });
	});
});

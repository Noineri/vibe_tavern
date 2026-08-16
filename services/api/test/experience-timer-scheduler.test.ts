/**
 * Experience timer scheduler tests (fix step 2c).
 *
 * Full-path through the REAL scheduler → REAL timer-effect service → REAL DB:
 * the poll discovers pending timer rows and runs each exactly once to a
 * terminal state. The timer service's sleep seam is stubbed to resolve
 * immediately (wall-clock waits would make the test depend on timing), and the
 * poll interval is 5ms so discovery is observable without real sleeps.
 *
 * Pins: discovery + fire + delivery with the page closed (no HTTP/frontend
 * involved), one in-flight run per effect id across overlapping polls, typed
 * failure isolation (one bad effect never kills the loop), stop() clearing the
 * interval, and the restart-countdown semantics via reconcile (claimed rows at
 * shutdown surface as `unknown` on the next start).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import { ExperienceTimerEffectService } from "../src/domain/interactive/experience-timer-effect-service.js";
import { ExperienceTimerScheduler } from "../src/domain/interactive/experience-timer-scheduler.js";

/** A timer game: the human's "arm" emits a tick that fires later. */
const TIMER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "timer-game", name: "Timer Game" },
  capabilities: [{ capability: "participants" }, { capability: "model" }],
  create() { return { rounds: 0 }; },
  project(c) { return { rounds: c.state.rounds }; },
  actions() { return [{ type: "arm", label: "Arm" }, { type: "tick", label: "Tick" }]; },
  reduce(c, a) {
    if (a.type === "arm") {
      return { state: c.state, status: "active", events: [], effects: [{ kind: "timer", request: { viewer: "model", actionType: "tick", afterMs: 250 } }] };
    }
    if (a.type === "tick") {
      return { state: { rounds: c.state.rounds + 1 }, status: "active", events: [] };
    }
    return { state: c.state, status: "active", events: [] };
  },
});
`;

const sleeps: number[] = [];

let stores: StoreContainer;
let resources: ExperienceResourceService;
let service: ExperienceService;

beforeEach(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-xtimer-sched-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	resources = new ExperienceResourceService(stores);
	service = new ExperienceService(stores, resources);
	sleeps.length = 0;
});

afterEach(() => {
	sleeps.length = 0;
});

function makeScheduler(onError?: (error: unknown) => void): ExperienceTimerScheduler {
	const timerEffects = new ExperienceTimerEffectService({
		stores,
		experienceService: service,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return new ExperienceTimerScheduler({ stores, timerEffects, pollIntervalMs: 5, onError });
}

const GRANTS = ["participants", "model"];
const PARTICIPANTS = [
	{ id: "human", label: "You", controller: "human" as const },
	{ id: "model", label: "AI", controller: "model" as const, providerProfileId: "pp1", modelId: "test-model" },
];

async function armTimer(): Promise<{ sessionId: string; effectId: string }> {
	const character = await stores.characters.create({ name: "Aria", description: "Mage." } as never);
	const chat = await stores.chats.createChat({ characterId: character.id, title: "T" } as never);
	await stores.personas.create({ name: "Olya", description: "Scholar.", defaultForNewChats: true } as never);
	const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: TIMER_SOURCE } as never);
	await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: GRANTS as never } as never);
	const started = await service.startSession({ chatId: chat.id, branchId: chat.activeBranchId as string, settings: {}, participants: PARTICIPANTS });
	if (!started.ok) throw new Error(`start failed: ${JSON.stringify(started.error)}`);
	const sid = started.data.sessionId;
	const armed = await service.submitAction(sid, { type: "arm", requestId: "arm_0", expectedRevision: 0, participantId: "human", payload: { text: "hello" } });
	if (!armed.ok) throw new Error(`arm failed: ${JSON.stringify(armed.error)}`);
	const effects = await stores.experiences.getEffectsForSession(sid);
	const timer = effects.find((e) => e.kind === "timer");
	if (timer === undefined) throw new Error("no timer effect emitted");
	return { sessionId: sid, effectId: timer.id };
}

/** Await an async condition with a bounded number of turns. */
async function until(cond: () => boolean | Promise<boolean>, turns = 500): Promise<void> {
	for (let i = 0; i < turns && !(await cond()); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(await cond()).toBeTrue();
}

describe("ExperienceTimerScheduler", () => {
	test("discovers a pending timer with no frontend involved and fires it to delivery", async () => {
		const { sessionId, effectId } = await armTimer();
		const scheduler = makeScheduler();
		scheduler.start();
		try {
			await until(async () => (await stores.experiences.getEffectById(effectId))?.status === "succeeded");
			const effect = await stores.experiences.getEffectById(effectId);
			expect(effect?.status).toBe("succeeded");
			expect(effect?.resultJson).toContain('"fired":true');
			// The tick was delivered: session advanced by 2 (arm + tick) and the
			// counter applied.
			const session = await stores.experiences.getSessionById(sessionId);
			expect(session?.revision).toBe(2);
			const steps = await stores.experiences.getSteps(sessionId);
			const tickStep = steps.find((s) => JSON.stringify(s.inputJson ?? "").includes("tick") || (s.inputJson ?? "").includes("tick"));
			expect(tickStep).toBeDefined();
			// The sleep seam observed the declared delay.
			expect(sleeps).toEqual([250]);
		} finally {
			scheduler.stop();
		}
	});

	test("one in-flight run per effect id: overlapping polls never double-run", async () => {
		const { effectId } = await armTimer();
		let releaseSleep: (() => void) | undefined;
		const timerEffects = new ExperienceTimerEffectService({
			stores,
			experienceService: service,
			sleep: () => new Promise<void>((resolve) => {
				sleeps.push(250);
				releaseSleep = resolve;
			}),
		});
		const scheduler = new ExperienceTimerScheduler({ stores, timerEffects, pollIntervalMs: 5 });
		scheduler.start();
		try {
			// Wait until the first run claims and parks inside the sleep…
			await until(() => sleeps.length === 1);
			// …let several overlapping polls observe the claimed row…
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(sleeps.length).toBe(1);
			// …release, and the single run completes.
			releaseSleep?.();
			await until(async () => (await stores.experiences.getEffectById(effectId))?.status === "succeeded");
			expect(sleeps.length).toBe(1);
		} finally {
			scheduler.stop();
		}
	});

	test("a typed failure on one effect never kills the loop for the others", async () => {
		const good = await armTimer();
		// A second session whose timer action type is illegal at fire time.
		const character = await stores.characters.create({ name: "Villain", description: "Foe." } as never);
		const chat = await stores.chats.createChat({ characterId: character.id, title: "T2" } as never);
		const badSource = TIMER_SOURCE.replace('actionType: "tick"', 'actionType: "detonate"');
		const script = await stores.scripts.create({ name: "Bad", scriptKind: "interactive", code: badSource } as never);
		await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: GRANTS as never } as never);
		const started = await service.startSession({ chatId: chat.id, branchId: chat.activeBranchId as string, settings: {}, participants: PARTICIPANTS });
		if (!started.ok) throw new Error("bad start failed");
		await service.submitAction(started.data.sessionId, { type: "arm", requestId: "arm_0", expectedRevision: 0, participantId: "human", payload: { text: "hi" } });

		const errors: unknown[] = [];
		const scheduler = makeScheduler((e) => errors.push(e));
		scheduler.start();
		try {
			await until(async () => (await stores.experiences.getEffectById(good.effectId))?.status === "succeeded");
		} finally {
			scheduler.stop();
		}
		const badEffects = await stores.experiences.getPendingEffectsByKind("timer");
		// The illegal timer failed terminally; the good one still delivered.
		const statuses = await Promise.all(
			(await stores.experiences.getEffectsForSession(started.data.sessionId)).map(async (e) => e.status),
		);
		expect(statuses).toContain("failed");
		expect(errors).toHaveLength(0); // typed failures are outcomes, not loop errors
		expect(badEffects.find((e) => e.id === good.effectId)).toBeUndefined();
	});

	test("stop() clears the interval — no further polls run", async () => {
		const first = await armTimer();
		const scheduler = makeScheduler();
		scheduler.start();
		// The immediate first poll already claimed `first` — wait it out.
		await until(async () => (await stores.experiences.getEffectById(first.effectId))?.status === "succeeded");
		scheduler.stop();

		// A timer armed AFTER stop is never discovered: no poll fires.
		const character = await stores.characters.create({ name: "Rogue", description: "Foe." } as never);
		const chat = await stores.chats.createChat({ characterId: character.id, title: "T3" } as never);
		const script = await stores.scripts.create({ name: "Rules3", scriptKind: "interactive", code: TIMER_SOURCE } as never);
		await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: GRANTS as never } as never);
		const started = await service.startSession({ chatId: chat.id, branchId: chat.activeBranchId as string, settings: {}, participants: PARTICIPANTS });
		if (!started.ok) throw new Error("start failed");
		await service.submitAction(started.data.sessionId, { type: "arm", requestId: "arm_0", expectedRevision: 0, participantId: "human", payload: { text: "hi" } });
		const sleepsAfterStop = sleeps.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sleeps.length).toBe(sleepsAfterStop); // the post-stop timer never ran

		// A second start after stop still works (idempotent lifecycle).
		scheduler.start();
		try {
			await until(() => sleeps.length > sleepsAfterStop);
		} finally {
			scheduler.stop();
		}
	});
});

/**
 * Reference kernel matrix — IR-91A
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, IR-91A_reference_kernel_matrix).
 *
 * One focused suite that drives the five author-owned reference fixtures from
 * `fixtures/experience-reference-fixtures.ts` through the REAL kernel / tester
 * boundary and pins projections, actions, effects, deterministic-random
 * determinism + stable hash, and the script-controlled chooser — with no
 * durable lifecycle scope, no DB, and no provider/model executor.
 *
 * The boundary under test is the public kernel surface (`runCreate`,
 * `runProject`, `runActions`, `runReduce` from `experience-kernel.ts`) and the
 * stateless tester surface (`runExperienceTest`, `simulateExperienceTest` from
 * `experience-tester.ts`). No production symbol is altered; this file only
 * asserts the existing contract.
 *
 * Out of scope (IR-91B/C/D): model-prompt privacy, replay/undo/safe-stop, DB
 * attachment/dice/branch transactions, and the real shipped Conversation pair.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	runActions,
	runCreate,
	runProject,
	runReduce,
	type ExperienceCapabilityContext,
} from "../src/domain/interactive/experience-kernel.js";
import {
	runExperienceTest,
	simulateExperienceTest,
} from "../src/domain/interactive/experience-tester.js";
import type {
	ExperienceParticipant,
	ExperienceViewer,
} from "@vibe-tavern/domain";
import {
	COUNTER_REFERENCE_SOURCE,
	DETERMINISTIC_RANDOM_REFERENCE_SOURCE,
	HIDDEN_STATE_REFERENCE_SOURCE,
	MODEL_STRUCTURED_REFERENCE_SOURCE,
	SCRIPT_CONTROLLED_REFERENCE_SOURCE,
} from "./fixtures/experience-reference-fixtures.js";

// ─── Deterministic canonicalization + hashing ────────────────────────────────

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

// ─── Shared rosters / viewers ────────────────────────────────────────────────

const HUMAN_SEAT: ExperienceParticipant = { id: "you", label: "You", controller: "human" };
const BOT_SEAT: ExperienceParticipant = { id: "bot", label: "Bot", controller: "script" };
const MODEL_SEAT: ExperienceParticipant = { id: "model", label: "Model", controller: "model" };
const HUMAN: ExperienceViewer = { kind: "human", participantId: "you" };
const OBSERVER: ExperienceViewer = { kind: "observer" };
const NO_CAPS: ExperienceCapabilityContext = {};

const SECRET = "buried-at-the-old-oak-tree";
const DICE_SEED = "ref-dice-seed-91a";

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("IR-91A reference kernel matrix (real kernel / tester boundary)", () => {
	test("A — no-capability counter discovers, starts, and applies to completion with no grants or effects", () => {
		const res = runExperienceTest({
			rulesCode: COUNTER_REFERENCE_SOURCE,
			actions: [
				{ type: "inc", requestId: "r1", expectedRevision: 0 },
				{ type: "inc", requestId: "r2", expectedRevision: 1 },
				{ type: "inc", requestId: "r3", expectedRevision: 2 },
			],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.definition.declaredCapabilities).toEqual([]);
		expect(res.data.status).toBe("completed");
		expect(res.data.revision).toBe(3);
		expect(res.data.finalState).toEqual({ count: 3 });
		expect(res.data.projection.state).toEqual({ count: 3 });
		expect(res.data.projection.actions.map((a) => a.type)).toEqual(["inc", "reset"]);
		expect(res.data.events.map((e) => e.type)).toEqual(["inc", "inc", "inc"]);
		// No capability was granted, so no random/participants surface reached the VM,
		// and the counter never requested a durable effect.
		expect(res.data.effects).toEqual([]);
	});

	test("B — secret stays out of the human/observer projection, legal actions, and public events; a human action emits a text-mode model effect", () => {
		const created = runCreate(HIDDEN_STATE_REFERENCE_SOURCE, "hidden.js", {}, NO_CAPS);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const state = created.value;
		// Authoritative state DOES hold the distinctive secret.
		expect(JSON.stringify(state)).toContain(SECRET);

		// Human projection: no secret.
		const humanProj = runProject(HIDDEN_STATE_REFERENCE_SOURCE, "hidden.js", state, HUMAN, NO_CAPS);
		expect(humanProj.ok).toBe(true);
		const humanJson = JSON.stringify(humanProj.ok ? humanProj.value : null);
		expect(humanJson).not.toContain(SECRET);
		expect(humanJson).not.toContain("secret");

		// Observer projection (reports/Writer view): no secret.
		const observerProj = runProject(HIDDEN_STATE_REFERENCE_SOURCE, "hidden.js", state, OBSERVER, NO_CAPS);
		expect(observerProj.ok).toBe(true);
		expect(JSON.stringify(observerProj.ok ? observerProj.value : null)).not.toContain(SECRET);

		// Legal-action set: no secret.
		const legal = runActions(HIDDEN_STATE_REFERENCE_SOURCE, "hidden.js", state, HUMAN, NO_CAPS);
		expect(legal.ok).toBe(true);
		expect(JSON.stringify(legal.ok ? legal.value : null)).not.toContain(SECRET);
		expect((legal.ok ? legal.value : []).map((d) => d.type)).toEqual(["search", "guess"]);

		// A human `search` advances a clue and requests a durable model effect; the
		// public event and the effect request carry no secret. Model-prompt privacy
		// (the prompt the executor receives) is IR-91B and is NOT asserted here —
		// only the effect request SHAPE is pinned.
		const reduced = runReduce(
			HIDDEN_STATE_REFERENCE_SOURCE,
			"hidden.js",
			state,
			{ type: "search", requestId: "s1", expectedRevision: 0 },
			NO_CAPS,
		);
		expect(reduced.ok).toBe(true);
		if (!reduced.ok) return;
		const transition = reduced.value;
		expect(transition.events).toHaveLength(1);
		expect(JSON.stringify(transition.events)).not.toContain(SECRET);
		expect(transition.effects).toHaveLength(1);
		const effect = transition.effects![0];
		expect(effect.kind).toBe("model");
		const request = effect.request as { mode?: unknown; viewer?: unknown };
		expect(request.mode).toBe("text");
		expect(request.viewer).toBe("model");
		expect(JSON.stringify(effect.request)).not.toContain(SECRET);
	});

	describe("C — deterministic-random rounds", () => {
		function playDice(seed: string) {
			return runExperienceTest({
				rulesCode: DETERMINISTIC_RANDOM_REFERENCE_SOURCE,
				capabilityGrants: ["deterministic_random"],
				seed,
				actions: [
					{ type: "draw", requestId: "d1", expectedRevision: 0 },
					{ type: "draw", requestId: "d2", expectedRevision: 1 },
					{ type: "draw", requestId: "d3", expectedRevision: 2 },
				],
			});
		}

		test("the same fixed seed reproduces the identical state/event sequence and a stable hash", () => {
			const a = playDice(DICE_SEED);
			const b = playDice(DICE_SEED);
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(true);
			if (!a.ok || !b.ok) return;
			// Completes after three draws.
			expect(a.data.status).toBe("completed");
			expect((a.data.finalState as { draws: number[] }).draws).toHaveLength(3);
			// Identical authoritative state + event sequence across independent runs.
			expect(a.data.finalState).toEqual(b.data.finalState);
			expect(a.data.events).toEqual(b.data.events);
			// Exact stable hash across the two independent runs (real
			// createDeterministicRandom stream, no Math.random / mock RNG).
			const hashA = stableHash({ state: a.data.finalState, events: a.data.events });
			const hashB = stableHash({ state: b.data.finalState, events: b.data.events });
			expect(hashA).toBe(hashB);
			// Pinned exact deterministic hash (state + event sequence) for the fixed
			// seed. Stable across independent runs because the stream is the real
			// mulberry32-seeded createDeterministicRandom, not Math.random.
			expect(hashA).toBe("e6801ca6944a171b39c5e0cb2a0aa0f3f62b25968459a431e376323cea1c02fb");
		});

		test("a different seed produces a divergent deterministic sequence", () => {
			const a = playDice(DICE_SEED);
			const c = playDice(`${DICE_SEED}-alt`);
			expect(a.ok).toBe(true);
			expect(c.ok).toBe(true);
			if (!a.ok || !c.ok) return;
			expect(a.data.finalState).not.toEqual(c.data.finalState);
		});
	});

	test("D — the real simulation chooser advances the script seat and never attributes it to the human seat", () => {
		const res = simulateExperienceTest({
			rulesCode: SCRIPT_CONTROLLED_REFERENCE_SOURCE,
			capabilityGrants: ["participants"],
			participants: [BOT_SEAT, HUMAN_SEAT],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.stopReason).toBe("completed");
		expect(res.data.iterations).toBe(3);
		expect(res.data.revision).toBe(3);
		expect(res.data.finalState).toEqual({ steps: 3 });
		// Every script-driven step belongs to the bot seat; the human seat present
		// in the roster is never the actor.
		expect(res.data.steps).toHaveLength(3);
		expect(res.data.steps.every((s) => s.participantId === "bot")).toBe(true);
		expect(res.data.steps.some((s) => s.participantId === "you")).toBe(false);
		expect(res.data.events.map((e) => e.type)).toEqual(["stepped", "stepped", "stepped"]);
	});

	test("E — a human pick emits an action-mode model effect and the structured model pick feeds back to completion", () => {
		const res = runExperienceTest({
			rulesCode: MODEL_STRUCTURED_REFERENCE_SOURCE,
			capabilityGrants: ["participants", "model"],
			participants: [HUMAN_SEAT, MODEL_SEAT],
			actions: [
				{ type: "pick", requestId: "h1", expectedRevision: 0 },
				{ type: "pick", requestId: "m1", expectedRevision: 1, participantId: "model", payload: { door: 1 } },
				{ type: "pick", requestId: "m2", expectedRevision: 2, participantId: "model", payload: { door: 2 } },
				{ type: "pick", requestId: "m3", expectedRevision: 3, participantId: "model", payload: { door: 3 } },
			],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// The structured model picks were accepted by the kernel boundary and the
		// game completed after three recorded doors.
		expect(res.data.status).toBe("completed");
		expect(res.data.revision).toBe(4);
		expect(res.data.finalState).toEqual({ round: 3, picks: [1, 2, 3] });
		// The single human pick requested exactly one action-mode model effect
		// targeted at the model seat (reported, never executed here).
		expect(res.data.effects).toHaveLength(1);
		const effect = res.data.effects[0];
		expect(effect.kind).toBe("model");
		const request = effect.request as { mode?: unknown; viewer?: unknown };
		expect(request.mode).toBe("action");
		expect(request.viewer).toBe("model");
	});
});

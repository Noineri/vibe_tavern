/**
 * Catch realtime builtin (REALTIME_EXPERIENCE_MODE_PLAN, RM-12) — the wave-6
 * realtime starter.
 *
 * Drives the REAL shipped Catch rules source (`CATCH_RULES_SOURCE` from
 * `@vibe-tavern/domain`) through the public kernel surface — discovery,
 * create, project, reduce, and the realtime `update` tick — and pins that a
 * round plays end-to-end: a chasing paddle catches steadily without misses,
 * three misses complete the round, and the same seed + same input schedule
 * replays to the same final state (the round-commit determinism that RM-8
 * verifies server-side). The loop host's tick order is mirrored here
 * (update → human inputs) with one nudge per tick and the shared
 * deterministic cursor. No DB, no provider, no durable lifecycle — pure
 * kernel only.
 *
 * Note: a perfect player NEVER completes — the rules end the round on the
 * 3rd miss; the deliberate end (the visual's finishRound with score/summary)
 * is a surface call, not a kernel transition. So the chased rounds below are
 * asserted as active with zero misses, and completion is driven by the dodge
 * controller.
 */
import { describe, expect, test } from "bun:test";
import { CATCH_RULES_SOURCE } from "@vibe-tavern/domain/builtins";
import { createDeterministicRandom } from "@vibe-tavern/domain";
import {
	discoverExperienceDefinition,
	runCreate,
	runProject,
	runReduce,
	runUpdate,
	type ExperienceCapabilityContext,
} from "../src/domain/interactive/experience-kernel.js";

const OBSERVER = { kind: "observer" as const };
const TICK_MS = 33;

/** The realtime caps the loop injects: the DETERMINISTIC cursor only. */
function cursorCaps(seed: number): ExperienceCapabilityContext {
	return { random: createDeterministicRandom(seed) };
}

interface RoundResult {
	readonly state: unknown;
	readonly score: number;
	readonly misses: number;
	readonly ticks: number;
	readonly status: "active" | "completed";
}

type Control = (projected: { ball: { x: number }; px: number; score: number }) => "left" | "right" | null;

/**
 * Play one round through the pure kernel: update ticks, then the controller's
 * nudge (if any). Mirrors the loop host's tick order (update → human inputs)
 * with one nudge per tick and the shared cursor. Stops at completion or at
 * the max tick budget (active outcome) — never throws on a long chase.
 */
function playRound(seed: number, control: Control, maxTicks = 4000): RoundResult {
	const caps = cursorCaps(seed);
	const created = runCreate(CATCH_RULES_SOURCE, "catch.js", {}, caps);
	expect(created.ok).toBe(true);
	if (!created.ok) throw new Error(created.message);
	let state = created.value;

	for (let i = 0; i < maxTicks; i += 1) {
		const ticked = runUpdate(CATCH_RULES_SOURCE, "catch.js", state, TICK_MS, caps);
		expect(ticked.ok).toBe(true);
		if (!ticked.ok) throw new Error(ticked.message);
		state = ticked.value.state;
		const s = state as { score: number; misses: number; over: boolean };
		if (ticked.value.status === "completed") {
			return { state, score: s.score, misses: s.misses, ticks: i + 1, status: "completed" };
		}
		const projected = runProject(CATCH_RULES_SOURCE, "catch.js", state, OBSERVER, caps);
		expect(projected.ok).toBe(true);
		if (!projected.ok) throw new Error(projected.message);
		const move = control(projected.value as { ball: { x: number }; px: number; score: number });
		if (move !== null) {
			const reduced = runReduce(
				CATCH_RULES_SOURCE,
				"catch.js",
				state,
				{ type: move, requestId: `r${i}`, expectedRevision: i },
				caps,
			);
			expect(reduced.ok).toBe(true);
			if (!reduced.ok) throw new Error(reduced.message);
			state = reduced.value.state;
		}
	}
	const s = state as { score: number; misses: number; over: boolean };
	return { state, score: s.score, misses: s.misses, ticks: maxTicks, status: "active" };
}

/** Chase the ball: nudge toward ball.x until the catch window is reached. */
const catchControl: Control = (p) => {
	if (p.ball.x < p.px - 0.02) return "left";
	if (p.ball.x > p.px + 0.02) return "right";
	return null;
};

/** Dodge the ball: always move AWAY from it (forces misses until 3 end it). */
const missControl: Control = (p) => {
	if (p.ball.x < p.px - 0.02) return "right";
	if (p.ball.x > p.px + 0.02) return "left";
	return p.ball.x < 0.5 ? "right" : "left";
};

/**
 * Stop at the FIRST catch (the deterministic center-drop ball — catchable by
 * doing nothing) and return the freshly respawned ball. The respawn draws
 * from the cursor, so two seeds place it differently.
 */
function firstRespawn(seed: number): { x: number; y: number } {
	const caps = cursorCaps(seed);
	const created = runCreate(CATCH_RULES_SOURCE, "catch.js", {}, caps);
	expect(created.ok).toBe(true);
	if (!created.ok) throw new Error(created.message);
	let state = created.value;

	for (let i = 0; i < 2000; i += 1) {
		const ticked = runUpdate(CATCH_RULES_SOURCE, "catch.js", state, TICK_MS, caps);
		expect(ticked.ok).toBe(true);
		if (!ticked.ok) throw new Error(ticked.message);
		state = ticked.value.state;
		if ((state as { score: number }).score >= 1) {
			const projected = runProject(CATCH_RULES_SOURCE, "catch.js", state, OBSERVER, caps);
			expect(projected.ok).toBe(true);
			if (!projected.ok) throw new Error(projected.message);
			return (projected.value as { ball: { x: number; y: number } }).ball;
		}
	}
	throw new Error(`seed ${String(seed)} never caught the first ball`);
}

describe("Catch builtin — realtime definition (RM-12)", () => {
	test("discovers a realtime manifest with tickMs 33 and an update method", () => {
		const discovered = discoverExperienceDefinition(CATCH_RULES_SOURCE, "catch.js");
		expect(discovered.ok).toBe(true);
		if (!discovered.ok) throw new Error(discovered.message);
		expect(discovered.definition.manifest.id).toBe("catch_arcade");
		expect(discovered.definition.manifest.mode).toBe("realtime");
		expect(discovered.definition.manifest.tickMs).toBe(33);
		expect(discovered.definition.hasUpdate).toBe(true);
	});

	test("create produces the canonical starting state (deterministic, no random draws)", () => {
		const created = runCreate(CATCH_RULES_SOURCE, "catch.js", {}, cursorCaps(1));
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error(created.message);
		expect(created.value).toEqual({
			score: 0,
			misses: 0,
			px: 0.5,
			ball: { x: 0.5, y: 0.04, vx: 0, vy: 0.2 },
			over: false,
		});
	});
});

describe("Catch builtin — a round plays end-to-end (RM-12)", () => {
	test("a chasing paddle catches steadily without misses (active round — a perfect player never completes)", () => {
		const outcome = playRound(42, catchControl, 500);
		expect(outcome.status).toBe("active");
		expect(outcome.misses).toBe(0);
		expect(outcome.score).toBeGreaterThanOrEqual(3);
		expect((outcome.state as { over: boolean }).over).toBe(false);
	});

	test("three misses complete the round (the miss path stays bounded)", () => {
		const outcome = playRound(7, missControl);
		expect(outcome.status).toBe("completed");
		expect(outcome.misses).toBe(3);
		expect((outcome.state as { over: boolean }).over).toBe(true);
	});

	test("same seed + same input schedule replays to the SAME final state", () => {
		const a = playRound(42, missControl);
		const b = playRound(42, missControl);
		expect(a.status).toBe("completed");
		// Bit-parity is the round-commit contract: RM-8 rejects a diverged hash
		// with round_verification_failed. The kernel must reproduce identically.
		expect(b.state).toEqual(a.state);
		expect(b.ticks).toBe(a.ticks);
	});

	test("different seeds spawn different respawn trajectories", () => {
		// The first ball is a deterministic center-drop, but every respawn draws
		// from the seeded cursor: two seeds must place the next ball differently
		// (the circle of determinism that makes replays seed-distinguishable).
		const a = firstRespawn(1);
		const b = firstRespawn(2);
		expect(a.y).toBe(0.04);
		expect(b.y).toBe(0.04);
		expect(a.x).not.toBe(b.x);
	});
});
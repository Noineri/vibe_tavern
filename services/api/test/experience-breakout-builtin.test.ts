/**
 * Breakout realtime builtin (REALTIME_EXPERIENCE_MODE_PLAN, RM-12/RM-12e) —
 * the wave-6 realtime starter, reworked from Catch into a brick-breaker.
 *
 * Drives the REAL shipped Breakout rules source (`BREAKOUT_RULES_SOURCE` from
 * `@vibe-tavern/domain`) through the public kernel surface — discovery,
 * create, project, reduce, and the realtime `update` tick — and pins the
 * arcade physics at the unit level (paddle-angle bounce, brick hits with
 * row scores, wall reflection, ball loss, the win/loss terminals) plus the
 * end-to-end story: a chasing paddle never loses a ball, a dodging paddle
 * loses exactly 3, and the same seed + same input schedule replays to the
 * same final state (the round-commit determinism that RM-8 verifies
 * server-side). The loop host's tick order is mirrored here
 * (update → human inputs) with one nudge per tick and the shared
 * deterministic cursor. No DB, no provider, no durable lifecycle — pure
 * kernel only.
 */
import { describe, expect, test } from "bun:test";
import { BREAKOUT_RULES_SOURCE } from "@vibe-tavern/domain/builtins";
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

// Mirror of the rules constants (they are the contract between rules and
// visual; these tests pin them so a silent constant change fails here).
const PADDLE_Y = 0.9;
const BALL_R = 0.014;
const FULL_FIELD = 0xffffffff;

/** The realtime caps the loop injects: the DETERMINISTIC cursor only. */
function cursorCaps(seed: number): ExperienceCapabilityContext {
	return { random: createDeterministicRandom(seed) };
}

interface BreakoutState {
	score: number;
	lives: number;
	px: number;
	ball: { x: number; y: number; vx: number; vy: number };
	bricks: number;
	over: boolean;
	won: boolean;
}

function makeState(overrides: Partial<BreakoutState> = {}): BreakoutState {
	return {
		score: 0,
		lives: 3,
		px: 0.5,
		ball: { x: 0.5, y: 0.6, vx: 0, vy: 0.5 },
		bricks: FULL_FIELD,
		over: false,
		won: false,
		...overrides,
	};
}

function tick(state: BreakoutState, seed = 1): { state: BreakoutState; status: string } {
	const caps = cursorCaps(seed);
	const res = runUpdate(BREAKOUT_RULES_SOURCE, "breakout.js", state, TICK_MS, caps);
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(res.message);
	return { state: res.value.state as BreakoutState, status: res.value.status };
}

interface RoundResult {
	readonly state: unknown;
	readonly score: number;
	readonly lives: number;
	readonly ticks: number;
	readonly status: "active" | "completed";
}

type Control = (p: { ball: { x: number }; px: number; score: number }) => "left" | "right" | null;

/**
 * Play one round through the pure kernel: update ticks, then the controller's
 * nudge (if any). Mirrors the loop host's tick order (update → human inputs)
 * with one nudge per tick and the shared cursor. Stops at completion or at
 * the max tick budget (active outcome) — never throws on a long chase.
 */
function playRound(seed: number, control: Control, maxTicks = 4000): RoundResult {
	const caps = cursorCaps(seed);
	const created = runCreate(BREAKOUT_RULES_SOURCE, "breakout.js", {}, caps);
	expect(created.ok).toBe(true);
	if (!created.ok) throw new Error(created.message);
	let state = created.value;

	for (let i = 0; i < maxTicks; i += 1) {
		const ticked = runUpdate(BREAKOUT_RULES_SOURCE, "breakout.js", state, TICK_MS, caps);
		expect(ticked.ok).toBe(true);
		if (!ticked.ok) throw new Error(ticked.message);
		state = ticked.value.state;
		const s = state as { score: number; lives: number; over: boolean };
		if (ticked.value.status === "completed") {
			return { state, score: s.score, lives: s.lives, ticks: i + 1, status: "completed" };
		}
		const projected = runProject(BREAKOUT_RULES_SOURCE, "breakout.js", state, OBSERVER, caps);
		expect(projected.ok).toBe(true);
		if (!projected.ok) throw new Error(projected.message);
		const move = control(projected.value as { ball: { x: number }; px: number; score: number });
		if (move !== null) {
			const reduced = runReduce(
				BREAKOUT_RULES_SOURCE,
				"breakout.js",
				state,
				{ type: move, requestId: `r${i}`, expectedRevision: i },
				caps,
			);
			expect(reduced.ok).toBe(true);
			if (!reduced.ok) throw new Error(reduced.message);
			state = reduced.value.state;
		}
	}
	const s = state as { score: number; lives: number; over: boolean };
	return { state, score: s.score, lives: s.lives, ticks: maxTicks, status: "active" };
}

/** Chase the ball: nudge toward ball.x until the dead zone is reached. */
const chaseControl: Control = (p) => {
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

describe("Breakout builtin — realtime definition (RM-12e)", () => {
	test("discovers a realtime manifest with tickMs 33 and an update method", () => {
		const discovered = discoverExperienceDefinition(BREAKOUT_RULES_SOURCE, "breakout.js");
		expect(discovered.ok).toBe(true);
		if (!discovered.ok) throw new Error(discovered.message);
		expect(discovered.definition.manifest.id).toBe("breakout_arcade");
		expect(discovered.definition.manifest.mode).toBe("realtime");
		expect(discovered.definition.manifest.tickMs).toBe(33);
		expect(discovered.definition.hasUpdate).toBe(true);
	});

	test("create produces the canonical starting state (deterministic, no random draws)", () => {
		const a = runCreate(BREAKOUT_RULES_SOURCE, "breakout.js", {}, cursorCaps(1));
		const b = runCreate(BREAKOUT_RULES_SOURCE, "breakout.js", {}, cursorCaps(2));
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (!a.ok || !b.ok) throw new Error(a.ok ? b.message : a.message);
		// Different seeds, SAME opening state: the first launch is fixed.
		expect(a.value).toEqual(b.value);
		const s = a.value as BreakoutState;
		expect(s.score).toBe(0);
		expect(s.lives).toBe(3);
		expect(s.px).toBe(0.5);
		expect(s.bricks).toBe(FULL_FIELD);
		expect(s.over).toBe(false);
		expect(s.won).toBe(false);
		// Opening launch: fixed slight rightward climb at base speed.
		expect(s.ball.x).toBe(0.5);
		expect(s.ball.vx).toBeCloseTo(0.06, 10);
		expect(s.ball.vy).toBeLessThan(-0.49);
		expect(s.ball.vy).toBeGreaterThan(-0.5);
	});
});

describe("Breakout builtin — arcade physics (RM-12e)", () => {
	test("paddle center hit rebounds straight up at constant speed", () => {
		const { state } = tick(makeState({ ball: { x: 0.5, y: PADDLE_Y - BALL_R - 0.005, vx: 0, vy: 0.4 } }));
		expect(state.ball.vy).toBeCloseTo(-0.5, 10);
		expect(state.ball.vx).toBe(0);
		expect(state.ball.y).toBeCloseTo(PADDLE_Y - BALL_R, 10);
		expect(state.lives).toBe(3);
	});

	test("paddle edge hit throws the ball wide (angle from the hit offset)", () => {
		const { state } = tick(makeState({ ball: { x: 0.5 + 0.07, y: PADDLE_Y - BALL_R - 0.005, vx: 0, vy: 0.4 } }));
		expect(state.ball.vx).toBeGreaterThan(0.3);
		expect(state.ball.vy).toBeLessThan(-0.3);
		// Constant speed: vx^2 + vy^2 stays 0.5^2.
		expect(state.ball.vx ** 2 + state.ball.vy ** 2).toBeCloseTo(0.25, 6);
	});

	test("side and top walls reflect the ball back into the field", () => {
		const left = tick(makeState({ ball: { x: 0.01, y: 0.5, vx: -0.3, vy: -0.2 } }));
		expect(left.state.ball.x).toBeCloseTo(BALL_R, 10);
		expect(left.state.ball.vx).toBeGreaterThan(0);
		const top = tick(makeState({ ball: { x: 0.5, y: 0.01, vx: 0.2, vy: -0.3 } }));
		expect(top.state.ball.y).toBeCloseTo(BALL_R, 10);
		expect(top.state.ball.vy).toBeGreaterThan(0);
	});

	test("a brick hit clears its bit, scores the row, and reflects the ball", () => {
		// Ball climbing into row 2 / col 2 (bit 18): row scores are [7,5,3,1].
		const { state } = tick(makeState({ ball: { x: 0.33, y: 0.245, vx: 0.05, vy: -0.4 } }));
		expect(state.bricks).toBe(FULL_FIELD & ~(1 << 18));
		expect(state.score).toBe(3);
		expect(state.over).toBe(false);
	});

	test("clearing the LAST brick completes the round as a win", () => {
		const { state, status } = tick(makeState({ bricks: 1 << 18, ball: { x: 0.33, y: 0.245, vx: 0.05, vy: -0.4 } }));
		expect(status).toBe("completed");
		expect(state.bricks).toBe(0);
		expect(state.over).toBe(true);
		expect(state.won).toBe(true);
	});

	test("a ball past the paddle costs a life and respawns from the cursor", () => {
		const { state, status } = tick(makeState({ px: 0.8, ball: { x: 0.2, y: 1.01, vx: 0, vy: 0.5 } }));
		expect(status).toBe("active");
		expect(state.lives).toBe(2);
		// Respawn launch: from the paddle line, climbing.
		expect(state.ball.vy).toBeLessThan(0);
		expect(state.ball.y).toBeGreaterThan(0.8);
	});

	test("the LAST lost ball completes the round as a loss", () => {
		const { state, status } = tick(makeState({ lives: 1, px: 0.8, ball: { x: 0.2, y: 1.01, vx: 0, vy: 0.5 } }));
		expect(status).toBe("completed");
		expect(state.over).toBe(true);
		expect(state.won).toBe(false);
		expect(state.lives).toBe(0);
	});
});

describe("Breakout builtin — a round plays end-to-end (RM-12e)", () => {
	test("a chasing paddle keeps all 3 balls while the score grows (active round)", () => {
		const outcome = playRound(42, chaseControl, 500);
		expect(outcome.status).toBe("active");
		expect(outcome.lives).toBe(3);
		expect(outcome.score).toBeGreaterThanOrEqual(3);
		expect((outcome.state as { over: boolean }).over).toBe(false);
	});

	test("three lost balls complete the round (the miss path stays bounded)", () => {
		const outcome = playRound(7, missControl);
		expect(outcome.status).toBe("completed");
		expect(outcome.lives).toBe(0);
		expect((outcome.state as { over: boolean }).over).toBe(true);
		expect((outcome.state as { won: boolean }).won).toBe(false);
	});

	test("same seed + same input schedule replays to the SAME final state", () => {
		const a = playRound(7, missControl);
		const b = playRound(7, missControl);
		expect(a.status).toBe("completed");
		expect(a.ticks).toBe(b.ticks);
		expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
	});
});

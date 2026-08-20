/**
 * Experience kernel `update` tests (REALTIME_EXPERIENCE_MODE_PLAN, RM-2).
 *
 * Characterize the OPTIONAL realtime tick method end to end through the real
 * `node:vm` sandbox: discovery flags (hasUpdate true/false), the happy tick
 * (dt-driven state advance through the SAME validated transition shape as
 * reduce), dt validation (positive integer host contract; the 16..1000 bound
 * stays owned by the contracts schema), invalid-transition rejection,
 * host-only `interrupted` rejection, async-return rejection, timeout, and the
 * replay-parity contract that makes round-commit verification possible: a tick
 * draws from the DETERMINISTIC cursor (never the ephemeral chance), so the
 * same seed + call order reproduces bit-identical state.
 */
import { describe, expect, test } from "bun:test";
import {
	createDeterministicRandom,
	discoverExperienceDefinition,
	runUpdate,
	type ExperienceCapabilityContext,
} from "../src/domain/interactive/experience-kernel.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A realtime package: a falling-clock whose `update` advances time by dt and
 *  completes when the clock runs out. Declares no capabilities. */
const TICKER_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "ticker", name: "Ticker", mode: "realtime", tickMs: 100 },
  capabilities: [],
  create(context, settings) {
    const total = (settings && typeof settings.total === "number") ? settings.total : 1000;
    return { remaining: total, total };
  },
  project(context, viewer) { return { remaining: context.state.remaining }; },
  actions(context, viewer) { return [{ type: "pause" }]; },
  reduce(context, action) {
    if (action.type === "pause") return { state: context.state, status: "completed", events: [] };
    return { state: context.state, status: "active", events: [] };
  },
  update(context, dt) {
    const remaining = context.state.remaining - dt;
    return {
      state: { ...context.state, remaining: Math.max(0, remaining) },
      status: remaining <= 0 ? "completed" : "active",
      events: remaining <= 0 ? [{ visibility: "public", type: "expired" }] : [],
    };
  },
});
`;

/** Same package WITHOUT `update` — a pure turn-based definition. */
const NO_UPDATE_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "plain", name: "Plain" },
  capabilities: [],
  create() { return { count: 0 }; },
  project(context) { return { count: context.state.count }; },
  actions() { return [{ type: "increment" }]; },
  reduce(context, action) {
    if (action.type === "increment") return { state: { count: context.state.count + 1 }, status: "active", events: [] };
    return { state: context.state, status: "active", events: [] };
  },
});
`;

/** Whose update draws from the deterministic cursor (replay parity). */
const RANDOM_TICK_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "randtick", name: "RandTick", mode: "realtime", tickMs: 50 },
  capabilities: [{ capability: "deterministic_random" }, { capability: "participants" }],
  create() { return { drift: 0, seats: context.participants.length }; },
  project(context) { return { drift: context.state.drift }; },
  actions() { return []; },
  reduce(context) { return { state: context.state, status: "active", events: [] }; },
  update(context, dt) {
    if (!context.random) throw new Error("update must receive context.random");
    if (context.chance) throw new Error("update must NOT receive context.chance");
    return { state: { ...context.state, drift: context.state.drift + context.random.float() }, status: "active", events: [] };
  },
});
`;

const BASE_CAPS: ExperienceCapabilityContext = {};

// ─── Discovery flags ─────────────────────────────────────────────────────────

describe("discoverExperienceDefinition — hasUpdate flag (RM-2)", () => {
	test("reports hasUpdate true when update is a function", () => {
		const result = discoverExperienceDefinition(TICKER_SCRIPT, "ticker.js");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition.hasUpdate).toBe(true);
		expect(result.definition.manifest.mode).toBe("realtime");
	});

	test("reports hasUpdate false for a turn-based package without update", () => {
		const result = discoverExperienceDefinition(NO_UPDATE_SCRIPT, "plain.js");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition.hasUpdate).toBe(false);
	});

	test("a non-function update is not a tick method (hasUpdate false)", () => {
		const broken = NO_UPDATE_SCRIPT.replace(
			"reduce(context, action) {",
			"update: 42,\n  reduce(context, action) {",
		);
		const result = discoverExperienceDefinition(broken, "broken.js");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition.hasUpdate).toBe(false);
	});
});

// ─── runUpdate — the tick lifecycle ─────────────────────────────────────────

describe("runUpdate", () => {
	test("advances state by dt and returns the validated transition", () => {
		const result = runUpdate(TICKER_SCRIPT, "ticker.js", { remaining: 1000, total: 1000 }, 100, BASE_CAPS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state).toEqual({ remaining: 900, total: 1000 });
		expect(result.value.status).toBe("active");
		expect(result.value.events).toEqual([]);
	});

	test("a tick may complete the round (expired event, completed status)", () => {
		const result = runUpdate(TICKER_SCRIPT, "ticker.js", { remaining: 40, total: 1000 }, 100, BASE_CAPS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.status).toBe("completed");
		expect(result.value.state).toEqual({ remaining: 0, total: 1000 });
		expect(result.value.events).toEqual([{ visibility: "public", type: "expired" }]);
	});

	test("rejects a non-positive-integer dtMs before touching the VM", () => {
		for (const bad of [0, -100, 50.5, Number.NaN]) {
			const result = runUpdate(TICKER_SCRIPT, "ticker.js", { remaining: 100, total: 100 }, bad, BASE_CAPS);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.kind).toBe("invalid_state");
			expect(result.message).toContain("dtMs");
		}
	});

	test("missing method fails typed as missing_method", () => {
		const result = runUpdate(NO_UPDATE_SCRIPT, "plain.js", { count: 0 }, 100, BASE_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("missing_method");
		expect(result.message).toContain("update");
	});

	test("rejects an invalid transition shape as invalid_transition", () => {
		// Dead code after the early return keeps the fixture syntactically whole;
		// the returned object lacks `status`, so transition validation fires.
		const broken = TICKER_SCRIPT.replace(
			"const remaining = context.state.remaining - dt;",
			"return { state: context.state }; const remaining = context.state.remaining - dt;",
		);
		const result = runUpdate(broken, "broken.js", { remaining: 100, total: 100 }, 100, BASE_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_transition");
	});

	test("rejects the host-only interrupted status exactly like reduce", () => {
		const interrupted = TICKER_SCRIPT.replace(
			"status: remaining <= 0 ? \"completed\" : \"active\",",
			"status: \"interrupted\",",
		);
		const result = runUpdate(interrupted, "interrupted.js", { remaining: 100, total: 100 }, 100, BASE_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_transition");
		expect(result.message).toContain("status");
	});

	test("rejects an oversized state output through the transition bounds", () => {
		const fat = TICKER_SCRIPT.replace(
			"state: { ...context.state, remaining: Math.max(0, remaining) },",
			"state: { ...context.state, blob: 'x'.repeat(300000) },",
		);
		const result = runUpdate(fat, "fat.js", { remaining: 100, total: 100 }, 100, BASE_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_transition");
	});

	test("rejects an async update (no Promise return)", () => {
		const asyncTick = TICKER_SCRIPT.replace(
			"update(context, dt) {",
			"async update(context, dt) {",
		);
		const result = runUpdate(asyncTick, "async.js", { remaining: 100, total: 100 }, 100, BASE_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("async_return");
		expect(result.message).toContain("update");
	});

	test("a hanging tick fails typed as timeout", () => {
		const hanging = TICKER_SCRIPT.replace(
			"const remaining = context.state.remaining - dt;",
			"while (true) {} const remaining = context.state.remaining - dt;",
		);
		const result = runUpdate(hanging, "hanging.js", { remaining: 100, total: 100 }, 100, BASE_CAPS, 250);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("timeout");
	});
});

// ─── Replay parity — the deterministic cursor, never chance ──────────────────

describe("runUpdate — deterministic cursor (replay parity)", () => {
	test("a tick draws from context.random and never receives context.chance", () => {
		// The host passes the reduce-shaped caps: deterministic random, no chance
		// (the replay service must never hand a tick the ephemeral source).
		const caps: ExperienceCapabilityContext = {
			random: createDeterministicRandom(1234),
			participants: [{ id: "p1", label: "P1", controller: "human" }],
		};
		const result = runUpdate(RANDOM_TICK_SCRIPT, "randtick.js", { drift: 0, seats: 1 }, 50, caps);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(typeof result.value.state).toBe("object");
		const state = result.value.state as { drift: number };
		expect(state.drift).toBeGreaterThan(0);
		expect(state.drift).toBeLessThan(1);
	});

	test("same seed + call order reproduces bit-identical ticks (commit verification)", () => {
		const runThreeTicks = (): unknown => {
			// Fresh cursor with the SAME seed — what the replay service will do.
			const caps: ExperienceCapabilityContext = { random: createDeterministicRandom(42) };
			let state: unknown = { drift: 0, seats: 1 };
			for (let i = 0; i < 3; i++) {
				const r = runUpdate(RANDOM_TICK_SCRIPT, "randtick.js", state, 50, caps);
				if (!r.ok) throw new Error(`tick ${i} failed: ${r.message}`);
				state = r.value.state;
			}
			return state;
		};
		expect(runThreeTicks()).toEqual(runThreeTicks());
	});
});

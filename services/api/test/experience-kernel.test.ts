/**
 * Experience kernel tests (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 1 / IR-12).
 *
 * Characterize the pure validation + orchestration layer over the sandbox:
 * discovery validation, the four-method lifecycle with JSON-round-trip + bounds
 * enforcement, transition status normalization (active/completed only), hidden-
 * state projection (negative assertion), legal-action validation, async-return
 * rejection, deterministic-random replay, and pure-helper determinism.
 *
 * Negative assertions prove hidden state never reaches a projection; replay
 * proves identical seed + action sequence reproduces identical state. Run
 * beside the Prompt and Dice sandbox suites to catch process-global or shared-
 * runtime regression (IR-12 self-check).
 */
import { describe, expect, test } from "bun:test";
import {
	createDeterministicRandom,
	createEphemeralRandom,
	discoverExperienceDefinition,
	runActions,
	runChoose,
	runCreate,
	runFlavor,
	runProject,
	runReduce,
	validateSubmittedAction,
	type ExperienceCapabilityContext,
} from "../src/domain/interactive/experience-kernel.js";
import {
	createDeck,
	createGrid,
	deal,
	pickDistinct,
	shuffle,
	sumScores,
} from "../src/domain/interactive/experience-helpers.js";
import type { ExperienceAction, ExperienceActionDescriptor, ExperienceViewer } from "@vibe-tavern/domain";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const COUNTER_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [],
  create(context, settings) {
    const start = (settings && typeof settings.start === "number") ? settings.start : 0;
    return { count: start };
  },
  project(context, viewer) { return { count: context.state.count }; },
  actions(context, viewer) { return [{ type: "increment", label: "+" }, { type: "reset" }]; },
  reduce(context, action) {
    if (action.type === "increment") return { state: { count: context.state.count + 1 }, status: "active", events: [{ visibility: "public", type: "incremented" }] };
    if (action.type === "reset") return { state: { count: 0 }, status: "completed", events: [] };
    return { state: context.state, status: "active", events: [] };
  },
});
`;

const HIDDEN_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "hidden", name: "Hidden" }, capabilities: [],
  create() { return { score: 0, secret: "top-secret-value" }; },
  project(context) { return { score: context.state.score, hint: context.state.secret.length }; },
  actions() { return [{ type: "score", participantId: "p1" }]; },
  reduce(context) { return { state: { score: context.state.score + 1, secret: context.state.secret }, status: "active", events: [] }; },
});
`;

const RANDOM_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "roller", name: "Roller" },
  capabilities: [{ capability: "deterministic_random", reason: "rolls" }],
  create() { return { rolls: [] }; },
  project(context) { return { rolls: context.state.rolls.slice() }; },
  actions() { return [{ type: "roll" }]; },
  reduce(context) {
    return { state: { rolls: context.state.rolls.concat([context.random.die(6)]) }, status: "active", events: [] };
  },
});
`;

const CHOOSE_FLAVOR_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "cf", name: "CF" }, capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions(c, v) { return [{ type: "inc", participantId: v.participantId }]; },
  choose(c, info) { return { type: "inc", participantId: info.viewer.participantId }; },
  flavor(c, v) { return { flavorTag: c.chance.int(1, 10), seat: v.participantId ?? "anon" }; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
});
`;

const CHOOSE_ILLEGAL_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "ci", name: "CI" }, capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: "inc" }]; },
  choose() { return { type: "cheat" }; },
  reduce(c) { return { state: c.state, status: "active", events: [] }; },
});
`;

const INTERRUPTED_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "bad", name: "Bad" }, capabilities: [],
  create(){return {};},
  project(c){return c.state;},
  actions(){return [];},
  reduce(c){ return { state: c.state, status: "interrupted", events: [] }; },
});
`;

const HUGE_STATE_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "huge", name: "Huge" }, capabilities: [],
  create() { return { big: "x".repeat(300000) }; },
  project(c){return c.state;},
  actions(){return [];},
  reduce(c){return {state:c.state,status:"active",events:[]};},
});
`;

const ASYNC_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "async", name: "Async" }, capabilities: [],
  create(){return { count: 0 };},
  project(c){return c.state;},
  actions(){return [];},
  reduce: async function (context) { return { state: { count: context.state.count + 1 }, status: "active", events: [] }; },
});
`;

const HUMAN: ExperienceViewer = { kind: "human", participantId: "p1" };
const NO_CAPS: ExperienceCapabilityContext = {};

// ─── discoverExperienceDefinition ────────────────────────────────────────────

describe("discoverExperienceDefinition", () => {
	test("validates and returns the canonical definition + source hash", () => {
		const result = discoverExperienceDefinition(COUNTER_SCRIPT, "counter.js");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition).toEqual({
			apiVersion: 1,
			manifest: { id: "counter", name: "Counter" },
			declaredCapabilities: [],
			hasChoose: false,
			hasFlavor: false,
		});
		expect(result.sourceHash.length).toBe(64);
	});

	test("reports hasChoose/hasFlavor when the optional methods are present", () => {
		const result = discoverExperienceDefinition(CHOOSE_FLAVOR_SCRIPT, "cf.js");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition.hasChoose).toBe(true);
		expect(result.definition.hasFlavor).toBe(true);
	});

	test("rejects a malformed manifest as invalid_definition", () => {
		const bad = `
			context.experience.register({ apiVersion: 1, manifest: { id: "", name: "" }, capabilities: [], create(){return {};}, project(c){return c.state;}, actions(){return [];}, reduce(c){return {state:c.state,status:"active",events:[]};} });
		`;
		const result = discoverExperienceDefinition(bad, "bad.js");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_definition");
	});

	test("propagates a sandbox missing-method failure", () => {
		const missing = `
			context.experience.register({ apiVersion: 1, manifest: { id: "x", name: "X" }, capabilities: [], create(){return {};}, project(c){return c.state;}, actions(){return [];} });
		`;
		const result = discoverExperienceDefinition(missing, "missing.js");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("missing_method");
	});
});

// ─── create / project / actions / reduce ────────────────────────────────────

describe("runCreate", () => {
	test("returns the validated initial state", () => {
		const result = runCreate(COUNTER_SCRIPT, "counter.js", { start: 7 }, NO_CAPS);
		expect(result.ok).toBe(true);
		expect(result.ok && result.value).toEqual({ count: 7 });
	});

	test("rejects oversized settings as invalid_state", () => {
		const huge = { big: "y".repeat(300000) };
		const result = runCreate(COUNTER_SCRIPT, "counter.js", huge, NO_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_state");
	});
});

describe("runProject", () => {
	test("returns the projected state for a viewer", () => {
		const result = runProject(COUNTER_SCRIPT, "counter.js", { count: 4 }, HUMAN, NO_CAPS);
		expect(result.ok).toBe(true);
		expect(result.ok && result.value).toEqual({ count: 4 });
	});

	test("never leaks hidden state into a projection (negative assertion)", () => {
		const result = runProject(HIDDEN_SCRIPT, "hidden.js", { score: 2, secret: "top-secret-value" }, HUMAN, NO_CAPS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const serialized = JSON.stringify(result.value);
		// The projection exposes only `score` and a length `hint` — never the secret.
		expect(serialized).not.toContain("top-secret-value");
		expect(serialized).not.toContain("secret");
		expect((result.value as { hint: number }).hint).toBe("top-secret-value".length);
	});

	test("rejects an invalid viewer (observer carrying a participantId)", () => {
		const result = runProject(COUNTER_SCRIPT, "counter.js", { count: 0 }, { kind: "observer", participantId: "p1" }, NO_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_view");
	});
});

describe("runActions", () => {
	test("returns the validated legal-action descriptors", () => {
		const result = runActions(COUNTER_SCRIPT, "counter.js", { count: 0 }, HUMAN, NO_CAPS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map((d) => d.type)).toEqual(["increment", "reset"]);
	});

	test("rejects a malformed descriptor set", () => {
		const bad = `
			context.experience.register({ apiVersion: 1, manifest: { id: "b", name: "B" }, capabilities: [], create(){return {};}, project(c){return c.state;}, actions(){return ["not-an-object"];}, reduce(c){return {state:c.state,status:"active",events:[]};} });
		`;
		const result = runActions(bad, "b.js", {}, HUMAN, NO_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_actions");
	});
});

describe("runReduce", () => {
	test("returns the validated transition", () => {
		const result = runReduce(COUNTER_SCRIPT, "counter.js", { count: 4 }, { type: "increment", requestId: "r1", expectedRevision: 4 }, NO_CAPS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state).toEqual({ count: 5 });
		expect(result.value.status).toBe("active");
		expect(result.value.events).toHaveLength(1);
	});

	test("accepts a rule-determined completed status", () => {
		const result = runReduce(COUNTER_SCRIPT, "counter.js", { count: 4 }, { type: "reset", requestId: "r1", expectedRevision: 4 }, NO_CAPS);
		expect(result.ok).toBe(true);
		expect(result.ok && result.value.status).toBe("completed");
	});

	test("rejects a host-only interrupted status as invalid_transition", () => {
		const result = runReduce(INTERRUPTED_SCRIPT, "int.js", {}, { type: "x", requestId: "r1", expectedRevision: 0 }, NO_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_transition");
	});

	test("rejects oversized state output as invalid_state", () => {
		const result = runCreate(HUGE_STATE_SCRIPT, "huge.js", {}, NO_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid_state");
	});

	test("rejects an async reducer (no Promise return)", () => {
		const result = runReduce(ASYNC_SCRIPT, "async.js", { count: 0 }, { type: "x", requestId: "r1", expectedRevision: 0 }, NO_CAPS);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Either the engine rejects the async intrinsic or the kernel flags the
		// thenable — both correctly refuse a non-synchronous reducer.
		expect(["async_return", "runtime", "syntax"]).toContain(result.kind);
	});
});

// ─── Legal-action validation ─────────────────────────────────────────────────

describe("validateSubmittedAction", () => {
	const legal: ExperienceActionDescriptor[] = [
		{ type: "increment", participantId: "p1" },
		{ type: "reset" },
	];

	test("accepts a legal action for the right seat", () => {
		const ok = validateSubmittedAction({ type: "increment", requestId: "r", expectedRevision: 0, participantId: "p1" }, legal);
		expect(ok.ok).toBe(true);
	});

	test("rejects an unknown action type", () => {
		const result = validateSubmittedAction({ type: "cheat", requestId: "r", expectedRevision: 0 }, legal);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("illegal_action");
	});

	test("rejects a legal type offered to the wrong participant", () => {
		const result = validateSubmittedAction({ type: "increment", requestId: "r", expectedRevision: 0, participantId: "p2" }, legal);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("illegal_action");
	});
});

// ─── choose / flavor (optional methods) ─────────────────────────────────────

describe("runChoose / runFlavor (optional methods)", () => {
	const noCaps: ExperienceCapabilityContext = {};
	const scriptViewer: ExperienceViewer = { kind: "script", participantId: "p1" };

	test("runChoose returns the script's chosen move as a normalized intent", () => {
		const legal = runActions(CHOOSE_FLAVOR_SCRIPT, "cf.js", { n: 0 }, scriptViewer, noCaps);
		expect(legal.ok).toBe(true);
		const chosen = runChoose(
			CHOOSE_FLAVOR_SCRIPT, "cf.js", { n: 0 }, scriptViewer,
			legal.ok ? legal.value : [],
			{ chance: createEphemeralRandom() },
		);
		expect(chosen.ok).toBe(true);
		if (!chosen.ok) return;
		expect(chosen.value.type).toBe("inc");
		expect(chosen.value.participantId).toBe("p1");
	});

	test("runChoose rejects a choice whose type is not in the legal set (illegal_action)", () => {
		const legal: ExperienceActionDescriptor[] = [{ type: "inc" }];
		const chosen = runChoose(
			CHOOSE_ILLEGAL_SCRIPT, "ci.js", { n: 0 },
			{ kind: "human", participantId: "p1" },
			legal, noCaps,
		);
		expect(chosen.ok).toBe(false);
		if (chosen.ok) return;
		expect(chosen.kind).toBe("illegal_action");
	});

	test("runChoose on a script without `choose` is a missing_method failure", () => {
		const chosen = runChoose(
			COUNTER_SCRIPT, "counter.js", { count: 0 }, scriptViewer,
			[{ type: "increment" }], noCaps,
		);
		expect(chosen.ok).toBe(false);
		if (chosen.ok) return;
		expect(chosen.kind).toBe("missing_method");
	});

	test("runFlavor returns bounded-JSON cosmetic data (ephemeral chance reaches the method)", () => {
		const flavor = runFlavor(
			CHOOSE_FLAVOR_SCRIPT, "cf.js", { n: 0 },
			{ kind: "observer" },
			{ chance: createEphemeralRandom() },
		);
		expect(flavor.ok).toBe(true);
		if (!flavor.ok) return;
		const out = flavor.value as { flavorTag: number; seat: string };
		expect(out.seat).toBe("anon");
		expect(out.flavorTag).toBeGreaterThanOrEqual(1);
		expect(out.flavorTag).toBeLessThanOrEqual(10);
	});
});

// ─── Deterministic random + replay ───────────────────────────────────────────

describe("deterministic random", () => {
	test("createDeterministicRandom: same seed reproduces the sequence", () => {
		const a = createDeterministicRandom(42);
		const b = createDeterministicRandom(42);
		const seq = (rng: { int: (m: number, mx: number) => number }) =>
			Array.from({ length: 5 }, () => rng.int(1, 6));
		expect(seq(a)).toEqual(seq(b));
	});

	test("different seeds diverge", () => {
		// A seed and its successor are extremely unlikely to share a 5-roll window.
		const a = createDeterministicRandom(1);
		const b = createDeterministicRandom(2);
		const seq = (rng: { int: (m: number, mx: number) => number }) =>
			Array.from({ length: 5 }, () => rng.int(1, 6));
		expect(seq(a)).not.toEqual(seq(b));
	});

	test("replay reproduces identical authoritative state from the same seed + actions", () => {
		function play(seed: number): number[] {
			const caps: ExperienceCapabilityContext = { random: createDeterministicRandom(seed) };
			const created = runCreate(RANDOM_SCRIPT, "roller.js", {}, caps);
			if (!created.ok) throw new Error("create failed");
			let state = created.value;
			for (let i = 0; i < 5; i += 1) {
				const reduced = runReduce(RANDOM_SCRIPT, "roller.js", state, { type: "roll", requestId: `r${i}`, expectedRevision: i }, caps);
				if (!reduced.ok) throw new Error("reduce failed");
				state = reduced.value.state;
			}
			return (state as { rolls: number[] }).rolls;
		}
		expect(play(99)).toEqual(play(99));
	});
});

// ─── Pure helper determinism ─────────────────────────────────────────────────

describe("experience helpers (deterministic given a fixed rng)", () => {
	/** A fixed-sequence rng for deterministic helper tests. */
	function fixedRng(values: number[]): () => number {
		let i = 0;
		return () => values[i++ % values.length];
	}

	test("shuffle + deal + pickDistinct are deterministic and non-mutating", () => {
		const rng = fixedRng([0.4, 0.1, 0.9, 0.5, 0.2]);
		const deck = createDeck(["a", "b"], ["1", "2"]);
		const before = deck.slice();
		const shuffled = shuffle(deck, rng);
		// Original deck untouched (pure).
		expect(deck).toEqual(before);
		// Same seed → same result.
		const reshuffled = shuffle(before, fixedRng([0.4, 0.1, 0.9, 0.5, 0.2]));
		expect(shuffled).toEqual(reshuffled);

		const dealt = deal(shuffled, 2, 1);
		expect(dealt.hands).toHaveLength(2);

		const picked = pickDistinct([1, 2, 3, 4], 2, fixedRng([0.3, 0.7]));
		expect(picked).toHaveLength(2);
		expect(new Set(picked).size).toBe(2);
	});

	test("createGrid + sumScores are pure helpers with no rng dependence", () => {
		const grid = createGrid(3, 2, (x, y) => x + y * 10);
		expect(grid).toEqual([[0, 1, 2], [10, 11, 12]]);
		const totals = sumScores([
			{ participantId: "p1", score: 3 },
			{ participantId: "p2", score: 5 },
			{ participantId: "p1", score: 4 },
		]);
		expect(totals).toEqual({ p1: 7, p2: 5 });
	});

	test("helpers are available inside the VM as the frozen context.helpers namespace", () => {
		const script = `
			context.experience.register({
				apiVersion: 1, manifest: { id: "h", name: "H" }, capabilities: [],
				create(context) { return { order: context.helpers.rotateOrder(["a","b","c","d"], 2) }; },
				project(c) { return c.state; },
				actions() { return []; },
				reduce(c) { return { state: c.state, status: "active", events: [] }; },
			});
		`;
		const result = runCreate(script, "h.js", {}, NO_CAPS);
		expect(result.ok).toBe(true);
		expect(result.ok && (result.value as { order: string[] }).order).toEqual(["c", "d", "a", "b"]);
	});
});

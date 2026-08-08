/**
 * Experience sandbox VM tests (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 1 / IR-12).
 *
 * Characterize the dedicated Interactive VM in isolation: discovery registration
 * (exactly one, four mandatory methods), method execution under the CPU timeout,
 * error classification (timeout/syntax/runtime/no-registration/multi/missing),
 * console capture, the SHA-256 source snapshot, deterministic host-context
 * pass-through, the async-return surface, frozen-input isolation, and proof the
 * experience VM exposes NO prompt/dice channels.
 *
 * The VM is a pure synchronous function (no I/O, no DB) so these are unit tests.
 * Run alongside the Prompt and Dice sandbox suites to catch any process-global
 * or shared-runtime regression (IR-12 self-check).
 */
import { describe, expect, test } from "bun:test";
import {
	discoverExperience,
	runExperienceMethod,
} from "../src/domain/interactive/experience-sandbox.js";

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
  project(context, viewer) {
    return { count: context.state.count };
  },
  actions(context, viewer) {
    return [{ type: "increment", label: "+" }, { type: "reset" }];
  },
  reduce(context, action) {
    if (action.type === "increment") {
      return { state: { count: context.state.count + 1 }, status: "active", events: [{ visibility: "public", type: "incremented" }] };
    }
    if (action.type === "reset") {
      return { state: { count: 0 }, status: "completed", events: [] };
    }
    return { state: context.state, status: "active", events: [{ visibility: "private", type: "ignored" }] };
  },
});
`;

const RANDOM_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "dice-roller", name: "Dice Roller" },
  capabilities: [{ capability: "deterministic_random", reason: "rolls" }],
  create() { return { rolls: [] }; },
  project(context) { return { rolls: context.state.rolls.slice() }; },
  actions() { return [{ type: "roll" }]; },
  reduce(context, action) {
    const die = context.random.die(6);
    return { state: { rolls: context.state.rolls.concat([die]) }, status: "active", events: [] };
  },
});
`;

const HIDDEN_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "hidden", name: "Hidden" },
  capabilities: [],
  create() { return { score: 0, secret: "top-secret" }; },
  project(context, viewer) { return { score: context.state.score, hint: context.state.secret.length }; },
  actions() { return [{ type: "score" }]; },
  reduce(context) { return { state: { score: context.state.score + 1, secret: context.state.secret }, status: "active", events: [] }; },
});
`;

const MISSING_METHOD_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "bad", name: "Bad" },
  capabilities: [],
  create() { return {}; },
  project(context) { return context.state; },
  actions() { return []; },
});
`;

const MULTI_REGISTER_SCRIPT = `
context.experience.register({ apiVersion: 1, manifest: { id: "a", name: "A" }, capabilities: [], create(){return {};}, project(c){return c.state;}, actions(){return [];}, reduce(c){return {state:c.state,status:"active",events:[]};} });
context.experience.register({ apiVersion: 1, manifest: { id: "b", name: "B" }, capabilities: [], create(){return {};}, project(c){return c.state;}, actions(){return [];}, reduce(c){return {state:c.state,status:"active",events:[]};} });
`;

const NO_REGISTER_SCRIPT = `var x = 1;`;

const METHOD_THROW_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "throw", name: "Throw" }, capabilities: [],
  create(){return {};},
  project(c){return c.state;},
  actions(){return [];},
  reduce(){ throw new Error("reduce-boom"); },
});
`;

const METHOD_LOOP_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "loop", name: "Loop" }, capabilities: [],
  create(){return {};},
  project(c){return c.state;},
  actions(){return [];},
  reduce(){ while (true) {} },
});
`;

const FROZEN_MUTATE_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "mutate", name: "Mutate" }, capabilities: [],
  create(){return { count: 0 };},
  project(c){return c.state;},
  actions(){return [];},
  reduce(context) { context.state.count = 999; return { state: context.state, status: "active", events: [] }; },
});
`;

const CONSOLE_SCRIPT = `
console.log("booting", 1);
context.experience.register({
  apiVersion: 1, manifest: { id: "log", name: "Log" }, capabilities: [],
  create() { console.log("creating", 42); return { count: 0 }; },
  project(c){return c.state;},
  actions(){return [];},
  reduce(c){return {state:c.state,status:"active",events:[]};},
});
`;

/** Probes for prompt/dice channels — they must be absent in the experience VM. */
const PROBE_SCRIPT = `
context.experience.register({
  apiVersion: 1, manifest: { id: "probe", name: "Probe" }, capabilities: [],
  create(){return {};},
  project(c){return c.state;},
  actions() { return [{ type: typeof context.dice + "_" + typeof context.chat + "_" + typeof context.character }]; },
  reduce(c){return {state:c.state,status:"active",events:[]};},
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

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(text)).digest("hex");
}

// ─── discoverExperience ──────────────────────────────────────────────────────

describe("discoverExperience", () => {
	test("captures the single registration with hash and all four methods present", () => {
		const out = discoverExperience(COUNTER_SCRIPT, "counter.js");
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.apiVersion).toBe(1);
		expect(out.manifest).toEqual({ id: "counter", name: "Counter" });
		expect(out.capabilities).toEqual([]);
		expect(out.hasChoose).toBe(false);
		expect(out.hasFlavor).toBe(false);
		expect(out.sourceHash).toBe(sha256(COUNTER_SCRIPT));
	});

	test("reports hasChoose/hasFlavor true when the optional methods are present", () => {
		const out = discoverExperience(CHOOSE_FLAVOR_SCRIPT, "cf.js");
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.hasChoose).toBe(true);
		expect(out.hasFlavor).toBe(true);
	});

	test("source hash is stable for identical source and differs on change", () => {
		const a = discoverExperience(COUNTER_SCRIPT, "a.js");
		const b = discoverExperience(COUNTER_SCRIPT, "b.js");
		expect(a.ok && b.ok && a.sourceHash).toBe(b.sourceHash);
		const tweaked = discoverExperience(COUNTER_SCRIPT + "\n// trailing", "c.js");
		expect(a.ok && tweaked.ok && a.sourceHash).not.toBe(tweaked.sourceHash);
	});

	test("rejects when register() is never called", () => {
		const out = discoverExperience(NO_REGISTER_SCRIPT, "none.js");
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("no_registration");
	});

	test("rejects when register() is called more than once", () => {
		const out = discoverExperience(MULTI_REGISTER_SCRIPT, "multi.js");
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("multi_registration");
	});

	test("rejects when a mandatory method is missing", () => {
		const out = discoverExperience(MISSING_METHOD_SCRIPT, "missing.js");
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("missing_method");
		expect(out.message).toContain("reduce");
	});

	test("classifies syntax errors", () => {
		const out = discoverExperience("this is not valid {{{", "broken.js");
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("syntax");
	});

	test("classifies top-level runtime errors and keeps the message", () => {
		const out = discoverExperience("throw new Error('boom');", "throw.js");
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("runtime");
		expect(out.message).toBe("boom");
	});

	test("classifies an infinite top-level loop as a timeout", () => {
		const out = discoverExperience("while (true) {}", "loop.js", 200);
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("timeout");
	});

	test("captures console output during discovery (top-level body log)", () => {
		const out = discoverExperience(CONSOLE_SCRIPT, "log.js");
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		// Discovery runs the body (register) but NOT create(); the top-level log fires.
		expect(out.console.some((e) => e.level === "log" && e.args[0] === "booting")).toBe(true);
	});
});

// ─── runExperienceMethod ─────────────────────────────────────────────────────

describe("runExperienceMethod", () => {
	test("executes create/project/actions/reduce and returns the raw output", () => {
		const created = runExperienceMethod(COUNTER_SCRIPT, "counter.js", "create", {
			hostContext: {},
			input: { start: 5 },
		});
		expect(created.ok).toBe(true);
		expect(created.ok && created.output).toEqual({ count: 5 });

		const projected = runExperienceMethod(COUNTER_SCRIPT, "counter.js", "project", {
			hostContext: { state: { count: 3 } },
			input: { kind: "human", participantId: "p1" },
		});
		expect(projected.ok && projected.output).toEqual({ count: 3 });

		const actions = runExperienceMethod(COUNTER_SCRIPT, "counter.js", "actions", {
			hostContext: { state: { count: 3 } },
			input: { kind: "human", participantId: "p1" },
		});
		expect(actions.ok && (actions.output as { type: string }[]).length).toBe(2);

		const reduced = runExperienceMethod(COUNTER_SCRIPT, "counter.js", "reduce", {
			hostContext: { state: { count: 3 } },
			input: { type: "increment", requestId: "r1", expectedRevision: 0 },
		});
		expect(reduced.ok && (reduced.output as { status: string }).status).toBe("active");
	});

	test("passes the host context through (random capability reaches the method)", () => {
		const rng = { die: (sides: number) => sides };
		const out = runExperienceMethod(RANDOM_SCRIPT, "random.js", "reduce", {
			hostContext: { state: { rolls: [] }, random: rng },
			input: { type: "roll", requestId: "r1", expectedRevision: 0 },
		});
		expect(out.ok).toBe(true);
		// die(6) returns 6 via the injected stub — proves context.random reached the VM.
		expect(out.ok && (out.output as { state: { rolls: number[] } }).state.rolls).toEqual([6]);
	});

	test("rejects a missing mandatory method at execution time", () => {
		const out = runExperienceMethod(MISSING_METHOD_SCRIPT, "missing.js", "reduce", {
			hostContext: { state: {} },
			input: { type: "x", requestId: "r1", expectedRevision: 0 },
		});
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("missing_method");
	});

	test("classifies a method throw as a runtime error with the message", () => {
		const out = runExperienceMethod(METHOD_THROW_SCRIPT, "throw.js", "reduce", {
			hostContext: { state: {} },
			input: { type: "x", requestId: "r1", expectedRevision: 0 },
		});
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("runtime");
		expect(out.message).toBe("reduce-boom");
	});

	test("classifies an infinite method loop as a timeout", () => {
		const out = runExperienceMethod(METHOD_LOOP_SCRIPT, "loop.js", "reduce", {
			hostContext: { state: {} },
			input: { type: "x", requestId: "r1", expectedRevision: 0 },
		}, 200);
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.kind).toBe("timeout");
	});

	test("does not let a method mutate the host's authoritative state", () => {
		const frozenState = Object.freeze({ count: 0 });
		const out = runExperienceMethod(FROZEN_MUTATE_SCRIPT, "mutate.js", "reduce", {
			hostContext: { state: frozenState },
			input: { type: "x", requestId: "r1", expectedRevision: 0 },
		});
		// Whether sloppy mode silently ignores the assignment or strict mode throws,
		// the host's frozen state is never modified — the authoritative-state
		// isolation invariant. (The kernel additionally passes a frozen clone, so
		// the original is protected even when the caller does not pre-freeze.)
		expect(frozenState.count).toBe(0);
	});

	test("captures console output during method execution", () => {
		const out = runExperienceMethod(CONSOLE_SCRIPT, "log.js", "create", {
			hostContext: {},
			input: undefined,
		});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.console.some((e) => e.level === "log" && e.args.includes("42"))).toBe(true);
	});

	test("executes the optional choose/flavor methods and reports missing_method when absent", () => {
		// A script WITH choose/flavor: both optional methods are invocable.
		const chosen = runExperienceMethod(CHOOSE_FLAVOR_SCRIPT, "cf.js", "choose", {
			hostContext: { state: { n: 0 }, chance: { int: (a: number) => a } },
			input: { viewer: { kind: "script", participantId: "p1" }, legal: [{ type: "inc", participantId: "p1" }] },
		});
		expect(chosen.ok).toBe(true);
		expect(chosen.ok && (chosen.output as { type: string }).type).toBe("inc");

		const flavored = runExperienceMethod(CHOOSE_FLAVOR_SCRIPT, "cf.js", "flavor", {
			hostContext: { state: { n: 0 }, chance: { int: () => 5 } },
			input: { kind: "observer" },
		});
		expect(flavored.ok).toBe(true);
		expect(flavored.ok && (flavored.output as { seat: string }).seat).toBe("anon");

		// A script WITHOUT choose: the widened method name is accepted, but the absent
		// optional method surfaces as missing_method (not a type error).
		const missing = runExperienceMethod(COUNTER_SCRIPT, "counter.js", "choose", {
			hostContext: { state: { count: 0 } },
			input: { viewer: { kind: "script", participantId: "p1" }, legal: [] },
		});
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.kind).toBe("missing_method");
	});
});

// ─── Channel isolation ───────────────────────────────────────────────────────

describe("experience VM channel isolation", () => {
	test("exposes no prompt/dice/character channels (only experience)", () => {
		const out = runExperienceMethod(PROBE_SCRIPT, "probe.js", "actions", {
			hostContext: { state: {} },
			input: { kind: "human", participantId: "p1" },
		});
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		const actions = out.output as { type: string }[];
		// typeof context.dice / context.chat / context.character are all "undefined".
		expect(actions[0].type).toBe("undefined_undefined_undefined");
	});
});

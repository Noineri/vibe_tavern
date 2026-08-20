/**
 * Experience kernel FRAME PORT tests (REALTIME_EXPERIENCE_MODE_PLAN, RM-3).
 *
 * Pin the port against the SAME fixtures and expectations the SERVER kernel
 * tests pin (`services/api/test/experience-kernel.test.ts` and
 * `experience-kernel-update.test.ts`): discovery validation, the full method
 * lifecycle with JSON-round-trip freezing + bounds enforcement, transition
 * status normalization, legal-action validation, async-return rejection,
 * deterministic-random replay, and the frame-specific execution kinds (syntax /
 * runtime — there is NO timeout kind here, a browser cannot interrupt sync
 * code). Fixtures below MIRROR the server fixtures; keep them in sync when the
 * server suite evolves (the port must never diverge on a fixture the server
 * accepts or rejects).
 *
 * The mulberry32 sequence pins (seed 42 / 1234) are captured from the SHARED
 * domain primitive — the exact floats the server kernel produces — so an
 * accidental algorithm edit anywhere breaks this file loudly instead of
 * silently desynchronizing frame ticks from the RM-8 replay.
 */
import { describe, expect, test } from "bun:test";
import {
  createDeterministicRandom,
  discoverExperienceDefinition,
  runActions,
  runChoose,
  runCreate,
  runFlavor,
  runProject,
  runReduce,
  runUpdate,
  validateSubmittedAction,
  type ExperienceCapabilityContext,
} from "./experience-kernel-frame.js";

// ─── Fixtures (mirrors of the server kernel fixtures) ────────────────────────

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

/** Realtime ticker with update + choose + flavor (all optional methods present). */
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

/** Hidden-information projection: each viewer sees only their own score. */
const HIDDEN_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "hidden", name: "Hidden" },
  capabilities: [{ capability: "participants", reason: "seats" }],
  create() { return { scores: { p1: 3, p2: 7 }, secret: "host-only" }; },
  project(context, viewer) { return { mine: context.state.scores[viewer.participantId] }; },
  actions() { return [{ type: "noop" }]; },
  reduce(context) { return { state: context.state, status: "active", events: [] }; },
});
`;

const VIEWER_P1 = { participantId: "p1", kind: "human" } as const;
const BASE_CAPS: ExperienceCapabilityContext = {};

// ─── Discovery ───────────────────────────────────────────────────────────────

describe("frame port — discoverExperienceDefinition", () => {
  test("validates a turn-based package (mode defaults to turn)", () => {
    const result = discoverExperienceDefinition(COUNTER_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.apiVersion).toBe(1);
    expect(result.definition.manifest).toEqual({ id: "counter", name: "Counter", mode: "turn" });
    expect(result.definition.declaredCapabilities).toEqual([]);
    expect(result.definition.hasChoose).toBe(false);
    expect(result.definition.hasFlavor).toBe(false);
    expect(result.definition.hasUpdate).toBe(false);
  });

  test("validates a realtime package and flags the optional methods", () => {
    const result = discoverExperienceDefinition(TICKER_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.manifest.mode).toBe("realtime");
    expect(result.definition.manifest.tickMs).toBe(100);
    expect(result.definition.hasUpdate).toBe(true);
  });

  test("rejects a body that never registers", () => {
    const result = discoverExperienceDefinition("1 + 1;");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("no_registration");
  });

  test("rejects double registration", () => {
    const result = discoverExperienceDefinition(
      COUNTER_SCRIPT + "\ncontext.experience.register({ apiVersion: 1 });",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("multi_registration");
  });

  test("rejects a missing mandatory method", () => {
    const broken = COUNTER_SCRIPT.replace("  reduce(context, action) {", "  // reduce removed\n  reduce: null,\n  hiddenReduce(context, action) {");
    const result = discoverExperienceDefinition(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing_method");
    expect(result.message).toContain("reduce");
  });

  test("rejects an invalid manifest through the shared schema", () => {
    const broken = COUNTER_SCRIPT.replace('manifest: { id: "counter", name: "Counter" }', "manifest: { id: 42 }");
    const result = discoverExperienceDefinition(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_definition");
  });

  test("classifies a syntax error at compile time", () => {
    const result = discoverExperienceDefinition("function {{{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("syntax");
  });

  test("classifies a top-level runtime error and captures its console", () => {
    const result = discoverExperienceDefinition("console.log('boot'); throw new Error('boom');");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("runtime");
    expect(result.message).toContain("boom");
    expect(result.console).toEqual([{ level: "log", args: ["boot"] }]);
  });
});

// ─── create / project / actions ──────────────────────────────────────────────

describe("frame port — create", () => {
  test("produces the initial state from settings", () => {
    const result = runCreate(COUNTER_SCRIPT, { start: 5 }, BASE_CAPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ count: 5 });
  });

  test("rejects oversized settings before executing author code", () => {
    const result = runCreate(COUNTER_SCRIPT, { blob: "x".repeat(70000) }, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_state");
  });
});

describe("frame port — project (hidden information)", () => {
  const caps: ExperienceCapabilityContext = {
    participants: [{ id: "p1", label: "P1", controller: "human" }],
  };

  test("projects one viewer's view without leaking others' data or the secret", () => {
    const result = runProject(HIDDEN_SCRIPT, { scores: { p1: 3, p2: 7 }, secret: "host-only" }, VIEWER_P1, caps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ mine: 3 });
    // Negative assertion (the server suite's hidden-state pin): the projection
    // channel never carries the other seat's score or the host-only field.
    expect(JSON.stringify(result.value)).not.toContain("7");
    expect(JSON.stringify(result.value)).not.toContain("secret");
  });

  test("rejects an invalid viewer", () => {
    const result = runProject(HIDDEN_SCRIPT, { scores: {} }, { participantId: 42 } as unknown as never, caps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_view");
  });
});

describe("frame port — actions", () => {
  test("returns the bounded legal set", () => {
    const result = runActions(COUNTER_SCRIPT, { count: 0 }, VIEWER_P1, BASE_CAPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(2);
    expect(result.value[0]?.type).toBe("increment");
  });

  test("rejects a non-array result as invalid_actions", () => {
    const broken = COUNTER_SCRIPT.replace(
      "actions(context, viewer) { return [{ type: \"increment\", label: \"+\" }, { type: \"reset\" }]; }",
      "actions(context, viewer) { return 42; }",
    );
    const result = runActions(broken, { count: 0 }, VIEWER_P1, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_actions");
  });
});

// ─── reduce ──────────────────────────────────────────────────────────────────

describe("frame port — reduce", () => {
  test("returns the validated transition", () => {
    const result = runReduce(COUNTER_SCRIPT, { count: 1 }, { type: "increment", requestId: "r1", expectedRevision: 1 }, BASE_CAPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      state: { count: 2 },
      status: "active",
      events: [{ visibility: "public", type: "incremented" }],
    });
  });

  test("rejects a structurally invalid action as illegal_action", () => {
    const result = runReduce(COUNTER_SCRIPT, { count: 0 }, { nope: true } as unknown as never, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("illegal_action");
  });

  test("rejects a malformed transition as invalid_transition", () => {
    const broken = COUNTER_SCRIPT.replace(
      "if (action.type === \"increment\") return { state: { count: context.state.count + 1 }, status: \"active\", events: [{ visibility: \"public\", type: \"incremented\" }] };",
      "if (action.type === \"increment\") return { state: context.state };",
    );
    const result = runReduce(broken, { count: 0 }, { type: "increment", requestId: "r1", expectedRevision: 1 }, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_transition");
  });

  test("rejects the host-only interrupted status", () => {
    const broken = COUNTER_SCRIPT.replace(
      "if (action.type === \"reset\") return { state: { count: 0 }, status: \"completed\", events: [] };",
      "if (action.type === \"reset\") return { state: { count: 0 }, status: \"interrupted\", events: [] };",
    );
    const result = runReduce(broken, { count: 0 }, { type: "reset", requestId: "r1", expectedRevision: 1 }, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_transition");
    expect(result.message).toContain("status");
  });

  test("rejects an oversized state output through the transition bounds", () => {
    const broken = COUNTER_SCRIPT.replace(
      "if (action.type === \"increment\") return { state: { count: context.state.count + 1 }, status: \"active\", events: [{ visibility: \"public\", type: \"incremented\" }] };",
      "if (action.type === \"increment\") return { state: { blob: 'x'.repeat(300000) }, status: \"active\", events: [] };",
    );
    const result = runReduce(broken, { count: 0 }, { type: "increment", requestId: "r1", expectedRevision: 1 }, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_transition");
  });

  test("rejects an async reducer (no Promise returns)", () => {
    const broken = COUNTER_SCRIPT.replace("reduce(context, action) {", "async reduce(context, action) {");
    const result = runReduce(broken, { count: 0 }, { type: "increment", requestId: "r1", expectedRevision: 1 }, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("async_return");
    expect(result.message).toContain("reduce");
  });

  test("cannot mutate the host state (injected state is a frozen clone)", () => {
    const hostile = COUNTER_SCRIPT.replace(
      "reduce(context, action) {",
      "reduce(context, action) { try { context.state.count = 999; } catch (e) {} context.state.nested = { deep: true };",
    );
    const hostState = { count: 1 };
    const result = runReduce(hostile, hostState, { type: "increment", requestId: "r1", expectedRevision: 1 }, BASE_CAPS);
    expect(result.ok).toBe(true);
    // Sloppy-mode assignment to a frozen clone silently no-ops; the HOST object
    // is never touched regardless.
    expect(hostState).toEqual({ count: 1 });
    if (!result.ok) return;
    expect(result.value.state).toEqual({ count: 2 });
  });
});

// ─── update (realtime tick) ─────────────────────────────────────────────────

describe("frame port — update", () => {
  test("advances state by dt and returns the validated transition", () => {
    const result = runUpdate(TICKER_SCRIPT, { remaining: 1000, total: 1000 }, 100, BASE_CAPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ remaining: 900, total: 1000 });
    expect(result.value.status).toBe("active");
  });

  test("a tick may complete the round", () => {
    const result = runUpdate(TICKER_SCRIPT, { remaining: 40, total: 1000 }, 100, BASE_CAPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("completed");
    expect(result.value.events).toEqual([{ visibility: "public", type: "expired" }]);
  });

  test("rejects a non-positive-integer dtMs", () => {
    for (const bad of [0, -100, 50.5, Number.NaN]) {
      const result = runUpdate(TICKER_SCRIPT, { remaining: 100, total: 100 }, bad, BASE_CAPS);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("invalid_state");
      expect(result.message).toContain("dtMs");
    }
  });

  test("missing update fails typed as missing_method", () => {
    const result = runUpdate(COUNTER_SCRIPT, { count: 0 }, 100, BASE_CAPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing_method");
    expect(result.message).toContain("update");
  });
});

// ─── choose / flavor (optional methods) ──────────────────────────────────────

describe("frame port — choose / flavor", () => {
  const CHOOSE_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "chooser", name: "Chooser" },
  capabilities: [],
  create() { return { turn: 0 }; },
  project(context) { return { turn: context.state.turn }; },
  actions() { return [{ type: "left" }, { type: "right" }]; },
  reduce(context, action) { return { state: { turn: context.state.turn + 1 }, status: "active", events: [] }; },
  choose(context, input) {
    if (!context.chance) throw new Error("choose must receive context.chance");
    if (context.random) throw new Error("choose must not receive the deterministic cursor by default");
    return { type: input.legal[context.chance.float() < 0.5 ? 0 : 1].type };
  },
  flavor(context) { return { note: "tick" + context.chance.float() }; },
});
`;

  test("chooses a legal move with the ephemeral chance available", () => {
    const result = runChoose(CHOOSE_SCRIPT, { turn: 0 }, VIEWER_P1, [{ type: "left" }, { type: "right" }], {
      chance: createDeterministicRandom(7),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(["left", "right"]).toContain(result.value.type);
  });

  test("rejects a chosen type outside the legal set", () => {
    const hostile = CHOOSE_SCRIPT.replace("return { type: input.legal[context.chance.float() < 0.5 ? 0 : 1].type };", "return { type: \"fly\" };");
    const result = runChoose(hostile, { turn: 0 }, VIEWER_P1, [{ type: "left" }], {
      chance: createDeterministicRandom(7),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("illegal_action");
    expect(result.message).toContain("fly");
  });

  test("flavor returns bounded cosmetic data", () => {
    const result = runFlavor(CHOOSE_SCRIPT, { turn: 0 }, VIEWER_P1, {
      chance: createDeterministicRandom(7),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof (result.value as { note: string }).note).toBe("string");
  });
});

// ─── Deterministic-random parity (the RM-8 replay lifeline) ─────────────────

describe("frame port — deterministic cursor parity", () => {
  test("produces the pinned mulberry32 sequence for seed 42 (exact floats)", () => {
    const rng = createDeterministicRandom(42);
    // Captured from the shared domain primitive — the same floats the SERVER
    // kernel produces for seed 42. Any edit to the algorithm breaks RM-8
    // replay; this pin makes it break CI first.
    expect(rng.float()).toBe(0.6011037519201636);
    expect(rng.float()).toBe(0.44829055899754167);
    expect(rng.float()).toBe(0.8524657934904099);
    expect(rng.int(1, 6)).toBe(5);
    expect(rng.die(20)).toBe(4);
    expect(rng.pick(["a", "b", "c"])).toBe("b");
  });

  test("reproduces bit-identical reduce sequences from the same seed", () => {
    const RANDOM_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "drifty", name: "Drifty", mode: "realtime", tickMs: 50 },
  capabilities: [{ capability: "deterministic_random" }],
  create() { return { drift: 0 }; },
  project(context) { return { drift: context.state.drift }; },
  actions() { return []; },
  reduce(context) { return { state: { drift: context.state.drift + context.random.float() }, status: "active", events: [] }; },
  update(context, dt) {
    if (!context.random) throw new Error("update must receive context.random");
    if (context.chance) throw new Error("update must NOT receive context.chance");
    return { state: { drift: context.state.drift + context.random.float() }, status: "active", events: [] };
  },
});
`;
    const runSequence = (): unknown => {
      const caps: ExperienceCapabilityContext = { random: createDeterministicRandom(42) };
      let state: unknown = { drift: 0 };
      for (let i = 0; i < 3; i++) {
        const tick = runUpdate(RANDOM_SCRIPT, state, 50, caps);
        if (!tick.ok) throw new Error(`tick ${i} failed: ${tick.message}`);
        state = tick.value.state;
      }
      const reduce = runReduce(RANDOM_SCRIPT, state, { type: "noop", requestId: "r1", expectedRevision: 1 }, caps);
      if (!reduce.ok) throw new Error(`reduce failed: ${reduce.message}`);
      return reduce.value.state;
    };
    // Frame-side and the future server replay construct the cursor the same
    // way (seed 42, same call order) — the sequences must be identical.
    expect(runSequence()).toEqual(runSequence());
  });

  test("random is absent from the context unless the capability is granted", () => {
    const PROBE_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "probe", name: "Probe" },
  capabilities: [],
  create() { return {}; },
  project(context) { return {}; },
  actions() { return []; },
  reduce(context) {
    if (context.random !== undefined) throw new Error("random leaked without the capability");
    if (context.participants !== undefined) throw new Error("participants leaked without the capability");
    return { state: context.state, status: "active", events: [] };
  },
});
`;
    const result = runReduce(PROBE_SCRIPT, {}, { type: "noop", requestId: "r1", expectedRevision: 1 }, BASE_CAPS);
    expect(result.ok).toBe(true);
  });
});

// ─── Legal-action pre-check (mirrors the kernel's validateSubmittedAction) ──

describe("frame port — validateSubmittedAction", () => {
  const legal = [
    { type: "move", participantId: "p1" },
    { type: "offer", participantId: "p1", payloadSchema: { type: "number", minimum: 1, maximum: 9 } },
  ] as const;

  test("accepts a legal action", () => {
    expect(
      validateSubmittedAction({ type: "move", participantId: "p1", requestId: "r", expectedRevision: 0 }, legal).ok,
    ).toBe(true);
  });

  test("rejects an action type the package never offered", () => {
    const result = validateSubmittedAction({ type: "fly", participantId: "p1", requestId: "r", expectedRevision: 0 }, legal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("illegal_action");
    expect(result.message).toContain("legal now");
  });

  test("rejects a payload-less action whose descriptor declares a payloadSchema", () => {
    const result = validateSubmittedAction({ type: "offer", participantId: "p1", requestId: "r", expectedRevision: 0 }, legal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("requires a payload");
  });

  test("validates the payload against the descriptor's payloadSchema", () => {
    const bad = validateSubmittedAction(
      { type: "offer", participantId: "p1", payload: 99, requestId: "r", expectedRevision: 0 },
      legal,
    );
    expect(bad.ok).toBe(false);
    const good = validateSubmittedAction(
      { type: "offer", participantId: "p1", payload: 5, requestId: "r", expectedRevision: 0 },
      legal,
    );
    expect(good.ok).toBe(true);
  });
});

/**
 * Loop host tests (REALTIME_EXPERIENCE_MODE_PLAN, RM-4).
 *
 * Pure-TS unit tests with FAKE drivers (no rAF, no DOM — the file stays
 * windowless): fixed-timestep accumulator, tick order (update → inputs →
 * script seats), the batched-ticks log, bounds (queue, inputs/tick, catch-up,
 * watchdog), and the two replay lifelines RM-8 will lean on:
 *   1. same seed + same event sequence ⇒ bit-identical final state and log;
 *   2. `actions` legality and `update`/`reduce` NEVER share randomness the
 *      wrong way — legality draws no cursor, choose never burns it.
 */
import { describe, expect, test } from "bun:test";
import {
  EXPERIENCE_LOOP_MAX_INPUTS_PER_TICK,
  EXPERIENCE_LOOP_MAX_INPUT_QUEUE,
  startExperienceLoopHost,
  type ExperienceLoopCallbacks,
  type ExperienceLoopConfig,
  type ExperienceLoopEvent,
} from "./experience-loop-host.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

const TICKER_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "ticker", name: "Ticker", mode: "realtime", tickMs: 100 },
  capabilities: [],
  create(context, settings) {
    const total = (settings && typeof settings.total === "number") ? settings.total : 1000;
    return { remaining: total, total };
  },
  project(context) { return { remaining: context.state.remaining }; },
  actions() { return [{ type: "pause" }]; },
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

/** Update draws from the deterministic cursor; actions/chance must stay pure. */
const RANDOM_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "drifty", name: "Drifty", mode: "realtime", tickMs: 50 },
  capabilities: [{ capability: "deterministic_random" }],
  create() { return { drift: 0 }; },
  project(context) { return { drift: context.state.drift }; },
  actions(context) {
    if (context.random !== undefined) throw new Error("actions must NOT receive the cursor");
    return [{ type: "bump" }];
  },
  reduce(context, action) {
    if (action.type !== "bump") throw new Error("unexpected action " + action.type);
    if (context.chance !== undefined) throw new Error("reduce must NOT receive chance");
    return { state: { drift: context.state.drift + 1 }, status: "active", events: [] };
  },
  update(context, dt) {
    if (context.chance !== undefined) throw new Error("update must NOT receive chance");
    return { state: { drift: context.state.drift + context.random.float() * dt }, status: "active", events: [] };
  },
});
`;

/** Script-seat package: choose flips via ephemeral chance. */
const SEAT_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "seated", name: "Seated", mode: "realtime", tickMs: 100 },
  capabilities: [{ capability: "participants" }],
  create() { return { moves: 0 }; },
  project(context) { return { moves: context.state.moves }; },
  actions() { return [{ type: "go" }, { type: "stop" }]; },
  reduce(context, action) {
    if (action.type === "stop") return { state: context.state, status: "completed", events: [] };
    return { state: { moves: context.state.moves + 1 }, status: "active", events: [] };
  },
  update(context) { return { state: context.state, status: "active", events: [] }; },
  choose(context, input) {
    if (context.random !== undefined) throw new Error("choose must NOT burn the cursor");
    if (!context.chance) throw new Error("choose needs chance");
    if (!context.participants) throw new Error("choose needs participants when granted");
    context.chance.float();
    return { type: "go" };
  },
});
`;

// ─── harness ────────────────────────────────────────────────────────────────

interface FakeClock {
  drivers: { requestFrame: (cb: (now: number) => void) => void; now: () => number };
  /** Advance fake time by `ms` and run the pending frame callbacks once. */
  advance(ms: number): void;
}

function makeFakeClock(start = 0): FakeClock {
  let t = start;
  let callbacks: Array<(now: number) => void> = [];
  return {
    drivers: {
      requestFrame: (cb) => {
        callbacks.push(cb);
      },
      now: () => t,
    },
    advance(ms) {
      t += ms;
      const pending = callbacks;
      callbacks = [];
      for (const cb of pending) cb(t);
    },
  };
}

interface Recorded {
  events: ExperienceLoopEvent[];
  views: unknown[];
  drops: string[];
  errors: Array<{ kind: string; message: string }>;
  finishes: Array<{
    status: "completed" | "interrupted";
    finalState: unknown;
    log: readonly ExperienceLoopEvent[];
    score?: unknown;
    summary?: unknown;
  }>;
}

function makeCallbacks(): { cb: ExperienceLoopCallbacks; recorded: Recorded } {
  const recorded: Recorded = { events: [], views: [], drops: [], errors: [], finishes: [] };
  return {
    recorded,
    cb: {
      onEvent: (e) => recorded.events.push(e),
      onView: (v) => recorded.views.push(v),
      onDrop: (r) => recorded.drops.push(r),
      onError: (e) => recorded.errors.push(e),
      onFinish: (f) => recorded.finishes.push(f),
    },
  };
}

function tickerConfig(overrides: Partial<ExperienceLoopConfig> = {}): ExperienceLoopConfig {
  return {
    rulesSource: TICKER_SCRIPT,
    tickMs: 100,
    initialState: { remaining: 1000, total: 1000 },
    seed: 42,
    viewer: { kind: "human", participantId: "p1" },
    scriptSeats: [],
    ...overrides,
  };
}

// ─── boot & ticking ─────────────────────────────────────────────────────────

describe("loop host — boot", () => {
  test("discovery failure is fatal and the handle is inert", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig({ rulesSource: "1 + 1;" }), cb, clock.drivers);
    expect(recorded.errors.length).toBe(1);
    expect(recorded.errors[0]?.kind).toBe("no_registration");
    expect(recorded.events).toEqual([]); // not even round_started
    handle.enqueueInput({ type: "pause" });
    clock.advance(500);
    expect(recorded.events).toEqual([]);
  });

  test("round_started is the first event; views arrive once per frame", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    expect(recorded.events.map((e) => e.kind)).toEqual(["round_started"]);
    expect(recorded.events[0]).toEqual({ kind: "round_started", seed: 42, settings: null });
    clock.advance(0); // a zero-delta frame: no tick, but a view
    expect(recorded.views).toEqual([{ remaining: 1000 }]);
  });
});

describe("loop host — fixed timestep", () => {
  test("three frames of 100ms drive exactly three ticks of tickMs=100", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    clock.advance(100);
    clock.advance(100);
    clock.advance(100);
    expect(handle.getState()).toEqual({ remaining: 700, total: 1000 });
    expect(recorded.views[recorded.views.length - 1]).toEqual({ remaining: 700 });
  });

  test("fractional frames accumulate across frames", () => {
    const clock = makeFakeClock();
    const { cb } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig({ tickMs: 60 }), cb, clock.drivers);
    clock.advance(50);
    expect(handle.getState()).toEqual({ remaining: 1000, total: 1000 }); // 50 < 60
    clock.advance(50); // 100 accumulated → one 60ms tick, 40 left over
    expect(handle.getState()).toEqual({ remaining: 940, total: 1000 });
    clock.advance(20); // 60 → second tick
    expect(handle.getState()).toEqual({ remaining: 880, total: 1000 });
  });

  test("a completing tick finishes the round exactly once and stops the loop", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(
      tickerConfig({ initialState: { remaining: 40, total: 1000 } }),
      cb,
      clock.drivers,
    );
    clock.advance(100); // remaining 40-100 → completed
    expect(recorded.finishes.length).toBe(1);
    const finish = recorded.finishes[0];
    expect(finish?.status).toBe("completed");
    expect(finish?.finalState).toEqual({ remaining: 0, total: 1000 });
    expect(finish?.log.map((e) => e.kind)).toEqual(["round_started", "ticks", "round_finished"]);
    expect((finish?.log[1] as { count: number }).count).toBe(1);
    clock.advance(100);
    clock.advance(100);
    expect(recorded.finishes.length).toBe(1); // no double finish
    expect(handle.getState()).toEqual({ remaining: 0, total: 1000 });
  });

  test("author transition events are dropped from the log (replay vocabulary only)", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    startExperienceLoopHost(tickerConfig({ initialState: { remaining: 40, total: 1000 } }), cb, clock.drivers);
    clock.advance(100);
    const log = recorded.finishes[0]?.log ?? [];
    // The ticker's update emits {type:"expired"} on completion — it must NOT
    // appear in the round log.
    expect(JSON.stringify(log)).not.toContain("expired");
    expect(log.map((e) => e.kind)).toEqual(["round_started", "ticks", "round_finished"]);
  });

  test("watchdog: exceeding maxRoundTicks is fatal, never finishes", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    startExperienceLoopHost(tickerConfig({ maxRoundTicks: 2 }), cb, clock.drivers);
    clock.advance(100);
    clock.advance(100);
    expect(recorded.errors).toEqual([]);
    clock.advance(100); // tick #3 > 2
    expect(recorded.errors.length).toBe(1);
    expect(recorded.errors[0]?.kind).toBe("watchdog");
    expect(recorded.finishes).toEqual([]);
  });

  test("tab-switch clamp: a huge frame delta drains at most 5 catch-up ticks", () => {
    const clock = makeFakeClock();
    const { cb } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig({ tickMs: 16 }), cb, clock.drivers);
    clock.advance(10_000); // 250ms clamped → floor(250/16)=15 capped at 5
    expect(handle.getState()).toEqual({ remaining: 1000 - 5 * 16, total: 1000 });
    clock.advance(16); // leftover was discarded — one tick per 16ms again
    expect(handle.getState()).toEqual({ remaining: 1000 - 6 * 16, total: 1000 });
  });
});

// ─── inputs ─────────────────────────────────────────────────────────────────

describe("loop host — inputs", () => {
  test("a queued input is applied on the next tick and logged after a ticks flush", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    handle.enqueueInput({ type: "pause", participantId: "p1" }); // pause → completed
    clock.advance(100); // tick: update (pending 1) → input reduce (completed)
    expect(recorded.finishes.length).toBe(1);
    const log = recorded.finishes[0]?.log ?? [];
    expect(log.map((e) => e.kind)).toEqual(["round_started", "ticks", "input", "round_finished"]);
    const inputEvent = log[2] as { kind: "input"; action: { type: string; requestId: string; expectedRevision: number } };
    expect(inputEvent.action.type).toBe("pause");
    expect(inputEvent.action.requestId).toBeTruthy();
    expect(inputEvent.action.expectedRevision).toBe(1); // one update ran first
  });

  test("an illegal input is dropped with a reason, the round continues", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    handle.enqueueInput({ type: "fly" });
    clock.advance(100);
    expect(recorded.drops.length).toBe(1);
    expect(recorded.drops[0]).toContain("fly");
    expect(recorded.finishes).toEqual([]); // round alive
    expect(handle.getState()).toEqual({ remaining: 900, total: 1000 }); // only the tick ran
  });

  test("inputs are bounded per tick; leftovers apply on later ticks", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const BUMP_SCRIPT = RANDOM_SCRIPT; // "bump" increments drift
    const handle = startExperienceLoopHost(
      tickerConfig({
        rulesSource: BUMP_SCRIPT,
        tickMs: 50,
        initialState: { drift: 0 },
      }),
      cb,
      clock.drivers,
    );
    // Queue more than the per-tick bound (update also runs; "bump" is legal).
    for (let i = 0; i < EXPERIENCE_LOOP_MAX_INPUTS_PER_TICK + 2; i++) {
      handle.enqueueInput({ type: "bump" });
    }
    clock.advance(50); // one tick: update + 4 bumps
    const appliedFirst = recorded.events.filter((e) => e.kind === "input").length;
    expect(appliedFirst).toBe(EXPERIENCE_LOOP_MAX_INPUTS_PER_TICK);
    clock.advance(50); // second tick: update + remaining 2 bumps
    const appliedSecond = recorded.events.filter((e) => e.kind === "input").length;
    expect(appliedSecond).toBe(EXPERIENCE_LOOP_MAX_INPUTS_PER_TICK + 2);
  });

  test("queue overflow drops the newest input with a reason", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    for (let i = 0; i < EXPERIENCE_LOOP_MAX_INPUT_QUEUE + 1; i++) {
      handle.enqueueInput({ type: "pause" });
    }
    expect(recorded.drops.length).toBe(1);
    expect(recorded.drops[0]).toContain("queue full");
  });
});

// ─── script seats ───────────────────────────────────────────────────────────

describe("loop host — script seats", () => {
  test("a choose-driven seat moves once per tick and is logged as script_move", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(
      tickerConfig({
        rulesSource: SEAT_SCRIPT,
        initialState: { moves: 0 },
        scriptSeats: [{ kind: "script", participantId: "s1" }],
        participants: [{ id: "s1", label: "S1", controller: "script" }],
      }),
      cb,
      clock.drivers,
    );
    clock.advance(100);
    clock.advance(100);
    const moves = (handle.getState() as { moves: number }).moves;
    expect(moves).toBe(2); // one choose per tick, all picks under 0.75 → "go"
    const kinds = recorded.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "script_move").length).toBe(2);
    const move = recorded.events.find((e) => e.kind === "script_move") as {
      participantId: string;
      action: { type: string };
    };
    expect(move.participantId).toBe("s1");
    expect(move.action.type).toBe("go");
  });

  test("a seat choosing an illegal move is dropped, the round continues", () => {
    const HOSTILE_SEAT = SEAT_SCRIPT.replace(
      'return { type: "go" };',
      'return { type: "fly" };',
    );
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(
      tickerConfig({
        rulesSource: HOSTILE_SEAT,
        initialState: { moves: 0 },
        scriptSeats: [{ kind: "script", participantId: "s1" }],
        participants: [{ id: "s1", label: "S1", controller: "script" }],
      }),
      cb,
      clock.drivers,
    );
    clock.advance(100);
    expect(recorded.drops.length).toBe(1);
    expect(recorded.drops[0]).toContain("fly");
    expect(recorded.finishes).toEqual([]);
    expect(handle.getState()).toEqual({ moves: 0 });
  });
});

// ─── replay lifelines ───────────────────────────────────────────────────────

describe("loop host — determinism (the RM-8 lifeline)", () => {
  test("same seed + same frames ⇒ bit-identical state AND log", () => {
    const run = (): { state: unknown; log: string } => {
      const clock = makeFakeClock();
      const { cb, recorded } = makeCallbacks();
      const handle = startExperienceLoopHost(
        tickerConfig({ rulesSource: RANDOM_SCRIPT, tickMs: 50, initialState: { drift: 0 } }),
        cb,
        clock.drivers,
      );
      handle.enqueueInput({ type: "bump" });
      clock.advance(50);
      handle.enqueueInput({ type: "bump" });
      clock.advance(50);
      clock.advance(50);
      return {
        state: handle.getState(),
        log: JSON.stringify(recorded.events),
      };
    };
    const a = run();
    const b = run();
    expect(a.state).toEqual(b.state);
    expect(a.log).toBe(b.log);
  });

  test("different seeds diverge (the cursor actually drives update)", () => {
    const run = (seed: number): unknown => {
      const clock = makeFakeClock();
      const { cb } = makeCallbacks();
      const handle = startExperienceLoopHost(
        tickerConfig({ rulesSource: RANDOM_SCRIPT, tickMs: 50, initialState: { drift: 0 }, seed }),
        cb,
        clock.drivers,
      );
      clock.advance(50);
      return handle.getState();
    };
    const a = run(42);
    const b = run(1234);
    expect(a).not.toEqual(b);
  });

  test("caps discipline: actions draws no cursor; update/reduce get no chance", () => {
    // RANDOM_SCRIPT throws on every violation — a single tick exercises all
    // three guards (actions without cursor, update without chance, reduce
    // without chance). A thrown guard would be a fatal error.
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(
      tickerConfig({ rulesSource: RANDOM_SCRIPT, tickMs: 50, initialState: { drift: 0 } }),
      cb,
      clock.drivers,
    );
    handle.enqueueInput({ type: "bump" });
    clock.advance(50);
    expect(recorded.errors).toEqual([]);
    expect(recorded.drops).toEqual([]);
    expect((handle.getState() as { drift: number }).drift).toBeGreaterThan(0);
  });
});

// ─── teardown ───────────────────────────────────────────────────────────────

describe("loop host — stop", () => {
  test("stop() loses the round: no finish, no further frames", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    handle.stop();
    clock.advance(100);
    clock.advance(100);
    expect(recorded.finishes).toEqual([]);
    expect(recorded.views).toEqual([]);
    expect(recorded.events.map((e) => e.kind)).toEqual(["round_started"]);
    handle.enqueueInput({ type: "pause" });
    expect(recorded.drops).toEqual([]); // inert after stop, not even a drop
  });
});

// ─── model seats (RM-5) ─────────────────────────────────────────────────────

/** Model-seat fixture: "speak" is the seat's legal action, "shout" is not. */
const ORACLE_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "oracle", name: "Oracle", mode: "realtime", tickMs: 50 },
  capabilities: [{ capability: "participants" }],
  create() { return { oracles: 0, junk: 0 }; },
  project(context) { return { oracles: context.state.oracles }; },
  actions() { return [{ type: "poke" }, { type: "speak" }]; },
  reduce(context, action) {
    if (action.type === "speak" && action.participantId === "m1") return { state: { ...context.state, oracles: context.state.oracles + 1 }, status: "active", events: [] };
    if (action.type === "poke") return { state: { ...context.state, junk: context.state.junk + 1 }, status: "active", events: [] };
    return { state: context.state, status: "active", events: [] };
  },
  update(context) { return { state: context.state, status: "active", events: [] }; },
});
`;

function oracleConfig(overrides: Partial<ExperienceLoopConfig> = {}): ExperienceLoopConfig {
  return {
    rulesSource: ORACLE_SCRIPT,
    tickMs: 50,
    initialState: { oracles: 0, junk: 0 },
    seed: 7,
    viewer: { kind: "human", participantId: "p1" },
    scriptSeats: [],
    modelSeats: [{ kind: "model", participantId: "m1" }],
    participants: [
      { id: "p1", label: "P1", controller: "human" },
      { id: "m1", label: "Oracle", controller: "model" },
    ],
    ...overrides,
  };
}

describe("loop host — model seats", () => {
  test("requestModel logs for a declared seat and rejects unknown seats", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(oracleConfig(), cb, clock.drivers);
    expect(handle.requestModel("m1", { q: "hello" }, "rq-1")).toBe(true);
    clock.advance(50); // a tick runs after the request
    expect(handle.requestModel("ghost", { q: "?" })).toBe(false);
    const kinds = recorded.events.map((e) => e.kind);
    // The ticks batch is LAZY: one quiet tick after the request has no flush
    // trigger yet, so the live stream shows only the request. (The finish-side
    // log would carry the batch.)
    expect(kinds).toEqual(["round_started", "model_request"]);
    const req = recorded.events[1] as { kind: "model_request"; seatId: string; prompt: unknown; requestId?: string };
    expect(req.seatId).toBe("m1");
    expect(req.prompt).toEqual({ q: "hello" });
    expect(req.requestId).toBe("rq-1");
    expect(recorded.drops.length).toBe(1);
    expect(recorded.drops[0]).toContain("ghost");
  });

  test("a legal model reply is recorded verbatim and applied via reduce", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(oracleConfig(), cb, clock.drivers);
    clock.advance(50);
    expect(handle.applyModelResult("m1", { type: "speak", payload: { text: "hi" } }, "rq-1")).toBe(true);
    expect(handle.getState()).toEqual({ oracles: 1, junk: 0 });
    const res = recorded.events.find((e) => e.kind === "model_result") as {
      result: unknown;
      requestId?: string;
    };
    expect(res.result).toEqual({ type: "speak", payload: { text: "hi" } });
    expect(res.requestId).toBe("rq-1");
  });

  test("an illegal or malformed reply is recorded but NOT applied; the round lives", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(oracleConfig(), cb, clock.drivers);
    clock.advance(50);
    expect(handle.applyModelResult("m1", { type: "shout" })).toBe(true); // illegal for the seat
    expect(handle.applyModelResult("m1", "the oracle rambles")).toBe(true); // not an action
    expect(handle.getState()).toEqual({ oracles: 0, junk: 0 });
    expect(recorded.drops.length).toBe(2);
    expect(recorded.finishes).toEqual([]);
    // Both replies are in the log — verbatim wire truth for the replay.
    expect(recorded.events.filter((e) => e.kind === "model_result").length).toBe(2);
  });

  test("a reply for an undeclared seat is rejected at the door (nothing logged)", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(oracleConfig(), cb, clock.drivers);
    expect(handle.applyModelResult("ghost", { type: "speak" })).toBe(false);
    expect(recorded.events.map((e) => e.kind)).toEqual(["round_started"]);
    expect(recorded.drops.length).toBe(1);
  });

  test("a completing model reply finishes the round (game-driven status)", () => {
    const FINISHING_ORACLE = ORACLE_SCRIPT.replace(
      'status: "active", events: [] };\n    if (action.type === "poke")',
      'status: "completed", events: [] };\n    if (action.type === "poke")',
    );
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(oracleConfig({ rulesSource: FINISHING_ORACLE }), cb, clock.drivers);
    expect(handle.applyModelResult("m1", { type: "speak" })).toBe(true);
    expect(recorded.finishes.length).toBe(1);
    expect(recorded.finishes[0]?.status).toBe("completed");
    expect(recorded.finishes[0]?.finalState).toEqual({ oracles: 1, junk: 0 });
  });

  test("late replies after the round ended are silent noise", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(oracleConfig(), cb, clock.drivers);
    handle.stop();
    expect(handle.applyModelResult("m1", { type: "speak" })).toBe(false);
    expect(handle.requestModel("m1", {})).toBe(false);
    expect(recorded.events.map((e) => e.kind)).toEqual(["round_started"]);
    expect(recorded.drops).toEqual([]);
  });

  test("determinism: same seed + same model timing ⇒ identical state AND log", () => {
    const run = (): { state: unknown; log: string } => {
      const clock = makeFakeClock();
      const { cb, recorded } = makeCallbacks();
      const handle = startExperienceLoopHost(oracleConfig(), cb, clock.drivers);
      handle.requestModel("m1", { q: "hello" }, "rq-1");
      clock.advance(50);
      handle.applyModelResult("m1", { type: "speak", payload: { text: "hi" } }, "rq-1");
      clock.advance(50);
      clock.advance(50);
      return { state: handle.getState(), log: JSON.stringify(recorded.events) };
    };
    const a = run();
    const b = run();
    expect(a.state).toEqual(b.state);
    expect(a.log).toBe(b.log);
  });
});

// ─── visual-driven finish (RM-5) ─────────────────────────────────────────────

describe("loop host — finishNow", () => {
  test("claims the status, carries score/summary, and ends the round once", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    clock.advance(100); // one tick: remaining 900
    expect(handle.finishNow({ status: "interrupted", score: 42, summary: "player gave up" })).toBe(true);
    const finish = recorded.finishes[0];
    expect(finish?.status).toBe("interrupted");
    expect(finish?.score).toBe(42);
    expect(finish?.summary).toBe("player gave up");
    expect(finish?.finalState).toEqual({ remaining: 900, total: 1000 });
    expect(finish?.log.map((e) => e.kind)).toEqual(["round_started", "ticks", "round_finished"]);
    expect((finish?.log.at(-1) as { status: string }).status).toBe("interrupted");
    expect(handle.finishNow()).toBe(false); // already over — no double finish
    clock.advance(100);
    expect(recorded.finishes.length).toBe(1);
    handle.enqueueInput({ type: "pause" });
    expect(recorded.drops).toEqual([]); // inert after the finish
  });

  test("defaults to completed and drops nothing into the log for absent fields", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(tickerConfig(), cb, clock.drivers);
    expect(handle.finishNow()).toBe(true);
    const finish = recorded.finishes[0];
    expect(finish?.status).toBe("completed");
    expect(finish?.score).toBeUndefined();
    expect(finish?.summary).toBeUndefined();
    expect(JSON.stringify(finish?.log)).not.toContain("score");
  });

  test("a game-driven finish already took the round — finishNow is a no-op", () => {
    const clock = makeFakeClock();
    const { cb, recorded } = makeCallbacks();
    const handle = startExperienceLoopHost(
      tickerConfig({ initialState: { remaining: 40, total: 1000 } }),
      cb,
      clock.drivers,
    );
    clock.advance(100); // update completes the round
    expect(recorded.finishes.length).toBe(1);
    expect(handle.finishNow({ score: 1 })).toBe(false);
    expect(recorded.finishes.length).toBe(1);
    expect(recorded.finishes[0]?.score).toBeUndefined();
  });
});

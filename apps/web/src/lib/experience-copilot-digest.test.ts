/**
 * experience-copilot-digest — ER-14 builder boundary tests.
 *
 * Boundary under test: the PURE digest builders in
 * `lib/experience-copilot-digest.ts` — no React, no store, no I/O. Asserts each
 * builder returns the EXACT backend digest shape
 * (`ExperienceCopilotRunTestDigest` / `ExperienceCopilotRunSimulateDigest` from
 * `experience-copilot-tools.ts`) so the model parses user-sent testFeedback
 * identically to its own run_test/run_simulate tool results: the capping rules
 * (consoleTail last 20 `"level: args"`, stateSummary JSON capped 1500 + `\u2026`)
 * MUST match the backend field-for-field.
 *
 * Runner: bun:test (pure-logic file — no DOM env, no mock.module).
 */
import { describe, expect, it } from "bun:test";
import {
  buildPlaygroundDigest,
  buildPlaygroundLogDigest,
  buildRealtimeLoopDigest,
  buildRunTestDigest,
  buildRunTestErrorDigest,
  buildSimulateDigest,
  type PlaygroundSessionLog,
} from "./experience-copilot-digest.js";
import type { ExperienceCopilotLaunchContext } from "@vibe-tavern/api-contracts";
import type {
  ExperiencePlaygroundData,
  ExperienceTestRunData,
  ExperienceTestSimulateData,
} from "../api/types.js";

// ── Factories ────────────────────────────────────────────────────────────────

function consoleEntries(n: number): { level: "log"; args: string[] }[] {
  return Array.from({ length: n }, (_, i) => ({
    level: "log",
    args: [`line-${i}`],
  }));
}

function makeRunData(overrides: Partial<ExperienceTestRunData> = {}): ExperienceTestRunData {
  return {
    definition: {
      apiVersion: 1,
      manifest: { id: "round", name: "Round", mode: "turn" },
      declaredCapabilities: [{ capability: "participants", reason: "x" }],
      hasChoose: false,
      hasFlavor: false,
      hasUpdate: false,
    },
    sourceHash: "h",
    initialState: {},
    finalState: {},
    revision: 3,
    status: "active",
    projection: {
      state: { round: 1 },
      actions: [
        { type: "score", label: "Score" },
        { type: "pass", label: "Pass" },
      ],
    },
    events: [],
    effects: [],
    console: [],
    steps: [],
    seatLegality: { seats: [], turnOwners: [] },
    ...overrides,
  };
}

function makeSimData(overrides: Partial<ExperienceTestSimulateData> = {}): ExperienceTestSimulateData {
  return {
    ...makeRunData(),
    stopReason: "awaiting_human",
    iterations: 5,
    ...overrides,
  };
}

function makePlayground(overrides: Partial<ExperiencePlaygroundData> = {}): ExperiencePlaygroundData {
  return {
    playgroundSessionId: "pg-1",
    initialState: {},
    state: { round: 2 },
    projection: {
      state: { round: 2 },
      actions: [{ type: "reply", label: "Reply" }],
    },
    events: [{ visibility: "public", type: "replied" }],
    effects: [{ kind: "model", request: { prompt: "n" } }],
    pendingTimers: 0,
    seed: 42,
    console: [{ level: "log", args: ["hi"] }],
    revision: 7,
    status: "active",
    stopReason: "awaiting_human",
    ...overrides,
  };
}

/** Grounding step 6: the client-side whole-session accumulator. */
function makeSessionLog(overrides: Partial<PlaygroundSessionLog> = {}): PlaygroundSessionLog {
  return {
    events: [],
    effects: [],
    console: [],
    turns: 0,
    ...overrides,
  };
}

// ── buildRunTestDigest (ok path) ─────────────────────────────────────────────

describe("buildRunTestDigest", () => {
  it("returns the exact ok-path ExperienceCopilotRunTestDigest shape", () => {
    const result = makeRunData();
    const { feedback } = buildRunTestDigest(result);

    expect(feedback).toEqual({
      ok: true,
      status: "active",
      revision: 3,
      legalActionTypes: ["score", "pass"],
      stateSummary: JSON.stringify({ round: 1 }),
      consoleTail: [],
      seatLegality: { seats: [], turnOwners: [] },
    });
  });

  it("includes the per-seat legality matrix in feedback and text when supplied", () => {
    const matrix = {
      seats: [
        { participantId: "you", label: "You", controller: "human" as const, actionTypes: ["score", "pass"], count: 2 },
        { participantId: "ai", label: "AI", controller: "script" as const, actionTypes: [], count: 0 },
      ],
      turnOwners: ["you"],
    };
    const { text, feedback } = buildRunTestDigest(makeRunData({ seatLegality: matrix }));

    expect(feedback.seatLegality).toEqual(matrix);
    expect(text).toContain("Turn: you");
    expect(text).toContain('Seat "You" (id "you", human): score, pass');
    expect(text).toContain('Seat "AI" (id "ai", script): none');
  });

  it("maps legalActionTypes from projection.actions[].type and caps stateSummary", () => {
    const big = { round: 1, blob: "x".repeat(2000) };
    const { feedback } = buildRunTestDigest(
      makeRunData({ projection: { state: big, actions: [{ type: "a" }, { type: "b" }] } }),
    );

    expect(feedback.legalActionTypes).toEqual(["a", "b"]);
    const summary = feedback.stateSummary as string;
    expect(summary.length).toBe(1500 + 1); // 1500 chars + trailing ellipsis
    expect(summary.endsWith("\u2026")).toBe(true);
    expect(summary.startsWith('{"round":1,"blob":"')).toBe(true);
  });

  it("caps consoleTail at the last 20 entries, formatted as 'level: args'", () => {
    const { feedback } = buildRunTestDigest(makeRunData({ console: consoleEntries(25) }));
    const tail = feedback.consoleTail as string[];
    expect(tail).toHaveLength(20);
    // Last 20 of 25 = indices 5..24.
    expect(tail[0]).toBe("log: line-5");
    expect(tail[19]).toBe("log: line-24");
  });

  it("produces a human-readable text with definition name/id and legal actions", () => {
    const { text } = buildRunTestDigest(makeRunData());
    expect(text).toContain("Test result (run_test)");
    expect(text).toContain("Round (round)");
    expect(text).toContain("Status: active");
    expect(text).toContain("Legal action types: score, pass");
    expect(text).toContain("attached to this message as context");
  });

  it("renders '(none)' for legal actions when there are none", () => {
    const { text, feedback } = buildRunTestDigest(
      makeRunData({ projection: { state: {}, actions: [] } }),
    );
    expect(text).toContain("Legal action types: (none)");
    expect(feedback.legalActionTypes).toEqual([]);
  });
});

// ── buildRunTestErrorDigest (fail path) ──────────────────────────────────────

describe("buildRunTestErrorDigest", () => {
  it("returns the exact fail-path shape with code + kind", () => {
    const { feedback } = buildRunTestErrorDigest({
      message: "Unexpected token",
      code: "vm_error",
      kind: "syntax",
      console: [{ level: "error", args: ["boom"] }],
    });

    expect(feedback).toEqual({
      ok: false,
      errorCode: "vm_error",
      errorKind: "syntax",
      errorMessage: "Unexpected token",
      consoleTail: ["error: boom"],
    });
  });

  it("omits errorKind when absent and defaults errorCode to 'error'", () => {
    const { feedback } = buildRunTestErrorDigest({ message: "fail", console: [] });
    expect(feedback).toEqual({
      ok: false,
      errorCode: "error",
      errorMessage: "fail",
      consoleTail: [],
    });
    expect("errorKind" in feedback).toBe(false);
  });

  it("caps consoleTail at 20 entries", () => {
    const { feedback } = buildRunTestErrorDigest({
      message: "fail",
      console: consoleEntries(30),
    });
    expect((feedback.consoleTail as string[])).toHaveLength(20);
    expect((feedback.consoleTail as string[])[19]).toBe("log: line-29");
  });
});

// ── buildSimulateDigest (ok path) ────────────────────────────────────────────

describe("buildSimulateDigest", () => {
  it("returns the exact ok-path ExperienceCopilotRunSimulateDigest shape", () => {
    const { feedback } = buildSimulateDigest(makeSimData());

    expect(feedback).toEqual({
      ok: true,
      stopReason: "awaiting_human",
      iterations: 5,
      status: "active",
      revision: 3,
      consoleTail: [],
    });
  });

  it("formats consoleTail and includes it", () => {
    const { feedback } = buildSimulateDigest(
      makeSimData({ console: [{ level: "warn", args: ["careful"] }] }),
    );
    expect(feedback.consoleTail).toEqual(["warn: careful"]);
  });

  it("produces a human-readable text with stop reason + iterations", () => {
    const { text } = buildSimulateDigest(makeSimData());
    expect(text).toContain("Simulation result (run_simulate)");
    expect(text).toContain("Stop reason: awaiting_human");
    expect(text).toContain("Iterations: 5");
  });
});

// ── buildPlaygroundDigest ────────────────────────────────────────────────────

describe("buildPlaygroundDigest", () => {
  it("shapes a live session like the simulate ok-path digest", () => {
    const { feedback } = buildPlaygroundDigest({ session: makePlayground() });

    expect(feedback).toEqual({
      ok: true,
      stopReason: "awaiting_human",
      iterations: 1, // events.length
      status: "active",
      revision: 7,
      consoleTail: ["log: hi"],
    });
  });

  it("flips to the fail-path shape when an error is present", () => {
    const { feedback } = buildPlaygroundDigest({
      session: makePlayground(),
      error: { message: "bad", code: "vm_error", kind: "syntax", console: [] },
    });

    expect(feedback.ok).toBe(false);
    expect(feedback).toMatchObject({
      ok: false,
      errorCode: "vm_error",
      errorKind: "syntax",
      errorMessage: "bad",
      stopReason: "awaiting_human",
      status: "active",
      revision: 7,
    });
  });

  it("includes event/effect counts in the human-readable text", () => {
    const { text } = buildPlaygroundDigest({ session: makePlayground() });
    expect(text).toContain("Events: 1");
    expect(text).toContain("Effects: 1");
    expect(text).toContain("Stop reason: awaiting_human");
  });
});

// ─── playground full-session log digest (grounding step 6) ────────────────

describe("buildPlaygroundLogDigest", () => {
  const launchContext: ExperienceCopilotLaunchContext = {
    participants: [
      { id: "you", label: "You", controller: "human" },
      { id: "bot", label: "Bot", controller: "script" },
    ],
    capabilityGrants: ["participants"],
    seed: "7",
  };

  it("carries the whole session: definition, boundary, legality, launch context, state, effects, events, console", () => {
    const matrix = {
      seats: [
        { participantId: "you", label: "You", controller: "human" as const, actionTypes: ["reply"], count: 1 },
        { participantId: "bot", label: "Bot", controller: "script" as const, actionTypes: [], count: 0 },
      ],
      turnOwners: ["you"],
    };
    const events = [
      { visibility: "public" as const, type: "scored" },
      { visibility: "public" as const, type: "turn_passed" },
    ];
    const { feedback, text } = buildPlaygroundLogDigest({
      session: makePlayground(),
      sessionLog: makeSessionLog({
        events,
        effects: [{ kind: "model", request: { prompt: "n" } }],
        console: [{ level: "log", args: ["hi"] }],
        turns: 2,
      }),
      definition: makeRunData().definition,
      launchContext,
      seatLegality: matrix,
    });

    expect(feedback).toEqual({
      ok: true,
      definition: { id: "round", name: "Round" },
      status: "active",
      revision: 7,
      stopReason: "awaiting_human",
      turns: 2,
      legalActionTypes: ["reply"],
      seatLegality: matrix,
      launchContext: {
        seats: [
          { id: "you", controller: "human" },
          { id: "bot", controller: "script" },
        ],
        grants: ["participants"],
        seed: "7",
      },
      stateSummary: '{"round":2}',
      effects: [{ kind: "model", request: { prompt: "n" } }],
      events,
      eventsTotal: 2,
      console: ["log: hi"],
      consoleTotal: 1,
    });

    expect(text).toContain("Playground session log");
    expect(text).toContain("Definition: Round (round)");
    expect(text).toContain("Turns: 2 · Events: 2 · Effects: 1");
    expect(text).toContain("Seats: you (human), bot (script) · Grants: participants · Seed: 7");
    expect(text).toContain('Seat "You" (id "you", human): reply');
    expect(text).toContain("public/scored | public/turn_passed");
  });

  it("keeps the last 200 events and 100 console lines with their totals, and caps the state at 8000 chars", () => {
    const events = Array.from({ length: 250 }, (_, i) => ({
      visibility: "public" as const,
      type: `ev-${i}`,
    }));
    const { feedback, text } = buildPlaygroundLogDigest({
      session: makePlayground({ state: { blob: "x".repeat(10_000) } }),
      sessionLog: makeSessionLog({ events, console: consoleEntries(150), turns: 3 }),
    });

    const fb = feedback as { events: Array<{ type: string }>; console: string[]; stateSummary: string };
    expect(fb.events).toHaveLength(200);
    expect(fb.events[0]!.type).toBe("ev-50"); // last 200 of 250
    expect(fb.events[199]!.type).toBe("ev-249");
    expect(feedback.eventsTotal).toBe(250);
    expect(fb.console).toHaveLength(100);
    expect(fb.console[0]).toBe("log: line-50"); // last 100 of 150
    expect(fb.console[99]).toBe("log: line-149");
    expect(feedback.consoleTotal).toBe(150);
    expect(fb.stateSummary.length).toBe(8000 + 1); // capped + trailing ellipsis
    expect(fb.stateSummary.endsWith("\u2026")).toBe(true);
    expect(text).toContain("Events (250 total, last 200):");
    expect(text).toContain("Console (150 total, last 100):");
  });

  it("shapes an empty session (no log, no launch context, no matrix) without inventing fields", () => {
    const { feedback, text } = buildPlaygroundLogDigest({
      session: makePlayground({ events: [], effects: [], console: [] }),
      sessionLog: makeSessionLog(),
    });

    expect(feedback).toEqual({
      ok: true,
      definition: { id: "(unknown)", name: "(unknown)" },
      status: "active",
      revision: 7,
      stopReason: "awaiting_human",
      turns: 0,
      legalActionTypes: ["reply"],
      stateSummary: '{"round":2}',
      effects: [],
      events: [],
      eventsTotal: 0,
      console: [],
      consoleTotal: 0,
    });
    expect("launchContext" in feedback).toBe(false);
    expect("seatLegality" in feedback).toBe(false);
    expect(text).toContain("Turns: 0 · Events: 0 · Effects: 0");
    expect(text).toContain("Events (0 total, last 0): none");
  });

  it("flips to the fail-path fields when an error is present", () => {
    const { feedback, text } = buildPlaygroundLogDigest({
      session: makePlayground(),
      sessionLog: makeSessionLog({ events: [{ visibility: "public", type: "boom" }], turns: 1 }),
      error: { message: "reducer fault", code: "vm_error", kind: "reduce", console: [] },
    });

    expect(feedback.ok).toBe(false);
    expect(feedback).toMatchObject({
      errorCode: "vm_error",
      errorKind: "reduce",
      errorMessage: "reducer fault",
      eventsTotal: 1,
    });
    expect(text).toContain("Error: reducer fault");
    expect(text).toContain("Code: vm_error");
  });
});

// ─── realtime loop digest (RM-13) ──────────────────────────────────────────

describe("buildRealtimeLoopDigest", () => {
  it("reports the loop's own state, not the turn-session vocabulary", () => {
    const { feedback, text } = buildRealtimeLoopDigest({
      realtime: { tickMs: 33, seed: 42 },
      diag: {
        view: { score: 3 },
        events: [{ kind: "round_started", seed: 42 }, { kind: "input", action: { type: "left" } }],
        errors: [],
        console: [{ level: "log", text: "hello" }],
        final: false,
      },
      claim: null,
      definition: null,
      error: null,
    });

    expect(feedback).toMatchObject({
      ok: true,
      mode: "realtime",
      tickMs: 33,
      seed: 42,
      status: "running",
    });
    const fb = feedback as { stateSummary?: string; eventTail?: string[]; consoleTail?: string[] };
    expect(fb.stateSummary).toBe('{"score":3}');
    expect(fb.eventTail?.some((l) => l.startsWith("round_started"))).toBe(true);
    expect(fb.consoleTail).toEqual(["log: hello"]);
    // No turn-session lies anywhere.
    expect(feedback.stopReason).toBeUndefined();
    expect(feedback.revision).toBeUndefined();
    expect(text).toContain("Mode: realtime · tick 33ms · seed 42");
    expect(text).toContain("Loop status: running");
  });

  it("a never-booted loop is itself the diagnostic (no sample, not_booted)", () => {
    const { feedback, text } = buildRealtimeLoopDigest({
      realtime: { tickMs: 16, seed: 1 },
      diag: null,
      claim: null,
      definition: null,
      error: null,
    });
    expect(feedback.status).toBe("not_booted");
    expect(feedback.stateSummary).toBeUndefined();
    expect(text).toContain("Loop status: not_booted");
    expect(text).toContain("none (loop never posted a view)");
  });

  it("a finished round reports the claim status and marks errors in the tail", () => {
    const { feedback } = buildRealtimeLoopDigest({
      realtime: { tickMs: 33, seed: 9 },
      diag: {
        events: [{ kind: "round_started", seed: 9 }],
        errors: [{ kind: "watchdog", message: "over budget" }],
        console: [],
        final: true,
      },
      claim: { status: "completed" },
      definition: null,
      error: null,
    });
    expect(feedback.status).toBe("completed");
    const fb = feedback as { errorTail?: string[] };
    expect(fb.errorTail).toEqual(["watchdog: over budget"]);
  });

  it("keeps the raised tails (100 events / 50 errors / 100 console — grounding step 6)", () => {
    const { feedback } = buildRealtimeLoopDigest({
      realtime: { tickMs: 33, seed: 42 },
      diag: {
        events: Array.from({ length: 120 }, (_, i) => ({ kind: `tick-${i}` })),
        errors: Array.from({ length: 60 }, (_, i) => ({ kind: `err-${i}`, message: "m" })),
        console: Array.from({ length: 120 }, (_, i) => ({ level: "log", text: `c-${i}` })),
        final: false,
      },
      claim: null,
      definition: null,
      error: null,
    });
    const fb = feedback as { eventTail?: string[]; errorTail?: string[]; consoleTail?: string[] };
    expect(fb.eventTail).toHaveLength(100);
    expect(fb.eventTail![0]).toContain("tick-20"); // last 100 of 120
    expect(fb.eventTail![99]).toContain("tick-119");
    expect(fb.errorTail).toHaveLength(50);
    expect(fb.errorTail![0]).toContain("err-10"); // last 50 of 60
    expect(fb.consoleTail).toHaveLength(100);
    expect(fb.consoleTail![0]).toBe("log: c-20"); // last 100 of 120
    expect(fb.consoleTail![99]).toBe("log: c-119");
  });
});

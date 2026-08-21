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
  buildRunTestDigest,
  buildRunTestErrorDigest,
  buildSimulateDigest,
} from "./experience-copilot-digest.js";
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
    console: [{ level: "log", args: ["hi"] }],
    revision: 7,
    status: "active",
    stopReason: "awaiting_human",
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

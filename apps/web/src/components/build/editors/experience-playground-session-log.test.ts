/**
 * experience-playground-session-log — the session-log selector boundary tests.
 *
 * Boundary under test: the PURE `buildSessionLogDigest` selector in
 * `experience-playground-session-log.ts` (extracted from
 * `ExperiencePlayground.tsx`, AS-8e7d) — no React, no store, no I/O. Pins the
 * realtime-vs-turn choice the status-strip "send log" / "copy log" buttons
 * rode on when it lived as a component closure: a non-null realtime round
 * selects the loop digest, a null round selects the accumulated turn-session
 * log, and both shapes carry `fullText` for the clipboard path.
 *
 * Runner: bun:test (pure-logic file — no DOM env, no mock.module).
 */
import { describe, expect, it } from "bun:test";
import {
  buildSessionLogDigest,
  type SessionLogDigestInput,
} from "./experience-playground-session-log.js";
import type {
  ExperiencePlaygroundData,
  ExperienceTestDefinition,
} from "../../../api/types.js";
import type { ExperienceLoopConfig } from "../../../lib/experience-loop-host.js";
import type { PlaygroundSessionLog } from "../../../lib/experience-copilot-digest.js";

// ── Factories ────────────────────────────────────────────────────────────────

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

function makeSessionLog(overrides: Partial<PlaygroundSessionLog> = {}): PlaygroundSessionLog {
  return {
    events: [{ visibility: "public", type: "replied" }],
    effects: [{ kind: "model", request: { prompt: "n" } }],
    console: [{ level: "log", args: ["hi"] }],
    turns: 3,
    ...overrides,
  };
}

function makeLoopConfig(overrides: Partial<ExperienceLoopConfig> = {}): ExperienceLoopConfig {
  return {
    rulesSource: "rules",
    tickMs: 33,
    initialState: {},
    seed: 42,
    viewer: { kind: "human" },
    scriptSeats: [],
    ...overrides,
  };
}

const definition: ExperienceTestDefinition = {
  apiVersion: 1,
  manifest: { id: "round", name: "Round", mode: "turn" },
  declaredCapabilities: [{ capability: "participants", reason: "x" }],
  hasChoose: false,
  hasFlavor: false,
  hasUpdate: false,
};

function baseInput(overrides: Partial<SessionLogDigestInput> = {}): SessionLogDigestInput {
  return {
    live: makePlayground(),
    realtimeRound: null,
    loopDiag: null,
    roundClaim: null,
    definition,
    error: null,
    sessionLog: makeSessionLog(),
    logLaunchContext: null,
    ...overrides,
  };
}

// ── buildSessionLogDigest ────────────────────────────────────────────────────

describe("buildSessionLogDigest", () => {
  it("a realtime round selects the loop digest (the frame loop is the authority)", () => {
    const digest = buildSessionLogDigest(
      baseInput({
        realtimeRound: makeLoopConfig(),
        loopDiag: {
          view: { score: 3 },
          events: [{ kind: "round_started", seed: 42 }],
          errors: [],
          console: [{ level: "log", text: "hello" }],
          final: false,
        },
      }),
    );

    expect(digest.text.startsWith("## Playground diagnostics (realtime loop)")).toBe(true);
    // The closure's field mapping moved intact: the loop's own tickMs + seed.
    expect(digest.text).toContain("tick 33ms · seed 42");
    expect(digest.fullText.startsWith("## Playground diagnostics (realtime loop)")).toBe(true);
    expect(digest.fullText).toContain("round_started");
    // No turn-session vocabulary leaks into the realtime branch.
    expect(digest.feedback.stopReason).toBeUndefined();
    expect(digest.feedback.revision).toBeUndefined();
  });

  it("a turn session selects the accumulated whole-session log", () => {
    const digest = buildSessionLogDigest(baseInput());

    expect(digest.text.startsWith("## Playground session log")).toBe(true);
    expect(digest.text).toContain("Turns: 3");
    expect(digest.fullText.startsWith("## Playground session log")).toBe(true);
    // fullText carries every line for the «Copy log» path (the old line format).
    expect(digest.fullText).toContain("public/replied");
    expect(digest.fullText).toContain("log: hi");
  });
});

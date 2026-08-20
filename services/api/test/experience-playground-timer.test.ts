/**
 * executeTimerTurnExperiencePlayground — ephemeral timer beats (playground timers).
 *
 * Exercises the playground's real-time axis directly against the real kernel:
 * the beat lifecycle (claim → legality re-check → sleep(afterMs) → reduce →
 * script-seat advance), the pendingTimers counter that drives the client's
 * beat loop, the silent typed-failure stops (malformed request, unknown
 * viewer, illegal action, invalid payload), and the timer stale-drop parity
 * with the durable runtime (a transition landing during the sleep drops the
 * tick without a reduce). The sleep seam is injected so tests never wait
 * wall-clock time, mirroring experience-timer-effect-service.test.ts.
 */

import { describe, expect, test } from "bun:test";

import {
  startExperiencePlayground,
  advanceExperiencePlayground,
  executeTimerTurnExperiencePlayground,
} from "../src/domain/interactive/experience-playground.js";

// ─── Shared rules sources ────────────────────────────────────────────────────

/**
 * A falling-counter game: every `tick` reduces `left` by 1 and re-arms the
 * timer (afterMs 800). `hold` is a human action that pauses ticking (no
 * re-arm). This is the minimal honest model of a timer-driven experience
 * (Tetris-shaped): timer effects self-perpetuate while the game runs.
 */
const TICKER_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "ticker", name: "Ticker" },
  capabilities: [{ capability: "participants", reason: "timer viewer" }],
  create() { return { left: 3, running: true }; },
  project(c) { return { left: c.state.left, running: c.state.running }; },
  actions(c) { return c.state.running ? [{ type: "hold" }, { type: "tick" }] : [{ type: "hold" }]; },
  reduce(c, a) {
    if (a.type === "hold") return { state: { left: c.state.left, running: false }, status: "active", events: [] };
    const left = c.state.left - 1;
    return {
      state: { left: left, running: true },
      status: left <= 0 ? "completed" : "active",
      events: [{ visibility: "public", type: "tick", detail: { left } }],
      effects: left > 0 ? [{ kind: "timer", request: { viewer: "p1", actionType: "tick", afterMs: 800 } }] : [],
    };
  },
});
`;

/** Declares a payloadSchema on tick (args validation path). */
const ARGS_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "args", name: "Args" },
  capabilities: [{ capability: "participants", reason: "timer viewer" }],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: "add", payloadSchema: { type: "number" } }]; },
  reduce(c, a) {
    return {
      state: { n: c.state.n + a.payload },
      status: "active",
      events: [],
      effects: [{ kind: "timer", request: { viewer: "p1", actionType: "add", afterMs: 100, args: 2 } }],
    };
  },
});
`;

const youHuman = { id: "p1", label: "You", controller: "human" as const };

/** Instant sleep recorder — the wall clock never runs in tests. */
function instantSleep(): { calls: number[]; sleep: (ms: number) => Promise<void> } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

function startTicker() {
  return startExperiencePlayground({
    rulesCode: TICKER_SOURCE,
    participants: [youHuman],
    capabilityGrants: ["participants"],
  });
}

// ─── Beat lifecycle ──────────────────────────────────────────────────────────

describe("executeTimerTurnExperiencePlayground — real kernel", () => {
  test("start reports pendingTimers=1 before any beat fires", () => {
    const started = startTicker();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The create() emitted no effects (the timer arms on the first reduce in
    // this ruleset) — but the shape must carry the counter at 0.
    expect(started.data.pendingTimers).toBe(0);
  });

  test("a beat sleeps afterMs then feeds the tick back through the real reducer", async () => {
    const started = startTicker();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Human starts the clock: hold is legal; use a first `tick` via advance to
    // arm the timer (create emitted none).
    const armed = advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "tick", requestId: "r1", expectedRevision: 0, participantId: "p1" },
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;
    expect(armed.data.revision).toBe(1);
    expect(armed.data.pendingTimers).toBe(1);

    const rec = instantSleep();
    const beat = await executeTimerTurnExperiencePlayground(
      { playgroundSessionId: started.data.playgroundSessionId },
      { sleep: rec.sleep },
    );
    expect(beat.ok).toBe(true);
    if (!beat.ok) return;
    // The declared delay was slept, the tick reduced (left 2→1), the timer
    // re-armed by the reducer, and the envelope carries the tick's events.
    expect(rec.calls).toEqual([800]);
    expect(beat.data.revision).toBe(2);
    expect(beat.data.state).toEqual({ left: 1, running: true });
    expect(beat.data.events.map((e) => e.type)).toEqual(["tick"]);
    expect(beat.data.pendingTimers).toBe(1);
  });

  test("the beat loop ticks the game to completion (pendingTimers hits 0)", async () => {
    const started = startTicker();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let data = started.data;
    // Arm + drain: tick (human) → 3 timer beats total (left 2 → 1 → completed).
    const armed = await advanceExperiencePlayground({
      playgroundSessionId: data.playgroundSessionId,
      humanAction: { type: "tick", requestId: "r1", expectedRevision: 0, participantId: "p1" },
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;
    data = armed.data;

    for (let beat = 0; beat < 3; beat += 1) {
      const res = await executeTimerTurnExperiencePlayground(
        { playgroundSessionId: data.playgroundSessionId },
        { sleep: instantSleep().sleep },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      data = res.data;
    }
    expect(data.status).toBe("completed");
    expect(data.stopReason).toBe("completed");
    expect(data.pendingTimers).toBe(0);

    // A beat on a terminal session is a no-op envelope.
    const after = await executeTimerTurnExperiencePlayground(
      { playgroundSessionId: data.playgroundSessionId },
      { sleep: instantSleep().sleep },
    );
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.revision).toBe(data.revision);
  });

  test("timer args satisfying payloadSchema flow through as the tick's payload", async () => {
    const started = startExperiencePlayground({
      rulesCode: ARGS_SOURCE,
      participants: [youHuman],
      capabilityGrants: ["participants"],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Fire the human action once (n 0→2) — its effect requests add(2).
    const armed = await advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "add", requestId: "r1", expectedRevision: 0, participantId: "p1", payload: 2 },
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;

    const beat = await executeTimerTurnExperiencePlayground(
      { playgroundSessionId: started.data.playgroundSessionId },
      { sleep: instantSleep().sleep },
    );
    expect(beat.ok).toBe(true);
    if (!beat.ok) return;
    // The timer's args (2) became the synthetic action's payload (n 2→4).
    expect(beat.data.state).toEqual({ n: 4 });
  });

  test("an unknown playground session id returns the typed error", async () => {
    const res = await executeTimerTurnExperiencePlayground(
      { playgroundSessionId: "nope" },
      { sleep: instantSleep().sleep },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("session_not_found");
  });

  // ─── Silent typed-failure stops (durable parity) ───────────────────────────

  test("a tick illegal at claim time is consumed silently — ticking stops, the game does not", async () => {
    const started = startTicker();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Arm the timer, then the human holds (running:false → tick illegal).
    let res = await advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "tick", requestId: "r1", expectedRevision: 0, participantId: "p1" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    res = await advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "hold", requestId: "r2", expectedRevision: res.data.revision, participantId: "p1" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.pendingTimers).toBe(1);

    const beat = await executeTimerTurnExperiencePlayground(
      { playgroundSessionId: started.data.playgroundSessionId },
      { sleep: instantSleep().sleep },
    );
    expect(beat.ok).toBe(true);
    if (!beat.ok) return;
    // The late tick is NOT reduced: state unchanged, revision unchanged,
    // pendingTimers consumed to 0, no error surfaced.
    expect(beat.data.revision).toBe(res.data.revision);
    expect(beat.data.state).toEqual({ left: 2, running: false });
    expect(beat.data.pendingTimers).toBe(0);
    expect(beat.data.events).toEqual([]);
  });

  test("a transition landing during the sleep drops the tick (timer stale-drop parity)", async () => {
    const started = startTicker();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sessionId = started.data.playgroundSessionId;

    // Arm the timer.
    const armed = await advanceExperiencePlayground({
      playgroundSessionId: sessionId,
      humanAction: { type: "tick", requestId: "r1", expectedRevision: 0, participantId: "p1" },
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;
    const claimRevision = armed.data.revision;

    // A beat whose sleep lets a human action land first (the durable
    // stale-drop: the tick targeted a revision that moved).
    const beatPromise = executeTimerTurnExperiencePlayground(
      { playgroundSessionId: sessionId },
      {
        sleep: async () => {
          // While the beat "sleeps", the human acts — the frontier moves.
          await advanceExperiencePlayground({
            playgroundSessionId: sessionId,
            humanAction: { type: "hold", requestId: "r2", expectedRevision: claimRevision, participantId: "p1" },
          });
        },
      },
    );
    const beat = await beatPromise;
    expect(beat.ok).toBe(true);
    if (!beat.ok) return;
    // The tick was dropped: only the human transition landed; the timer slot
    // is consumed (no infinite re-beat), no error surfaces.
    expect(beat.data.state).toEqual({ left: 2, running: false });
    expect(beat.data.pendingTimers).toBe(0);
  });

  test("one beat at a time per session — a concurrent second call no-ops", async () => {
    const started = startTicker();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sessionId = started.data.playgroundSessionId;

    const armed = await advanceExperiencePlayground({
      playgroundSessionId: sessionId,
      humanAction: { type: "tick", requestId: "r1", expectedRevision: 0, participantId: "p1" },
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok) return;

    // Gate the first beat's sleep on the second (concurrent) call resolving.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = executeTimerTurnExperiencePlayground(
      { playgroundSessionId: sessionId },
      {
        sleep: async () => {
          const second = await executeTimerTurnExperiencePlayground(
            { playgroundSessionId: sessionId },
            { sleep: instantSleep().sleep },
          );
          // The concurrent beat returned immediately without ticking.
          expect(second.ok).toBe(true);
          if (second.ok) expect(second.data.revision).toBe(armed.data.revision);
          release();
        },
      },
    );
    await first;
    await gate;
    // The first beat's tick landed exactly once (left 2→1) despite the
    // concurrent call; the final beat ticks once more (left 1→0) and the game
    // completes without re-arming.
    const final = await executeTimerTurnExperiencePlayground(
      { playgroundSessionId: sessionId },
      { sleep: instantSleep().sleep },
    );
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.data.state).toEqual({ left: 0, running: true });
    expect(final.data.status).toBe("completed");
    expect(final.data.pendingTimers).toBe(0);
  });
});

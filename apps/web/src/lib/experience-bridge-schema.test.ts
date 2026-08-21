/**
 * experience-bridge-schema — pure wire-schema tests (IR-61).
 *
 * No DOM, no ports: these pin the protocol version, nonce generation, the
 * discriminated-union parsing of both directions, and that every host builder
 * round-trips through `parseHostToVisualStrict`. A regression here means the
 * host and the SDK have drifted on the wire contract.
 */
import { describe, it, expect } from "bun:test";
import {
  BRIDGE_DIAG_MAX_EVENTS,
  BRIDGE_MAX_ROUND_LOG_EVENTS,
  BRIDGE_PROTOCOL_VERSION,
  bridgeErrorCodes,
  buildError,
  buildHello,
  buildLifecycle,
  buildModelResult,
  buildPending,
  buildResult,
  buildState,
  generateSessionNonce,
  parseHostToVisualStrict,
  parseVisualToHost,
} from "./experience-bridge-schema.js";

const env = { nonce: "abc123" };

function validView() {
  return {
    state: { score: 3 },
    actions: [{ type: "play", participantId: "p1", label: "Play" }],
    flavor: { theme: "dark" },
    revision: 7,
    status: "active" as const,
  };
}

describe("experience-bridge-schema — protocol version + nonce", () => {
  it("exposes the pinned protocol version", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
  });

  it("generates 32-hex-char nonces that differ per call", () => {
    const a = generateSessionNonce();
    const b = generateSessionNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("experience-bridge-schema — builders round-trip", () => {
  it("buildHello parses as a host→visual hello", () => {
    const msg = buildHello(env, "sess_1", 0);
    expect(parseHostToVisualStrict(msg)).toEqual(msg);
    expect(msg).toMatchObject({ kind: "hello", nonce: "abc123", sessionId: "sess_1", initialRevision: 0 });
  });

  it("buildState parses and carries the projected view", () => {
    const view = validView();
    const msg = buildState(env, view, { kind: "human", participantId: "p1" });
    expect(parseHostToVisualStrict(msg)).toEqual(msg);
    expect(msg).toMatchObject({ kind: "state", nonce: "abc123" });
  });

  it("buildResult parses with the session status", () => {
    const msg = buildResult(env, "req_1", 8, "active");
    expect(parseHostToVisualStrict(msg)).toEqual(msg);
    expect(msg).toMatchObject({ kind: "result", requestId: "req_1", revision: 8, status: "active" });
  });

  it("buildError parses for every documented error code", () => {
    for (const code of bridgeErrorCodes) {
      const msg = buildError(env, code, "boom", { requestId: "req_1", revision: 3 });
      const parsed = parseHostToVisualStrict(msg);
      expect(parsed).not.toBeNull();
      expect(parsed).toMatchObject({ kind: "error", code, message: "boom" });
    }
  });

  it("buildError omits optional requestId/revision when not given", () => {
    const msg = buildError(env, "protocol_error", "bad");
    expect(parseHostToVisualStrict(msg)).toEqual(msg);
    expect("requestId" in msg).toBe(false);
    expect("revision" in msg).toBe(false);
  });

  it("buildPending + buildLifecycle parse", () => {
    expect(parseHostToVisualStrict(buildPending(env, "typing"))).toMatchObject({ kind: "pending", phase: "typing" });
    expect(parseHostToVisualStrict(buildLifecycle(env, "suspend"))).toMatchObject({ kind: "lifecycle", event: "suspend" });
  });
});

describe("experience-bridge-schema — visual→host parsing", () => {
  it("accepts a well-formed ready/action/resize/finish", () => {
    expect(parseVisualToHost({ v: 1, kind: "ready", nonce: "n" })).not.toBeNull();
    expect(
      parseVisualToHost({
        v: 1,
        kind: "action",
        nonce: "n",
        action: { type: "play", requestId: "r1", expectedRevision: 2 },
      }),
    ).not.toBeNull();
    expect(parseVisualToHost({ v: 1, kind: "resize", nonce: "n", width: 320, height: 240 })).not.toBeNull();
    expect(parseVisualToHost({ v: 1, kind: "finish", nonce: "n", revision: 5 })).not.toBeNull();
  });

  it("rejects a wrong protocol version (fail closed on skew)", () => {
    expect(parseVisualToHost({ v: 2, kind: "ready", nonce: "n" })).toBeNull();
    expect(parseVisualToHost({ v: 0, kind: "ready", nonce: "n" })).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(parseVisualToHost({ v: 1, kind: "bogus", nonce: "n" })).toBeNull();
  });

  it("rejects a malformed action (missing required fields)", () => {
    // action without requestId/expectedRevision is invalid.
    expect(parseVisualToHost({ v: 1, kind: "action", nonce: "n", action: { type: "play" } })).toBeNull();
  });

  it("rejects a non-object message without throwing", () => {
    expect(parseVisualToHost(null)).toBeNull();
    expect(parseVisualToHost("ready")).toBeNull();
    expect(parseVisualToHost(42)).toBeNull();
    expect(parseVisualToHost(undefined)).toBeNull();
  });

  it("rejects negative/zero/resize dimensions", () => {
    expect(parseVisualToHost({ v: 1, kind: "resize", nonce: "n", width: -1, height: 10 })).toBeNull();
  });
});

describe("experience-bridge-schema — host→host strict parse", () => {
  it("rejects a malformed host message", () => {
    expect(parseHostToVisualStrict({ v: 1, kind: "hello" /* missing nonce/sessionId/rev */ })).toBeNull();
    expect(parseHostToVisualStrict({ v: 1, kind: "state", nonce: "n" /* missing view */ })).toBeNull();
  });
});

// ─── realtime round vocabulary (RM-5) ────────────────────────────────────────

describe("experience-bridge-schema — realtime round vocabulary", () => {
  it("round-trips a model_request (visual→host) with and without requestId", () => {
    const msg = parseVisualToHost({
      v: 1,
      kind: "model_request",
      nonce: "n",
      seatId: "m1",
      requestId: "rq-1",
      prompt: { q: "hello" },
    });
    expect(msg).not.toBeNull();
    expect(msg).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "model_request",
      nonce: "n",
      seatId: "m1",
      requestId: "rq-1",
      prompt: { q: "hello" },
    });
    expect(
      parseVisualToHost({ v: 1, kind: "model_request", nonce: "n", seatId: "m1", prompt: null }),
    ).not.toBeNull();
  });

  it("rejects a model_request with an empty seatId", () => {
    expect(parseVisualToHost({ v: 1, kind: "model_request", nonce: "n", seatId: "", prompt: {} })).toBeNull();
  });

  it("round-trips a round_commit and bounds the log + summary", () => {
    const log = [{ kind: "round_started", seed: 1 }, { kind: "round_finished", status: "completed" }];
    const msg = parseVisualToHost({
      v: 1,
      kind: "round_commit",
      nonce: "n",
      status: "completed",
      finalState: { remaining: 0 },
      log,
      score: 42,
      summary: "done",
    });
    expect(msg).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "round_commit",
      nonce: "n",
      status: "completed",
      finalState: { remaining: 0 },
      log,
      score: 42,
      summary: "done",
    });
    // interrupted is the visual-driven abandon claim — also valid
    expect(
      parseVisualToHost({ v: 1, kind: "round_commit", nonce: "n", status: "interrupted", finalState: {}, log: [] }),
    ).not.toBeNull();
    // an active claim is not a terminal round — rejected
    expect(
      parseVisualToHost({ v: 1, kind: "round_commit", nonce: "n", status: "active", finalState: {}, log: [] }),
    ).toBeNull();
  });

  it("rejects an oversized round_commit log", () => {
    const huge = Array.from({ length: BRIDGE_MAX_ROUND_LOG_EVENTS + 1 }, () => ({ kind: "ticks", count: 1 }));
    expect(
      parseVisualToHost({ v: 1, kind: "round_commit", nonce: "n", status: "completed", finalState: {}, log: huge }),
    ).toBeNull();
  });

  it("buildModelResult stamps v+nonce and round-trips host→visual", () => {
    const msg = buildModelResult({ nonce: "n" }, "m1", { type: "speak" }, "rq-1");
    expect(parseHostToVisualStrict(msg)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "model_result",
      nonce: "n",
      seatId: "m1",
      requestId: "rq-1",
      result: { type: "speak" },
    });
    expect(parseHostToVisualStrict(buildModelResult({ nonce: "n" }, "m1", "ramble"))).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "model_result",
      nonce: "n",
      seatId: "m1",
      result: "ramble",
    });
  });
});

// ─── loop_diag (RM-13) ──────────────────────────────────────────────────────

describe("bridge schema — loop_diag", () => {
  it("accepts a well-formed sample (view optional, tails bounded by the SDK)", () => {
    expect(
      parseVisualToHost({
        v: 1,
        kind: "loop_diag",
        nonce: "n",
        view: { score: 2 },
        events: [{ kind: "round_started", seed: 1 }],
        errors: [{ kind: "boot_failed", message: "x" }],
        console: [{ level: "error", text: "boom" }],
        final: false,
      }),
    ).not.toBeNull();
    // view absent (pre-boot sample) is valid
    expect(
      parseVisualToHost({
        v: 1,
        kind: "loop_diag",
        nonce: "n",
        events: [],
        errors: [],
        console: [],
        final: true,
      }),
    ).not.toBeNull();
  });

  it("rejects a bad console level and oversized tails", () => {
    expect(
      parseVisualToHost({
        v: 1,
        kind: "loop_diag",
        nonce: "n",
        events: [],
        errors: [],
        console: [{ level: "trace", text: "no" }],
        final: false,
      }),
    ).toBeNull();
    const huge = Array.from({ length: BRIDGE_DIAG_MAX_EVENTS + 1 }, () => ({ kind: "ticks" }));
    expect(
      parseVisualToHost({ v: 1, kind: "loop_diag", nonce: "n", events: huge, errors: [], console: [], final: false }),
    ).toBeNull();
  });
});

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
  BRIDGE_PROTOCOL_VERSION,
  bridgeErrorCodes,
  buildError,
  buildHello,
  buildLifecycle,
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

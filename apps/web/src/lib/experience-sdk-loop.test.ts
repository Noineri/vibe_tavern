/**
 * VibeExperience SDK — realtime loop surface tests (RM-5).
 *
 * The SDK string is eval'd against a fake window built on a real EventTarget
 * (happy-dom supplies CustomEvent/MessageEvent), so the vt-loop:* channel is
 * exercised exactly as the frame wires it: the SDK subscribes at load, the
 * runtime dispatches, and the two host-bound kinds auto-forward over a REAL
 * MessageChannel into an ExperienceHostBridge (byte-parity with the wire
 * contract). The turn-based surface is regression-tested in
 * experience-bridge.test.ts — those tests are intentionally UNCHANGED.
 */
import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { ExperienceHostBridge, type BridgePort } from "./experience-bridge.js";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "./experience-sdk.js";

useDomEnv();

interface SdkHarness {
  connect: (onView: (v: unknown) => void) => LoopExperience;
  dispatchLoop(type: string, detail: unknown): void;
  listenLoop(type: string): Array<unknown>;
  deliverWindowMessage(data: unknown): void;
}

interface LoopExperience {
  actLocal(type: string, payload?: unknown, opts?: { participantId?: string }): void;
  modelRequest(seatId: string, prompt: unknown): string;
  finishRound(payload?: { status?: string; score?: number; summary?: string }): void;
  onTick(cb: (view: unknown) => void): LoopExperience;
  onLoopEvent(cb: (e: { kind: string }) => void): LoopExperience;
  onRoundFinish(cb: (f: unknown) => void): LoopExperience;
  onRoundError(cb: (e: unknown) => void): LoopExperience;
}

function createHarness(): SdkHarness {
  const target = new EventTarget();
  const fakeWindow = {
    addEventListener: ((type: string, fn: EventListener) => target.addEventListener(type, fn)) as never,
    dispatchEvent: ((e: Event) => target.dispatchEvent(e)) as never,
    crypto: globalThis.crypto,
    VibeExperience: undefined as unknown,
  };
  new Function("window", VIBE_EXPERIENCE_SDK_SOURCE)(fakeWindow);
  const sdk = (fakeWindow as { VibeExperience?: { connect: SdkHarness["connect"] } }).VibeExperience;
  if (sdk === undefined) throw new Error("SDK did not publish VibeExperience");
  return {
    connect: sdk.connect,
    dispatchLoop(type, detail) {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    },
    listenLoop(type) {
      const seen: unknown[] = [];
      target.addEventListener(type, (e) => seen.push((e as CustomEvent).detail));
      return seen;
    },
    deliverWindowMessage(data) {
      target.dispatchEvent(new MessageEvent("message", { data }));
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── author-facing loop subscriptions ───────────────────────────────────────

describe("SDK loop surface — subscriptions", () => {
  test("onTick delivers live views and the cached latest to a late subscriber", () => {
    const h = createHarness();
    h.dispatchLoop("vt-loop:view", { remaining: 10 });
    h.dispatchLoop("vt-loop:view", { remaining: 5 }); // latest wins
    const xp = h.connect(() => {});
    const seen: unknown[] = [];
    xp.onTick((v) => seen.push(v));
    expect(seen).toEqual([{ remaining: 5 }]); // cached, exactly once
    h.dispatchLoop("vt-loop:view", { remaining: 0 });
    expect(seen).toEqual([{ remaining: 5 }, { remaining: 0 }]);
  });

  test("onLoopEvent replays the buffered round log tail, then streams live", () => {
    const h = createHarness();
    // Events fired BEFORE connect (the SDK loads before the loop boots —
    // round_started can already be on the window by the time the visual binds).
    h.dispatchLoop("vt-loop:event", { kind: "round_started", seed: 42 });
    h.dispatchLoop("vt-loop:event", { kind: "ticks", count: 3 });
    const xp = h.connect(() => {});
    const seen: string[] = [];
    xp.onLoopEvent((e) => seen.push(e.kind));
    expect(seen).toEqual(["round_started", "ticks"]);
    h.dispatchLoop("vt-loop:event", { kind: "input", action: { type: "poke" } });
    expect(seen).toEqual(["round_started", "ticks", "input"]);
  });

  test("onRoundFinish / onRoundError deliver the loop payloads", () => {
    const h = createHarness();
    const xp = h.connect(() => {});
    const finishes: unknown[] = [];
    const errors: unknown[] = [];
    xp.onRoundFinish((f) => finishes.push(f));
    xp.onRoundError((e) => errors.push(e));
    h.dispatchLoop("vt-loop:finish", { status: "completed", finalState: {}, log: [] });
    h.dispatchLoop("vt-loop:error", { kind: "watchdog", message: "over" });
    expect((finishes[0] as { status: string }).status).toBe("completed");
    expect((errors[0] as { kind: string }).kind).toBe("watchdog");
  });
});

// ─── author-facing loop actions (frame-local) ───────────────────────────────

describe("SDK loop surface — frame-local actions", () => {
  test("actLocal dispatches vt-loop:input with the intention (no port needed)", () => {
    const h = createHarness();
    const inputs = h.listenLoop("vt-loop:input");
    const xp = h.connect(() => {});
    xp.actLocal("poke", { x: 1 }, { participantId: "p1" });
    expect(inputs).toEqual([{ type: "poke", participantId: "p1", payload: { x: 1 } }]);
  });

  test("modelRequest returns a correlation id and dispatches vt-loop:model-request", () => {
    const h = createHarness();
    const reqs = h.listenLoop("vt-loop:model-request");
    const xp = h.connect(() => {});
    const requestId = xp.modelRequest("m1", { q: "hello" });
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reqs).toEqual([{ seatId: "m1", prompt: { q: "hello" }, requestId }]);
  });

  test("finishRound dispatches vt-loop:finish-request with the claim", () => {
    const h = createHarness();
    const claims = h.listenLoop("vt-loop:finish-request");
    const xp = h.connect(() => {});
    xp.finishRound({ status: "interrupted", score: 42, summary: "gave up" });
    expect(claims).toEqual([{ status: "interrupted", score: 42, summary: "gave up" }]);
  });
});

// ─── host-bound auto-forwarding (real MessageChannel + bridge) ─────────────

describe("SDK loop surface — host bridge auto-forward", () => {
  test("a logged model_request reaches bridge.onModelRequest over the port", async () => {
    const channel = new MessageChannel();
    const received: Array<{ seatId: string; requestId?: string; prompt: unknown }> = [];
    const bridge = new ExperienceHostBridge({
      sessionId: "sess_rt",
      initialRevision: 0,
      onAction: () => {},
      onModelRequest: (r) => received.push(r),
    });
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);
    const h = createHarness();
    h.deliverWindowMessage({ kind: "port", port: channel.port2 });
    bridge.sendHello();
    await tick();

    // Pre-handshake forwards are dropped (no nonce yet) — simulate by never
    // racing: the handshake above completed, so this one must arrive.
    h.dispatchLoop("vt-loop:event", { kind: "model_request", seatId: "m1", prompt: { q: "hi" }, requestId: "rq-9" });
    await tick();
    expect(received).toEqual([{ seatId: "m1", requestId: "rq-9", prompt: { q: "hi" } }]);
  });

  test("model_request before the handshake is NOT forwarded (fail closed)", async () => {
    const channel = new MessageChannel();
    const received: unknown[] = [];
    const bridge = new ExperienceHostBridge({
      sessionId: "sess_rt",
      initialRevision: 0,
      onAction: () => {},
      onModelRequest: (r) => received.push(r),
    });
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);
    const h = createHarness();
    h.deliverWindowMessage({ kind: "port", port: channel.port2 });
    // No hello yet → the SDK has no nonce → no auto-forward.
    h.dispatchLoop("vt-loop:event", { kind: "model_request", seatId: "m1", prompt: {}, requestId: "rq-x" });
    await tick();
    expect(received).toEqual([]);
  });

  test("vt-loop:finish auto-commits as round_commit with score/summary", async () => {
    const channel = new MessageChannel();
    const commits: Array<Record<string, unknown>> = [];
    const bridge = new ExperienceHostBridge({
      sessionId: "sess_rt",
      initialRevision: 0,
      onAction: () => {},
      onRoundCommit: (c) => commits.push(c as unknown as Record<string, unknown>),
    });
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);
    const h = createHarness();
    h.deliverWindowMessage({ kind: "port", port: channel.port2 });
    bridge.sendHello();
    await tick();

    h.dispatchLoop("vt-loop:finish", {
      status: "completed",
      finalState: { score: 42 },
      log: [{ kind: "round_started", seed: 1 }, { kind: "round_finished", status: "completed" }],
      score: 42,
      summary: "done",
    });
    await tick();
    expect(commits.length).toBe(1);
    expect(commits[0]).toEqual({
      status: "completed",
      finalState: { score: 42 },
      log: [{ kind: "round_started", seed: 1 }, { kind: "round_finished", status: "completed" }],
      score: 42,
      summary: "done",
    });
  });

  test("bridge.sendModelResult re-enters the frame as vt-loop:model-result", async () => {
    const channel = new MessageChannel();
    const bridge = new ExperienceHostBridge({
      sessionId: "sess_rt",
      initialRevision: 0,
      onAction: () => {},
    });
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);
    const h = createHarness();
    const results = h.listenLoop("vt-loop:model-result");
    h.deliverWindowMessage({ kind: "port", port: channel.port2 });
    bridge.sendHello();
    await tick();

    bridge.sendModelResult("m1", { type: "speak", payload: { text: "hi" } }, "rq-9");
    await tick();
    expect(results).toEqual([{ seatId: "m1", result: { type: "speak", payload: { text: "hi" } }, requestId: "rq-9" }]);
  });
});

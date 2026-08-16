/**
 * ExperienceHostBridge — protocol brain + live parity tests (IR-61).
 *
 * Two layers:
 *   1. Unit: drive `handleMessage(raw)` directly with a fake recording port to
 *      assert handshake-once, nonce rejection, stale-revision fast-reject,
 *      duplicate-click lock, lock-clear-on-result/error, and resize/finish
 *      dispatch. No DOM, no real ports.
 *   2. Integration: wire the bridge to the eval'd `VibeExperience` SDK over a
 *      real `MessageChannel` (bun supports MessagePort natively, no DOM needed)
 *      and assert a full handshake → sendState → act round-trip. This is the
 *      byte-for-byte parity check that the host and the frame SDK agree on the
 *      wire contract end to end.
 */
import { describe, it, expect } from "bun:test";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import { ExperienceHostBridge, type BridgePort } from "./experience-bridge.js";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "./experience-sdk.js";

// ─── Fake recording port (outbound capture) ─────────────────────────────────

interface RecordedPort extends BridgePort {
  sent: unknown[];
}
function recordedPort(): RecordedPort {
  const sent: unknown[] = [];
  return {
    sent,
    postMessage: (m: unknown) => sent.push(m),
    onmessage: null,
    onmessageerror: null,
    start() {},
    close() {},
  };
}

function baseOpts(over: Partial<ExperienceHostBridgeOptions>): ExperienceHostBridgeOptions {
  return {
    sessionId: "sess_1",
    initialRevision: 0,
    onAction: over.onAction ?? (() => {}),
    ...(over as object),
  } as ExperienceHostBridgeOptions;
}
type ExperienceHostBridgeOptions = ConstructorParameters<typeof ExperienceHostBridge>[0];

function viewAt(revision: number) {
  return {
    state: { score: revision },
    actions: [{ type: "play", participantId: "p1", label: "Play" }],
    revision,
    status: "active" as const,
  };
}

// ─── Unit: protocol brain ───────────────────────────────────────────────────

describe("ExperienceHostBridge — handshake + nonce identity", () => {
  it("fires onReady once when a matching-nonce ready arrives", () => {
    let ready = 0;
    const b = new ExperienceHostBridge(baseOpts({ onReady: () => (ready += 1), onAction: () => {} }));
    const nonce = b.sessionNonce;
    b.handleMessage({ v: 1, kind: "ready", nonce });
    b.handleMessage({ v: 1, kind: "ready", nonce }); // duplicate ready is a no-op
    expect(ready).toBe(1);
    expect(b.isReady).toBe(true);
  });

  it("drops a message with a stale/wrong nonce (foreign or previous-session frame)", () => {
    const actions: ExperienceActionDto[] = [];
    const errors: string[] = [];
    const b = new ExperienceHostBridge(
      baseOpts({ onAction: (a) => actions.push(a), onProtocolError: (r) => errors.push(r) }),
    );
    // Correct nonce would be b.sessionNonce; post with a foreign one.
    b.handleMessage({
      v: 1,
      kind: "action",
      nonce: "not-the-real-nonce",
      action: { type: "play", requestId: "r1", expectedRevision: 0 },
    });
    expect(actions).toHaveLength(0);
    expect(errors).toContain("stale_nonce");
  });

  it("drops a malformed message via onProtocolError without throwing", () => {
    const errors: string[] = [];
    const b = new ExperienceHostBridge(baseOpts({ onAction: () => {}, onProtocolError: (r) => errors.push(r) }));
    b.handleMessage({ totally: "broken" });
    b.handleMessage(null);
    expect(errors.filter((e) => e === "malformed_message").length).toBe(2);
  });
});

describe("ExperienceHostBridge — action validation: revision + duplicate lock", () => {
  it("forwards a valid, current-revision action and locks", () => {
    const port = recordedPort();
    const actions: ExperienceActionDto[] = [];
    const b = new ExperienceHostBridge(baseOpts({ onAction: (a) => actions.push(a) }));
    b.bindHostPort(port);
    // Establish authoritative revision 5 by pushing a state.
    b.sendState(viewAt(5));
    expect(b.revision).toBe(5);
    b.handleMessage({
      v: 1,
      kind: "action",
      nonce: b.sessionNonce,
      action: { type: "play", requestId: "r1", expectedRevision: 5 },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("play");
  });

  it("fast-rejects a stale-revision action with an error and does NOT forward", () => {
    const port = recordedPort();
    const actions: ExperienceActionDto[] = [];
    const b = new ExperienceHostBridge(baseOpts({ onAction: (a) => actions.push(a) }));
    b.bindHostPort(port);
    b.sendState(viewAt(5)); // authoritative revision is now 5
    b.handleMessage({
      v: 1,
      kind: "action",
      nonce: b.sessionNonce,
      action: { type: "play", requestId: "r1", expectedRevision: 3 }, // stale
    });
    expect(actions).toHaveLength(0);
    expect(port.sent.some((m) => (m as { kind?: string }).kind === "error")).toBe(true);
    const err = port.sent.find((m) => (m as { kind?: string }).kind === "error") as {
      code: string;
      requestId?: string;
      revision?: number;
    };
    expect(err.code).toBe("stale_revision");
    expect(err.requestId).toBe("r1");
    expect(err.revision).toBe(5);
  });

  it("drops a second action while one is in flight (duplicate-click lock)", () => {
    const port = recordedPort();
    const actions: ExperienceActionDto[] = [];
    const errors: string[] = [];
    const b = new ExperienceHostBridge(
      baseOpts({ onAction: (a) => actions.push(a), onProtocolError: (r) => errors.push(r) }),
    );
    b.bindHostPort(port);
    b.sendState(viewAt(2));
    b.handleMessage({
      v: 1, kind: "action", nonce: b.sessionNonce,
      action: { type: "play", requestId: "r1", expectedRevision: 2 },
    });
    // Same requestId again while r1 is in flight → duplicate.
    b.handleMessage({
      v: 1, kind: "action", nonce: b.sessionNonce,
      action: { type: "play", requestId: "r1", expectedRevision: 2 },
    });
    // A different requestId while r1 is in flight → busy.
    b.handleMessage({
      v: 1, kind: "action", nonce: b.sessionNonce,
      action: { type: "play", requestId: "r2", expectedRevision: 2 },
    });
    expect(actions).toHaveLength(1);
    expect(errors).toContain("duplicate_request");
    expect(errors).toContain("busy");
  });

  it("clears the lock on sendResult so the next action proceeds", () => {
    const port = recordedPort();
    const actions: ExperienceActionDto[] = [];
    const b = new ExperienceHostBridge(baseOpts({ onAction: (a) => actions.push(a) }));
    b.bindHostPort(port);
    b.sendState(viewAt(1));
    b.handleMessage({
      v: 1, kind: "action", nonce: b.sessionNonce,
      action: { type: "play", requestId: "r1", expectedRevision: 1 },
    });
    b.sendResult("r1", 2, "active"); // clears lock, advances revision to 2
    expect(b.revision).toBe(2);
    b.handleMessage({
      v: 1, kind: "action", nonce: b.sessionNonce,
      action: { type: "play", requestId: "r2", expectedRevision: 2 },
    });
    expect(actions).toHaveLength(2);
  });

  it("clears the lock on sendError for the matching requestId", () => {
    const port = recordedPort();
    const actions: ExperienceActionDto[] = [];
    const b = new ExperienceHostBridge(baseOpts({ onAction: (a) => actions.push(a) }));
    b.bindHostPort(port);
    b.sendState(viewAt(1));
    b.handleMessage({
      v: 1, kind: "action", nonce: b.sessionNonce,
      action: { type: "play", requestId: "r1", expectedRevision: 1 },
    });
    b.sendError("invalid_action", "nope", { requestId: "r1" });
    b.handleMessage({
      v: 1, kind: "action", nonce: b.sessionNonce,
      action: { type: "play", requestId: "r2", expectedRevision: 1 },
    });
    expect(actions).toHaveLength(2);
  });
});

describe("ExperienceHostBridge — resize + finish dispatch", () => {
  it("forwards resize and finish on the active nonce", () => {
    const resizes: { width: number; height: number }[] = [];
    const finishes: number[] = [];
    const b = new ExperienceHostBridge(
      baseOpts({ onAction: () => {}, onResize: (s) => resizes.push(s), onFinish: (r) => finishes.push(r) }),
    );
    const nonce = b.sessionNonce;
    b.handleMessage({ v: 1, kind: "resize", nonce, width: 300, height: 500 });
    b.handleMessage({ v: 1, kind: "finish", nonce, revision: 9 });
    expect(resizes).toEqual([{ width: 300, height: 500 }]);
    expect(finishes).toEqual([9]);
  });
});

// ─── Integration: bridge ↔ eval'd SDK over a real MessageChannel ────────────

/**
 * A minimal frame harness: a fake `window` (addEventListener + crypto from the
 * host global) into which the SDK source is evaluated. Lets us drive the SDK
 * with a real MessagePort without a DOM. The SDK sets `window.VibeExperience`.
 */
function createSdkHarness() {
  const messageListeners: Array<(ev: { data: unknown }) => void> = [];
  const fakeWindow = {
    addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
      if (type === "message") messageListeners.push(fn);
    },
    crypto: globalThis.crypto,
    VibeExperience: undefined as unknown,
  };
  // Run the SDK IIFE with `window` bound to the fake. Bare `crypto`/`Math`/etc.
  // resolve to the bun globals (the SDK only needs crypto.getRandomValues).
  new Function("window", VIBE_EXPERIENCE_SDK_SOURCE)(fakeWindow);
  return {
    window: fakeWindow,
    deliverWindowMessage(data: unknown) {
      for (const fn of messageListeners) fn({ data });
    },
  };
}

describe("ExperienceHostBridge ↔ VibeExperience SDK — live parity", () => {
  it("handshakes, projects state, and round-trips an action over real ports", async () => {
    const channel = new MessageChannel();
    const seenViews: unknown[] = [];
    const actions: ExperienceActionDto[] = [];
    let ready = false;

    // Host bridge on port1.
    const bridge = new ExperienceHostBridge(
      baseOpts({ onReady: () => (ready = true), onAction: (a) => actions.push(a) }),
    );
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);

    // Frame SDK on the harness, handed port2 via the window 'port' message.
    const harness = createSdkHarness();
    harness.deliverWindowMessage({ kind: "port", port: channel.port2 });

    // The visual source connects and renders. Held on the harness window.
    const xp = (harness.window.VibeExperience as {
      connect: (onView: (v: unknown) => void) => { act: (t: string, p?: unknown) => void };
    }).connect((view) => seenViews.push(view));

    // Host sends hello (the SDK binds nonce + replies ready). Wait one tick for
    // the MessagePort delivery (ports deliver on the next macrotask).
    bridge.sendHello();
    await tick();
    expect(ready).toBe(true);

    // Host projects authoritative state.
    bridge.sendState(viewAt(1));
    await tick();
    expect(seenViews).toHaveLength(1);

    // Frame submits an action → host onAction fires.
    xp.act("play");
    await tick();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.expectedRevision).toBe(1);
    expect(actions[0]!.type).toBe("play");

    // Host acks; the lock clears.
    bridge.sendResult(actions[0]!.requestId, 2, "active");
    await tick();
    // A second action at the new revision proceeds.
    xp.act("play");
    await tick();
    expect(actions).toHaveLength(2);
    expect(actions[1]!.expectedRevision).toBe(2);
  });

  it("fails closed when the SDK sees a wrong protocol version", async () => {
    const channel = new MessageChannel();
    const seenViews: unknown[] = [];
    const bridge = new ExperienceHostBridge(baseOpts({ onAction: () => {} }));
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);
    const harness = createSdkHarness();
    harness.deliverWindowMessage({ kind: "port", port: channel.port2 });
    (harness.window.VibeExperience as { connect: (f: (v: unknown) => void) => void }).connect((v) =>
      seenViews.push(v),
    );
    bridge.sendHello();
    await tick();
    // Manually post a state with a WRONG version directly on the frame port —
    // the SDK must ignore it (no view rendered).
    channel.port1.postMessage({ v: 999, kind: "state", nonce: bridge.sessionNonce, view: viewAt(1) });
    await tick();
    expect(seenViews).toHaveLength(0);
  });
});

function tick(): Promise<void> {
  // A handshake→ready→state→act round-trip crosses MessagePort several times
  // (each hop is its own macrotask). Drain a bounded number of ticks so multi-
  // hop exchanges settle in one await (same rationale as dom-env's scheduler
  // flush). 6 covers the longest single await here (a 2-hop hello→ready).
  return new Promise((resolve) => {
    let left = 6;
    const step = () => {
      if (left-- <= 0) return resolve();
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

// ─── IR-90E: Conversation visual ↔ real bridge round-trip ──────────────────
//
// Tests the UNCHANGED shipped Conversation visual source through the REAL
// bridge + SDK over a real MessageChannel. This is the boundary the parent
// acceptance review required: complete the handshake, send the real
// projection/actions, assert the visual's textarea becomes enabled, type text,
// submit through the visual bridge, and verify the action carries
// {type:'reply', payload:{text}}. NOT a visual fixture or source substring.

import { CONVERSATION_VISUAL_SOURCE } from "../components/experience/starters/conversation.js";

/** A typed fake DOM element sufficient for the Conversation visual's needs.
 *  Previously typed as Record<string,unknown>, which caused TS2339 on
 *  `style.display` — the index-signature value `unknown` blocks optional
 *  property access in strict mode (IR-90E2 fix). */
interface FakeElementStyle {
  [key: string]: string;
}

interface FakeElement {
  id: string;
  className: string;
  innerHTML: string;
  textContent: string;
  disabled: boolean;
  value: string;
  style: FakeElementStyle;
  onclick: (() => void) | null;
  addEventListener: () => void;
  appendChild: (c: Record<string, unknown>) => void;
  scrollTop: number;
  scrollHeight: number;
  scrollWidth: number;
  clientWidth: number;
  _children: Record<string, unknown>[];
}

function fakeElement(id: string): FakeElement {
  const children: Record<string, unknown>[] = [];
  return {
    id,
    className: "",
    innerHTML: "",
    textContent: "",
    disabled: false,
    value: "",
    style: { display: "" },
    onclick: null,
    addEventListener: () => {},
    appendChild: (c: Record<string, unknown>) => { children.push(c); },
    scrollTop: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
    _children: children,
  };
}

/** A fake window + document sufficient for evaluating the Conversation visual.
 *  The SDK is evaluated first (sets window.VibeExperience), then the visual's
 *  <script> is extracted and evaluated (calls VibeExperience.connect).
 *  `fakeDocument` includes `createTextNode` because the real Conversation
 *  render loop calls `document.createTextNode(m.text)` for every message;
 *  without it the render throws, the SDK catches the exception, and the
 *  pending-state assertion never reaches the `disabled=true` code path. */
function createConversationHarness() {
  const messageListeners: Array<(ev: { data: unknown }) => void> = [];
  const elements = new Map<string, FakeElement>();

  function ensureElement(id: string): FakeElement {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id)!;
  }

  const fakeDocument = {
    getElementById: (id: string) => ensureElement(id),
    createElement: (_tag: string) => fakeElement("created"),
    createTextNode: (text: string): Record<string, unknown> => ({ textContent: text, nodeType: 3 }),
  };

  const fakeWindow = {
    addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
      if (type === "message") messageListeners.push(fn);
    },
    crypto: globalThis.crypto,
    document: fakeDocument,
    VibeExperience: undefined as unknown,
  };

  // 1. Evaluate the SDK IIFE into the fake window.
  new Function("window", VIBE_EXPERIENCE_SDK_SOURCE)(fakeWindow);

  // 2. Extract and evaluate the Conversation visual's <script> content.
  const scriptMatch = CONVERSATION_VISUAL_SOURCE.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) throw new Error("no <script> in Conversation visual source");
  new Function("window", "document", scriptMatch[1]!)(fakeWindow, fakeDocument);

  return {
    window: fakeWindow,
    elements,
    deliverWindowMessage(data: unknown) {
      for (const fn of messageListeners) fn({ data });
    },
  };
}

describe("IR-90E: Conversation visual ↔ real bridge round-trip", () => {
  it("handshakes, enables the textarea on reply action, submits reply with text payload, and receives the action", async () => {
    const channel = new MessageChannel();
    const actions: ExperienceActionDto[] = [];
    let ready = false;

    // Host bridge.
    const bridge = new ExperienceHostBridge(
      baseOpts({ onReady: () => (ready = true), onAction: (a) => actions.push(a) }),
    );
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);

    // Frame harness with the REAL Conversation visual.
    const harness = createConversationHarness();
    harness.deliverWindowMessage({ kind: "port", port: channel.port2 });

    // Handshake.
    bridge.sendHello();
    await tick();
    expect(ready).toBe(true);

    // Send the initial projection with reply + finish actions (what the
    // Model Conversation rules project for the human seat).
    bridge.sendState({
      state: { messages: [], turn: 0 },
      actions: [
        { type: "reply", label: "Reply", allowsText: true },
        { type: "finish", label: "Finish" },
      ],
      revision: 0,
      status: "active",
    });
    await tick();

    // The Conversation visual's textarea (xp-input) should be ENABLED
    // (not disabled) because the reply action is present.
    const inputEl = harness.elements.get("xp-input");
    expect(inputEl).toBeTruthy();
    expect(inputEl!.disabled).toBe(false);

    // The Finish button should be visible (display !== 'none') because the
    // finish action is present.
    const finishBtn = harness.elements.get("xp-finish");
    expect(finishBtn).toBeTruthy();
    // The visual sets display to 'block' when finish is available.
    expect(String(finishBtn!.style?.display ?? "")).not.toBe("none");

    // Type text into the textarea and submit through the visual bridge.
    inputEl!.value = "Hello from the visual!";
    const sendBtn = harness.elements.get("xp-send");
    expect(sendBtn?.onclick).toBeTruthy();
    (sendBtn!.onclick as () => void)();
    await tick();

    // The host bridge received the action with the text payload.
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("reply");
    expect(actions[0]!.payload).toEqual({ text: "Hello from the visual!" });
    expect(actions[0]!.expectedRevision).toBe(0);

    // Ack the action and send the next state (after the model turn, both
    // messages present). The visual should render the new messages.
    bridge.sendResult(actions[0]!.requestId, 1, "active");
    bridge.sendState({
      state: {
        messages: [
          { from: "you", text: "Hello from the visual!" },
          { from: "them", text: "Hi there!" },
        ],
        turn: 2,
      },
      actions: [
        { type: "reply", label: "Reply", allowsText: true },
        { type: "finish", label: "Finish" },
      ],
      revision: 1,
      status: "active",
    });
    await tick();

    // After the ack, a second action at the new revision proceeds (the
    // duplicate-click lock was cleared by sendResult).
    inputEl!.value = "Second message";
    (sendBtn!.onclick as () => void)();
    await tick();
    expect(actions).toHaveLength(2);
    expect(actions[1]!.expectedRevision).toBe(1);
    expect(actions[1]!.payload).toEqual({ text: "Second message" });
  });

  it("disables the textarea when no reply action is present (pending state)", async () => {
    const channel = new MessageChannel();
    let ready = false;
    const bridge = new ExperienceHostBridge(baseOpts({ onReady: () => (ready = true), onAction: () => {} }));
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);
    const harness = createConversationHarness();
    harness.deliverWindowMessage({ kind: "port", port: channel.port2 });

    bridge.sendHello();
    await tick();
    expect(ready).toBe(true);

    // Send a state WITH reply first (so the visual enables the textarea),
    // then send a state WITHOUT reply (the pending state).
    bridge.sendState({
      state: { messages: [] },
      actions: [{ type: "reply", allowsText: true }],
      revision: 0,
      status: "active",
    });
    await tick();
    expect(harness.elements.get("xp-input")!.disabled).toBe(false);

    // Now send the pending state with NO actions.
    bridge.sendState({
      state: { messages: [{ from: "you", text: "Hello" }] },
      actions: [],
      revision: 1,
      status: "active",
    });
    await tick();

    // The textarea should now be DISABLED.
    expect(harness.elements.get("xp-input")!.disabled).toBe(true);
  });
});
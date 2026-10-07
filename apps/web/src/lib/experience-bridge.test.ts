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
// Tests the UNCHANGED shipped Conversation visual source (the owner's
// Messenger, report step 4a) through the REAL bridge + SDK over a real
// MessageChannel. This is the boundary the parent acceptance review required:
// complete the handshake, send the real projection/actions, open the chat,
// assert the visual's composer becomes enabled, type text, submit through the
// visual bridge, and verify the action carries the chat-scoped
// {type:'reply', payload:{chatId, text}} the REAL Messenger rules consume.
// NOT a visual fixture or source substring.

import { CONVERSATION_VISUAL_SOURCE } from "../components/experience/starters/conversation.js";

/** A generic fake DOM node sufficient for evaluating the Messenger visual.
 *  Derived from the surface the owner's visual actually touches (createElement
 *  trees, class-token queries, attribute reads, parentNode.removeChild,
 *  lastChild styling) — the retired compact visual needed only a fixed
 *  property bag, the Messenger renders a full three-tab tree (report step 4a
 *  re-pin: the boundary is unchanged — REAL visual source evaluated against
 *  the REAL SDK). */
class FakeNode {
  readonly tagName: string;
  id = "";
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  title = "";
  maxLength = 0;
  placeholder = "";
  scrollTop = 0;
  scrollHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  parentNode: FakeNode | null = null;
  onclick: ((ev?: unknown) => void) | null = null;
  oninput: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onkeydown: ((ev: { key: string; shiftKey?: boolean; preventDefault: () => void }) => void) | null = null;
  private readonly children: FakeNode[] = [];
  private innerHtml = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  /** The visual only ever assigns "" here — a clear, mirroring a real DOM. */
  set innerHTML(next: string) {
    this.innerHtml = next;
    if (next === "") {
      for (const child of this.children.splice(0)) child.parentNode = null;
    }
  }

  get innerHTML(): string {
    return this.innerHtml;
  }

  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  get lastChild(): FakeNode | null {
    return this.children.length > 0 ? this.children[this.children.length - 1]! : null;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name]! : null;
  }

  /** The only selector shapes the visual uses: '.class' or 'tag'. */
  private matches(selector: string): boolean {
    if (selector.startsWith(".")) {
      return this.className.split(/\s+/).includes(selector.slice(1));
    }
    return this.tagName === selector;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
}

/** Build the Messenger's static skeleton (the ids/classes its script grabs
 *  at eval time — including the three tab buttons it wires by data-tab). */
function buildMessengerSkeleton(byId: Map<string, FakeNode>): FakeNode {
  const root = new FakeNode("div");
  root.className = "xp-shell";
  root.id = "xp-root";
  byId.set("xp-root", root);

  const app = root.appendChild(new FakeNode("div"));
  app.className = "xp-app";

  const top = app.appendChild(new FakeNode("header"));
  top.className = "xp-top";
  const title = top.appendChild(new FakeNode("div"));
  title.className = "xp-title";
  title.textContent = "Chats";
  title.id = "xp-title";
  byId.set("xp-title", title);

  const content = app.appendChild(new FakeNode("div"));
  content.className = "xp-content";
  content.id = "xp-content";
  byId.set("xp-content", content);

  const fab = app.appendChild(new FakeNode("button"));
  fab.className = "xp-fab";
  fab.id = "xp-fab";
  fab.textContent = "+";
  byId.set("xp-fab", fab);

  const tabs = app.appendChild(new FakeNode("nav"));
  tabs.className = "xp-tabs";
  tabs.id = "xp-tabs";
  byId.set("xp-tabs", tabs);
  for (const tabName of ["chats", "characters", "profile"] as const) {
    const tab = tabs.appendChild(new FakeNode("button"));
    tab.className = tabName === "chats" ? "xp-tab active" : "xp-tab";
    tab.attributes["data-tab"] = tabName;
    const icon = tab.appendChild(new FakeNode("span"));
    icon.textContent = "◌";
    tab.textContent = tabName;
  }

  const layer = app.appendChild(new FakeNode("div"));
  layer.id = "xp-layer";
  byId.set("xp-layer", layer);

  const error = app.appendChild(new FakeNode("div"));
  error.className = "xp-error";
  error.id = "xp-error";
  error.style.display = "none";
  byId.set("xp-error", error);

  return root;
}

/** A fake window + document sufficient for evaluating the Messenger visual.
 *  The SDK is evaluated first (sets window.VibeExperience), then the visual's
 *  <script> is extracted and evaluated (calls VibeExperience.connect and
 *  renders each view the bridge pushes into the fake tree). */
function createConversationHarness() {
  const messageListeners: Array<(ev: { data: unknown }) => void> = [];
  const elements = new Map<string, FakeNode>();
  const root = buildMessengerSkeleton(elements);

  const fakeDocument = {
    getElementById: (id: string): FakeNode | null => elements.get(id) ?? null,
    createElement: (tag: string): FakeNode => new FakeNode(tag),
    createTextNode: (text: string): FakeNode => {
      const node = new FakeNode("#text");
      node.textContent = text;
      return node;
    },
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

  // 2. Extract and evaluate the Messenger visual's <script> content.
  const scriptMatch = CONVERSATION_VISUAL_SOURCE.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) throw new Error("no <script> in Conversation visual source");
  new Function("window", "document", scriptMatch[1]!)(fakeWindow, fakeDocument);

  return {
    window: fakeWindow,
    elements,
    /** Query the live rendered tree from the shell root ('.class' or 'tag'). */
    querySelector: (selector: string): FakeNode | null => root.querySelector(selector),
    querySelectorAll: (selector: string): FakeNode[] => root.querySelectorAll(selector),
    deliverWindowMessage(data: unknown) {
      for (const fn of messageListeners) fn({ data });
    },
  };
}

describe("IR-90E: Conversation visual ↔ real bridge round-trip", () => {
  // The Messenger's projected human view with ONE active chat (the shape the
  // REAL rules project after create_character + create_chat — see the parity
  // suite). The composer lives INSIDE the opened chat, so the round trip opens
  // it via the chat-list item's click handler, exactly as a user does.
  const ADA = { id: 1, name: "Ada", description: "A test character", modelId: "ai_seat", modelLabel: "AI" };

  function messengerView(revision: number, overrides: {
    messages?: Array<{ from: string; characterId: number | null; fromName: string; text: string }>;
    typing?: { chatId: number; characterId: number; characterName: string } | null;
    actions?: Array<{ type: string; label?: string; allowsText?: boolean }>;
  }) {
    const messages = overrides.messages ?? [];
    const last = messages.length > 0 ? messages[messages.length - 1]! : null;
    return {
      state: {
        role: "human",
        phase: "chat",
        userProfile: { name: "Alex", bio: "" },
        models: ["AI"],
        characters: [ADA],
        chats: [{
          id: 1,
          name: "First chat",
          characterIds: [1],
          replyMode: "all",
          nextSpeaker: 0,
          messages,
          unread: 0,
          preview: last === null ? "" : (last.from === "you" ? "You: " : `${last.fromName}: `) + last.text,
        }],
        activeChatId: 1,
        typing: overrides.typing ?? null,
        characterLimit: 24,
        chatLimit: 12,
      },
      actions: overrides.actions ?? [
        { type: "edit_profile", label: "Profile" },
        { type: "create_character", label: "New character" },
        { type: "create_chat", label: "New chat" },
        { type: "open_chat", label: "Open chat" },
        { type: "reply", label: "Send", allowsText: true },
        { type: "finish", label: "Finish" },
      ],
      revision,
      status: "active" as const,
    };
  }

  it("handshakes, opens the chat, enables the composer on reply action, submits reply with {chatId,text}, and receives the action", async () => {
    const channel = new MessageChannel();
    const actions: ExperienceActionDto[] = [];
    let ready = false;

    // Host bridge.
    const bridge = new ExperienceHostBridge(
      baseOpts({ onReady: () => (ready = true), onAction: (a) => actions.push(a) }),
    );
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);

    // Frame harness with the REAL Messenger visual.
    const harness = createConversationHarness();
    harness.deliverWindowMessage({ kind: "port", port: channel.port2 });

    // Handshake.
    bridge.sendHello();
    await tick();
    expect(ready).toBe(true);

    // Send the initial projection (reply + finish legal — what the REAL rules
    // project for the human seat once a chat is active).
    bridge.sendState(messengerView(0, {}));
    await tick();

    // The chat list renders the one chat; opening it renders the composer
    // (the click handler opens the active chat — no open_chat action fires
    // because activeChatId already matches).
    const chatItem = harness.querySelector(".xp-listitem");
    expect(chatItem?.onclick).toBeTruthy();
    (chatItem!.onclick as () => void)();
    await tick();

    // The Messenger visual's composer textarea should be ENABLED (not
    // disabled): the reply action is present, no character is typing, and the
    // bridge reported no pending phase.
    const inputEl = harness.querySelector("textarea");
    expect(inputEl).toBeTruthy();
    expect(inputEl!.disabled).toBe(false);

    // The End-session path stays gated on the finish action (the visual's
    // profile tab button — asserted structurally here, driven below via the
    // action panel in the playground suite).
    const sendBtn = harness.querySelector(".xp-send");
    expect(sendBtn?.onclick).toBeTruthy();

    // Type text into the composer and submit through the visual bridge.
    inputEl!.value = "Hello from the visual!";
    (sendBtn!.onclick as () => void)();
    await tick();

    // The host bridge received the action with the chat-scoped text payload —
    // EXACTLY the shape the REAL Messenger rules reduce consumes.
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("reply");
    expect(actions[0]!.payload).toEqual({ chatId: 1, text: "Hello from the visual!" });
    expect(actions[0]!.expectedRevision).toBe(0);

    // Ack the action and send the next state (after the model turn, the
    // delivered reply landed in the chat). The visual re-renders the chat —
    // including the composer — from the new projection.
    bridge.sendResult(actions[0]!.requestId, 1, "active");
    bridge.sendState(messengerView(1, {
      messages: [
        { from: "you", characterId: null, fromName: "Alex", text: "Hello from the visual!" },
        { from: "character", characterId: 1, fromName: "Ada", text: "Hi there!" },
      ],
    }));
    await tick();

    // The delivered reply is rendered (the character's bubble).
    expect(harness.querySelectorAll(".xp-bubble").some((b) => b.textContent === "Hi there!")).toBe(true);

    // After the ack, a second action at the new revision proceeds (the
    // duplicate-click lock was cleared by sendResult; the composer re-rendered
    // enabled by the new view).
    const input2 = harness.querySelector("textarea");
    const send2 = harness.querySelector(".xp-send");
    expect(input2!.disabled).toBe(false);
    input2!.value = "Second message";
    (send2!.onclick as () => void)();
    await tick();
    expect(actions).toHaveLength(2);
    expect(actions[1]!.expectedRevision).toBe(1);
    expect(actions[1]!.payload).toEqual({ chatId: 1, text: "Second message" });
  });

  it("locks the composer when no reply action is present (pending state)", async () => {
    const channel = new MessageChannel();
    let ready = false;
    const bridge = new ExperienceHostBridge(baseOpts({ onReady: () => (ready = true), onAction: () => {} }));
    bridge.bindHostPort(channel.port1 as unknown as BridgePort);
    const harness = createConversationHarness();
    harness.deliverWindowMessage({ kind: "port", port: channel.port2 });

    bridge.sendHello();
    await tick();
    expect(ready).toBe(true);

    // Send a state WITH reply first (so the visual enables the composer),
    // then the pending state (no legal action + the typing indicator — what
    // the REAL rules project while a character replies).
    bridge.sendState(messengerView(0, {}));
    await tick();
    const chatItem = harness.querySelector(".xp-listitem");
    (chatItem!.onclick as () => void)();
    await tick();
    expect(harness.querySelector("textarea")!.disabled).toBe(false);

    // Now the pending state: NO actions and Ada is typing.
    bridge.sendState(messengerView(1, {
      messages: [{ from: "you", characterId: null, fromName: "Alex", text: "Hello" }],
      typing: { chatId: 1, characterId: 1, characterName: "Ada" },
      actions: [],
    }));
    await tick();

    // The composer should now be DISABLED (the step-4a owner check: nothing
    // can be sent while the character replies) and the typing dots rendered.
    expect(harness.querySelector("textarea")!.disabled).toBe(true);
    expect(harness.querySelectorAll(".xp-typing").length).toBeGreaterThan(0);
  });
});
// ─── realtime round vocabulary dispatch (RM-5) ─────────────────────────────

describe("ExperienceHostBridge — realtime model/commit dispatch", () => {
  it("forwards model_request without touching the one-action lock", () => {
    const received: Array<{ seatId: string; requestId?: string; prompt: unknown }> = [];
    const actions: string[] = [];
    const errors: string[] = [];
    const bridge = new ExperienceHostBridge(
      baseOpts({
        onModelRequest: (r) => received.push(r),
        onAction: (a) => actions.push(a.requestId),
        onProtocolError: (r) => errors.push(r),
      }),
    );
    const nonce = bridge.sessionNonce;
    // An action is in flight (no sendResult yet) — the lock holds for turn
    // actions, but a model request is not one and must sail through.
    bridge.handleMessage({
      v: 1,
      kind: "action",
      nonce,
      action: { type: "play", requestId: "req-1", expectedRevision: bridge.revision, participantId: "p1" },
    });
    bridge.handleMessage({
      v: 1,
      kind: "model_request",
      nonce,
      seatId: "m1",
      requestId: "rq-1",
      prompt: { q: "hi" },
    });
    expect(received).toEqual([{ seatId: "m1", requestId: "rq-1", prompt: { q: "hi" } }]);
    // The lock is still engaged for turn actions (the model request bypassed
    // it, it did not clear it).
    bridge.handleMessage({
      v: 1,
      kind: "action",
      nonce,
      action: { type: "play", requestId: "req-2", expectedRevision: bridge.revision, participantId: "p1" },
    });
    expect(actions).toEqual(["req-1"]);
    expect(errors).toContain("busy");
  });

  it("rejects realtime kinds with a stale nonce", () => {
    const commits: unknown[] = [];
    const errors: string[] = [];
    const bridge = new ExperienceHostBridge(
      baseOpts({ onRoundCommit: (c) => commits.push(c), onProtocolError: (r) => errors.push(r) }),
    );
    bridge.handleMessage({ v: 1, kind: "round_commit", nonce: "stale", status: "completed", finalState: {}, log: [] });
    expect(commits).toEqual([]);
    expect(errors).toContain("stale_nonce");
  });

  it("forwards round_commit verbatim (status/finalState/log/score/summary)", () => {
    const commits: Array<Record<string, unknown>> = [];
    const bridge = new ExperienceHostBridge(baseOpts({ onRoundCommit: (c) => commits.push(c as unknown as Record<string, unknown>) }));
    const log = [{ kind: "round_started", seed: 1 }];
    bridge.handleMessage({
      v: 1,
      kind: "round_commit",
      nonce: bridge.sessionNonce,
      status: "interrupted",
      finalState: { x: 1 },
      log,
      score: 7,
      summary: "quit",
    });
    expect(commits).toEqual([{ status: "interrupted", finalState: { x: 1 }, log, score: 7, summary: "quit" }]);
  });

  it("sendModelResult posts a host→visual model_result", () => {
    const port = recordedPort();
    const bridge = new ExperienceHostBridge(baseOpts({}));
    bridge.bindHostPort(port);
    bridge.sendModelResult("m1", { type: "speak" }, "rq-1");
    expect(port.sent).toEqual([
      { v: 1, kind: "model_result", nonce: bridge.sessionNonce, seatId: "m1", requestId: "rq-1", result: { type: "speak" } },
    ]);
  });
});

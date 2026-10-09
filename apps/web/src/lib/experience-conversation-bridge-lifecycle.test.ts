/**
 * Real Messenger pair × ExperienceHostBridge — revision-lock lifecycle
 * (IR-91D; re-pinned on the owner's Messenger, report step 4a, owner
 * 2026-10-06).
 *
 * THE CROSSING neither sibling suite covers:
 *  - `experience-conversation-starter-parity.test.ts` (IR-90B) drives the REAL
 *    rules + visual through the REAL kernel and asserts the projected view,
 *    action types, and the user-reply→model-effect→model-reply round trip — but
 *    KERNEL-LEVEL (discover/create/project/actions/reduce directly; no bridge).
 *  - `experience-bridge.test.ts` (IR-61 / IR-90E) drives `ExperienceHostBridge`
 *    (handshake, nonce, stale-revision fast-reject, duplicate-click lock,
 *    finish dispatch) and even wires the REAL Conversation visual over a real
 *    MessageChannel — but with SYNTHETIC projected views/actions (not derived
 *    from the real rules) and no model-continuation revision synchronization.
 *
 * IR-91D drives the REAL Messenger rules + visual through the REAL kernel AND
 * through `ExperienceHostBridge`'s revision-lock-result lifecycle, including
 * the real model-effect round trip and revision synchronization across it.
 * Every view the bridge carries and every action it accepts is derived from the
 * imported real sources. If the real starter broke (action name, projected
 * shape, model-effect shape, revision sequence), this suite fails — a
 * synthetic pair cannot satisfy it because at least one assertion (real
 * `create_character` / `reply` action names / real chat message keys / real
 * model-effect `{viewer,actionType}` shape / real revision sequence) would no
 * longer hold.
 *
 * The real lifecycle this suite drives (the Messenger's minimum flow): create →
 * create_character (rev 1) → create_chat (rev 2) → the user's `reply` (rev 3,
 * emitting the model effect) → the model continuation (rev 4, reply lands in
 * the chat, turn back to the human).
 */
import { describe, expect, it } from "bun:test";
import {
  runActions,
  runCreate,
  runProject,
  runReduce,
  type ExperienceCapabilityContext,
} from "../../../../services/api/src/domain/interactive/experience-kernel.js";
import type { ExperienceAction, ExperienceParticipant } from "@vibe-tavern/domain";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import { ExperienceHostBridge, type BridgePort } from "./experience-bridge.js";
import { getRulesStarter } from "./experience-rules-starters.js";
import { CONVERSATION_VISUAL_SOURCE } from "../components/experience/starters/conversation.js";

// ── The REAL shipped sources (imported verbatim; no inline copies, no mocks) ─

const STARTER = getRulesStarter("model_conversation");
if (!STARTER) throw new Error("model_conversation starter missing from catalog");
const RULES_SOURCE = STARTER.source;
const SCRIPT_NAME = "model_conversation.js";

// One human seat + one model seat (pinned per IR-70E), mirroring the
// ExperienceSetupModal roster. The created character binds to the model seat
// through its roster label; the model effect's `viewer` is that seat's id.
const PARTICIPANTS: ExperienceParticipant[] = [
  { id: "human_1", label: "You", controller: "human" },
  { id: "ai_seat", label: "AI", controller: "model", providerProfileId: "pp_1", modelId: "gpt-test" },
];
const CAPS: ExperienceCapabilityContext = { participants: PARTICIPANTS };
const HUMAN_VIEWER = { kind: "human" as const, participantId: "human_1" };

// ── Kernel helpers (mirror the parity test) ──────────────────────────────────

function unwrap<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** Build a minimal valid action carrier for a reduce / bridge-submission call. */
function action(
  type: string,
  expectedRevision: number,
  extra: Partial<ExperienceAction> = {},
): ExperienceAction {
  return { type, requestId: `req-${type}-${expectedRevision}`, expectedRevision, ...extra };
}

/** Reduce the REAL lifecycle to the state AFTER the given actions. */
function drive(...actions: ExperienceAction[]): unknown {
  let state: unknown = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
  for (const act of actions) {
    state = unwrap(runReduce(RULES_SOURCE, SCRIPT_NAME, state, act, CAPS)).state;
  }
  return state;
}

// ── Bridge helpers (mirror the bridge test's recordedPort + handshake seam) ──

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

function makeBridge(handlers: {
  onAction: (a: ExperienceActionDto) => void;
  onReady?: () => void;
  onFinish?: (r: number) => void;
  onProtocolError?: (reason: string, raw?: unknown) => void;
}): ExperienceHostBridge {
  return new ExperienceHostBridge({
    sessionId: "sess_ir91d",
    initialRevision: 0,
    onAction: handlers.onAction,
    ...(handlers.onReady ? { onReady: handlers.onReady } : {}),
    ...(handlers.onFinish ? { onFinish: handlers.onFinish } : {}),
    ...(handlers.onProtocolError ? { onProtocolError: handlers.onProtocolError } : {}),
  });
}

/** The frame's `ready` arriving on the active nonce (handshake complete). */
function postReady(b: ExperienceHostBridge): void {
  b.handleMessage({ v: 1, kind: "ready", nonce: b.sessionNonce });
}

/** Submit an action through the bridge — the shape the visual's xp.act posts. */
function postAction(b: ExperienceHostBridge, act: ExperienceAction): void {
  b.handleMessage({ v: 1, kind: "action", nonce: b.sessionNonce, action: act });
}

/** The frame's End-session button posts {kind:"finish", revision}. */
function postFinish(b: ExperienceHostBridge, revision: number): void {
  b.handleMessage({ v: 1, kind: "finish", nonce: b.sessionNonce, revision });
}

/** Pull the first error the bridge pushed to the port, or undefined. */
function firstError(
  port: RecordedPort,
): { code: string; requestId?: string; revision?: number } | undefined {
  return port.sent.find((m) => (m as { kind?: string }).kind === "error") as
    | { code: string; requestId?: string; revision?: number }
    | undefined;
}

// ── Real-derived bridge view + model-continuation helpers ────────────────────

/**
 * Build the bridge view the host pushes, by projecting the REAL rules for the
 * human seat at the given revision. `state` is the REAL projected state; the
 * `actions` are the REAL legal descriptors the visual enables its controls on.
 * Both come straight from the kernel — no hand-rolled view.
 */
function realView(state: unknown, revision: number) {
  return {
    state: unwrap(runProject(RULES_SOURCE, SCRIPT_NAME, state, HUMAN_VIEWER, CAPS)),
    actions: unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, state, HUMAN_VIEWER, CAPS)),
    revision,
    status: "active" as const,
  };
}

/**
 * Drive the REAL model-effect round trip: take the transition a human reply
 * produced (which carries a `model` effect emitted by the REAL rules), mirror
 * `mapResultToAction` from `experience-model-effect-service.ts` to build the
 * model's reply action from the REAL effect-request shape
 * (type = request.actionType, participantId = request.viewer), and feed it back
 * through the REAL reducer. The model's text is the only stubbed input — the
 * LLM executor is a side-effect seam (never the pair), exactly as the parity
 * test stubs the model's "Pong!".
 */
function driveModelContinuation(
  humanTransition: { state: unknown; effects?: ReadonlyArray<{ kind: string; request: unknown }> },
  originatingRevision: number,
  modelText: string,
) {
  const effect = humanTransition.effects?.[0];
  if (!effect || effect.kind !== "model") {
    throw new Error("expected a model effect on the human-reply transition");
  }
  const request = effect.request as {
    viewer: string;
    mode: string;
    actionType?: string;
    instruction?: string;
  };
  const modelAction: ExperienceAction = {
    type: request.actionType ?? "reply",
    requestId: "effect:continuation",
    expectedRevision: originatingRevision,
    participantId: request.viewer,
    payload: { text: modelText },
  };
  return unwrap(runReduce(RULES_SOURCE, SCRIPT_NAME, humanTransition.state, modelAction, CAPS));
}

/** The create_character → create_chat prefix that makes `reply` legal. */
function messengerScenarioActions(): ExperienceAction[] {
  return [
    action("create_character", 0, { payload: { name: "Ada", model: "AI" } }),
    action("create_chat", 1, { payload: { name: "First chat", characterIds: [1], replyMode: "all" } }),
  ];
}

// ── The crossing ─────────────────────────────────────────────────────────────

describe("IR-91D: Real Messenger pair × ExperienceHostBridge — revision-lock lifecycle", () => {
  it("the REAL projected initial view binds the bridge's revision authority to 0 (edit_profile + create_character + finish exposed)", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));

    // The REAL rules expose the Messenger lobby actions — the action types the
    // REAL visual gates its profile card / new-character sheet / End-session
    // button on. `reply` is NOT legal before a chat exists (composer lock).
    const legal = unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, state0, HUMAN_VIEWER, CAPS));
    expect(legal.map((a) => a.type)).toEqual(["edit_profile", "create_character", "finish"]);

    const view0 = realView(state0, 0);

    const bridge = makeBridge({ onAction: () => {} });
    bridge.bindHostPort(recordedPort());
    postReady(bridge);
    expect(bridge.isReady).toBe(true);

    bridge.sendState(view0);
    // The bridge's authoritative revision now matches the REAL projected view.
    expect(bridge.revision).toBe(0);
    // The REAL projected state the bridge carries is the Messenger setup the
    // REAL visual renders (models list, empty characters/chats).
    const projected = view0.state as {
      phase: string;
      models: string[];
      characters: unknown[];
      chats: unknown[];
      typing: unknown;
    };
    expect(projected.phase).toBe("setup");
    expect(projected.models).toEqual(["AI"]);
    expect(projected.characters).toEqual([]);
    expect(projected.chats).toEqual([]);
    expect(projected.typing).toBeNull();
  });

  it("a REAL create_character is accepted at the current revision, forwarded via onAction, and the lock clears when sendResult advances to revision 1", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const port = recordedPort();
    const forwarded: ExperienceActionDto[] = [];
    const bridge = makeBridge({ onAction: (a) => forwarded.push(a) });
    bridge.bindHostPort(port);
    postReady(bridge);
    bridge.sendState(realView(state0, 0));

    // The visual's character sheet submits
    // xp.act('create_character', {name, model}) → this action shape.
    const create = action("create_character", 0, { payload: { name: "Ada", model: "AI" } });
    postAction(bridge, create);

    // Accepted (not stale-rejected): forwarded with the real type + payload.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.type).toBe("create_character");
    expect(forwarded[0]!.payload).toEqual({ name: "Ada", model: "AI" });
    expect(firstError(port)).toBeUndefined();

    // The REAL reducer turns this carried action into the bound character the
    // REAL visual renders (Model: <label>) — the bridge carries what the
    // visual reads.
    const t1 = unwrap(runReduce(RULES_SOURCE, SCRIPT_NAME, state0, create, CAPS));
    expect(t1.events).toEqual([{ visibility: "public", type: "character_created" }]);
    expect(CONVERSATION_VISUAL_SOURCE).toContain("has(v,'create_character')");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("act('create_character',{name:n.value,description:d.value,model:m.value})");

    // sendResult clears the duplicate-click lock and advances the authoritative
    // revision to 1; the next lobby action (create_chat) at the new revision
    // now proceeds.
    bridge.sendResult(create.requestId, 1, "active");
    expect(bridge.revision).toBe(1);
    const createChat = action("create_chat", 1, {
      payload: { name: "First chat", characterIds: [1], replyMode: "all" },
    });
    postAction(bridge, createChat);
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]!.expectedRevision).toBe(1);
  });

  it("the REAL model-effect round trip: after the model reply, a pre-continuation action is stale-rejected and resyncs only at the new revision", () => {
    // Derive the REAL lifecycle the host runs: create → create_character (rev1)
    // → create_chat (rev2) → human reply (rev3, with a model effect emitted by
    // the REAL rules) → model continuation (rev4, no further effect). The
    // parity test pins this at kernel level; here it drives the BRIDGE's
    // revision authority through the same sequence.
    const state2 = drive(...messengerScenarioActions());
    const t3 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state2,
        action("reply", 2, { payload: { chatId: 1, text: "Ping" } }),
        CAPS,
      ),
    );
    // The REAL rules emit a model effect targeting the REAL model seat, typed
    // with the pending character's reply action.
    expect(t3.effects?.[0]?.kind).toBe("model");
    expect(t3.effects?.[0]?.request).toMatchObject({
      viewer: "ai_seat",
      mode: "text",
      actionType: "reply_character_1",
    });
    const t4 = driveModelContinuation(t3, 3, "Pong!");
    // REAL model-reply shape: the character's message lands in the chat
    // ({from:'character', fromName, text}) and the ball returns to the human —
    // no further effect, `reply` legal again.
    expect(t4.effects).toBeUndefined();
    const projected4 = unwrap(runProject(RULES_SOURCE, SCRIPT_NAME, t4.state, HUMAN_VIEWER, CAPS)) as {
      typing: unknown;
      chats: Array<{ messages: Array<{ from: string; characterId: number | null; fromName: string; text: string }> }>;
    };
    expect(projected4.typing).toBeNull();
    expect(projected4.chats[0]?.messages).toEqual([
      { from: "you", characterId: null, fromName: "You", text: "Ping" },
      { from: "character", characterId: 1, fromName: "Ada", text: "Pong!" },
    ]);

    // Bridge lifecycle synchronized to the real revision sequence.
    const port = recordedPort();
    const forwarded: ExperienceActionDto[] = [];
    const bridge = makeBridge({ onAction: (a) => forwarded.push(a) });
    bridge.bindHostPort(port);
    postReady(bridge);
    bridge.sendState(realView(state2, 2)); // rev 2 — reply is legal here

    // Human reply accepted at rev 2; ack advances to rev 3.
    const humanReply = action("reply", 2, { payload: { chatId: 1, text: "Ping" } });
    postAction(bridge, humanReply);
    expect(forwarded).toHaveLength(1);
    bridge.sendResult(humanReply.requestId, 3, "active");

    // The host runs the model continuation and pushes the post-continuation
    // REAL view at rev 4 — resynchronizing the bridge's revision authority.
    bridge.sendState(realView(t4.state, 4));
    expect(bridge.revision).toBe(4);

    // An action built on the PRE-continuation revision (3) is now stale.
    const stale = action("reply", 3, { payload: { chatId: 1, text: "too late" } });
    postAction(bridge, stale);
    expect(forwarded).toHaveLength(1); // not forwarded
    const err = firstError(port);
    expect(err?.code).toBe("stale_revision");
    expect(err?.revision).toBe(4);
    expect(err?.requestId).toBe(stale.requestId);

    // Re-bound to the new revision (4) → accepted.
    postAction(bridge, action("reply", 4, { payload: { chatId: 1, text: "on time" } }));
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]!.expectedRevision).toBe(4);
  });

  it("the REAL finish (gated by the visual's End-session button) reaches onFinish with the final revision", () => {
    // Reach the post-continuation view at rev 4 (same real lifecycle as above).
    const state2 = drive(...messengerScenarioActions());
    const t3 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state2,
        action("reply", 2, { payload: { chatId: 1, text: "Ping" } }),
        CAPS,
      ),
    );
    const t4 = driveModelContinuation(t3, 3, "Pong!");
    const view4 = realView(t4.state, 4);

    // The REAL visual shows its End-session button only when
    // hasAction(view,'finish') is true — the REAL rules still expose `finish`
    // at rev 4 (pending is empty again after the continuation).
    expect(view4.actions.map((a) => a.type)).toContain("finish");

    const finishes: number[] = [];
    const bridge = makeBridge({ onAction: () => {}, onFinish: (r) => finishes.push(r) });
    bridge.bindHostPort(recordedPort());
    postReady(bridge);
    bridge.sendState(view4);
    expect(bridge.revision).toBe(4);

    // The End-session button posts {kind:"finish", revision} on the active nonce.
    postFinish(bridge, 4);
    expect(finishes).toEqual([4]);
  });
});

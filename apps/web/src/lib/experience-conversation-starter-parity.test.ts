/**
 * Messenger rules starter ↔ Conversation visual parity (IR-90B).
 *
 * The regression class this unit exists to prevent: "tests passed because the
 * fixtures were self-consistent." The shipped rules starter and the visual
 * starter must agree on ONE contract. Step 4a of the copilot grounding report
 * replaced both with the owner's finished Messenger (owner 2026-10-06), so the
 * pinned pair is the real messenger: the human drives profile / character /
 * chat actions, each character replies through its own model seat while the
 * human waits (NO human action is legal while a reply is pending — the
 * composer lock), and the delivered reply lands back in the chat.
 *
 * This test imports the REAL shipped rules source (never an inline copy that
 * can drift) and runs it through the REAL IR-12 kernel, then asserts the
 * projected view and action types EXACTLY match what the REAL Conversation
 * visual source (`conversation.ts`) consumes — the `chats`/`characters`/
 * `typing` projection and the `create_character` / `create_chat` / `reply` /
 * `finish` action types. It also exercises the full user-reply → model-effect
 * → model-reply feed-back round trip that the host's
 * `experience-model-effect-service.ts` drives.
 */
import { describe, expect, it } from "bun:test";
import {
  discoverExperienceDefinition,
  runActions,
  runCreate,
  runProject,
  runReduce,
  type ExperienceCapabilityContext,
} from "../../../../services/api/src/domain/interactive/experience-kernel.js";
import type { ExperienceAction, ExperienceParticipant } from "@vibe-tavern/domain";
import { getRulesStarter } from "./experience-rules-starters.js";
import { CONVERSATION_VISUAL_SOURCE } from "../components/experience/starters/conversation.js";

// ── The REAL shipped sources (no inline copies) ──────────────────────────────

const STARTER = getRulesStarter("model_conversation");
if (!STARTER) throw new Error("model_conversation starter missing from catalog");
const RULES_SOURCE = STARTER.source;
const SCRIPT_NAME = "model_conversation.js";

// A realistic roster mirroring how the ExperienceSetupModal builds one once BOTH
// capabilities are declared: one human seat + one model seat (pinned per IR-70E).
// The character created below binds itself to the model seat through its label.
const PARTICIPANTS: ExperienceParticipant[] = [
  { id: "human_1", label: "You", controller: "human" },
  { id: "ai_seat", label: "AI", controller: "model", providerProfileId: "pp_1", modelId: "gpt-test" },
];
const MODEL_SEAT_ID = "ai_seat";
const CAPS: ExperienceCapabilityContext = { participants: PARTICIPANTS };
const HUMAN_VIEWER = { kind: "human" as const, participantId: "human_1" };
const MODEL_VIEWER = { kind: "model" as const, participantId: MODEL_SEAT_ID };

/** Build a minimal valid action carrier for a reduce call. */
function action(
  type: string,
  expectedRevision: number,
  extra: Partial<ExperienceAction> = {},
): ExperienceAction {
  return {
    type,
    requestId: `req-${type}-${expectedRevision}`,
    expectedRevision,
    ...extra,
  };
}

// ── Helpers for kernel results (bail with the error message) ────────────────

function unwrap<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** The projected human view at a state (the shape the visual renders). */
interface MessengerHumanView {
  role: string;
  phase: string;
  userProfile: { name: string; bio: string };
  models: string[];
  characters: Array<{ id: number; name: string; description: string; modelId: string; modelLabel: string }>;
  chats: Array<{
    id: number;
    name: string;
    characterIds: number[];
    messages: Array<{ from: string; characterId: number | null; fromName: string; text: string }>;
    preview: string;
  }>;
  activeChatId: number | null;
  typing: { chatId: number; characterId: number; characterName: string } | null;
}

/** Project the human view at a state through the REAL kernel. */
function humanView(state: unknown): MessengerHumanView {
  return unwrap(runProject(RULES_SOURCE, SCRIPT_NAME, state, HUMAN_VIEWER, CAPS)) as MessengerHumanView;
}

describe("Messenger rules starter ↔ Conversation visual — contract parity", () => {
  // ── The visual reads these EXACT tokens; the rules must emit them ──────────
  it("the REAL visual source consumes the messenger projection (chats/characters/typing) and gates its controls on the rules' action types", () => {
    // These assertions pin the visual's contract so a future edit to
    // conversation.ts that silently changes it fails HERE, not in production.
    // Derived from the real source: the three-tab shell gates every control on
    // has(view, <type>) and renders chat messages as {from, fromName, text}.
    expect(CONVERSATION_VISUAL_SOURCE).toContain("has(v,'create_character')");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("has(v,'create_chat')");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("has(v,'edit_profile')");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("has(v,'reply')");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("has(v,'finish')");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("m.from==='you'");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("m.fromName");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("m.text");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("s.typing");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("t.characterName+' is typing…'");
    // The composer submits EXACTLY the payload the rules reduce consumes…
    expect(CONVERSATION_VISUAL_SOURCE).toContain("act('reply',{chatId:c.id,text:text})");
    // …and locks itself while a reply is pending (typing dots / bridge pending).
    expect(CONVERSATION_VISUAL_SOURCE).toContain("can=has(v,'reply')&&!t&&!pending");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("send.disabled=!can");
  });

  it("the REAL rules source declares BOTH participants and model capabilities", () => {
    // discoverExperienceDefinition returns {ok, definition} (not {ok, value}),
    // so it is handled inline rather than through the value-based unwrap().
    const discovered = discoverExperienceDefinition(RULES_SOURCE, SCRIPT_NAME);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) throw new Error(discovered.message);
    expect(discovered.definition.manifest).toMatchObject({ id: "model_conversation", name: "Messenger" });
    const caps = discovered.definition.declaredCapabilities.map((c) => c.capability);
    expect(caps).toContain("participants");
    expect(caps).toContain("model");
  });

  it("the initial human actions are edit_profile/create_character/finish — `reply` is NOT legal before a chat exists", () => {
    const state = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const legal = unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, state, HUMAN_VIEWER, CAPS));
    expect(legal.map((a) => a.type)).toEqual(["edit_profile", "create_character", "finish"]);

    // An observer sees no actions (the visual starter's fixture preview path).
    expect(unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, state, { kind: "observer" }, CAPS))).toEqual([]);

    // The projected setup view carries the model names the character sheet's
    // model picker renders (state.models) and the limits the headers count.
    const view = humanView(state);
    expect(view.models).toEqual(["AI"]);
    expect(view.phase).toBe("setup");
    expect(view.characters).toEqual([]);
    expect(view.chats).toEqual([]);
    expect(view.typing).toBeNull();
  });

  it("create_character binds the character to the model seat by its roster label", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const t1 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state0,
        action("create_character", 0, { payload: { name: "Ada", description: "A test character", model: "AI" } }),
        CAPS,
      ),
    );
    expect(t1.status).toBe("active");
    expect(t1.events).toEqual([{ visibility: "public", type: "character_created" }]);

    // The character carries the REAL model-seat participant id — the value the
    // model effect's `viewer` and the pending classification both key on.
    const view = humanView(t1.state);
    expect(view.characters).toEqual([
      { id: 1, name: "Ada", description: "A test character", modelId: MODEL_SEAT_ID, modelLabel: "AI" },
    ]);
  });

  it("create_chat opens an active chat and exposes `reply` (text-allowing) — the composer's action", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const t1 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state0,
        action("create_character", 0, { payload: { name: "Ada", description: "A test character", model: "AI" } }),
        CAPS,
      ),
    );
    const t2 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t1.state,
        action("create_chat", 1, { payload: { name: "First chat", characterIds: [1], replyMode: "all" } }),
        CAPS,
      ),
    );
    expect(t2.events).toEqual([{ visibility: "public", type: "chat_created" }]);

    const legal = unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, t2.state, HUMAN_VIEWER, CAPS));
    // Parity: the visual enables the composer via hasAction(view,'reply').
    expect(legal.map((a) => a.type)).toContain("reply");
    expect(legal.find((a) => a.type === "reply")?.allowsText).toBe(true);

    const view = humanView(t2.state);
    expect(view.activeChatId).toBe(1);
    expect(view.chats).toHaveLength(1);
    expect(view.chats[0]).toMatchObject({ id: 1, name: "First chat", characterIds: [1], messages: [] });
  });

  it("a user `reply` lands the message in the chat and emits a model effect on the REAL model seat", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const t1 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state0,
        action("create_character", 0, { payload: { name: "Ada", description: "A test character", model: "AI" } }),
        CAPS,
      ),
    );
    const t2 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t1.state,
        action("create_chat", 1, { payload: { name: "First chat", characterIds: [1], replyMode: "all" } }),
        CAPS,
      ),
    );

    // The human replies via the visual's composer: xp.act('reply', {chatId, text}).
    const t3 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t2.state,
        action("reply", 2, { payload: { chatId: 1, text: "Hello there!" } }),
        CAPS,
      ),
    );
    expect(t3.events).toEqual([{ visibility: "public", type: "user_replied" }]);

    // Message-shape parity: the chat history carries {from, characterId,
    // fromName, text} — the keys the visual renders (m.from / m.fromName / m.text).
    const view3 = humanView(t3.state);
    expect(view3.chats[0]?.messages).toEqual([
      { from: "you", characterId: null, fromName: "You", text: "Hello there!" },
    ]);
    expect(view3.chats[0]?.preview).toBe("You: Hello there!");

    // The model effect must target the REAL model-seat participant id (the
    // bound character's modelId), carry actionType 'reply_character_<id>' (the
    // type parseModelEffectRequest / mapResultToAction feed back), and an
    // instruction naming the character.
    expect(t3.effects).toBeDefined();
    const effect = t3.effects?.[0];
    expect(effect?.kind).toBe("model");
    expect(effect?.request).toMatchObject({
      viewer: MODEL_SEAT_ID,
      mode: "text",
      actionType: "reply_character_1",
    });
    const instruction = (effect?.request as { instruction?: string }).instruction ?? "";
    expect(instruction).toContain("Ada");
    expect(instruction).toContain("private messenger");
  });

  it("while the reply is pending, ONLY the model seat has legal actions (reply_character_<id>) — the composer lock", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const t1 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state0,
        action("create_character", 0, { payload: { name: "Ada", description: "A test character", model: "AI" } }),
        CAPS,
      ),
    );
    const t2 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t1.state,
        action("create_chat", 1, { payload: { name: "First chat", characterIds: [1], replyMode: "all" } }),
        CAPS,
      ),
    );
    const t3 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t2.state,
        action("reply", 2, { payload: { chatId: 1, text: "Hello there!" } }),
        CAPS,
      ),
    );

    // The human seat has NO legal action while the character replies — the
    // rules answer actions() with [] and the visual's composer locks.
    expect(unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, t3.state, HUMAN_VIEWER, CAPS))).toEqual([]);

    // The model seat sees exactly the pending character's reply action.
    const modelLegal = unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, t3.state, MODEL_VIEWER, CAPS));
    expect(modelLegal).toHaveLength(1);
    expect(modelLegal[0]).toMatchObject({ type: "reply_character_1", allowsText: true });

    // The projected human view shows the typing indicator the visual renders
    // from state.typing (chat-scoped, named after the replying character).
    const view = humanView(t3.state);
    expect(view.typing).toEqual({ chatId: 1, characterId: 1, characterName: "Ada" });
  });

  it("the delivered model reply lands in the chat, clears pending, and returns the turn to the human", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const t1 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state0,
        action("create_character", 0, { payload: { name: "Ada", description: "A test character", model: "AI" } }),
        CAPS,
      ),
    );
    const t2 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t1.state,
        action("create_chat", 1, { payload: { name: "First chat", characterIds: [1], replyMode: "all" } }),
        CAPS,
      ),
    );
    const t3 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t2.state,
        action("reply", 2, { payload: { chatId: 1, text: "Ping" } }),
        CAPS,
      ),
    );

    // The host's mapResultToAction feeds the model result back as
    // { type: request.actionType, participantId: request.viewer, payload: {text} }.
    const t4 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t3.state,
        action("reply_character_1", 3, { participantId: MODEL_SEAT_ID, payload: { text: "Pong!" } }),
        CAPS,
      ),
    );
    expect(t4.events).toEqual([{ visibility: "public", type: "model_replied" }]);
    // The ball returns to the human: no further effect is emitted.
    expect(t4.effects).toBeUndefined();

    // The reply lands in the chat with the character's identity (the visual's
    // m.fromName speaker + m.text bubble), the typing indicator is gone, and
    // the human's composer unlocks (reply legal again).
    const view = humanView(t4.state);
    expect(view.chats[0]?.messages).toEqual([
      { from: "you", characterId: null, fromName: "You", text: "Ping" },
      { from: "character", characterId: 1, fromName: "Ada", text: "Pong!" },
    ]);
    expect(view.chats[0]?.preview).toBe("Ada: Pong!");
    expect(view.typing).toBeNull();
    const legal = unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, t4.state, HUMAN_VIEWER, CAPS));
    expect(legal.map((a) => a.type)).toContain("reply");
  });

  it("`finish` → status:'completed' (the visual's End-session button is gated on hasAction(view,'finish'))", () => {
    const state = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const transition = unwrap(
      runReduce(RULES_SOURCE, SCRIPT_NAME, state, action("finish", 0), CAPS),
    );
    expect(transition.status).toBe("completed");
    expect(transition.events).toEqual([{ visibility: "public", type: "finished" }]);
  });
});

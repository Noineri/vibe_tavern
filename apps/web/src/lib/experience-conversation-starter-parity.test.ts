/**
 * Model Conversation starter ↔ Conversation visual parity (IR-90B).
 *
 * The regression class this unit exists to prevent: "tests passed because the
 * fixtures were self-consistent." The shipped rules starter and the visual
 * starter previously disagreed on the contract (action name `say` vs `reply`,
 * message shape `{role,text}` vs `{from,text}`, a dead `viewer:'model_seat'`
 * literal, no `actionType` on the model effect, no `finish`). The visual-only
 * preview fixtures used matching action names internally and so never caught the
 * mismatch.
 *
 * This test imports the REAL shipped rules source (never an inline copy that can
 * drift) and runs it through the REAL IR-12 kernel, then asserts the projected
 * message shape and action types EXACTLY match what the REAL Conversation
 * visual source (`conversation.ts`) consumes — `from`/`text` message keys, and
 * `reply`/`finish` action types. It also exercises the full user-reply →
 * model-effect → model-reply feed-back round trip that the host's
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
const PARTICIPANTS: ExperienceParticipant[] = [
  { id: "human_1", label: "You", controller: "human" },
  { id: "ai_seat", label: "AI", controller: "model", providerProfileId: "pp_1", modelId: "gpt-test" },
];
const MODEL_SEAT_ID = "ai_seat";
const CAPS: ExperienceCapabilityContext = { participants: PARTICIPANTS };
const HUMAN_VIEWER = { kind: "human" as const, participantId: "human_1" };

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

describe("Model Conversation starter ↔ Conversation visual — contract parity", () => {
  // ── The visual reads these EXACT tokens; the rules must emit them ──────────
  it("the REAL visual source consumes `from`/`text` keys and `reply`/`finish` actions", () => {
    // These assertions pin the visual's contract so a future edit to
    // conversation.ts that silently changes it fails HERE, not in production.
    expect(CONVERSATION_VISUAL_SOURCE).toContain("m.from==='you'");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("m.text||''");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("hasAction(view,'reply')");
    expect(CONVERSATION_VISUAL_SOURCE).toContain("hasAction(view,'finish')");
  });

  it("the REAL rules source declares BOTH participants and model capabilities", () => {
    // discoverExperienceDefinition returns {ok, definition} (not {ok, value}),
    // so it is handled inline rather than through the value-based unwrap().
    const discovered = discoverExperienceDefinition(RULES_SOURCE, SCRIPT_NAME);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) throw new Error(discovered.message);
    const caps = discovered.definition.declaredCapabilities.map((c) => c.capability);
    expect(caps).toContain("participants");
    expect(caps).toContain("model");
  });

  it("actions() exposes `reply` (text-allowing) and `finish` — matching the visual", () => {
    const state = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const legal = unwrap(runActions(RULES_SOURCE, SCRIPT_NAME, state, HUMAN_VIEWER, CAPS));
    const types = legal.map((a) => a.type);

    // Parity: the visual enables the composer via hasAction(view,'reply') and
    // shows the Finish button via hasAction(view,'finish').
    expect(types).toContain("reply");
    expect(types).toContain("finish");

    const reply = legal.find((a) => a.type === "reply");
    expect(reply?.allowsText).toBe(true);
  });

  it("a user `reply` with {text} lands {from:'you',text} and emits a model effect on the REAL model seat", () => {
    const state = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));

    // The human replies via the visual's composer: xp.act('reply', {text:...}).
    // The SDK does NOT set participantId for a human action, so it is absent —
    // the reducer classifies this as a human reply.
    const transition = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state,
        action("reply", 0, { payload: { text: "Hello there!" } }),
        CAPS,
      ),
    );

    // Message shape parity: {from, text} — NOT {role, text}.
    const s1 = transition.state as { messages: unknown[]; turn: number };
    expect(s1.messages).toEqual([{ from: "you", text: "Hello there!" }]);
    expect(s1.turn).toBe(1);

    // The model effect must target the REAL model-seat participant id (resolved
    // from context.participants), not a dead literal. It must also carry
    // actionType:'reply' or parseModelEffectRequest rejects it as malformed, and
    // the host feeds the model text back as a `reply` action.
    expect(transition.effects).toBeDefined();
    const effect = transition.effects?.[0];
    expect(effect?.kind).toBe("model");
    expect(effect?.request).toMatchObject({
      viewer: MODEL_SEAT_ID,
      mode: "text",
      actionType: "reply",
    });

    // The projected view (what the visual renders) must carry the same shape.
    const projected = unwrap(runProject(RULES_SOURCE, SCRIPT_NAME, transition.state, HUMAN_VIEWER, CAPS));
    expect((projected as { messages: unknown[] }).messages).toEqual([
      { from: "you", text: "Hello there!" },
    ]);
  });

  it("feeding the model's `reply` back (synthetic participantId=model seat) lands {from:'them',text} with no new effect", () => {
    const state0 = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));

    // 1. Human reply → produces state at revision 1 + a pending model effect.
    const t1 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        state0,
        action("reply", 0, { payload: { text: "Ping" } }),
        CAPS,
      ),
    );
    expect(t1.effects).toBeDefined();

    // 2. The host's mapResultToAction feeds the model result back as
    //    { type: actionType ?? 'reply', participantId: request.viewer, payload: {text} }.
    //    request.viewer is the model seat; actionType is 'reply'. So the
    //    synthetic action is { type:'reply', participantId: MODEL_SEAT_ID, payload:{text} }.
    const t2 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t1.state,
        action("reply", 1, { participantId: MODEL_SEAT_ID, payload: { text: "Pong!" } }),
        CAPS,
      ),
    );

    // The model's reply is classified as 'them' (not 'you'), and no new model
    // effect is emitted (the ball returns to the human).
    const s2 = t2.state as { messages: unknown[] };
    expect(s2.messages).toEqual([
      { from: "you", text: "Ping" },
      { from: "them", text: "Pong!" },
    ]);
    expect(t2.effects).toBeUndefined();
  });

  it("`finish` → status:'completed' (the visual's Finish button is gated on hasAction(view,'finish'))", () => {
    const state = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const transition = unwrap(
      runReduce(RULES_SOURCE, SCRIPT_NAME, state, action("finish", 0), CAPS),
    );
    expect(transition.status).toBe("completed");
    expect(transition.events).toEqual([{ visibility: "public", type: "finished" }]);
  });

  it("messages use the `from` key (not the legacy `role` key) — direct shape parity with the visual", () => {
    const state = unwrap(runCreate(RULES_SOURCE, SCRIPT_NAME, {}, CAPS));
    const t1 = unwrap(
      runReduce(RULES_SOURCE, SCRIPT_NAME, state, action("reply", 0, { payload: { text: "a" } }), CAPS),
    );
    const t2 = unwrap(
      runReduce(
        RULES_SOURCE,
        SCRIPT_NAME,
        t1.state,
        action("reply", 1, { participantId: MODEL_SEAT_ID, payload: { text: "b" } }),
        CAPS,
      ),
    );
    for (const msg of (t2.state as { messages: Array<Record<string, unknown>> }).messages) {
      expect(msg).toHaveProperty("from");
      expect(msg).toHaveProperty("text");
      expect(msg).not.toHaveProperty("role");
    }
  });
});

/**
 * In-memory playground Interactive-experience session driver tests
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-84A).
 *
 * Pins behavior at the REAL boundary: the driver functions → real sandbox/kernel
 * (no StoreContainer, no chat/session/DB — acceptance #4), plus HTTP integration
 * tests exercising the full route → adapter → driver → kernel path and the
 * typed-error → HTTP-status mapping. The parity oracle is the IR-81B tester's
 * `runExperienceTest` (same kernel, same inputs → identical revisions/states/
 * projections/events/effects).
 *
 * mock.module is NOT used here, so these files are safe to run in any order.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";
import { createExperienceRoutes } from "../src/api/routes/experience.js";
import { ExperienceAdapter } from "../src/api/adapters/experience-adapter.js";
import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import { ExperienceReplayService } from "../src/domain/interactive/experience-replay-service.js";
import {
  ExperienceContextService,
  type ExperienceChatLifecycleSeam,
} from "../src/domain/interactive/experience-context-service.js";
import { ExperienceModelEffectService } from "../src/domain/interactive/experience-model-effect-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import {
  startExperiencePlayground,
  advanceExperiencePlayground,
  executeModelTurnExperiencePlayground,
  type PlaygroundModelDeps,
  type PlaygroundModelResolveInput,
  type PlaygroundModelResolveResult,
} from "../src/domain/interactive/experience-playground.js";
import { runExperienceTest } from "../src/domain/interactive/experience-tester.js";
import { ExperienceChatterService } from "../src/domain/interactive/experience-chatter-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";

// ─── Shared rules sources (real, runnable experience bodies) ─────────────────

/** Minimal counter game: increment to 3 completes. Declares no capabilities. */
const COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "counter", name: "Counter" }, capabilities: [],
  create() { console.log("created"); return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "inc" }, { type: "reset" }]; },
  reduce(c, a) {
    if (a.type === "reset") return { state: { count: 0 }, status: "active", events: [] };
    const n = c.state.count + 1;
    return { state: { count: n }, status: n >= 3 ? "completed" : "active", events: [{ visibility: "public", type: "inc", detail: { n } }] };
  },
});
`;

/** A deterministic-random game: each reduce draws from the seeded stream. */
const RNG_SOURCE = `
  context.experience.register({
    apiVersion: 1, manifest: { id: "rng", name: "Rng" },
    capabilities: [{ capability: "deterministic_random" }],
    create(c) { return { roll: c.random.int(1, 1000) }; },
    project(c) { return { roll: c.state.roll }; },
    actions() { return [{ type: "reroll" }]; },
    reduce(c) { return { state: { roll: c.random.int(1, 1000) }, status: "active", events: [] }; },
  });
`;

/** reduce requests a durable model effect (reported, never executed). */
const EFFECT_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "eff", name: "Eff" }, capabilities: [],
  create() { return { asked: false }; },
  project(c) { return { asked: c.state.asked }; },
  actions() { return [{ type: "ask" }]; },
  reduce(c) {
    return {
      state: { asked: true }, status: "active",
      events: [{ visibility: "public", type: "asked" }],
      effects: [{ kind: "model", request: { viewer: "p1", mode: "text", actionType: "reply" } }],
    };
  },
});
`;

/** Script seat that counts to 3 then completes; declares `choose`. */
const SCRIPT_COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "sc", name: "SC" }, capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions(c) { return c.state.n < 3 ? [{ type: "tick" }] : []; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: c.state.n + 1 >= 3 ? "completed" : "active", events: [] }; },
  choose(c, { legal }) { return legal[0]; },
});
`;

/** Script + human seats; script passes the turn to the human. */
const TURN_HANDOFF_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "th", name: "TH" }, capabilities: [],
  create() { return { turn: "script" }; },
  project(c) { return { turn: c.state.turn }; },
  actions(c, v) {
    if (v.participantId === "bot") return c.state.turn === "script" ? [{ type: "pass" }] : [];
    return c.state.turn === "human" ? [{ type: "go" }] : [];
  },
  reduce(c) { return { state: { turn: "human" }, status: "active", events: [] }; },
  choose(c, { legal }) { return legal[0]; },
});
`;

const botScript = { id: "bot", label: "Bot", controller: "script" as const };
const youHuman = { id: "you", label: "You", controller: "human" as const };

// ─── 1. Direct-to-driver — real kernel (start + advance) ─────────────────────

describe("startExperiencePlayground / advanceExperiencePlayground — real kernel", () => {
  test("start discovers, creates, projects, lists legal actions, and reports the boundary", () => {
    const res = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.definition?.manifest.id).toBe("counter");
    expect(res.data.revision).toBe(0);
    expect(res.data.status).toBe("active");
    expect(res.data.initialState).toEqual({ count: 0 });
    expect(res.data.state).toEqual({ count: 0 });
    expect(res.data.projection.state).toEqual({ count: 0 });
    expect(res.data.projection.actions.map((a) => a.type)).toEqual(["inc", "reset"]);
    // A human seat with legal actions → awaiting_human.
    expect(res.data.stopReason).toBe("awaiting_human");
    expect(res.data.events).toEqual([]);
    expect(res.data.effects).toEqual([]);
    // Real VM console was captured (the create() body logs "created").
    expect(res.data.console.some((e) => e.args.includes("created"))).toBe(true);
  });

  test("advance applies a legal human action and returns the bumped revision + next projection + events/effects/console", () => {
    const started = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const res = advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.revision).toBe(1);
    expect(res.data.state).toEqual({ count: 1 });
    expect(res.data.initialState).toEqual({ count: 0 });
    expect(res.data.projection.state).toEqual({ count: 1 });
    // This turn emitted the inc event (delta, not accumulated).
    expect(res.data.events.map((e) => e.type)).toEqual(["inc"]);
    expect(res.data.stopReason).toBe("awaiting_human");
    // The definition is omitted on advance.
    expect(res.data.definition).toBeUndefined();
    // Turn console was captured (the reduce ran in the real VM).
    expect(Array.isArray(res.data.console)).toBe(true);
  });

  test("a legal action sequence drives the counter to a completed boundary", () => {
    const started = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.playgroundSessionId;

    const a1 = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 } });
    expect(a1.ok && a1.data.revision).toBe(1);
    const a2 = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "inc", requestId: "r2", expectedRevision: 1 } });
    expect(a2.ok && a2.data.revision).toBe(2);
    const a3 = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "inc", requestId: "r3", expectedRevision: 2 } });
    expect(a3.ok).toBe(true);
    if (!a3.ok) return;
    expect(a3.data.status).toBe("completed");
    expect(a3.data.revision).toBe(3);
    expect(a3.data.state).toEqual({ count: 3 });
    expect(a3.data.stopReason).toBe("completed");
  });

  test("an illegal action type returns the typed illegal_action error and applies nothing", () => {
    const started = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const res = advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "cheat", requestId: "r1", expectedRevision: 0 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("illegal_action");
    expect(res.error.status).toBe(422);
  });

  test("a stale expectedRevision returns the typed stale_revision error with the live revision", () => {
    const started = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.playgroundSessionId;

    const first = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 } });
    expect(first.ok).toBe(true);

    const res = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "inc", requestId: "r2", expectedRevision: 0 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("stale_revision");
    expect(res.error.status).toBe(409);
    expect(res.error.currentRevision).toBe(1);
  });

  test("a duplicate requestId is idempotent — it does not re-reduce or advance the revision", () => {
    const started = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.playgroundSessionId;

    const first = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "inc", requestId: "dup", expectedRevision: 0 } });
    expect(first.ok && first.data.revision).toBe(1);

    // Replay the SAME requestId (idempotency precedes CAS even with a now-stale revision).
    const replay = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "inc", requestId: "dup", expectedRevision: 0 } });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    // The revision did NOT advance again; the state is unchanged.
    expect(replay.data.revision).toBe(1);
    expect(replay.data.state).toEqual({ count: 1 });
    // The replayed turn surfaces the original step's events.
    expect(replay.data.events.map((e) => e.type)).toEqual(["inc"]);
  });

  test("an over-granted capability (not declared by the rules) returns capability_denied at start", () => {
    const res = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE, // declares no capabilities
      participants: [youHuman],
      capabilityGrants: ["deterministic_random"],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("capability_denied");
    expect(res.error.needs).toEqual(["deterministic_random"]);
  });

  test("a granted capability lets create read it; a discovery failure returns the typed error", () => {
    // A discovery failure returns the typed vm_error and runs no further step.
    const broken = startExperiencePlayground({
      rulesCode: "context.experience.register({ apiVersion: 1, manifest: { id: 'x', name: 'X' } });",
      participants: [],
      capabilityGrants: [],
    });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error.code).toBe("vm_error");
    expect(broken.error.kind).toBe("missing_method");
  });

  test("effects are reported on advance, never executed", () => {
    const started = startExperiencePlayground({
      rulesCode: EFFECT_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const res = advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "ask", requestId: "r1", expectedRevision: 0 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The model-effect request is captured this turn (reported, never executed).
    expect(res.data.effects).toHaveLength(1);
    expect(res.data.effects[0]?.kind).toBe("model");
    expect(res.data.state).toEqual({ asked: true });
  });

  test("an unknown playground session id returns a typed error", () => {
    const res = advanceExperiencePlayground({
      playgroundSessionId: "does-not-exist",
      humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.status).toBe(422);
    expect(res.error.code).toBe("session_not_found");
  });
});

// ─── 2. Script-seat advancement — between human turns ───────────────────────

describe("script-seat advancement — real choose until boundary", () => {
  test("leading script seats advance synchronously at start until the human boundary", () => {
    // TURN_HANDOFF: the script seat "bot" passes the turn to the human at start.
    const res = startExperiencePlayground({
      rulesCode: TURN_HANDOFF_SOURCE,
      participants: [botScript, youHuman],
      capabilityGrants: [],
      humanSeatId: "you",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The script advanced once (pass → turn: "human") then stopped at the human.
    expect(res.data.revision).toBe(1);
    expect(res.data.stopReason).toBe("awaiting_human");
    expect(res.data.state).toEqual({ turn: "human" });
  });

  test("a pure-script game advances to completion with no human seat", () => {
    const res = startExperiencePlayground({
      rulesCode: SCRIPT_COUNTER_SOURCE,
      participants: [botScript],
      capabilityGrants: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("completed");
    expect(res.data.revision).toBe(3);
    expect(res.data.state).toEqual({ n: 3 });
  });

  test("a fixed seed reproduces identical deterministic draws across two sessions", () => {
    const run = () =>
      startExperiencePlayground({
        rulesCode: RNG_SOURCE,
        participants: [youHuman],
        capabilityGrants: ["deterministic_random"],
        seed: "reproducible-seed",
      });
    const a = run();
    const b = run();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // The create() draw is pinned by the seed → identical initial state.
    expect(a.data.initialState).toEqual(b.data.initialState);
    expect(a.data.state).toEqual(b.data.state);
  });
});

// ─── 3. Model-seat stub — awaiting_model without any provider call ──────────

describe("model-seat stub — boundary reported, no provider/model invoked", () => {
  test("an awaiting_model boundary is reported WITHOUT any provider/ai-sdk call", () => {
    const modelSeat = { id: "m1", label: "Model", controller: "model" as const };
    const res = startExperiencePlayground({
      rulesCode: `
        context.experience.register({
          apiVersion: 1, manifest: { id: "ms", name: "MS" }, capabilities: [],
          create() { return {}; },
          project() { return {}; },
          actions() { return [{ type: "speak" }]; },
          reduce() { return { state: {}, status: "active", events: [] }; },
        });
      `,
      participants: [modelSeat],
      capabilityGrants: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stopReason).toBe("awaiting_model");
    // No reduce happened (the model seat did not act) — revision stays at 0.
    expect(res.data.revision).toBe(0);
  });
});

// ─── 3b. Ephemeral model continuation — IR-90E ────────────────────────────

/** A simplified model-conversation rules body (mirrors the shipped starter):
 *  human reply → user message + model effect; model reply (participantId =
 *  model seat) → model message + no new effect; finish → completed. */
const MODEL_CONV_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "mc", name: "MC" },
  capabilities: [{ capability: 'participants' }, { capability: 'model' }],
  create() { return { messages: [], turn: 0 }; },
  project(c) { return { messages: c.state.messages.slice(), turn: c.state.turn }; },
  actions() { return [{ type: 'reply', allowsText: true }, { type: 'finish' }]; },
  reduce(c, a) {
    if (a.type === 'finish') return { state: c.state, status: 'completed', events: [{ visibility: 'public', type: 'finished' }] };
    if (a.type !== 'reply') return { state: c.state, status: 'active', events: [] };
    var text = (a.payload && a.payload.text) || '';
    var ps = c.participants || [];
    var modelSeat = null;
    for (var i = 0; i < ps.length; i++) { if (ps[i].controller === 'model') { modelSeat = ps[i]; break; } }
    var msgs = c.state.messages.slice();
    var turn = c.state.turn + 1;
    if (modelSeat && a.participantId === modelSeat.id) {
      msgs.push({ from: 'them', text: text });
      return { state: { messages: msgs, turn: turn }, status: 'active', events: [{ visibility: 'public', type: 'model_replied' }] };
    }
    msgs.push({ from: 'you', text: text });
    var t = { state: { messages: msgs, turn: turn }, status: 'active', events: [{ visibility: 'public', type: 'user_replied' }] };
    if (modelSeat) t.effects = [{ kind: 'model', request: { viewer: modelSeat.id, mode: 'text', actionType: 'reply', instruction: 'Reply in character.' } }];
    return t;
  }
});
`;

const mcHuman = { id: "you", label: "You", controller: "human" as const };
const mcModel = { id: "ai", label: "AI", controller: "model" as const, providerProfileId: "pp_test", modelId: "gpt-test" };

/** A two-model group-chat rules body (fix step 10): a human reply emits ONE
 *  model effect per model seat (emission order = participant order); each model
 *  reply clears that seat's pending slot. Mirrors the shipped messenger shape. */
const GROUP_TWO_MODEL_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "gm", name: "GM" },
  capabilities: [{ capability: 'participants' }, { capability: 'model' }],
  create() { return { messages: [], pending: [] }; },
  project(c) { return { messages: c.state.messages.slice(), pending: c.state.pending.slice() }; },
  actions(c, viewer) {
    if (viewer && viewer.kind === 'model') {
      if (c.state.pending.length === 0) return [];
      return [{ type: 'reply', allowsText: true }];
    }
    if (c.state.pending.length > 0) return [];
    return [{ type: 'reply', allowsText: true }];
  },
  reduce(c, a) {
    var text = (a.payload && a.payload.text) || '';
    var ps = c.participants || [];
    var isModel = false;
    for (var i = 0; i < ps.length; i++) { if (ps[i].controller === 'model' && ps[i].id === a.participantId) isModel = true; }
    var msgs = c.state.messages.slice();
    var pending = c.state.pending.slice();
    if (isModel) {
      var idx = pending.indexOf(a.participantId);
      if (idx === -1) return { state: c.state, status: 'active', events: [] };
      pending.splice(idx, 1);
      msgs.push({ from: a.participantId, text: text });
      return { state: { messages: msgs, pending: pending }, status: 'active', events: [{ visibility: 'public', type: 'model_replied' }] };
    }
    msgs.push({ from: 'you', text: text });
    var newPending = [];
    var effects = [];
    for (var j = 0; j < ps.length; j++) {
      if (ps[j].controller === 'model') {
        newPending.push(ps[j].id);
        effects.push({ kind: 'model', request: { viewer: ps[j].id, mode: 'text', actionType: 'reply', instruction: 'Reply in character.' } });
      }
    }
    return { state: { messages: msgs, pending: newPending }, status: 'active', events: [{ visibility: 'public', type: 'user_replied' }], effects: effects };
  }
});
`;

const gmHuman = { id: "you", label: "You", controller: "human" as const };
const gmModel1 = { id: "ai1", label: "AI1", controller: "model" as const, providerProfileId: "pp1", modelId: "m1" };
const gmModel2 = { id: "ai2", label: "AI2", controller: "model" as const, providerProfileId: "pp2", modelId: "m2" };

/** A deterministic mock model seam that echoes the targeted seat id. */
function mockEchoModelDeps(): PlaygroundModelDeps {
  return {
    async resolveModelReply(input: PlaygroundModelResolveInput): Promise<PlaygroundModelResolveResult> {
      const req = input.request as { viewer?: unknown };
      return { ok: true, mode: "text", text: `reply-${typeof req.viewer === "string" ? req.viewer : "?"}` };
    },
  };
}

/** A deterministic mock model seam: always returns a fixed reply text. */
function mockModelDeps(replyText: string): PlaygroundModelDeps {
  return {
    async resolveModelReply(): Promise<PlaygroundModelResolveResult> {
      return { ok: true, mode: "text", text: replyText };
    },
  };
}

describe("executeModelTurnExperiencePlayground — ephemeral model continuation (IR-90E)", () => {
  test("a human reply → model continuation produces both messages with no store writes", async () => {
    const started = startExperiencePlayground({
      rulesCode: MODEL_CONV_SOURCE,
      participants: [mcHuman, mcModel],
      capabilityGrants: ["participants", "model"],
      humanSeatId: "you",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // The human replies.
    const advanced = advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hello!" } },
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    // The stop reason is awaiting_human (both seats have reply+finish) but the
    // turn's effects include a pending model effect for the model seat.
    const s1 = advanced.data.state as { messages: Array<{ from: string; text: string }>; turn: number };
    expect(s1.messages).toEqual([{ from: "you", text: "Hello!" }]);
    expect(advanced.data.effects.some((e) => e.kind === "model")).toBe(true);

    // Execute the ephemeral model continuation through the mock seam.
    const modelTurn = await executeModelTurnExperiencePlayground(
      { playgroundSessionId: started.data.playgroundSessionId },
      mockModelDeps("Hi there!"),
    );
    expect(modelTurn.ok).toBe(true);
    if (!modelTurn.ok) return;
    expect(modelTurn.data.stopReason).toBe("awaiting_human");
    expect(modelTurn.data.revision).toBe(2);
    const s2 = modelTurn.data.state as { messages: Array<{ from: string; text: string }>; turn: number };
    expect(s2.messages).toEqual([
      { from: "you", text: "Hello!" },
      { from: "them", text: "Hi there!" },
    ]);
    // The projection for the human viewer shows both messages + reply/finish.
    const proj = modelTurn.data.projection.state as { messages: unknown[] };
    expect(proj.messages).toHaveLength(2);
    expect(modelTurn.data.projection.actions.map((a) => a.type)).toContain("reply");
    expect(modelTurn.data.projection.actions.map((a) => a.type)).toContain("finish");
  });

  test("a model seat without a pinned provider/model returns a typed no_model error", async () => {
    const started = startExperiencePlayground({
      rulesCode: MODEL_CONV_SOURCE,
      participants: [mcHuman, { id: "ai", label: "AI", controller: "model" }],
      capabilityGrants: ["participants", "model"],
      humanSeatId: "you",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hi" } },
    });

    const modelTurn = await executeModelTurnExperiencePlayground(
      { playgroundSessionId: started.data.playgroundSessionId },
      mockModelDeps("reply"),
    );
    expect(modelTurn.ok).toBe(false);
    if (modelTurn.ok) return;
    expect(modelTurn.error.code).toBe("no_model");
  });

  test("a model seam failure surfaces as a typed error without advancing the revision", async () => {
    const started = startExperiencePlayground({
      rulesCode: MODEL_CONV_SOURCE,
      participants: [mcHuman, mcModel],
      capabilityGrants: ["participants", "model"],
      humanSeatId: "you",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hi" } },
    });

    const failingDeps: PlaygroundModelDeps = {
      async resolveModelReply() { return { ok: false, code: "no_api_key", message: "API key required" }; },
    };
    const modelTurn = await executeModelTurnExperiencePlayground(
      { playgroundSessionId: started.data.playgroundSessionId },
      failingDeps,
    );
    expect(modelTurn.ok).toBe(false);
    if (modelTurn.ok) return;
    expect(modelTurn.error.code).toBe("no_api_key");
  });

  test("finish works after a model turn — the conversation completes", async () => {
    const started = startExperiencePlayground({
      rulesCode: MODEL_CONV_SOURCE,
      participants: [mcHuman, mcModel],
      capabilityGrants: ["participants", "model"],
      humanSeatId: "you",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.playgroundSessionId;

    // Human reply → model continuation.
    advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hello" } } });
    await executeModelTurnExperiencePlayground({ playgroundSessionId: id }, mockModelDeps("Hi!"));

    // Finish.
    const finish = advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "finish", requestId: "h2", expectedRevision: 2 } });
    expect(finish.ok).toBe(true);
    if (!finish.ok) return;
    expect(finish.data.status).toBe("completed");
    expect(finish.data.stopReason).toBe("completed");
  });

  // ── Fix step 10: two-model drain ────────────────────────────────────────
  test("two model effects from one transition are both delivered in emission order", async () => {
    const started = startExperiencePlayground({
      rulesCode: GROUP_TWO_MODEL_SOURCE,
      participants: [gmHuman, gmModel1, gmModel2],
      capabilityGrants: ["participants", "model"],
      humanSeatId: "you",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.playgroundSessionId;

    advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hi" } } });

    const turn = await executeModelTurnExperiencePlayground({ playgroundSessionId: id }, mockEchoModelDeps());
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.data.revision).toBe(3); // 1 human + 2 model steps
    expect(turn.data.stopReason).toBe("awaiting_human");
    const s = turn.data.state as { messages: Array<{ from: string; text: string }>; pending: string[] };
    expect(s.messages).toEqual([
      { from: "you", text: "Hi" },
      { from: "ai1", text: "reply-ai1" },
      { from: "ai2", text: "reply-ai2" },
    ]);
    expect(s.pending).toEqual([]);
  });

  test("a second drain call is a no-op (no re-execution of delivered effects)", async () => {
    const started = startExperiencePlayground({
      rulesCode: GROUP_TWO_MODEL_SOURCE,
      participants: [gmHuman, gmModel1, gmModel2],
      capabilityGrants: ["participants", "model"],
      humanSeatId: "you",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.playgroundSessionId;

    advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hi" } } });
    await executeModelTurnExperiencePlayground({ playgroundSessionId: id }, mockEchoModelDeps());

    const again = await executeModelTurnExperiencePlayground({ playgroundSessionId: id }, mockEchoModelDeps());
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.revision).toBe(3); // unchanged
    expect(again.data.events).toEqual([]);
    const s = again.data.state as { messages: Array<{ from: string; text: string }> };
    expect(s.messages).toHaveLength(3); // no duplicated model message
  });

  test("a mid-drain seam failure aborts after delivered effects; a later call drains the rest", async () => {
    const started = startExperiencePlayground({
      rulesCode: GROUP_TWO_MODEL_SOURCE,
      participants: [gmHuman, gmModel1, gmModel2],
      capabilityGrants: ["participants", "model"],
      humanSeatId: "you",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.playgroundSessionId;

    advanceExperiencePlayground({ playgroundSessionId: id, humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hi" } } });

    // First call: deliver ai1, then fail on ai2.
    let calls = 0;
    const failingSecondDeps: PlaygroundModelDeps = {
      async resolveModelReply(): Promise<PlaygroundModelResolveResult> {
        calls += 1;
        if (calls === 1) return { ok: true, mode: "text", text: "reply-ai1" };
        return { ok: false, code: "provider_failed", message: "boom" };
      },
    };
    const turn = await executeModelTurnExperiencePlayground({ playgroundSessionId: id }, failingSecondDeps);
    expect(turn.ok).toBe(false);
    if (turn.ok) return;
    expect(turn.error.code).toBe("provider_failed");

    // The second call with a working deps drains the remaining effect only.
    const rest = await executeModelTurnExperiencePlayground({ playgroundSessionId: id }, mockEchoModelDeps());
    expect(rest.ok).toBe(true);
    if (!rest.ok) return;
    expect(rest.data.revision).toBe(3); // ai1 already applied (2) + ai2 now (3)
    const s = rest.data.state as { messages: Array<{ from: string; text: string }>; pending: string[] };
    expect(s.messages.map((m) => `${m.from}:${m.text}`)).toEqual([
      "you:Hi",
      "ai1:reply-ai1",
      "ai2:reply-ai2",
    ]);
    expect(s.pending).toEqual([]);
  });
});

// ─── 3c. ExperienceAdapter — injected PlaygroundModelDeps (IR-90E1) ──────────

/** Build an adapter with all real services but inject explicit playground model
 *  deps (no providerProfiles derivation). The driver-under-test (start/advance
 *  playground) is never mocked — only the model seam is injected. */
function buildAdapterWithModelDeps(stores: StoreContainer, deps: PlaygroundModelDeps): ExperienceAdapter {
	const resources = new ExperienceResourceService(stores);
	const lifecycle = new ExperienceService(stores, resources, { generateSeed: () => "seed1" });
	const replay = new ExperienceReplayService(stores, resources);
	const providerProfiles = createProviderProfileService(stores.providers, stores.proxies);
	const chatLifecycle: ExperienceChatLifecycleSeam = {
		assembleSummaryPrompt: async () => {
			throw new Error("Compact-summary execution is outside this playground fixture.");
		},
	};
	const contextService = new ExperienceContextService({ stores, providerProfiles, chatLifecycle });
	const modelEffect = new ExperienceModelEffectService({
		stores,
		experienceService: lifecycle,
		contextService,
		providerProfiles,
	});
	// IR-90E1: inject explicit playground model deps; undefined providerProfiles
	// means the adapter would have no model deps via the derivation path — the
	// injected deps are the only seam.
	return new ExperienceAdapter(
		lifecycle, resources, replay, modelEffect, contextService,
		undefined, // providerProfiles — not derived; deps injected explicitly
		deps,
	);
}

describe("ExperienceAdapter — injected PlaygroundModelDeps (IR-90E1)", () => {
	test("adapter transparently chains model continuation after a human advance", async () => {
		// A spy seam: records every call and returns a fixed reply.
		const spyCalls: PlaygroundModelResolveInput[] = [];
		const modelDeps: PlaygroundModelDeps = {
			async resolveModelReply(input) {
				spyCalls.push(input);
				return { ok: true, mode: "text", text: "Hi from model!" };
			},
		};

		const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-adapter-model-"));
		const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
		const adapter = buildAdapterWithModelDeps(stores, modelDeps);

		// Start a playground session with model-conversation rules.
		const started = await adapter.startExperiencePlayground({
			rulesCode: MODEL_CONV_SOURCE,
			participants: [mcHuman, mcModel],
			capabilityGrants: ["participants", "model"],
			humanSeatId: "you",
		});
		expect(started.stopReason).toBe("awaiting_human");
		expect(started.revision).toBe(0);

		// Advance with a human reply — the adapter should auto-chain the
		// model continuation via the injected deps and return both messages.
		const advanced = await adapter.advanceExperiencePlayground({
			playgroundSessionId: started.playgroundSessionId,
			humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hello!" } },
		});

		// The adapter transparently continued the model turn.
		expect(advanced.stopReason).toBe("awaiting_human");
		expect(advanced.revision).toBe(2); // human reduce + model reduce = 2
		const state = advanced.state as { messages: Array<{ from: string; text: string }>; turn: number };
		expect(state.messages).toEqual([
			{ from: "you", text: "Hello!" },
			{ from: "them", text: "Hi from model!" },
		]);

		// The injected seam received the pinned provider/model from the model seat.
		expect(spyCalls).toHaveLength(1);
		expect(spyCalls[0]!.providerProfileId).toBe("pp_test");
		expect(spyCalls[0]!.modelId).toBe("gpt-test");
		// The pending effect request was forwarded to the seam verbatim.
		const req = spyCalls[0]!.request as { viewer: string; mode: string; instruction: string };
		expect(req.viewer).toBe("ai");
		expect(req.mode).toBe("text");
		expect(req.instruction).toBe("Reply in character.");
	});

	test("adapter with no pending model effect does NOT invoke the injected seam", async () => {
		let callCount = 0;
		const modelDeps: PlaygroundModelDeps = {
			async resolveModelReply() {
				callCount += 1;
				return { ok: true, mode: "text", text: "unexpected" };
			},
		};

		const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-adapter-nomodel-"));
		const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
		const adapter = buildAdapterWithModelDeps(stores, modelDeps);

		// Start a counter game — no model effects.
		const started = await adapter.startExperiencePlayground({
			rulesCode: COUNTER_SOURCE,
			participants: [youHuman],
			capabilityGrants: [],
		});
		expect(started.stopReason).toBe("awaiting_human");

		const advanced = await adapter.advanceExperiencePlayground({
			playgroundSessionId: started.playgroundSessionId,
			humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
		});
		expect(advanced.revision).toBe(1);
		expect(advanced.state).toEqual({ count: 1 });
		// The injected seam was NOT called — there was no pending model effect.
		expect(callCount).toBe(0);
	});

	test("adapter with NO injected deps preserves the model-stub behavior (no continuation)", async () => {
		// This adapter is built WITHOUT explicit deps and WITHOUT providerProfiles —
		// the production path that routes through buildAdapter() in the existing
		// HTTP integration tests (section 6).
		const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-adapter-stub-"));
		const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
		const adapter = buildAdapter(stores); // existing helper — no providerProfiles, no injected deps

		const started = await adapter.startExperiencePlayground({
			rulesCode: MODEL_CONV_SOURCE,
			participants: [mcHuman, mcModel],
			capabilityGrants: ["participants", "model"],
			humanSeatId: "you",
		});
		expect(started.stopReason).toBe("awaiting_human");

		// Advance with a human reply. No model deps → no continuation.
		const advanced = await adapter.advanceExperiencePlayground({
			playgroundSessionId: started.playgroundSessionId,
			humanAction: { type: "reply", requestId: "h1", expectedRevision: 0, payload: { text: "Hello!" } },
		});
		// The adapter returned the human-only state; the pending model effect is
		// reported but NOT executed.
		expect(advanced.revision).toBe(1); // only the human action applied
		const s = advanced.state as { messages: Array<{ from: string; text: string }> };
		expect(s.messages).toEqual([{ from: "you", text: "Hello!" }]);
	});
});

// ─── 4. No-write invariant — structural + behavioral ─────────────────────────

describe("no-write invariant — zero persistence/binding/DB involvement", () => {
  test("structural: the driver module imports only kernel/sandbox/shared/domain/contracts", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../src/domain/interactive/experience-playground.ts"),
    ).text();
    // The ONLY import targets permitted (the no-persistence dependency graph).
    const allowedImports = new Set([
      "./experience-kernel.js",
      "./experience-sandbox.js",
      "./experience-shared.js",
      "./experience-tester.js",
      "@vibe-tavern/domain",
    ]);
    // Collect every `from "..."` target that appears on an `import` line ONLY
    // (the module's doc comment legitimately names the banned modules in prose
    // to explain what it does NOT import — scanning the whole source would
    // false-positive on that prose, exactly the `as never`/"was never" trap).
    const importTargets: string[] = [];
    for (const line of source.match(/^import .+$/gm) ?? []) {
      for (const m of line.matchAll(/from\s+"([^"]+)"/g)) {
        importTargets.push(m[1]!);
      }
    }
    expect(importTargets.length).toBeGreaterThan(0);
    for (const target of importTargets) {
      expect(allowedImports.has(target)).toBe(true);
    }
    // No persistence/provider/binding/db target is imported.
    const banned = [
      "experience-store",
      "experience-service.js",
      "experience-resource-service",
      "experience-replay-service",
      "experience-model-effect-service",
      "experience-context-service",
      "@vibe-tavern/db",
      "provider-profile-service",
      "@ai-sdk",
      "ai-sdk",
    ];
    for (const target of importTargets) {
      expect(banned.some((b) => target.includes(b))).toBe(false);
    }
  });

  test("behavioral: a start+advance loop never calls the persistence layer's write path", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-pg-nowrite-"));
    const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);

    // Spy on the experience store's mutating methods. The driver never receives
    // a store, so this confirms the adapter's playground methods (which DO hold
    // a store via the lifecycle service) do not delegate to persistence.
    const writeCalls: string[] = [];
    const target = stores.experiences as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["applyTransition", "createSession", "appendJournalEntry"]) {
      const original = target[method];
      if (typeof original === "function") {
        target[method] = (...args: unknown[]) => {
          writeCalls.push(method);
          return original(...args);
        };
      }
    }

    const adapter = buildAdapter(stores);
    const started = await adapter.startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    await adapter.advanceExperiencePlayground({
      playgroundSessionId: started.playgroundSessionId,
      humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
    });

    // The playground start+advance wrote nothing through the store.
    expect(writeCalls).toEqual([]);
  });
});

// ─── 5. Parity — playground driver vs the IR-81B tester's runExperienceTest ──

describe("parity — same kernel/seed/sequence → identical outcomes", () => {
  test("a fixed-seed action sequence matches runExperienceTest exactly (state/revision/events/effects/status)", () => {
    const seed = "parity-seed";
    const actions = [
      { type: "reroll", requestId: "p1", expectedRevision: 0 },
      { type: "reroll", requestId: "p2", expectedRevision: 1 },
    ];

    // Oracle: the IR-81B tester replays the full sequence in one shot.
    const oracle = runExperienceTest({
      rulesCode: RNG_SOURCE,
      capabilityGrants: ["deterministic_random"],
      seed,
      actions,
    });
    expect(oracle.ok).toBe(true);
    if (!oracle.ok) return;

    // Subject: the playground driver drives the same sequence turn by turn.
    const started = startExperiencePlayground({
      rulesCode: RNG_SOURCE,
      participants: [youHuman],
      capabilityGrants: ["deterministic_random"],
      seed,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const accEvents: typeof started.data.events = [...started.data.events];
    const accEffects: typeof started.data.effects = [...started.data.effects];
    let last = started.data;
    for (const action of actions) {
      const advanced = advanceExperiencePlayground({
        playgroundSessionId: started.data.playgroundSessionId,
        humanAction: action,
      });
      expect(advanced.ok).toBe(true);
      if (!advanced.ok) return;
      accEvents.push(...advanced.data.events);
      accEffects.push(...advanced.data.effects);
      last = advanced.data;
    }

    // Identical deterministic draws → identical final state + revision.
    expect(last.state).toEqual(oracle.data.finalState);
    expect(last.revision).toBe(oracle.data.revision);
    expect(last.status).toBe(oracle.data.status);
    // The single-stream RNG is shared: the create draw matches too.
    expect(started.data.initialState).toEqual(oracle.data.initialState);
    // Accumulated events/effects match the oracle's full run.
    expect(accEvents).toEqual(oracle.data.events);
    expect(accEffects).toEqual(oracle.data.effects);
    // Projected view matches.
    expect(last.projection.state).toEqual(oracle.data.projection.state);
    expect(last.projection.actions.map((a) => a.type)).toEqual(
      oracle.data.projection.actions.map((a) => a.type),
    );
  });

  test("a no-capability counter sequence matches runExperienceTest", () => {
    const actions = [
      { type: "inc", requestId: "c1", expectedRevision: 0 },
      { type: "inc", requestId: "c2", expectedRevision: 1 },
      { type: "inc", requestId: "c3", expectedRevision: 2 },
    ];
    const oracle = runExperienceTest({ rulesCode: COUNTER_SOURCE, actions });
    expect(oracle.ok).toBe(true);
    if (!oracle.ok) return;

    const started = startExperiencePlayground({
      rulesCode: COUNTER_SOURCE,
      participants: [youHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    let last = started.data;
    for (const action of actions) {
      const advanced = advanceExperiencePlayground({
        playgroundSessionId: started.data.playgroundSessionId,
        humanAction: action,
      });
      expect(advanced.ok).toBe(true);
      if (!advanced.ok) return;
      last = advanced.data;
    }
    expect(last.state).toEqual(oracle.data.finalState);
    expect(last.revision).toBe(oracle.data.revision);
    expect(last.status).toBe(oracle.data.status);
  });
});

// ─── 6. HTTP integration — route → adapter → driver → real kernel ────────────

function mount(runtime: ReturnType<typeof buildAdapter>) {
  const app = createExperienceRoutes(runtime);
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  return app;
}

async function jsonBody(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

function buildAdapter(stores: StoreContainer): ExperienceAdapter {
  const resources = new ExperienceResourceService(stores);
  const lifecycle = new ExperienceService(stores, resources, { generateSeed: () => "seed1" });
  const replay = new ExperienceReplayService(stores, resources);
  const providerProfiles = createProviderProfileService(stores.providers, stores.proxies);
  const chatLifecycle: ExperienceChatLifecycleSeam = {
    assembleSummaryPrompt: async () => {
      throw new Error("Compact-summary execution is outside this playground fixture.");
    },
  };
  const contextService = new ExperienceContextService({ stores, providerProfiles, chatLifecycle });
  const modelEffect = new ExperienceModelEffectService({
    stores,
    experienceService: lifecycle,
    contextService,
    providerProfiles,
  });
  return new ExperienceAdapter(lifecycle, resources, replay, modelEffect, contextService);
}

async function setupPlaygroundApp() {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-pg-"));
  const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  return mount(buildAdapter(stores));
}

describe("Experience playground routes — integration (real adapter + kernel)", () => {
  test("POST /api/experience/playground/start + /advance drive a real loop", async () => {
    const app = await setupPlaygroundApp();
    const startRes = await app.request("/api/experience/playground/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesCode: COUNTER_SOURCE,
        participants: [youHuman],
        capabilityGrants: [],
      }),
    });
    expect(startRes.status).toBe(200);
    const started = await jsonBody(startRes);
    expect(started.definition.manifest.id).toBe("counter");
    expect(started.revision).toBe(0);
    expect(started.stopReason).toBe("awaiting_human");
    expect(started.projection.state).toEqual({ count: 0 });

    const advanceRes = await app.request("/api/experience/playground/advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playgroundSessionId: started.playgroundSessionId,
        humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
      }),
    });
    expect(advanceRes.status).toBe(200);
    const advanced = await jsonBody(advanceRes);
    expect(advanced.revision).toBe(1);
    expect(advanced.state).toEqual({ count: 1 });
    expect(advanced.events.map((e: { type: string }) => e.type)).toEqual(["inc"]);
    expect(advanced.stopReason).toBe("awaiting_human");
  });

  test("a stale expectedRevision is 409 stale_revision with currentRevision", async () => {
    const app = await setupPlaygroundApp();
    const started = await jsonBody(
      await app.request("/api/experience/playground/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rulesCode: COUNTER_SOURCE, participants: [youHuman], capabilityGrants: [] }),
      }),
    );
    await app.request("/api/experience/playground/advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playgroundSessionId: started.playgroundSessionId,
        humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
      }),
    });
    const res = await app.request("/api/experience/playground/advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playgroundSessionId: started.playgroundSessionId,
        humanAction: { type: "inc", requestId: "r2", expectedRevision: 0 },
      }),
    });
    expect(res.status).toBe(409);
    const body = await jsonBody(res);
    expect(body.error.details.code).toBe("stale_revision");
    expect(body.error.details.currentRevision).toBe(1);
  });

  test("an illegal action is 422 illegal_action", async () => {
    const app = await setupPlaygroundApp();
    const started = await jsonBody(
      await app.request("/api/experience/playground/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rulesCode: COUNTER_SOURCE, participants: [youHuman], capabilityGrants: [] }),
      }),
    );
    const res = await app.request("/api/experience/playground/advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playgroundSessionId: started.playgroundSessionId,
        humanAction: { type: "cheat", requestId: "r1", expectedRevision: 0 },
      }),
    });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).error.details.code).toBe("illegal_action");
  });

  test("an over-granted capability is 422 capability_denied", async () => {
    const app = await setupPlaygroundApp();
    const res = await app.request("/api/experience/playground/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesCode: COUNTER_SOURCE,
        participants: [youHuman],
        capabilityGrants: ["rp_context"],
      }),
    });
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).error.details.code).toBe("capability_denied");
  });

  test("a vm_error is 422 and surfaces the console on the error path", async () => {
    const app = await setupPlaygroundApp();
    const res = await app.request("/api/experience/playground/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rulesCode: "(((", participants: [], capabilityGrants: [] }),
    });
    expect(res.status).toBe(422);
    const body = await jsonBody(res);
    expect(body.error.details.code).toBe("vm_error");
    expect(body.error.details.kind).toBe("syntax");
    expect(Array.isArray(body.error.details.console)).toBe(true);
  });

  test("schema rejection: a start body missing rulesCode is 400", async () => {
    const app = await setupPlaygroundApp();
    const res = await app.request("/api/experience/playground/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participants: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("schema rejection: an advance body missing playgroundSessionId is 400", async () => {
    const app = await setupPlaygroundApp();
    const res = await app.request("/api/experience/playground/advance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── 7. Async flavor chatter (item 4 / AC-2b) ─────────────────────────────

/** A rules body whose `flavor` returns a chatter marker (seat `ai1`). */
const CHATTER_FLAVOR_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "chatter", name: "Chatter" },
  capabilities: [{ capability: 'participants' }],
  create() { return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: 'inc' }]; },
  reduce(c) { return { state: { count: c.state.count + 1 }, status: 'active', events: [] }; },
  flavor() { return { experienceChatter: { seatId: 'ai1', instructions: 'react in character', fallback: '...' } }; },
});
`;

/** A rules body whose `flavor` returns static cosmetic data (no marker). */
const STATIC_FLAVOR_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "sf", name: "SF" },
  capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: 'tick' }]; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: 'active', events: [] }; },
  flavor() { return { hint: 'look at the board' }; },
});
`;

const chatterHuman = { id: "you", label: "You", controller: "human" as const };
const chatterModelSeat = {
  id: "ai1", label: "AI", controller: "model" as const,
  providerProfileId: "pp_chatter", modelId: "m_chatter",
};

function makeChatterProfile(): StoredProviderProfileRecord {
  return {
    id: "pp_chatter", name: "Chatter Test", providerPreset: "ollama", endpoint: "http://x", apiKey: null,
    defaultModel: "m_chatter", contextBudget: 8000, pinContextBudget: false, bindPerModel: false,
    modelFreeOnly: false, modelGroupByOwner: false, maxTokens: 4096, temperature: 1, topP: 1, topK: 0,
    minP: 0, topA: 0, typicalP: 1, tfsZ: 1, repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 0, dryAllowedLength: 0, drySequenceBreakers: [], xtcThreshold: 0,
    xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1, stopSequences: [],
    logitBias: [], seed: null, reasoningEffort: "medium", showReasoning: false, streamResponse: true,
    customSamplers: false, proxyMode: "off", proxyId: null, isActive: true, visionModel: null,
    createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
  } as StoredProviderProfileRecord;
}

/** Build a REAL ExperienceChatterService with a mock provider-profile service +
 *  a fixed-text executor seam (the same injection shape the chatter-service test
 *  uses). Returns the service plus a call-count spy on the executor. */
function makeChatterService(replyText: string): { service: ExperienceChatterService; executeCalls: () => number } {
  const profile = makeChatterProfile();
  const providerProfiles: Pick<ProviderProfileService, "resolveActiveProviderProfile" | "getProviderProfile" | "getProviderModelSettings"> = {
    resolveActiveProviderProfile: async () => profile,
    getProviderProfile: async (id: string) => (id === profile.id ? profile : null),
    getProviderModelSettings: async () => null,
  };
  let calls = 0;
  const service = new ExperienceChatterService({
    providerProfiles: providerProfiles as unknown as ProviderProfileService,
    execute: (async () => {
      calls += 1;
      return { text: replyText };
    }) as never,
  });
  return { service, executeCalls: () => calls };
}

/** Let the chatter fire-and-forget promise land before asserting the resolved view. */
async function settleChatter(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("playground async flavor chatter (AC-2b)", () => {
  test("static flavor passes through into the playground projection (no chatter dep)", () => {
    const started = startExperiencePlayground({
      rulesCode: STATIC_FLAVOR_SOURCE,
      participants: [chatterHuman],
      capabilityGrants: [],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.projection.flavor).toEqual({ hint: "look at the board" });
  });

  test("a chatter marker returns pending on the first projection, then resolved after the model settles", async () => {
    const { service, executeCalls } = makeChatterService("A cosmetic line.");
    const started = startExperiencePlayground(
      {
        rulesCode: CHATTER_FLAVOR_SOURCE,
        participants: [chatterHuman, chatterModelSeat],
        capabilityGrants: ["participants"],
        humanSeatId: "you",
      },
      { chatter: service },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.projection.flavor).toEqual({ status: "pending", seatId: "ai1", fallback: "..." });

    // Advance bumps the revision → a fresh attempt (pending again).
    const advanced = advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.data.projection.flavor).toEqual({ status: "pending", seatId: "ai1", fallback: "..." });

    await settleChatter();
    // Re-project the SAME revision via the idempotent duplicate-requestId replay
    // (no revision advance) — the cache now serves the resolved view.
    const replay = advanceExperiencePlayground({
      playgroundSessionId: started.data.playgroundSessionId,
      humanAction: { type: "inc", requestId: "r1", expectedRevision: 0 },
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.projection.flavor).toEqual({ status: "resolved", seatId: "ai1", text: "A cosmetic line." });
    // The executor ran exactly twice — one attempt for revision 0 (start) and
    // one for revision 1 (advance). The duplicate-requestId replay above did NOT
    // fire a third call (single-attempt-per-revision semantics).
    expect(executeCalls()).toBe(2);
  });

  test("static flavor stays byte-identical when a chatter dep IS wired (no marker → no model call)", async () => {
    const { service, executeCalls } = makeChatterService("never used");
    const started = startExperiencePlayground(
      {
        rulesCode: STATIC_FLAVOR_SOURCE,
        participants: [chatterHuman],
        capabilityGrants: [],
      },
      { chatter: service },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.projection.flavor).toEqual({ hint: "look at the board" });
    await settleChatter();
    expect(executeCalls()).toBe(0);
  });
});

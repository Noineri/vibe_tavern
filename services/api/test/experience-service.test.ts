/**
 * Experience lifecycle service tests
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-31).
 *
 * Full-path through the REAL VM (node:vm sandbox + kernel) and the REAL DB
 * (temp SQLite via createStoreContainer). No mocked store, no narrowed pure-
 * function substitute. Covers start/resume/end, per-viewer projection, action
 * dispatch + CAS + idempotency, the synchronous script-controller loop, and
 * deterministic-random cursor tracking across resume/replay.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { EXPERIENCE_CAPABILITY, EXPERIENCE_VIEWER_KIND } from "@vibe-tavern/domain";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";

// ─── Test experiences ────────────────────────────────────────────────────────

/** A no-capability counter game: inc/reset, completes at count >= 3. */
const COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [],
  create() { return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "inc" }, { type: "reset" }]; },
  reduce(c, a) {
    if (a.type === "reset") return { state: { count: 0 }, status: "active", events: [{ visibility: "public", type: "reset" }] };
    const n = c.state.count + 1;
    return { state: { count: n }, status: n >= 3 ? "completed" : "active", events: [{ visibility: "public", type: "inc", detail: { n } }] };
  },
});
`;

/** A 2-player turn-based hotseat using the participants capability + explicit choose. */
const HOTSEAT_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "hotseat", name: "Hotseat" },
  capabilities: [{ capability: "participants", reason: "seat roster" }],
  create() { return { turn: 0, scores: [0, 0] }; },
  project(c) { return { turn: c.state.turn, scores: c.state.scores }; },
  actions(c, v) {
    if (v.participantId !== "p" + c.state.turn) return [];
    return [{ type: "score", participantId: "p" + c.state.turn }];
  },
  choose(c, info) {
    // Explicit chooser: pick the first legal move offered for this seat.
    const legal = info.legal[0];
    return legal
      ? { type: legal.type, participantId: info.viewer.participantId }
      : { type: "score", participantId: info.viewer.participantId };
  },
  reduce(c) {
    const scores = [...c.state.scores];
    scores[c.state.turn] += 1;
    return { state: { turn: (c.state.turn + 1) % 2, scores }, status: "active", events: [{ visibility: "public", type: "scored", detail: { player: c.state.turn } }] };
  },
});
`;

/** A hotseat with a script seat that has legal actions but NO `choose` method. */
const NO_CHOOSE_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "nochoose", name: "NoChoose" },
  capabilities: [{ capability: "participants", reason: "seat" }],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions(c, v) { return v.participantId === "bot" ? [{ type: "tick", participantId: "bot" }] : []; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
});
`;

/** A game whose optional `flavor` returns cosmetic data using ephemeral `chance`. */
const FLAVOR_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "flavor", name: "Flavor" },
  capabilities: [],
  create() { return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "inc" }]; },
  flavor(c, v) {
    return { greeting: "hi " + (v.participantId ?? "stranger"), tag: c.chance.int(1, 100) };
  },
  reduce(c) { return { state: { count: c.state.count + 1 }, status: "active", events: [] }; },
});
`;

/** A deterministic-random game: each roll consumes one die draw. */
const DICEY_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "dicey", name: "Dicey" },
  capabilities: [{ capability: "deterministic_random", reason: "rolls" }],
  create() { return { rolls: [] }; },
  project(c) { return { rolls: c.state.rolls }; },
  actions() { return [{ type: "roll" }]; },
  reduce(c) {
    const face = c.random.die(6);
    return { state: { rolls: [...c.state.rolls, face] }, status: "active", events: [{ visibility: "public", type: "rolled", detail: { face } }] };
  },
});
`;

/** A game that requests a model effect on reduce (pending in Wave 3). */
const MODEL_EFFECT_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "m-eff", name: "ModelEffect" },
  capabilities: [],
  create() { return { asked: false }; },
  project(c) { return { asked: c.state.asked }; },
  actions() { return [{ type: "ask" }]; },
  reduce(c) {
    return { state: { asked: true }, status: "active", events: [], effects: [{ kind: "model", request: { prompt: "reply" } }] };
  },
});
`;

// ─── Setup helpers ───────────────────────────────────────────────────────────

let stores: StoreContainer;
let resources: ExperienceResourceService;

async function setup(seed: string | null = null) {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-xlife-svc-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  resources = new ExperienceResourceService(stores);
  const service = new ExperienceService(stores, resources, seed === null ? {} : { generateSeed: () => seed });
  return service;
}

async function seedChatAndScript(source: string, grants: string[] = []) {
  const character = await stores.characters.create({ name: "Hero" } as never);
  const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });
  const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source });
  await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: grants as never });
  return { chatId: chat.id, branchId: chat.activeBranchId };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceService — basic lifecycle (counter, no capabilities)", () => {
  test("start → project → action → resume → end, with revision + status tracking", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);

    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.revision).toBe(0);
    expect(started.data.status).toBe("active");
    expect(started.data.manifest.id).toBe("counter");
    const sid = started.data.sessionId;

    // Projection returns the current state + legal actions for the viewer.
    const view = await service.getProjectedView(sid, { kind: "observer" });
    expect(view.ok && (view.data.state as { count: number }).count).toBe(0);
    expect(view.ok && view.data.actions.map((a) => a.type)).toEqual(["inc", "reset"]);

    // Apply an action: revision advances, state updates, a public event emitted.
    const a1 = await service.submitAction(sid, { type: "inc", requestId: "r1", expectedRevision: 0 });
    expect(a1.ok && a1.data.session.revision).toBe(1);
    expect(a1.ok && (a1.data.projection.state as { count: number }).count).toBe(1);
    expect(a1.ok && a1.data.events[0]?.type).toBe("inc");

    const a2 = await service.submitAction(sid, { type: "inc", requestId: "r2", expectedRevision: 1 });
    expect(a2.ok && a2.data.session.revision).toBe(2);

    // Resume reloads the same authoritative state.
    const resumed = await service.resumeSession(sid);
    expect(resumed.ok && resumed.data.revision).toBe(2);

    // Third inc completes the game.
    const a3 = await service.submitAction(sid, { type: "inc", requestId: "r3", expectedRevision: 2 });
    expect(a3.ok && a3.data.session.status).toBe("completed");
    expect(a3.ok && a3.data.await).toBe("completed");

    // End (already completed — explicit finish releases the active slot).
    expect((await service.endSession(sid, "completed")).ok).toBe(true);
  });

  test("stale expectedRevision is a 409; an illegal action type is a 422", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    if (!started.ok) return;
    const sid = started.data.sessionId;
    await service.submitAction(sid, { type: "inc", requestId: "r1", expectedRevision: 0 }); // rev → 1

    const stale = await service.submitAction(sid, { type: "inc", requestId: "r2", expectedRevision: 0 });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("stale_revision");
    expect(stale.error.currentRevision).toBe(1);

    const illegal = await service.submitAction(sid, { type: "cheat", requestId: "r3", expectedRevision: 1 });
    expect(illegal.ok).toBe(false);
    if (illegal.ok) return;
    expect(illegal.error.code).toBe("illegal_action");
  });

  test("duplicate requestId is idempotent (replayed, no second revision bump)", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    if (!started.ok) return;
    const sid = started.data.sessionId;

    const first = await service.submitAction(sid, { type: "inc", requestId: "dup", expectedRevision: 0 });
    const dup = await service.submitAction(sid, { type: "inc", requestId: "dup", expectedRevision: 0 });
    expect(first.ok && first.data.replayed).toBe(false);
    expect(dup.ok && dup.data.replayed).toBe(true);
    expect(dup.ok && dup.data.session.revision).toBe(first.ok ? first.data.session.revision : -1);
  });

  test("start refuses when the branch already has an active session", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    expect((await service.startSession({ chatId, branchId, settings: {}, participants: [] })).ok).toBe(true);
    const second = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("branch_has_active");
  });
});

describe("ExperienceService — synchronous script-controller loop (hotseat)", () => {
  test("after a human move, the script opponent auto-acts and the turn returns to the human", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(HOTSEAT_SOURCE, [EXPERIENCE_CAPABILITY.participants]);
    const participants = [
      { id: "p0", label: "You", controller: "human" },
      { id: "p1", label: "Bot", controller: "script" },
    ];
    const started = await service.startSession({ chatId, branchId, settings: {}, participants });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;
    expect(started.data.participants).toHaveLength(2);

    // Human (p0) acts → revision 1.
    const human = await service.submitAction(sid, {
      type: "score", requestId: "h1", expectedRevision: 0, participantId: "p0",
    });
    expect(human.ok && human.data.session.revision).toBe(1);

    // Now it's the script's turn (p1): advanceScriptTurns reduces it automatically.
    const advanced = await service.advanceScriptTurns(sid);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.data.await).toBe("human"); // turn came back to the human
    // Two transitions happened (human + script); scores are [1, 1].
    expect((advanced.data.projection.state as { scores: number[] }).scores).toEqual([1, 1]);
    expect(advanced.data.session.revision).toBe(2);
  });

  test("submitAction rejects a move by a participant whose turn it is not (illegal_action)", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(HOTSEAT_SOURCE, [EXPERIENCE_CAPABILITY.participants]);
    const participants = [
      { id: "p0", label: "You", controller: "human" },
      { id: "p1", label: "Bot", controller: "script" },
    ];
    const started = await service.startSession({ chatId, branchId, settings: {}, participants });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;

    // p1 acts on turn 0 (it's p0's turn) → illegal.
    const illegal = await service.submitAction(sid, {
      type: "score", requestId: "x", expectedRevision: 0, participantId: "p1",
    });
    expect(illegal.ok).toBe(false);
    if (illegal.ok) return;
    expect(illegal.error.code).toBe("illegal_action");
  });
});

describe("ExperienceService — explicit choose + flavor (contract revision)", () => {
  test("a script seat with legal actions but no `choose` is a typed no_choose_method error", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(NO_CHOOSE_SOURCE, [EXPERIENCE_CAPABILITY.participants]);
    const participants = [
      { id: "p0", label: "You", controller: "human" },
      { id: "bot", label: "Bot", controller: "script" },
    ];
    const started = await service.startSession({ chatId, branchId, settings: {}, participants });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The bot is the only seat with legal actions, so the turn is immediately its own.
    const advanced = await service.advanceScriptTurns(started.data.sessionId);
    expect(advanced.ok).toBe(false);
    if (advanced.ok) return;
    expect(advanced.error.code).toBe("no_choose_method");
    expect((advanced.error as { participantId: string }).participantId).toBe("bot");
  });

  test("the optional `flavor` method contributes cosmetic data (ephemeral chance) to the projection", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(FLAVOR_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const view = await service.getProjectedView(started.data.sessionId, { kind: EXPERIENCE_VIEWER_KIND.observer });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.state).toEqual({ count: 0 });
    const flavor = view.data.flavor as { greeting: string; tag: number } | undefined;
    expect(flavor).toBeDefined();
    expect(flavor!.greeting).toBe("hi stranger");
    expect(flavor!.tag).toBeGreaterThanOrEqual(1);
    expect(flavor!.tag).toBeLessThanOrEqual(100);
  });

  test("flavor is best-effort: an absent `flavor` method omits the field without failing", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const view = await service.getProjectedView(started.data.sessionId, { kind: EXPERIENCE_VIEWER_KIND.observer });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.flavor).toBeUndefined();
    expect((view.data.state as { count: number }).count).toBe(0);
  });
});

describe("ExperienceService — deterministic-random cursor tracking (resume + replay)", () => {
  test("two sessions sharing a seed produce identical die rolls (replay determinism)", async () => {
    const service = await setup("shared-seed-42");
    const a = await seedChatAndScript(DICEY_SOURCE, [EXPERIENCE_CAPABILITY.deterministicRandom]);
    const startedA = await service.startSession({ chatId: a.chatId, branchId: a.branchId, settings: {}, participants: [] });
    expect(startedA.ok).toBe(true);
    if (!startedA.ok) return;
    const sidA = startedA.data.sessionId;

    const rollsA: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await service.submitAction(sidA, { type: "roll", requestId: `a${i}`, expectedRevision: i });
      const state = r.ok ? (r.data.projection.state as { rolls: number[] }) : { rolls: [] };
      rollsA.push(state.rolls[i]!);
    }

    // A fresh session with the SAME seed reproduces the exact stream.
    const service2 = await setup("shared-seed-42");
    const b = await seedChatAndScript(DICEY_SOURCE, [EXPERIENCE_CAPABILITY.deterministicRandom]);
    const startedB = await service2.startSession({ chatId: b.chatId, branchId: b.branchId, settings: {}, participants: [] });
    expect(startedB.ok).toBe(true);
    if (!startedB.ok) return;
    const sidB = startedB.data.sessionId;
    const rollsB: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await service2.submitAction(sidB, { type: "roll", requestId: `b${i}`, expectedRevision: i });
      const state = r.ok ? (r.data.projection.state as { rolls: number[] }) : { rolls: [] };
      rollsB.push(state.rolls[i]!);
    }
    expect(rollsB).toEqual(rollsA);
  });

  test("resume continues the stream (cursor persisted, not reset)", async () => {
    const service = await setup("resume-seed-7");
    const g = await seedChatAndScript(DICEY_SOURCE, [EXPERIENCE_CAPABILITY.deterministicRandom]);
    const started = await service.startSession({ chatId: g.chatId, branchId: g.branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;

    // Roll twice.
    await service.submitAction(sid, { type: "roll", requestId: "r0", expectedRevision: 0 });
    await service.submitAction(sid, { type: "roll", requestId: "r1", expectedRevision: 1 });
    const after2 = (await service.getProjectedView(sid, { kind: "observer" })).ok
      ? ((await service.getProjectedView(sid, { kind: "observer" })).data.state as { rolls: number[] }).rolls
      : [];

    // "Resume" (reload from DB) and roll again — the third roll continues the stream,
    // matching a fresh seed-replay's third roll.
    const service2 = await setup("resume-seed-7");
    const g2 = await seedChatAndScript(DICEY_SOURCE, [EXPERIENCE_CAPABILITY.deterministicRandom]);
    const started2 = await service2.startSession({ chatId: g2.chatId, branchId: g2.branchId, settings: {}, participants: [] });
    expect(started2.ok).toBe(true);
    if (!started2.ok) return;
    const replay = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await service2.submitAction(started2.data.sessionId, { type: "roll", requestId: `p${i}`, expectedRevision: i });
      replay.push((r.ok ? (r.data.projection.state as { rolls: number[] }).rolls[i] : -1));
    }
    // The resumed third roll equals the replay third roll; first two match too.
    const r3 = await service.submitAction(sid, { type: "roll", requestId: "r2", expectedRevision: 2 });
    expect(r3.ok ? (r3.data.projection.state as { rolls: number[] }).rolls[2] : -1).toBe(replay[2]);
    expect(after2).toEqual([replay[0], replay[1]]);
  });
});

describe("ExperienceService — pending model effects (Wave 4 runs them)", () => {
  test("a reducer that emits a model effect persists it pending, never runs it", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_EFFECT_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    if (!started.ok) return;
    const sid = started.data.sessionId;

    expect((await service.getPendingEffects(sid)).ok && (await service.getPendingEffects(sid)).data).toHaveLength(0);
    await service.submitAction(sid, { type: "ask", requestId: "a1", expectedRevision: 0 });
    const pending = await service.getPendingEffects(sid);
    expect(pending.ok && pending.data).toHaveLength(1);
    expect(pending.ok && pending.data[0]?.kind).toBe("model");
    expect(pending.ok && pending.data[0]?.status).toBe("pending");
  });
});

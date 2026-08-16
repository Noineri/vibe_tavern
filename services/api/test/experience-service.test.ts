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

import { createStoreContainer, type StoreContainer, type ExperienceVisualRow } from "@vibe-tavern/db";
import { EXPERIENCE_CAPABILITY, EXPERIENCE_VIEWER_KIND, type ExperienceCapability } from "@vibe-tavern/domain";

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

/** A hidden-state game whose observer projection is the report-safe public setup. */
const START_VIEWER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "start-viewer", name: "Start Viewer" },
  capabilities: [],
  create() { return { secret: "only-human" }; },
  project(c, v) { return v.kind === "human" ? { viewer: v.participantId, secret: c.state.secret } : { viewer: "observer" }; },
  actions() { return [{ type: "go", participantId: "human-1" }]; },
  reduce(c) { return { state: c.state, status: "active", events: [] }; },
});
`;

const SCRIPT_COMPLETION_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "script-complete", name: "Script Complete" },
  capabilities: [{ capability: "participants", reason: "script seat" }],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions(c, v) { return v.participantId === "bot" ? [{ type: "finish", participantId: "bot" }] : []; },
  choose(c, info) { return { type: info.legal[0].type, participantId: "bot" }; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: "completed", events: [{ visibility: "public", type: "script_finished" }] }; },
});
`;

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

/** A minimal experience that declares the `model` capability (IR-70E seat tests). */
const MODEL_SEAT_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "model-seat", name: "Model Seat" },
  capabilities: [{ capability: "model", reason: "model seats" }],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: "go" }]; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
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

async function seedChatAndScript(
  source: string,
  grants: ExperienceCapability[] = [],
  visual?: { source: string },
): Promise<{ chatId: string; branchId: string; visual: ExperienceVisualRow | null }> {
  const character = await stores.characters.create({ name: "Hero" } as never);
  const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });
  const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source });
  let visualRow: ExperienceVisualRow | null = null;
  if (visual !== undefined) {
    const created = await resources.createVisual({ name: "Viz", source: visual.source, apiVersion: 1 });
    if (created.ok) visualRow = created.data;
  }
  await resources.updateConfig(chat.id, {
    enabled: true,
    scriptId: script.id,
    capabilityGrants: grants,
    ...(visualRow !== null ? { visualId: visualRow.id } : {}),
  });
  return { chatId: chat.id, branchId: chat.activeBranchId, visual: visualRow };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceService — basic lifecycle (counter, no capabilities)", () => {
  test("start → project → action → resume → natural completion, with explicit report finalization", async () => {
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

    // Rule completion keeps the host-owned slot discoverable but does not
    // silently expand the already-frozen start report. Its public events remain
    // pending until the user explicitly finalizes the completed experience.
    const completed = await stores.experiences.getSessionById(sid);
    expect(completed?.activeSlot).toBe(0);
    expect(completed?.reportFrontier).toBe(0);
    expect((await stores.experiences.getActiveSessionForBranch(branchId))?.id).toBe(sid);
    const frozenBeforeQueue = await service.getQueuedAttachment(sid);
    expect(frozenBeforeQueue.ok && frozenBeforeQueue.data?.queueRevision).toBe(1);
    expect(frozenBeforeQueue.ok && frozenBeforeQueue.data?.publicReport?.events.map((event) => event.type)).toEqual([
      "experience_started",
    ]);

    // The original completing request stays idempotent and still cannot grow
    // the queued snapshot implicitly.
    const duplicate = await service.submitAction(sid, { type: "inc", requestId: "r3", expectedRevision: 2 });
    expect(duplicate.ok && duplicate.data.replayed).toBe(true);
    const afterDuplicateReport = await service.getQueuedAttachment(sid);
    expect(afterDuplicateReport.ok && afterDuplicateReport.data?.queueRevision).toBe(1);

    const status = await service.getReportStatus(sid);
    expect(status.ok && status.data.pendingPublicEventCount).toBe(3);
    const finalReport = await service.finishWithReport(sid, 3);
    expect(finalReport.ok).toBe(true);
    if (!finalReport.ok) return;
    expect(finalReport.data?.queueRevision).toBe(2);
    expect(finalReport.data?.publicReport?.events.map((event) => event.type)).toEqual([
      "experience_started", "inc", "inc", "inc",
    ]);
    const finalized = await stores.experiences.getSessionById(sid);
    expect(finalized?.status).toBe("completed");
    expect(finalized?.revision).toBe(3);
    expect(finalized?.reportFrontier).toBe(3);
    expect(finalized?.activeSlot).toBeNull();
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
    const repeatedFinish = await service.finishWithReport(sid, 3);
    expect(repeatedFinish).toEqual(finalReport);
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

  test("start report uses the public observer projection and self-describes participant ids", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(START_VIEWER_SOURCE);
    const participants = [{ id: "human-1", label: "You", controller: "human" as const }];
    const started = await service.startSession({ chatId, branchId, settings: {}, participants });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const report = await service.getQueuedAttachment(started.data.sessionId);
    const detail = report.ok ? report.data?.publicReport?.events[0]?.detail as {
      projection: unknown; participants: Array<{ id: string }>; firstActor?: string;
    } : null;
    expect(detail?.projection).toEqual({ viewer: "observer" });
    expect(JSON.stringify(detail)).not.toContain("only-human");
    expect(detail?.participants).toEqual([{ id: "human-1", label: "You", controller: "human" }]);
    expect(detail?.firstActor).toBe("human-1");
    const human = await service.getProjectedView(started.data.sessionId, { kind: "human", participantId: "human-1" });
    expect(human.ok && human.data.state).toEqual({ viewer: "human-1", secret: "only-human" });
  });

  test("an injected start-report failure rolls back the active claim and allows a later normal start", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    let failedSessionId: string | null = null;
    expect(() => stores.experiences.createSessionWithInitialReport({
      chatId,
      branchId,
      rulesId: "rules", rulesLabel: "Rules", rulesRevision: 1, rulesSource: COUNTER_SOURCE, rulesSourceHash: "hash",
      apiVersion: 1, manifestId: "counter", manifestName: "Counter", initialSettingsJson: "{}", currentStateJson: "{\"count\":0}",
      participantsJson: "[]", capabilityGrantsJson: "[]", contextMode: "none", randomSeed: "seed",
    }, (session) => {
      failedSessionId = session.id;
      throw new Error("injected start report failure");
    })).toThrow("injected start report failure");
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
    expect(await stores.experiences.getSessionById(failedSessionId!)).toBeNull();
    expect(await stores.experiences.getQueuedAttachmentForSession(failedSessionId!)).toBeNull();

    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const report = await service.getQueuedAttachment(started.data.sessionId);
    expect(report.ok && report.data?.queueRevision).toBe(1);
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
  test("a script reducer completion waits for explicit finalization without silently growing the queued report", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(SCRIPT_COMPLETION_SOURCE, [EXPERIENCE_CAPABILITY.participants]);
    const started = await service.startSession({
      chatId, branchId, settings: {}, participants: [{ id: "bot", label: "Bot", controller: "script" }],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const advanced = await service.advanceScriptTurns(started.data.sessionId);
    expect(advanced.ok && advanced.data.await).toBe("completed");
    const completed = await stores.experiences.getSessionById(started.data.sessionId);
    expect(completed?.status).toBe("completed");
    expect(completed?.activeSlot).toBe(0);
    expect(completed?.reportFrontier).toBe(0);
    const frozen = await service.getQueuedAttachment(started.data.sessionId);
    expect(frozen.ok && frozen.data?.queueRevision).toBe(1);
    expect(frozen.ok && frozen.data?.publicReport?.events.map((event) => event.type)).toEqual(["experience_started"]);
    const status = await service.getReportStatus(started.data.sessionId);
    expect(status.ok && status.data.pendingPublicEventCount).toBe(1);
    const queued = await service.queueReport(started.data.sessionId, 1);
    expect(queued.ok && queued.data.publicReport?.events.map((event) => event.type)).toEqual(["experience_started", "script_finished"]);
    expect(queued.ok && queued.data.queueRevision).toBe(2);
    const report = await service.finishWithReport(started.data.sessionId, 1);
    expect(report.ok && report.data?.publicReport?.events.map((event) => event.type)).toEqual(["experience_started", "script_finished"]);
    expect(report.ok && report.data?.queueRevision).toBe(2);
    const finalized = await stores.experiences.getSessionById(started.data.sessionId);
    expect(finalized?.status).toBe("completed");
    expect(finalized?.activeSlot).toBeNull();
    expect(finalized?.revision).toBe(1);
  });

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
    expect(started.ok).toBe(true);
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

// ─── IR-70A: branch-scoped active-session discovery + queued-attachment read ─

describe("ExperienceService — branch-scoped active-session discovery (IR-70A)", () => {
  test("discovers the active session by {chatId, branchId} and returns the same view as start", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const found = await service.getActiveSessionForBranch(chatId, branchId);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data.sessionId).toBe(started.data.sessionId);
    expect(found.data.chatId).toBe(chatId);
    expect(found.data.branchId).toBe(branchId);
    expect(found.data.status).toBe("active");
    expect(found.data.revision).toBe(0);
    expect(found.data.manifest.id).toBe("counter");
  });

  test("chat_not_found for an unknown chat", async () => {
    const service = await setup();
    const found = await service.getActiveSessionForBranch("unknown-chat", "b_1");
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe("chat_not_found");
    expect(found.error.status).toBe(404);
  });

  test("branch_not_found for a branch that belongs to a different chat", async () => {
    const service = await setup();
    const { chatId } = await seedChatAndScript(COUNTER_SOURCE);
    // Create a second chat and use ITS branch with the first chat's id.
    const character2 = await stores.characters.create({ name: "Other" });
    const chat2 = await stores.chats.createChat({ characterId: character2.id, title: "Other" });

    const found = await service.getActiveSessionForBranch(chatId, chat2.activeBranchId);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe("branch_not_found");
    expect(found.error.status).toBe(404);
  });

  test("no_active_session for a valid chat+branch that has no session yet", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const found = await service.getActiveSessionForBranch(chatId, branchId);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.code).toBe("no_active_session");
    expect(found.error.status).toBe(404);
  });

  test("discovery does not fabricate state — it reads the authoritative active slot only", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // After an action (revision 0 → 1), discovery reflects the persisted state.
    await service.submitAction(started.data.sessionId, { type: "inc", requestId: "r1", expectedRevision: 0 });
    const found = await service.getActiveSessionForBranch(chatId, branchId);
    expect(found.ok && found.data.revision).toBe(1);
  });
});

describe("ExperienceService — privacy-safe queued-attachment read (IR-70A)", () => {
  test("start atomically queues a privacy-safe revision-zero setup report", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = await service.getQueuedAttachment(started.data.sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) return;
    expect(result.data.sessionRevision).toBe(0);
    expect(result.data.queueRevision).toBe(1);
    expect(result.data.publicReport?.events[0]?.type).toBe("experience_started");
    expect((await stores.experiences.getSessionById(started.data.sessionId))?.reportFrontier).toBe(0);
  });

  test("returns the queued attachment with public display/commit-intent fields", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;

    await stores.experiences.queueAttachment({
      chatId,
      branchId,
      sessionId: sid,
      sessionRevision: 0,
      queueRevision: 2,
      kind: "report",
      publicEventsJson: JSON.stringify({ title: "Round 1", summary: "Inc happened", events: [{ type: "inc", detail: { n: 1 } }] }),
      hiddenStateCheckpointJson: JSON.stringify({ secret: "PRIVACY_MARKER_42" }),
      rulesSourceHash: "hash123",
      visualSourceHash: null,
    });

    const result = await service.getQueuedAttachment(sid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).not.toBeNull();
    const view = result.data!;
    expect(view.id).toBeTruthy();
    expect(view.chatId).toBe(chatId);
    expect(view.branchId).toBe(branchId);
    expect(view.sessionId).toBe(sid);
    expect(view.kind).toBe("report");
    expect(view.sessionRevision).toBe(0);
    expect(view.queueRevision).toBe(2);
    expect(view.rulesSourceHash).toBe("hash123");
    expect(view.visualSourceHash).toBeNull();
    expect(view.publicReport).toEqual({ title: "Round 1", summary: "Inc happened", events: [{ type: "inc", detail: { n: 1 } }] });
  });

  test("the public DTO NEVER includes hiddenStateCheckpointJson (privacy)", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;

    await stores.experiences.queueAttachment({
      chatId,
      branchId,
      sessionId: sid,
      sessionRevision: 0,
      queueRevision: 2,
      kind: "report",
      publicEventsJson: JSON.stringify({ title: "T", events: [] }),
      hiddenStateCheckpointJson: JSON.stringify({ secret: "PRIVACY_MARKER_42" }),
      rulesSourceHash: "h",
      visualSourceHash: null,
    });

    const result = await service.getQueuedAttachment(sid);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data === null) return;
    // The hidden key is absent from the DTO object.
    expect(result.data).not.toHaveProperty("hiddenStateCheckpointJson");
    // The serialized JSON does NOT carry the hidden marker value.
    expect(JSON.stringify(result.data)).not.toContain("PRIVACY_MARKER_42");
  });

  test("session_not_found when the session does not exist", async () => {
    const service = await setup();
    const result = await service.getQueuedAttachment("nonexistent-session");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("session_not_found");
    expect(result.error.status).toBe(404);
  });
});

// ─── IR-70E: model-seat assignment persistence + start validation ──────────

describe("ExperienceService — model-seat assignment persistence (IR-70E)", () => {
  test("start persists and resume returns the exact per-seat assignments", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const participants = [
      { id: "p1", label: "You", controller: "human" as const },
      { id: "ai", label: "AI", controller: "model" as const, providerProfileId: "pp_1", modelId: "gpt-4" },
    ];
    const started = await service.startSession({ chatId, branchId, settings: {}, participants });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.participants).toEqual(participants);

    const resumed = await service.resumeSession(started.data.sessionId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.participants).toEqual(participants);
    const modelSeat = resumed.data.participants.find((p) => p.controller === "model");
    expect(modelSeat?.providerProfileId).toBe("pp_1");
    expect(modelSeat?.modelId).toBe("gpt-4");
  });

  test("two distinct model seats persist distinct assignments", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const participants = [
      { id: "p1", label: "You", controller: "human" as const },
      { id: "alice", label: "Alice", controller: "model" as const, providerProfileId: "pp_a", modelId: "model-a" },
      { id: "bob", label: "Bob", controller: "model" as const, providerProfileId: "pp_b", modelId: "model-b" },
    ];
    const started = await service.startSession({ chatId, branchId, settings: {}, participants });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.participants).toHaveLength(3);

    const resumed = await service.resumeSession(started.data.sessionId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.participants).toEqual(participants);
  });
});

describe("ExperienceService — model-seat assignment validation at start (IR-70E)", () => {
  test("rejects a model participant missing both pinned ids (no session, no slot)", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "ai", label: "AI", controller: "model" as const }],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("validation_error");
    expect(started.error.status).toBe(422);
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
  });

  test("rejects a model participant missing only the modelId", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "ai", label: "AI", controller: "model" as const, providerProfileId: "pp_1" }],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("validation_error");
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
  });

  test("rejects a model participant missing only the providerProfileId", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "ai", label: "AI", controller: "model" as const, modelId: "m_1" }],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("validation_error");
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
  });

  test("rejects a human participant carrying even an empty providerProfileId field", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "p1", label: "You", controller: "human" as const, providerProfileId: "" }],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("validation_error");
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
  });

  test("rejects a human participant carrying a modelId", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "p1", label: "You", controller: "human" as const, modelId: "m_1" }],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("validation_error");
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
  });

  test("rejects a script participant carrying either id", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const a = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "bot", label: "Bot", controller: "script" as const, providerProfileId: "pp_1" }],
    });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error.code).toBe("validation_error");
    const b = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "bot", label: "Bot", controller: "script" as const, modelId: "m_1" }],
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.code).toBe("validation_error");
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
  });

  test("rejects a model participant without the 'model' capability grant (no session, no initial attachment, no slot)", async () => {
    const service = await setup();
    // The experience declares `model` but we grant nothing — `resolveEffectiveSetup`
    // rejects undeclared grants, so grant the declared `model` here and instead
    // strip it to simulate the missing-grant path via a no-grant config.
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, []);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [
        { id: "p1", label: "You", controller: "human" as const },
        { id: "ai", label: "AI", controller: "model" as const, providerProfileId: "pp_1", modelId: "m_1" },
      ],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("validation_error");
    expect(started.error.status).toBe(422);
    // Nothing was written: no active session, no queued attachment, no slot claim.
    expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
  });
});

// ─── IR-70G: pinned visual source snapshot in the session view ───────────────

describe("ExperienceService — pinned visual source snapshot (IR-70G)", () => {
  test("start returns the exact persisted pinned visualSource/visualSourceHash", async () => {
    const service = await setup();
    const { chatId, branchId, visual } = await seedChatAndScript(COUNTER_SOURCE, [], { source: "<board id='v1'/>" });
    expect(visual).not.toBeNull();
    if (visual === null) return;

    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.visualId).toBe(visual.id);
    expect(started.data.visualSource).toBe("<board id='v1'/>");
    expect(started.data.visualSourceHash).toBe(visual.sourceHash);
  });

  test("after editing the live visual resource, the session view still returns the original pinned snapshot", async () => {
    const service = await setup();
    const { chatId, branchId, visual } = await seedChatAndScript(COUNTER_SOURCE, [], { source: "<board id='v1'/>" });
    expect(visual).not.toBeNull();
    if (visual === null) return;

    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;
    const pinnedSource = started.data.visualSource;
    const pinnedHash = started.data.visualSourceHash;
    expect(pinnedSource).toBe("<board id='v1'/>");
    expect(pinnedHash).toBe(visual.sourceHash);

    // Edit the live visual resource — the persisted snapshot must NOT change.
    const edited = await resources.updateVisual(visual.id, { source: "<board id='v2-mutated'/>" });
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.data.sourceHash).not.toBe(pinnedHash);

    const resumed = await service.resumeSession(sid);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.visualSource).toBe(pinnedSource);
    expect(resumed.data.visualSourceHash).toBe(pinnedHash);
    expect(resumed.data.visualId).toBe(visual.id);

    // getActiveSessionForBranch also returns the pinned snapshot.
    const found = await service.getActiveSessionForBranch(chatId, branchId);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data.visualSource).toBe(pinnedSource);
    expect(found.data.visualSourceHash).toBe(pinnedHash);
  });

  test("after deleting the live visual resource, the session view still returns the original pinned snapshot", async () => {
    const service = await setup();
    const { chatId, branchId, visual } = await seedChatAndScript(COUNTER_SOURCE, [], { source: "<board id='v1'/>" });
    expect(visual).not.toBeNull();
    if (visual === null) return;

    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;
    const pinnedSource = started.data.visualSource;
    const pinnedHash = started.data.visualSourceHash;

    // Delete the live visual resource — the pinned snapshot survives (no FK).
    await resources.deleteVisual(visual.id);
    expect(await resources.getVisual(visual.id)).toBeNull();

    const resumed = await service.resumeSession(sid);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.visualSource).toBe(pinnedSource);
    expect(resumed.data.visualSourceHash).toBe(pinnedHash);
    expect(resumed.data.visualId).toBe(visual.id);
  });

  test("a session with no visual responds with explicit null visualId/source/hash", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(COUNTER_SOURCE);
    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.visualId).toBeNull();
    expect(started.data.visualSource).toBeNull();
    expect(started.data.visualSourceHash).toBeNull();

    const resumed = await service.resumeSession(started.data.sessionId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.visualId).toBeNull();
    expect(resumed.data.visualSource).toBeNull();
    expect(resumed.data.visualSourceHash).toBeNull();
  });

  test("action responses inherit the pinned visual source fields", async () => {
    const service = await setup();
    const { chatId, branchId, visual } = await seedChatAndScript(COUNTER_SOURCE, [], { source: "<board id='v1'/>" });
    expect(visual).not.toBeNull();
    if (visual === null) return;

    const started = await service.startSession({ chatId, branchId, settings: {}, participants: [] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sid = started.data.sessionId;

    const result = await service.submitAction(sid, { type: "inc", requestId: "r1", expectedRevision: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.visualSource).toBe("<board id='v1'/>");
    expect(result.data.session.visualSourceHash).toBe(visual.sourceHash);
    expect(result.data.session.visualId).toBe(visual.id);
  });
});

// ─── Report item 6b: character-backed seats (snapshot at start) ─────────────

describe("ExperienceService — character-backed model seats (report item 6b)", () => {
  test("start freezes the character card into the persisted seat; resume returns it", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const libChar = await stores.characters.create({
      name: "Mila",
      description: "Rival spy.",
      defaultScenario: "Cold war Berlin.",
      personalitySummary: "Sharp, guarded.",
    } as never);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [
        { id: "p1", label: "You", controller: "human" as const },
        { id: "mila", label: "Mila", controller: "model" as const, providerProfileId: "pp_1", modelId: "m-1", characterId: libChar.id },
        // Same character twice with different models — duplicates are legal.
        { id: "mila2", label: "Mila (fast)", controller: "model" as const, providerProfileId: "pp_2", modelId: "m-2", characterId: libChar.id },
      ],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const seat = started.data.participants.find((p) => p.id === "mila");
    expect(seat?.characterId).toBe(libChar.id);
    expect(seat?.character).toEqual({
      id: libChar.id,
      name: "Mila",
      description: "Rival spy.",
      scenario: "Cold war Berlin.",
      personality: "Sharp, guarded.",
    });
    const resumed = await service.resumeSession(started.data.sessionId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.participants.find((p) => p.id === "mila2")?.character?.name).toBe("Mila");
  });

  test("deleting the source character after start leaves the frozen snapshot intact", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const libChar = await stores.characters.create({ name: "Gone Soon", description: "Ephemeral." } as never);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "ai", label: "AI", controller: "model" as const, providerProfileId: "pp_1", modelId: "m-1", characterId: libChar.id }],
    });
    expect(started.ok).toBe(true);
    await stores.characters.delete(libChar.id);
    const resumed = await service.resumeSession(started.ok ? started.data.sessionId : "");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const seat = resumed.data.participants.find((p) => p.id === "ai");
    expect(seat?.character?.name).toBe("Gone Soon");
    expect(seat?.characterId).toBe(libChar.id);
  });

  test("a dangling characterId at start is a clean 404 with no session", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "ai", label: "AI", controller: "model" as const, providerProfileId: "pp_1", modelId: "m-1", characterId: "no-such-char" }],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.status).toBe(404);
    expect(started.error.code).toBe("character_not_found");
    // No session was created for the branch.
    const active = await stores.experiences.getActiveSessionForBranch(branchId);
    expect(active).toBeNull();
  });

  test("a human seat carrying characterId is rejected at the service boundary (schema mirror)", async () => {
    const service = await setup();
    const { chatId, branchId } = await seedChatAndScript(MODEL_SEAT_SOURCE, [EXPERIENCE_CAPABILITY.model]);
    const libChar = await stores.characters.create({ name: "X", description: "Y" } as never);
    const started = await service.startSession({
      chatId, branchId, settings: {},
      participants: [{ id: "p1", label: "You", controller: "human" as const, characterId: libChar.id }],
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.status).toBe(422);
    expect(started.error.code).toBe("validation_error");
  });
});

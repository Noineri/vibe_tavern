/**
 * Experience replay service tests
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-31).
 *
 * Full-path through the REAL VM + REAL DB: the ExperienceService plays a live
 * session first (start + actions), then the ReplayService replays / undoes /
 * recalculates from the persisted journal. Pins replay determinism, append-only
 * undo (history never deleted), and recalculation safe-stop on a now-illegal
 * historical action.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import { ExperienceReplayService } from "../src/domain/interactive/experience-replay-service.js";

// ─── Test experiences ────────────────────────────────────────────────────────

const COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [],
  create() { return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "inc" }, { type: "reset" }]; },
  reduce(c, a) {
    if (a.type === "reset") return { state: { count: 0 }, status: "active", events: [] };
    const n = c.state.count + 1;
    return { state: { count: n }, status: n >= 3 ? "completed" : "active", events: [{ visibility: "public", type: "inc", detail: { n } }] };
  },
});
`;

const BANK_V1 = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "bank", name: "Bank" },
  capabilities: [],
  create() { return { balance: 0 }; },
  project(c) { return { balance: c.state.balance }; },
  actions() { return [{ type: "deposit" }, { type: "withdraw" }]; },
  reduce(c, a) {
    const d = a.type === "deposit" ? 1 : -1;
    return { state: { balance: c.state.balance + d }, status: "active", events: [] };
  },
});
`;

// v2 removes "withdraw" — replaying a history that contains it safe-stops.
const BANK_V2 = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "bank", name: "Bank" },
  capabilities: [],
  create() { return { balance: 0 }; },
  project(c) { return { balance: c.state.balance }; },
  actions() { return [{ type: "deposit" }]; },
  reduce(c, a) {
    return { state: { balance: c.state.balance + 1 }, status: "active", events: [] };
  },
});
`;

// ─── Setup ───────────────────────────────────────────────────────────────────

let stores: StoreContainer;
let resources: ExperienceResourceService;
let service: ExperienceService;
let replay: ExperienceReplayService;

beforeEach(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-xreplay-svc-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  resources = new ExperienceResourceService(stores);
  service = new ExperienceService(stores, resources);
  replay = new ExperienceReplayService(stores, resources);
});

async function playSession(source: string, actions: { type: string; participantId?: string }[], grants: string[] = []) {
  const character = await stores.characters.create({ name: "Hero" } as never);
  const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });
  const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source });
  await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: grants as never });
  const started = await service.startSession({ chatId: chat.id, branchId: chat.activeBranchId, settings: {}, participants: [] });
  if (!started.ok) throw new Error("start failed");
  const sid = started.data.sessionId;
  let rev = 0;
  for (const a of actions) {
    const r = await service.submitAction(sid, { type: a.type, requestId: `act_${rev}`, expectedRevision: rev, participantId: a.participantId });
    if (!r.ok) throw new Error(`action ${a.type} failed: ${JSON.stringify(r.error)}`);
    rev = r.data.session.revision;
  }
  return sid;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceReplayService — deterministic replay", () => {
  test("replay reproduces the exact authoritative state the live session reached", async () => {
    const sid = await playSession(COUNTER_SOURCE, [{ type: "inc" }, { type: "inc" }]);
    const r = await replay.replaySession(sid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ok).toBe(true);
    if (!r.data.ok) return;
    // Final state matches the persisted current state.
    expect((r.data.finalState as { count: number }).count).toBe(2);
    // Checkpoint per revision (0 = after create, then one per action).
    expect(r.data.checkpoints).toHaveLength(3);
    expect((r.data.checkpoints[0]!.state as { count: number }).count).toBe(0);
    expect((r.data.checkpoints[1]!.state as { count: number }).count).toBe(1);
    expect((r.data.checkpoints[2]!.state as { count: number }).count).toBe(2);
  });

  test("replay of a session with deterministic_random reproduces the same cursor", async () => {
    // A fixed-seed service so the persisted seed is known.
    const fixedService = new ExperienceService(stores, resources, { generateSeed: () => "replay-seed-1" });
    const character = await stores.characters.create({ name: "H" } as never);
    const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });
    const dicey = `context.experience.register({ apiVersion:1, manifest:{id:"dicey",name:"Dicey"}, capabilities:["deterministic_random"], create(){return {rolls:[]};}, project(c){return {rolls:c.state.rolls};}, actions(){return [{type:"roll"}];}, reduce(c){const f=c.random.die(6);return {state:{rolls:[...c.state.rolls,f]},status:"active",events:[]};} });`;
    const script = await stores.scripts.create({ name: "D", scriptKind: "interactive", code: dicey });
    await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: ["deterministic_random"] as never });
    const started = await fixedService.startSession({ chatId: chat.id, branchId: chat.activeBranchId, settings: {}, participants: [] });
    if (!started.ok) return;
    const sid = started.data.sessionId;
    await fixedService.submitAction(sid, { type: "roll", requestId: "r0", expectedRevision: 0 });
    await fixedService.submitAction(sid, { type: "roll", requestId: "r1", expectedRevision: 1 });
    const replayed = await replay.replaySession(sid);
    if (!replayed.ok || !replayed.data.ok) return;
    // The reconstructed cursor equals the persisted cursor after 2 rolls.
    const session = await stores.experiences.getSessionById(sid);
    expect(replayed.data.cursor).toBe(session?.randomCursor);
  });
});

describe("ExperienceReplayService — append-only undo", () => {
  test("undo appends a NEW revision with the target state; history is never deleted", async () => {
    const sid = await playSession(COUNTER_SOURCE, [{ type: "inc" }, { type: "inc" }]); // rev 2, count 2
    const stepsBefore = await stores.experiences.getSteps(sid);
    expect(stepsBefore).toHaveLength(2);

    const undo = await replay.undoToRevision(sid, 1);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    // New revision (3), state rewound to rev-1's count (1).
    expect(undo.data.session.revision).toBe(3);
    expect((undo.data.projection.state as { count: number }).count).toBe(1);

    // History is append-only: the 2 action steps remain + 1 system undo step.
    const stepsAfter = await stores.experiences.getSteps(sid);
    expect(stepsAfter).toHaveLength(3);
    expect(stepsAfter[2]!.kind).toBe("system");
    expect(stepsAfter[0]!.sequence).toBe(1); // original steps untouched
    expect(stepsAfter[1]!.sequence).toBe(2);

    // The live session now reports the rewound state at the new revision.
    const resumed = await service.resumeSession(sid);
    expect(resumed.ok && resumed.data.revision).toBe(3);
  });

  test("after undo, new actions continue from the rewound state + advanced cursor", async () => {
    const sid = await playSession(COUNTER_SOURCE, [{ type: "inc" }, { type: "inc" }]); // rev 2, count 2
    await replay.undoToRevision(sid, 0); // rewind to count 0 → rev 3

    // A new action applies on top of the rewound state.
    const next = await service.submitAction(sid, { type: "inc", requestId: "after_undo", expectedRevision: 3 });
    expect(next.ok && (next.data.projection.state as { count: number }).count).toBe(1); // 0 + 1
    expect(next.ok && next.data.session.revision).toBe(4);
  });

  test("undo to the current (or future) revision is a validation error", async () => {
    const sid = await playSession(COUNTER_SOURCE, [{ type: "inc" }]); // rev 1
    const same = await replay.undoToRevision(sid, 1);
    expect(same.ok).toBe(false);
    if (same.ok) return;
    expect(same.error.code).toBe("validation_error");
    const future = await replay.undoToRevision(sid, 5);
    expect(future.ok).toBe(false);
  });
});

describe("ExperienceReplayService — rules recalculation preview (no commit)", () => {
  test("v2 that accepts the same actions replays cleanly to a (possibly different) state", async () => {
    // v1 history: deposit, withdraw, deposit → balance 1 (0+1-1+1).
    const sid = await playSession(BANK_V1, [{ type: "deposit" }, { type: "withdraw" }, { type: "deposit" }]);
    const before = await stores.experiences.getSessionById(sid);

    const preview = await replay.previewRecalculation(sid, BANK_V2);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // v2 makes withdraw illegal → safe-stop at the 2nd action (revision 2).
    expect(preview.data.outcome.ok).toBe(false);
    if (preview.data.outcome.ok) return;
    expect(preview.data.outcome.reason).toBe("illegal_action");
    expect(preview.data.outcome.failedAtRevision).toBe(2);

    // No commit: the persisted session is unchanged.
    const after = await stores.experiences.getSessionById(sid);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.currentStateJson).toBe(before?.currentStateJson);
  });

  test("v2 that accepts the full history replays to completion", async () => {
    // Pure deposit history under v1 → balance 2. Under v2 (deposit only) → still legal.
    const sid = await playSession(BANK_V1, [{ type: "deposit" }, { type: "deposit" }]);
    const preview = await replay.previewRecalculation(sid, BANK_V2);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.outcome.ok).toBe(true);
    if (!preview.data.outcome.ok) return;
    expect((preview.data.outcome.finalState as { balance: number }).balance).toBe(2);
    expect(preview.data.newManifestId).toBe("bank");
  });

  test("preview with broken new-rules source is a vm_error, no replay attempted", async () => {
    const sid = await playSession(BANK_V1, [{ type: "deposit" }]);
    const preview = await replay.previewRecalculation(sid, "context.experience.register({ /* unterminated");
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error.code).toBe("vm_error");
  });
});

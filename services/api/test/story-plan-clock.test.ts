/**
 * DK-4b — the scene clock drives the branch plan (story-plan-sync.ts +
 * tracker-service.ts's record observer, wired exactly as server-runtime.ts
 * wires them):
 *  - PURE (T0): advancePlanToClock's promotion + due-front ordering, the
 *    clock-aware pickCurrentStoryEvent, and the no-clock equivalence pin —
 *    with clock null the projection is byte-identical to the pre-clock rule
 *    (the wave's core invariant, stated explicitly here).
 *  - SERVICE (T1/T2, real store container, real SceneTrackerService over the
 *    same container, NO LLM — the injected execute throws if a model call is
 *    ever attempted): a scene EDIT moving the clock past a dated pending
 *    promotes it through the observer (fire-and-forget; the test parks the
 *    returned promise — no sleeps), the future-dated event stays OUT of the
 *    projected goals, a second advance with the same clock writes nothing,
 *    a non-active branch's record changes nothing, and the promotion's plan
 *    write produces no scene write and no observer re-entry (the loop guard).
 *
 * Hygiene (L1): DBs through createStoreContainer (template-backed); waits are
 * parked promises; no global state, no mock.module, nothing to restore.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brandId,
  normalizeAgentPlan,
  normalizeSceneTrackerConfig,
  OBJECTIVE_MODE,
  OBJECTIVE_TASK_STATUS,
  type AgentPlan,
  type ChatBranchId,
  type ChatId,
  type MessageId,
  type MessageVariantId,
  type ObjectiveState,
  type StoryClock,
  type StoryEventTime,
} from "@vibe-tavern/domain";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ObjectiveService } from "../src/domain/insights/objective-service.js";
import { SceneTrackerService, type SceneTarget } from "../src/domain/insights/tracker-service.js";
import { unusedObjectiveDeps } from "./objective-service-fixture.js";
import {
  StoryPlanSync,
  advancePlanToClock,
  pickCurrentStoryEvent,
  projectStoryPlanGoals,
} from "../src/domain/director/story-plan-sync.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A plan task with an optional story-time stamp (DK-1). */
const task = (
  id: string,
  title: string,
  status: "pending" | "active" | "completed" | "abandoned",
  at?: StoryEventTime,
): AgentPlan["tasks"][number] => ({ id, title, body: "", status, ...(at ? { at } : {}) });

const planOf = (tasks: AgentPlan["tasks"]): AgentPlan => ({ goal: "Story goal", constraints: [], tasks });

/** A minimal goals-mode tracker state the projection reads. */
const trackerState = (goals: Array<{ id: string; status: ObjectiveState["shortTermGoals"][number]["status"] }>): ObjectiveState => ({
  mode: OBJECTIVE_MODE.goals,
  objectiveDescription: "",
  tasks: [],
  longTermGoal: null,
  shortTermGoals: goals.map((goal) => ({ id: goal.id, description: `goal ${goal.id}`, status: goal.status })),
  autoCheckFrequency: 0,
  autoCheckEventCount: 0,
  contextWindow: 10,
  injectionDepth: 1,
  generatePrompt: "",
  checkPrompt: "",
  injectPrompt: "",
  useChatModel: true,
  providerProfileId: null,
  model: null,
});

const clock = (day: number, part: StoryClock["part"]): StoryClock => ({ day, part, label: null });

/** The chat's tracker schema with the three DK-2 clock markers at top level. */
const CLOCK_SCHEMA = {
  mood: { $type: "string" },
  story_day: { $type: "number", min: 1, max: 999, clock: "day", label: "Story day" },
  story_time: { $type: "string", clock: "part", label: "Part of day" },
  story_date: { $type: "string", clock: "label", label: "Date label" },
} as const;

/** A scene state for CLOCK_SCHEMA at a given story time. */
const sceneAt = (day: number, part: string, mood = "calm"): Record<string, unknown> => ({
  mood,
  story_day: day,
  story_time: part,
  story_date: `Day ${day} (${part})`,
});

// ─── pure: advancePlanToClock ────────────────────────────────────────────────

describe("pure: advancePlanToClock (DK-4b)", () => {
  test("no due dated pending → null (future events wait for the clock; undated never auto-promote)", () => {
    const futureOnly = planOf([
      task("t1", "Current", "active"),
      task("t2", "Later", "pending", { day: 9, part: "day" }),
    ]);
    expect(advancePlanToClock(futureOnly, clock(3, "day"))).toBeNull();

    const undatedOnly = planOf([task("t1", "Current", "active"), task("t2", "Undated", "pending")]);
    expect(advancePlanToClock(undatedOnly, clock(9, "night"))).toBeNull();
  });

  test("promotes the EARLIEST due one (story time, not plan order); the interrupted current and the due-front order follow", () => {
    // Plan order is NOT time order: D2 (day 3) is earlier than D1 (day 5);
    // F (day 9) is future and must not move into the due-front.
    const plan = planOf([
      task("a", "Current", "active"),
      task("d1", "Due one", "pending", { day: 5, part: "day" }),
      task("f", "Future", "pending", { day: 9, part: "day" }),
      task("d2", "Due two", "pending", { day: 3, part: "day" }),
    ]);
    const advanced = advancePlanToClock(plan, clock(6, "day"));
    expect(advanced).not.toBeNull();
    // The promoted earliest-due (d2) is active where the current was; the
    // due-front (d1) sits DIRECTLY after it in story-time order; the
    // interrupted current (a) follows as pending; the future (f) keeps its
    // relative place behind — untouched, its `at` intact.
    expect(advanced.tasks.map((t) => t.id)).toEqual(["d2", "d1", "a", "f"]);
    expect(advanced.tasks.map((t) => t.status)).toEqual(["active", "pending", "pending", "pending"]);
    expect(advanced.tasks.find((t) => t.id === "d2")?.at).toEqual({ day: 3, part: "day" }); // stamps never touched
    expect(normalizeAgentPlan(advanced)).not.toBeNull();
  });

  test("idempotent — when the earliest due event already IS the current event, null", () => {
    const plan = planOf([
      task("a", "Current", "active"),
      task("d1", "Due one", "pending", { day: 5, part: "day" }),
    ]);
    const advanced = advancePlanToClock(plan, clock(6, "day"));
    expect(advanced).not.toBeNull();
    // Second call with the same clock: the promoted d1 is now the current
    // event AND the earliest due one → nothing to advance.
    expect(advancePlanToClock(advanced, clock(6, "day"))).toBeNull();
    // Also null when there was no active event and the first due pending was
    // already picked as current by the pick rule.
    const picked = planOf([task("d1", "Due one", "pending", { day: 2, part: "day" })]);
    expect(advancePlanToClock(picked, clock(3, "day"))).toBeNull();
  });

  test("night rollover falls out of the time order: night of day 2 is due at morning of day 3, not at evening of day 2", () => {
    const plan = planOf([task("a", "Current", "active"), task("n", "Night event", "pending", { day: 2, part: "night" })]);
    expect(advancePlanToClock(plan, clock(2, "evening"))).toBeNull(); // not yet
    const advanced = advancePlanToClock(plan, clock(3, "morning")); // the night passed
    expect(advanced).not.toBeNull();
    expect(advanced?.tasks.map((t) => t.id)).toEqual(["n", "a"]);
    expect(advanced?.tasks[0].status).toBe("active");
  });
});

// ─── pure: clock-aware current event + the no-clock equivalence pin ─────────

describe("pure: pickCurrentStoryEvent with a clock (delegation to pickCurrentPlanTask)", () => {
  test("no clock: a future-dated pending is still picked (pre-clock rule); with a clock: the due one wins", () => {
    const plan = planOf([
      task("future", "Future", "pending", { day: 9, part: "day" }),
      task("due", "Due", "pending", { day: 2, part: "day" }),
    ]);
    expect(pickCurrentStoryEvent(plan)?.id).toBe("future"); // clock null = every dated task due
    expect(pickCurrentStoryEvent(plan, null)?.id).toBe("future");
    expect(pickCurrentStoryEvent(plan, clock(3, "day"))?.id).toBe("due"); // the future is skipped
  });
});

describe("pure: projectStoryPlanGoals no-clock equivalence (the byte-identical pin)", () => {
  const previous = planOf([task("t1", "Current", "active")]);
  const next = planOf([
    task("t1", "Current", "active"),
    task("t2", "Undated", "pending"),
    task("t3", "Future", "pending", { day: 9, part: "day" }),
  ]);

  test("clock null — default AND explicit — projects dated + undated 1:1, byte-identical", () => {
    const byDefault = projectStoryPlanGoals(previous, next, trackerState([]), "branch_a");
    const explicitNull = projectStoryPlanGoals(previous, next, trackerState([]), "branch_a", null);
    expect(JSON.stringify(byDefault)).toBe(JSON.stringify(explicitNull));
    // The literal pre-clock projection: every task maps 1:1 in plan order.
    expect(byDefault.shortTermGoals).toEqual([
      { id: "t1", description: "Current", status: OBJECTIVE_TASK_STATUS.active },
      { id: "t2", description: "Undated", status: OBJECTIVE_TASK_STATUS.pending },
      { id: "t3", description: "Future", status: OBJECTIVE_TASK_STATUS.pending },
    ]);
  });

  test("with a clock, only the NOT-YET-DUE pending drops out — order and statuses keep", () => {
    const projected = projectStoryPlanGoals(previous, next, trackerState([]), "branch_a", clock(3, "day"));
    expect(projected.shortTermGoals.map((goal) => goal.id)).toEqual(["t1", "t2"]); // t3 (day 9) stays out
    expect(projected.mode).toBe(OBJECTIVE_MODE.goals);
    expect(projected.longTermGoal).toBeNull();
  });
});

// ─── service: the wired observer advances the plan ──────────────────────────

let stores: StoreContainer;
let objectiveService: ObjectiveService;
let storyPlanSync: StoryPlanSync;
let tracker: SceneTrackerService;
let characterId: string;
let observerCalls = 0;
let lastAdvance: Promise<void> | null = null;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-story-plan-clock-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const character = await stores.characters.create({ name: "Story plan clock fixture" });
  characterId = character.id;
  objectiveService = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps);
  storyPlanSync = new StoryPlanSync(stores, objectiveService);
  // Mirror the production wiring (server-runtime.ts): the follow-back first…
  objectiveService.registerStateObserver((chatId, nextState) =>
    storyPlanSync.onObjectiveStateCommitted(chatId, nextState),
  );
  // …then the Scene record observer, exactly as server-runtime registers it,
  // plus a test-local parked handle for the detached advance (no sleeps) and
  // an invocation counter for the loop-guard pins.
  tracker = new SceneTrackerService(
    stores,
    unusedObjectiveDeps,
    unusedObjectiveDeps,
    // No model call may ever happen in this file — the plan advances with NO
    // extra model call (the packet's goal), and any accidental LLM path fails
    // loudly here.
    async () => {
      throw new Error("no model call expected in the story-plan clock tests");
    },
    async () => "BASE",
  );
  tracker.registerRecordWrittenObserver((chatId, branchId) => {
    observerCalls += 1;
    lastAdvance = storyPlanSync.advanceByClock(chatId, branchId);
    return lastAdvance;
  });
});

/** A fresh chat: user seed message, an assistant reply on the active branch, a forked branchB. */
async function makeWorld(): Promise<{
  chatId: ChatId;
  branchA: ChatBranchId;
  branchB: ChatBranchId;
  target: SceneTarget;
}> {
  const chat = await stores.chats.createChat({ characterId, title: "Clock chat", promptPresetId: null });
  const chatId = brandId<ChatId>(chat.id);
  const branchA = brandId<ChatBranchId>(chat.activeBranchId);
  await stores.messages.addMessage({
    chatId: chat.id,
    branchId: chat.activeBranchId,
    role: "user",
    authorType: "user",
    content: "seed",
  });
  const assistant = await stores.messages.addMessage({
    chatId: chat.id,
    branchId: chat.activeBranchId,
    role: "assistant",
    authorType: "assistant",
    content: "The gates loom.",
  });
  const fork = await stores.chats.forkBranch(chat.id, assistant.id);
  const branchB = brandId<ChatBranchId>(fork.id);
  const variants = await stores.messages.getVariants(assistant.id);
  const variant = variants[0];
  if (!variant) throw new Error("the assistant fixture variant vanished");
  const target: SceneTarget = {
    chatId,
    branchId: branchA,
    messageId: brandId<MessageId>(assistant.id),
    variantId: brandId<MessageVariantId>(variant.id),
  };
  return { chatId, branchA, branchB, target };
}

/** Turn the chat's tracker schema into the clock-marked one (chat-level config). */
async function configureClockSchema(chatId: ChatId): Promise<void> {
  const chat = await stores.chats.getById(chatId as string);
  if (!chat) throw new Error(`chat ${chatId} vanished`);
  await stores.chats.updateInsightsConfig(chatId as string, {
    insightsConfig: { ...chat.insightsConfig, tracker: normalizeSceneTrackerConfig({ schema: CLOCK_SCHEMA }) },
  });
}

const readPlan = async (chatId: ChatId, branchId: ChatBranchId): Promise<AgentPlan> =>
  (await stores.agentPlans.get({ kind: "chatBranch", chatId: chatId as string, branchId: branchId as string })) ??
  ({ goal: "", constraints: [], tasks: [] } as AgentPlan);

const readState = (chatId: ChatId): Promise<ObjectiveState> => objectiveService.getState(chatId);

describe("service: the scene clock drives the branch plan (through the wired observer)", () => {
  test("a scene edit moving the clock past a dated pending promotes it and re-projects; the future event stays out", async () => {
    observerCalls = 0; // per-test counter (the file-level observer is shared)
    lastAdvance = null;
    const { chatId, branchA, target } = await makeWorld();
    await configureClockSchema(chatId);
    await storyPlanSync.applyPlan(chatId, branchA, planOf([
      task("t1", "Current", "active"),
      task("t2", "Due soon", "pending", { day: 2, part: "day" }),
      task("t3", "Future", "pending", { day: 9, part: "day" }),
    ]));
    // No scene record yet → no clock → the projection is today's: t3 included.
    const stateBefore = await readState(chatId);
    expect(stateBefore.shortTermGoals.map((goal) => goal.id)).toEqual(["t1", "t2", "t3"]);

    // First write: the clock EXISTS now (day 1) but nothing is due yet — the
    // advance is a no-op: no plan write, no re-projection, one observer fire.
    const record1 = await tracker.editScene(target, sceneAt(1, "morning"));
    expect(lastAdvance).not.toBeNull();
    await lastAdvance;
    expect(observerCalls).toBe(1);
    expect((await readPlan(chatId, branchA)).tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(JSON.stringify(await readState(chatId))).toBe(JSON.stringify(stateBefore));

    // Second write: the clock jumps past t2's day → the promotion fires the
    // plan write + projection through applyPlan. No model call, no scene write.
    const record2 = await tracker.editScene(target, sceneAt(3, "morning"));
    await lastAdvance;
    expect(observerCalls).toBe(2); // the plan write re-fired NOTHING (loop guard)

    const plan = await readPlan(chatId, branchA);
    expect(plan.tasks.map((t) => t.id)).toEqual(["t2", "t1", "t3"]); // d2-style promotion order
    expect(plan.tasks.map((t) => t.status)).toEqual(["active", "pending", "pending"]);
    expect(plan.tasks[0].at).toEqual({ day: 2, part: "day" }); // stamps never touched

    const state = await readState(chatId);
    // The tracker never advances into a future event: t3 (day 9) is OUT.
    expect(state.shortTermGoals).toEqual([
      { id: "t2", description: "Due soon", status: OBJECTIVE_TASK_STATUS.active },
      { id: "t1", description: "Current", status: OBJECTIVE_TASK_STATUS.pending },
    ]);
    expect(state.planProjectedFromBranchId).toBe(branchA as string);

    // Idempotence: the SAME clock again (a different mood, same day/part) →
    // the advance recomputes the no-op — the plan and tracker are byte-identical.
    const planJson = JSON.stringify(await readPlan(chatId, branchA));
    const stateJson = JSON.stringify(await readState(chatId));
    const record3 = await tracker.editScene(target, sceneAt(3, "morning", "tense"));
    await lastAdvance;
    expect(observerCalls).toBe(3); // the edit fired the observer; the advance wrote nothing
    expect(JSON.stringify(await readPlan(chatId, branchA))).toBe(planJson);
    expect(JSON.stringify(await readState(chatId))).toBe(stateJson);

    // The promotion produced NO scene write: the stored record is exactly the
    // LAST edit's (same generatedAt) — nothing newer appeared after it.
    const stored = await stores.messages.getSceneRecord(target.variantId);
    expect(stored).toEqual(record3);
    expect(record2.generatedAt).not.toEqual(record3.generatedAt); // and the edits did write
  });

  test("a NON-active branch's scene record changes nothing", async () => {
    observerCalls = 0; // per-test counter (the file-level observer is shared)
    lastAdvance = null;
    const { chatId, branchA, branchB } = await makeWorld();
    await configureClockSchema(chatId);
    // A plan on the NON-active branch with a dated pending already past any clock.
    await storyPlanSync.applyPlan(chatId, branchB, planOf([
      task("t5", "B current", "active"),
      task("t6", "B due", "pending", { day: 2, part: "day" }),
    ]));
    const stateBefore = JSON.stringify(await readState(chatId));
    const planBefore = JSON.stringify(await readPlan(chatId, branchB));

    // An assistant message ON branchB gets a record far in the story's future.
    const assistant = await stores.messages.addMessage({
      chatId: chatId as string,
      branchId: branchB as string,
      role: "assistant",
      authorType: "assistant",
      content: "Side branch scene.",
    });
    const variants = await stores.messages.getVariants(assistant.id);
    const sideTarget: SceneTarget = {
      chatId,
      branchId: branchB,
      messageId: brandId<MessageId>(assistant.id),
      variantId: brandId<MessageVariantId>(variants[0].id),
    };
    await tracker.editScene(sideTarget, sceneAt(5, "night"));
    await lastAdvance; // the observer fired — and the ACTIVE-branch gate stopped it

    expect(observerCalls).toBe(1);
    expect(JSON.stringify(await readPlan(chatId, branchB))).toBe(planBefore); // t6 NOT promoted
    expect(JSON.stringify(await readState(chatId))).toBe(stateBefore); // the tracker did not move
    expect((await readPlan(chatId, branchA)).tasks).toEqual([]); // the active branch never grew a plan
  });
});

describe("service: the record observer never breaks a scene write", () => {
  test("throwing and async-rejecting observers are swallowed — the write stands", async () => {
    const { chatId, target } = await makeWorld();
    await configureClockSchema(chatId);
    // A separate service instance for the failure policy (mirrors the
    // objective-service observer-failure test): its observers misbehave, the
    // scene write must not.
    const broken = new SceneTrackerService(
      stores,
      unusedObjectiveDeps,
      unusedObjectiveDeps,
      async () => {
        throw new Error("no model call expected");
      },
      async () => "BASE",
    );
    broken.registerRecordWrittenObserver(() => {
      throw new Error("sync observer boom");
    });
    const written = await broken.editScene(target, sceneAt(1, "day"));
    expect(written.sceneState).toEqual(sceneAt(1, "day")); // the write stood
    expect(((await stores.messages.getSceneRecord(target.variantId)) as { generatedAt: string }).generatedAt).toBe(
      written.generatedAt,
    );

    broken.registerRecordWrittenObserver(async () => {
      throw new Error("async observer boom");
    });
    const second = await broken.editScene(target, sceneAt(2, "day"));
    expect(second.sceneState).toEqual(sceneAt(2, "day")); // still stands
  });
});

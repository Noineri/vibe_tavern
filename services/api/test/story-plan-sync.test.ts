/**
 * StoryPlanSync + its pure functions (DIRECTOR_MODE_PLAN DR-3a) — the
 * story-plan ↔ goal-tracker sync:
 *  - the PURE projection/follow-back/current-event helpers (T0 — no DB);
 *  - the SERVICE end-to-end over the real store container (T1/T2 — SQLite
 *    through createStoreContainer, no LLM: the tracker writes under test are
 *    the manual CRUD path, which shares commitState with the check path);
 *  - the ObjectiveService state observer (registered exactly as
 *    server-runtime.ts wires it) and the follow-back it triggers;
 *  - reconcileActiveBranch (DR-3b wires the branch-change call sites — these
 *    tests call it directly);
 *  - loop-termination evidence for the plan's stop-when: the projection →
 *    observer → plan-write cycle reaches a fixpoint after one round.
 *
 * Each test builds its own chat (and forks its own branches) on the shared
 * container — objective state and plans are keyed by (chat, branch), so
 * chats never share state.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brandId,
  EMPTY_AGENT_PLAN,
  normalizeAgentPlan,
  OBJECTIVE_MODE,
  OBJECTIVE_TASK_STATUS,
  type AgentPlan,
  type ChatBranchId,
  type ChatId,
  type ObjectiveState,
} from "@vibe-tavern/domain";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ObjectiveService } from "../src/domain/insights/objective-service.js";
import {
  StoryPlanSync,
  followGoalStatuses,
  insertStoryEventAfterCurrent,
  pickCurrentStoryEvent,
  projectStoryPlanGoals,
  storyEventGoalText,
} from "../src/domain/director/story-plan-sync.js";
import { isDomainError } from "../src/shared/errors.js";

/** Assert a rejected promise is the expected DomainError (kind + optional
 *  details.code) — Bun's `rejects.toSatisfy` does not unwrap the reason. */
async function expectDomainError(promise: Promise<unknown>, kind: string, code?: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected the call to reject");
  } catch (err) {
    if (!isDomainError(err)) throw new Error(`expected a DomainError, got: ${String(err)}`);
    expect(err.kind).toBe(kind);
    if (code !== undefined) expect(err.details?.code).toBe(code);
  }
}

// ─── pure helpers (T0) ───────────────────────────────────────────────────────

describe("pure: storyEventGoalText (A3)", () => {
  test("title alone when the body is empty or blank; title + \\n + body otherwise", () => {
    expect(storyEventGoalText({ id: "t1", title: "Reach the gates", body: "", status: "pending" })).toBe("Reach the gates");
    expect(storyEventGoalText({ id: "t1", title: "Reach the gates", body: "   ", status: "pending" })).toBe("Reach the gates");
    expect(storyEventGoalText({ id: "t1", title: "Reach the gates", body: "At dawn.", status: "pending" })).toBe(
      "Reach the gates\nAt dawn.",
    );
  });
});

const task = (id: string, title: string, body: string, status: "pending" | "active" | "completed" | "abandoned") => ({
  id,
  title,
  body,
  status,
});

const planOf = (tasks: AgentPlan["tasks"], goal = "Story goal"): AgentPlan => ({
  goal,
  constraints: ["Stay in character"],
  tasks,
});

describe("pure: projectStoryPlanGoals (A2/A3/A5/A8)", () => {
  // A tracker with foreign (non-plan) content in every slot the projection owns.
  const foreignState = (): ObjectiveState => ({
    mode: OBJECTIVE_MODE.route,
    objectiveDescription: "Manual objective",
    tasks: [{ id: "route_1", description: "Manual route task", status: OBJECTIVE_TASK_STATUS.pending }],
    longTermGoal: { description: "Foreign long-term goal", status: OBJECTIVE_TASK_STATUS.pending },
    shortTermGoals: [{ id: "obj_st_1", description: "Foreign goal", status: OBJECTIVE_TASK_STATUS.pending }],
    autoCheckFrequency: 3,
    autoCheckEventCount: 1,
    contextWindow: 24,
    injectionDepth: 2,
    generatePrompt: "GEN",
    checkPrompt: "CHECK",
    injectPrompt: "INJECT",
    useChatModel: false,
    providerProfileId: "prov_1",
    model: "model-x",
  });

  const next = planOf([
    task("t1", "Reach the gates", "At dawn.", "active"),
    task("t2", "Lift the siege", "", "pending"),
  ]);

  test("first apply replaces foreign goals: goals mode, long-term null, plan order, A3 texts, source recorded", () => {
    const projected = projectStoryPlanGoals(null, next, foreignState(), "branch_a");
    expect(projected.mode).toBe(OBJECTIVE_MODE.goals); // A5
    expect(projected.longTermGoal).toBeNull(); // A2 — the premise never reaches the RP prompt
    expect(projected.shortTermGoals).toEqual([
      { id: "t1", description: "Reach the gates\nAt dawn.", status: OBJECTIVE_TASK_STATUS.active },
      { id: "t2", description: "Lift the siege", status: OBJECTIVE_TASK_STATUS.pending },
    ]);
    expect(projected.planProjectedFromBranchId).toBe("branch_a"); // R2 — the projection source
  });

  test("other ObjectiveState fields pass through untouched", () => {
    const projected = projectStoryPlanGoals(null, next, foreignState(), "branch_a");
    expect(projected.objectiveDescription).toBe("Manual objective");
    expect(projected.tasks).toEqual(foreignState().tasks); // the route-mode list survives a mode switch back
    expect(projected.autoCheckFrequency).toBe(3); // A6 — the tracker's own settings are not the plan's business
    expect(projected.autoCheckEventCount).toBe(1);
    expect(projected.contextWindow).toBe(24);
    expect(projected.injectionDepth).toBe(2);
    expect(projected.generatePrompt).toBe("GEN");
    expect(projected.checkPrompt).toBe("CHECK");
    expect(projected.injectPrompt).toBe("INJECT");
    expect(projected.useChatModel).toBe(false);
    expect(projected.providerProfileId).toBe("prov_1");
    expect(projected.model).toBe("model-x");
  });

  test("statuses carried by id: the tracker's status survives an unchanged plan save", () => {
    // previous and next both say t1 pending; the tracker has t1 completed (a
    // check that landed after the editor opened) — the completed survives.
    const previous = planOf([task("t1", "Reach the gates", "", "pending")]);
    const tracker: ObjectiveState = {
      ...foreignState(),
      mode: OBJECTIVE_MODE.goals,
      longTermGoal: null,
      shortTermGoals: [{ id: "t1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.completed }],
    };
    const projected = projectStoryPlanGoals(previous, previous, tracker, "branch_a");
    expect(projected.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  test("a stale editor save does not revert a completed goal (status unchanged between saves)", () => {
    const previous = planOf([task("t1", "Reach the gates", "", "active")]);
    const staleSave = planOf([task("t1", "Reach the gates", "", "active"), task("t2", "Lift the siege", "", "pending")]);
    const tracker: ObjectiveState = {
      ...foreignState(),
      mode: OBJECTIVE_MODE.goals,
      longTermGoal: null,
      shortTermGoals: [{ id: "t1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.completed }],
    };
    const projected = projectStoryPlanGoals(previous, staleSave, tracker, "branch_a");
    expect(projected.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(projected.shortTermGoals[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  test("an explicit status change in the plan wins over the tracker's older status", () => {
    const previous = planOf([task("t1", "Reach the gates", "", "active")]);
    const explicit = planOf([task("t1", "Reach the gates", "", "completed")]); // the user checked it in the editor
    const tracker: ObjectiveState = {
      ...foreignState(),
      mode: OBJECTIVE_MODE.goals,
      longTermGoal: null,
      shortTermGoals: [{ id: "t1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.active }],
    };
    const projected = projectStoryPlanGoals(previous, explicit, tracker, "branch_a");
    expect(projected.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  test("an empty plan projects to empty goals (A8) and keeps the pass-through fields", () => {
    const projected = projectStoryPlanGoals(next, EMPTY_AGENT_PLAN, foreignState(), "branch_a");
    expect(projected.mode).toBe(OBJECTIVE_MODE.goals);
    expect(projected.longTermGoal).toBeNull();
    expect(projected.shortTermGoals).toEqual([]);
    expect(projected.objectiveDescription).toBe("Manual objective");
    expect(projected.autoCheckFrequency).toBe(3);
  });
});

describe("pure: followGoalStatuses (3a — statuses live in the plan, R2)", () => {
  const plan = planOf([task("t1", "Reach the gates", "", "active"), task("t2", "Lift the siege", "", "pending")]);

  const goalsState = (goals: Array<{ id: string; status: ObjectiveState["shortTermGoals"][number]["status"] }>): ObjectiveState => ({
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

  test("advances a completed check into the plan; goal/constraints untouched", () => {
    const followed = followGoalStatuses(plan, goalsState([{ id: "t1", status: OBJECTIVE_TASK_STATUS.completed }]));
    expect(followed).not.toBeNull();
    expect(followed.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(followed.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect(followed.goal).toBe("Story goal");
    expect(followed.constraints).toEqual(["Stay in character"]);
  });

  test("null when nothing changed; ids the plan does not know are ignored; tasks without a goal keep their status", () => {
    expect(followGoalStatuses(plan, goalsState([{ id: "t1", status: OBJECTIVE_TASK_STATUS.active }]))).toBeNull();
    expect(followGoalStatuses(plan, goalsState([{ id: "obj_st_9", status: OBJECTIVE_TASK_STATUS.completed }]))).toBeNull();
  });

  test("two actives resolve to the TRACKER's active (other demoted) and the result passes normalizeAgentPlan", () => {
    // The tracker kept t2 active; the plan still declares t1 active.
    const followed = followGoalStatuses(plan, goalsState([{ id: "t2", status: OBJECTIVE_TASK_STATUS.active }]));
    expect(followed).not.toBeNull();
    expect(followed.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending); // plan's active demoted
    expect(followed.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.active); // tracker's active kept
    expect(normalizeAgentPlan(followed)).not.toBeNull();
  });
});

describe("pure: pickCurrentStoryEvent + insertStoryEventAfterCurrent (G2/R3)", () => {
  test("current = first active, else first pending, else null", () => {
    const activeSecond = planOf([task("t1", "a", "", "pending"), task("t2", "b", "", "active")]);
    expect(pickCurrentStoryEvent(activeSecond)?.id).toBe("t2"); // an active beats an earlier pending
    expect(pickCurrentStoryEvent(planOf([task("t1", "a", "", "pending")]))?.id).toBe("t1");
    expect(pickCurrentStoryEvent(planOf([task("t1", "a", "", "completed"), task("t2", "b", "", "abandoned")]))).toBeNull();
  });

  test("inserts the pending event right after the current one; appends when exhausted", () => {
    const plan = planOf([task("t1", "a", "", "active"), task("t2", "b", "", "pending")]);
    const inserted = insertStoryEventAfterCurrent(plan, { id: "task_new", title: "New", body: "Body" });
    expect(inserted.tasks.map((t) => t.id)).toEqual(["t1", "task_new", "t2"]); // right after the current event
    expect(inserted.tasks[1]).toEqual({ id: "task_new", title: "New", body: "Body", status: OBJECTIVE_TASK_STATUS.pending });

    const exhausted = planOf([task("t1", "a", "", "completed")]);
    const appended = insertStoryEventAfterCurrent(exhausted, { id: "task_new", title: "New", body: "" });
    expect(appended.tasks.map((t) => t.id)).toEqual(["t1", "task_new"]);
  });
});

// ─── service + observer (T1/T2: real store container) ────────────────────────

let stores: StoreContainer;
let objectiveService: ObjectiveService;
let storyPlanSync: StoryPlanSync;
let characterId: string;

/** The two constructor deps (SessionRuntime, ProviderProfileService) no path
 *  under test touches — one shared cast instead of one per construction site
 *  (the objective-service suite's established `null as never` pattern). */
const unusedObjectiveDeps = null as never;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-story-plan-sync-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const character = await stores.characters.create({ name: "Story plan sync fixture" });
  characterId = character.id;
  objectiveService = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps);
  storyPlanSync = new StoryPlanSync(stores, objectiveService);
  // Mirror the production wiring (server-runtime.ts): every committed state
  // triggers the follow-back.
  objectiveService.registerStateObserver((chatId, nextState) =>
    storyPlanSync.onObjectiveStateCommitted(chatId, nextState),
  );
});

interface World {
  chatId: ChatId;
  branchA: ChatBranchId;
  branchB: ChatBranchId;
}

/** A fresh chat with a seeded message and a forked second branch (plan-less). */
async function makeWorld(): Promise<World> {
  const chat = await stores.chats.createChat({ characterId, title: "Sync chat", promptPresetId: null });
  const chatId = brandId<ChatId>(chat.id);
  const branchA = brandId<ChatBranchId>(chat.activeBranchId);
  const message = await stores.messages.addMessage({
    chatId: chat.id,
    branchId: chat.activeBranchId,
    role: "user",
    authorType: "user",
    content: "seed",
  });
  const fork = await stores.chats.forkBranch(chat.id, message.id);
  return { chatId, branchA, branchB: brandId<ChatBranchId>(fork.id) };
}

async function readPlan(chatId: ChatId, branchId: ChatBranchId): Promise<AgentPlan> {
  return (
    (await stores.agentPlans.get({ kind: "chatBranch", chatId: chatId as string, branchId: branchId as string })) ??
    EMPTY_AGENT_PLAN
  );
}

const readState = (chatId: ChatId): Promise<ObjectiveState> => objectiveService.getState(chatId);

async function readEnabled(chatId: ChatId): Promise<boolean> {
  const chat = await stores.chats.getById(chatId as string);
  if (!chat) throw new Error(`chat ${chatId} vanished`);
  return chat.insightsConfig.objectiveEnabled;
}

describe("service: applyPlan (A5/A8)", () => {
  test("an ACTIVE-branch apply projects and turns the tracker on", async () => {
    const { chatId, branchA } = await makeWorld();
    expect(await readEnabled(chatId)).toBe(false); // default off — A5 turns it on

    const saved = await storyPlanSync.applyPlan(chatId, branchA, {
      goal: "Take the city",
      constraints: [],
      tasks: [
        { id: "t1", title: "Reach the gates", body: "At dawn.", status: "active" },
        { id: "t2", title: "Lift the siege", body: "", status: "pending" },
      ],
    });
    expect(saved.tasks).toHaveLength(2); // returns the normalized plan, like the route

    const state = await readState(chatId);
    expect(state.mode).toBe(OBJECTIVE_MODE.goals);
    expect(state.longTermGoal).toBeNull(); // A2
    expect(state.shortTermGoals.map((g) => g.description)).toEqual(["Reach the gates\nAt dawn.", "Lift the siege"]);
    expect(state.planProjectedFromBranchId).toBe(branchA as string);
    expect(await readEnabled(chatId)).toBe(true); // A5
  });

  test("the first apply REPLACES foreign goals (A5 warning case, no plan guard)", async () => {
    const { chatId, branchA } = await makeWorld();
    await objectiveService.setObjectiveMode(chatId, OBJECTIVE_MODE.goals);
    await objectiveService.updateLongTermGoal(chatId, { description: "Foreign long-term" });
    await objectiveService.addShortTermGoal(chatId, "Foreign goal");

    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "Reach the gates", "", "active")]));
    const state = await readState(chatId);
    expect(state.longTermGoal).toBeNull(); // the foreign long-term goal is gone (A2)
    expect(state.shortTermGoals.map((g) => g.description)).toEqual(["Reach the gates"]); // the foreign goal is replaced
  });

  test("a NON-active branch's applyPlan saves the plan but does not touch the tracker", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await objectiveService.setObjectiveMode(chatId, OBJECTIVE_MODE.goals);
    await objectiveService.addShortTermGoal(chatId, "Foreign goal");
    const before = await readState(chatId);

    await storyPlanSync.applyPlan(chatId, branchB, planOf([task("t1", "Reach the gates", "", "active")]));
    expect((await readPlan(chatId, branchB)).tasks.map((t) => t.id)).toEqual(["t1"]); // saved for the branch
    expect(await readState(chatId)).toEqual(before); // the tracker is byte-identical
    expect((await readState(chatId)).planProjectedFromBranchId ?? null).toBeNull();
    expect(await readEnabled(chatId)).toBe(false); // A5 never fired
    // The active branch keeps no plan side effects.
    expect(await readPlan(chatId, branchA)).toEqual(EMPTY_AGENT_PLAN);
  });

  test("an EMPTY plan empties the goals and leaves objectiveEnabled as is (A8)", async () => {
    const { chatId, branchA } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "Reach the gates", "", "active")]));
    expect((await readState(chatId)).shortTermGoals).toHaveLength(1);
    expect(await readEnabled(chatId)).toBe(true);

    await storyPlanSync.applyPlan(chatId, branchA, { goal: "", constraints: [], tasks: [] });
    const state = await readState(chatId);
    expect(state.shortTermGoals).toEqual([]); // A8 — released
    expect(state.mode).toBe(OBJECTIVE_MODE.goals);
    expect(state.longTermGoal).toBeNull();
    expect(await readEnabled(chatId)).toBe(true); // the toggle is the user's, not the plan's
  });

  test("invalid plans throw the plan ROUTE's two 422 codes; an unknown branch is a 404", async () => {
    const { chatId, branchA } = await makeWorld();
    const twoActive = storyPlanSync.applyPlan(chatId, branchA, {
      goal: "",
      constraints: [],
      tasks: [
        { id: "a", title: "First", body: "", status: "active" },
        { id: "b", title: "Second", body: "", status: "active" },
      ],
    });
    await expectDomainError(twoActive, "Unprocessable", "agent_plan_multiple_active");

    const garbage = storyPlanSync.applyPlan(chatId, branchA, "garbage");
    await expectDomainError(garbage, "Unprocessable", "agent_plan_invalid");

    const unknownBranch = storyPlanSync.applyPlan(chatId, brandId<ChatBranchId>("brnch_none"), planOf([]));
    await expectDomainError(unknownBranch, "NotFound");
  });
});

describe("service: insertNextEvent (R3)", () => {
  test("lands right after the current event and re-projects on the active branch", async () => {
    const { chatId, branchA } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "Current", "", "active"), task("t2", "Later", "", "pending")]));

    const saved = await storyPlanSync.insertNextEvent(chatId, branchA, { title: "New event", body: "Do the thing" });
    expect(saved.tasks.map((t) => t.title)).toEqual(["Current", "New event", "Later"]);
    expect(saved.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect(saved.tasks[1].id.startsWith("task_")).toBe(true); // the editor's id convention
    expect(await readPlan(chatId, branchA)).toEqual(saved); // persisted

    const state = await readState(chatId); // the active branch re-projected (R3 via applyPlan)
    expect(state.shortTermGoals.map((g) => g.id)).toEqual([saved.tasks[0].id, saved.tasks[1].id, saved.tasks[2].id]);
    expect(state.shortTermGoals[1].description).toBe("New event\nDo the thing"); // A3 through the service
  });

  test("appends when the plan is exhausted; a blank title is a 422", async () => {
    const { chatId, branchA } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "Done", "", "completed")]));

    const saved = await storyPlanSync.insertNextEvent(chatId, branchA, { title: "New event", body: "" });
    expect(saved.tasks.map((t) => t.title)).toEqual(["Done", "New event"]);

    const blank = storyPlanSync.insertNextEvent(chatId, branchA, { title: "   ", body: "" });
    await expectDomainError(blank, "Unprocessable");
  });
});

describe("service + observer: follow-back (3a — a completed goal advances the plan, no model call)", () => {
  test("a manual tracker edit flows back into the projected branch's plan", async () => {
    const { chatId, branchA } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "Reach the gates", "", "active"), task("t2", "Lift the siege", "", "pending")]));

    // The manual check path — the same commitState boundary the LLM check commits through.
    await objectiveService.updateShortTermGoal(chatId, "t1", { status: OBJECTIVE_TASK_STATUS.completed });
    await storyPlanSync.waitForFollowBack(chatId); // parked promise, no polling

    const plan = await readPlan(chatId, branchA);
    expect(plan.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed); // the plan advanced
    expect(plan.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    const state = await readState(chatId);
    expect(state.shortTermGoals.map((g) => g.status)).toEqual([OBJECTIVE_TASK_STATUS.completed, OBJECTIVE_TASK_STATUS.pending]);
    expect(state.mode).toBe(OBJECTIVE_MODE.goals); // the tracker itself was not re-projected
  });

  test("observer failures are logged and swallowed — the committed state stands", async () => {
    const { chatId } = await makeWorld();
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps);
    service.registerStateObserver(() => {
      throw new Error("sync observer boom");
    });
    const withGoal = await service.addShortTermGoal(chatId, "Survives the throwing observer");
    expect(withGoal.shortTermGoals[0].description).toBe("Survives the throwing observer");

    service.registerStateObserver(async () => {
      throw new Error("async observer boom");
    });
    const withSecond = await service.updateShortTermGoal(chatId, withGoal.shortTermGoals[0].id, {
      status: OBJECTIVE_TASK_STATUS.completed,
    });
    expect(withSecond.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.completed); // the write stood
  });

  test("a tracker without a projection source writes no plan (chats without a branch plan: byte-identical)", async () => {
    const { chatId, branchA } = await makeWorld();
    await objectiveService.setObjectiveMode(chatId, OBJECTIVE_MODE.goals);
    await objectiveService.addShortTermGoal(chatId, "Manual goal");
    await storyPlanSync.waitForFollowBack(chatId);
    expect(await readPlan(chatId, branchA)).toEqual(EMPTY_AGENT_PLAN); // no plan row appeared
  });
});

describe("service: reconcileActiveBranch (R2 — the tracker re-fills from the ACTIVE branch)", () => {
  test("switching branches swaps the goals and back without losing statuses", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "", "active"), task("t2", "A second", "", "pending")]));
    await objectiveService.updateShortTermGoal(chatId, "t1", { status: OBJECTIVE_TASK_STATUS.completed });
    await storyPlanSync.waitForFollowBack(chatId);
    expect((await readPlan(chatId, branchA)).tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed); // the status lives in the plan

    await storyPlanSync.applyPlan(chatId, branchB, planOf([task("t3", "B first", "", "active")])); // saved while B is not active
    await stores.chats.activateBranch(chatId as string, branchB as string);
    await storyPlanSync.reconcileActiveBranch(chatId);
    let state = await readState(chatId);
    expect(state.shortTermGoals.map((g) => g.id)).toEqual(["t3"]); // swapped to branch B's plan
    expect(state.planProjectedFromBranchId).toBe(branchB as string);

    await stores.chats.activateBranch(chatId as string, branchA as string);
    await storyPlanSync.reconcileActiveBranch(chatId);
    state = await readState(chatId);
    expect(state.shortTermGoals.map((g) => g.id)).toEqual(["t1", "t2"]); // swapped back
    expect(state.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.completed); // statuses restored from the plan
    expect(state.shortTermGoals[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  test("a plan-less active branch empties plan-projected goals but leaves FOREIGN goals alone", async () => {
    // Plan-projected: emptied (R2 — no plan on the new active branch → no plan goals).
    const projected = await makeWorld();
    await storyPlanSync.applyPlan(projected.chatId, projected.branchA, planOf([task("t1", "A first", "", "active")]));
    await stores.chats.activateBranch(projected.chatId as string, projected.branchB as string); // B has no plan
    await storyPlanSync.reconcileActiveBranch(projected.chatId);
    const emptied = await readState(projected.chatId);
    expect(emptied.shortTermGoals).toEqual([]);
    expect(emptied.planProjectedFromBranchId).toBe(projected.branchB as string);
    expect(await readEnabled(projected.chatId)).toBe(true); // A8 — the toggle is left as is

    // Foreign: a tracker the plan never drove is untouched by a plan-less branch.
    const foreign = await makeWorld();
    await objectiveService.setObjectiveMode(foreign.chatId, OBJECTIVE_MODE.goals);
    await objectiveService.addShortTermGoal(foreign.chatId, "Foreign goal");
    const before = await readState(foreign.chatId);
    await storyPlanSync.reconcileActiveBranch(foreign.chatId); // active branch A also has no plan
    expect(await readState(foreign.chatId)).toEqual(before); // byte-identical
  });

  test("a PLANNED active branch takes foreign goals over (the plan drives the chat)", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await objectiveService.setObjectiveMode(chatId, OBJECTIVE_MODE.goals);
    await objectiveService.addShortTermGoal(chatId, "Foreign goal");
    await storyPlanSync.applyPlan(chatId, branchB, planOf([task("t9", "B first", "", "active")])); // B not active yet

    await stores.chats.activateBranch(chatId as string, branchB as string);
    await storyPlanSync.reconcileActiveBranch(chatId);
    const state = await readState(chatId);
    expect(state.shortTermGoals.map((g) => g.id)).toEqual(["t9"]); // the plan replaced the foreign goals
    expect(state.planProjectedFromBranchId).toBe(branchB as string);
    expect((await readPlan(chatId, branchA)).tasks).toEqual([]); // branch A never grew a plan
  });

  test("idempotent — a second reconcile on the same active branch changes nothing", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "", "active")]));
    await stores.chats.activateBranch(chatId as string, branchB as string);
    await storyPlanSync.reconcileActiveBranch(chatId);
    const settledState = await readState(chatId);
    const settledPlan = await readPlan(chatId, branchA);

    await storyPlanSync.reconcileActiveBranch(chatId); // same active branch — no-op
    expect(await readState(chatId)).toEqual(settledState);
    expect(await readPlan(chatId, branchA)).toEqual(settledPlan);
  });
});

describe("loop termination (DR-3a stop-when: projection → observer → plan write)", () => {
  test("the cycle reaches a fixpoint after one round — neither direction would write again", async () => {
    const { chatId, branchA } = await makeWorld();
    // Round 1: the projection fills the tracker; nothing to follow back (statuses agree).
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "Reach the gates", "", "active"), task("t2", "Lift the siege", "", "pending")]));
    await storyPlanSync.waitForFollowBack(chatId);

    // Round 2: a check completes t1; follow-back advances the plan.
    await objectiveService.updateShortTermGoal(chatId, "t1", { status: OBJECTIVE_TASK_STATUS.completed });
    await storyPlanSync.waitForFollowBack(chatId);
    const plan = await readPlan(chatId, branchA);
    const state = await readState(chatId);
    expect(plan.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);

    // Fixpoint: follow-back is a no-op (statuses agree)…
    expect(followGoalStatuses(plan, state)).toBeNull();
    // …and a re-projection of the stored plan reproduces the owned fields exactly
    // (previous = next = the stored plan: no explicit changes, so the tracker's
    // statuses — which equal the plan's — carry), so no state write either.
    const reprojection = projectStoryPlanGoals(plan, plan, state, branchA as string);
    expect(reprojection.mode).toBe(state.mode);
    expect(reprojection.longTermGoal).toBe(state.longTermGoal);
    expect(reprojection.shortTermGoals).toEqual(state.shortTermGoals);
    expect(reprojection.planProjectedFromBranchId).toBe(state.planProjectedFromBranchId);

    // Re-applying the SAME plan writes nothing observable — the cycle has ended.
    await storyPlanSync.applyPlan(chatId, branchA, plan);
    await storyPlanSync.waitForFollowBack(chatId);
    expect(await readPlan(chatId, branchA)).toEqual(plan);
    expect(await readState(chatId)).toEqual(state);
  });
});

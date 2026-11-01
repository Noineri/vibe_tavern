/**
 * Story-plan ↔ goal-tracker sync — DR-3b, the WIRING half
 * (DIRECTOR_MODE_PLAN): every ACTIVE-branch change ends with
 * StoryPlanSync.reconcileActiveBranch, and the branch-plan PUT route goes
 * through StoryPlanSync.applyPlan.
 *
 * Everything runs at the WIRED level on a real store container:
 *  - a real SessionRuntime whose own chatApp carries the reconciler
 *    late-bound exactly as server-runtime.ts registers it
 *    (registerActiveBranchReconciler);
 *  - the ObjectiveService state observer registered exactly as
 *    server-runtime.ts does (follow-back stays live under the hooks);
 *  - the plan HTTP routes served by the real AgentPlanAdapter carrying the
 *    sync delegate, as RuntimeApiAdapter passes it in production.
 *
 * Owner ruling R2 (verbatim in the plan document): the plan belongs to the
 * branch; the tracker is re-filled from the ACTIVE branch's plan at every
 * active-branch change — statuses live in the plan, so a switch loses
 * nothing. Chats with no branch plans stay byte-identical on every path
 * (one test pins it with the hook live).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  brandId,
  EventBus,
  OBJECTIVE_MODE,
  OBJECTIVE_TASK_STATUS,
  type AgentPlan,
  type ChatBranchId,
  type ChatId,
  type MessageId,
  type ObjectiveState,
} from "@vibe-tavern/domain";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ObjectiveService } from "../src/domain/insights/objective-service.js";
import { StoryPlanSync } from "../src/domain/director/story-plan-sync.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { AgentPlanAdapter } from "../src/api/adapters/agent-plan-adapter.js";
import { createAgentBranchPlanRoutes } from "../src/api/routes/agent-branch-plan.js";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";

let stores: StoreContainer;
let objectiveService: ObjectiveService;
let storyPlanSync: StoryPlanSync;
let chatApp: ChatApplicationService;
let app: Hono;
let characterId: string;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-story-plan-wiring-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const character = await stores.characters.create({ name: "Story plan wiring fixture" });
  characterId = character.id;
  // Real constructor deps of the kinds server-runtime passes — no path under
  // test calls the model, but constructing them keeps this file cast-free
  // and the wiring faithful.
  const sessionRuntime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const providerProfileService = createProviderProfileService(
    stores.providers,
    stores.proxies,
    new EventBus(),
  );
  objectiveService = new ObjectiveService(stores, sessionRuntime, providerProfileService);
  storyPlanSync = new StoryPlanSync(stores, objectiveService);
  // Mirror the production wiring (server-runtime.ts): the observer first…
  objectiveService.registerStateObserver((chatId, nextState) =>
    storyPlanSync.onObjectiveStateCommitted(chatId, nextState),
  );
  // …then the reconciler registered on the chatApp SessionRuntime OWNS —
  // the exact object server-runtime registers on (the late-bound hook; a
  // constructor param would force a construction cycle).
  chatApp = sessionRuntime.chatApp;
  chatApp.registerActiveBranchReconciler((chatId) => storyPlanSync.reconcileActiveBranch(chatId));
  // The branch-plan routes over the adapter WITH the sync delegate, as
  // RuntimeApiAdapter passes it in production (agent-plan-adapter.ts).
  const adapter = new AgentPlanAdapter(stores, storyPlanSync);
  app = new Hono().route("/", createAgentBranchPlanRoutes(adapter));
  // The production DomainError mapping the app-level handler applies (the
  // same onError mount agent-branch-plan-routes.test.ts uses).
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
});

interface World {
  chatId: ChatId;
  branchA: ChatBranchId;
  branchB: ChatBranchId;
  messageId: string;
}

/** A fresh chat with a seeded message and a forked second branch (plan-less). */
async function makeWorld(): Promise<World> {
  const chat = await stores.chats.createChat({ characterId, title: "Wiring chat", promptPresetId: null });
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
  return { chatId, branchA, branchB: brandId<ChatBranchId>(fork.id), messageId: message.id };
}

const task = (
  id: string,
  title: string,
  status: "pending" | "active" | "completed" | "abandoned" = "pending",
): AgentPlan["tasks"][number] => ({ id, title, body: "", status });

const planOf = (tasks: AgentPlan["tasks"]): AgentPlan => ({ goal: "Story goal", constraints: [], tasks });

const readState = (chatId: ChatId): Promise<ObjectiveState> => objectiveService.getState(chatId);

async function readEnabled(chatId: ChatId): Promise<boolean> {
  const chat = await stores.chats.getById(chatId as string);
  if (!chat) throw new Error(`chat ${chatId} vanished`);
  return chat.insightsConfig.objectiveEnabled;
}

const jsonHeaders = { "content-type": "application/json" };

function planUrl(chatId: string, branchId: string): string {
  return `/api/agent/chats/${chatId}/branches/${branchId}/plan`;
}

async function putPlan(chatId: string, branchId: string, plan: unknown): Promise<Response> {
  return app.request(planUrl(chatId, branchId), {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ plan }),
  });
}

interface WirePlan {
  goal: string;
  constraints: string[];
  tasks: Array<{ id: string; title: string; body: string; status: string }>;
}

describe("branch hooks: activateBranch (R2 at the wired level)", () => {
  test("activate swaps to the new branch's plan goals; activate back restores the previous statuses", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([
      task("t1", "A first", "active"),
      task("t2", "A second", "pending"),
    ]));
    // A goal check lands while A is active → the status lives in A's plan.
    await objectiveService.updateShortTermGoal(chatId, "t1", { status: OBJECTIVE_TASK_STATUS.completed });
    await storyPlanSync.waitForFollowBack(chatId); // parked promise, no polling
    await storyPlanSync.applyPlan(chatId, branchB, planOf([task("t3", "B first", "active")])); // saved while B is not active

    const onB = await chatApp.activateBranch(chatId, branchB); // the hook fires inside
    expect(onB.activeBranchId).toBe(branchB as string);
    expect((await readState(chatId)).shortTermGoals.map((g) => g.id)).toEqual(["t3"]);

    await chatApp.activateBranch(chatId, branchA);
    const tracker = await readState(chatId);
    expect(tracker.shortTermGoals.map((g) => g.id)).toEqual(["t1", "t2"]); // swapped back
    expect(tracker.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.completed); // statuses restored from the plan — a switch loses nothing
    expect(tracker.shortTermGoals[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  test("a chat with no branch plans anywhere is byte-identical through activation", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await objectiveService.setObjectiveMode(chatId, OBJECTIVE_MODE.goals);
    await objectiveService.addShortTermGoal(chatId, "Foreign goal"); // foreign tracker — never plan-driven
    const before = await readState(chatId);

    await chatApp.activateBranch(chatId, branchB);
    expect(await readState(chatId)).toEqual(before); // R2's foreign rule, live through the hook
    await chatApp.activateBranch(chatId, branchA);
    expect(await readState(chatId)).toEqual(before);
  });
});

describe("branch hooks: createBranch", () => {
  test("a fork that activates reconciles — the fresh branch starts plan-less (the plan belongs to the branch)", async () => {
    const { chatId, branchA, messageId } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "active")]));
    expect((await readState(chatId)).shortTermGoals.map((g) => g.id)).toEqual(["t1"]);

    const created = await chatApp.createBranch(chatId, {
      sourceBranchId: branchA,
      forkedFromMessageId: brandId<MessageId>(messageId),
      label: "Wired fork",
      activateFork: true,
    });
    expect(created.copiedMessageCount).toBe(1); // creation itself is unchanged
    const tracker = await readState(chatId);
    expect(tracker.shortTermGoals).toEqual([]); // the new ACTIVE branch has no plan → the goals were released (A8)
    expect(tracker.planProjectedFromBranchId).toBe(created.branchId as string); // the source follows the fork
    expect(tracker.mode).toBe(OBJECTIVE_MODE.goals);
  });

  test("a fork created WITHOUT activation never touches the tracker", async () => {
    const { chatId, branchA, messageId } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "active")]));
    const before = await readState(chatId);

    const created = await chatApp.createBranch(chatId, {
      sourceBranchId: branchA,
      forkedFromMessageId: brandId<MessageId>(messageId),
      label: "Dormant fork",
      activateFork: false,
    });
    expect(created.branchId as string).not.toBe(branchA as string);
    expect(await readState(chatId)).toEqual(before); // the ACTIVE branch never changed — no reconcile either
  });
});

describe("branch hooks: deleteBranch", () => {
  test("deleting the ACTIVE branch hands the tracker to the surviving branch's plan", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "active")]));
    await storyPlanSync.applyPlan(chatId, branchB, planOf([task("t3", "B first", "active")])); // B not active: saved only
    await chatApp.activateBranch(chatId, branchB); // the hook → B's plan drives
    expect((await readState(chatId)).shortTermGoals.map((g) => g.id)).toEqual(["t3"]);

    const deleted = await chatApp.deleteBranch(chatId, branchB); // B was ACTIVE → the store re-points to the root
    expect(deleted.activeBranchId).toBe(branchA as string);
    expect(deleted.deletedBranchId).toBe(branchB as string);
    const tracker = await readState(chatId);
    expect(tracker.shortTermGoals.map((g) => g.id)).toEqual(["t1"]); // the survivor's plan drives
    expect(tracker.planProjectedFromBranchId).toBe(branchA as string);
  });
});

describe("branch hooks: the load-time dangling-branch fallbacks", () => {
  test("a dangling activeBranchId falls back to the root branch and reconciles", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "active")]));
    // The pre-DR-3b world: B activated at the STORE level (no hook), then its
    // plan applied — the tracker legitimately follows B while B is active.
    await stores.chats.activateBranch(chatId as string, branchB as string);
    await storyPlanSync.applyPlan(chatId, branchB, planOf([task("t3", "B first", "active")]));
    expect((await readState(chatId)).shortTermGoals.map((g) => g.id)).toEqual(["t3"]);

    // DB damage the first fallback exists for: activeBranchId points nowhere.
    await stores.chats.activateBranch(chatId as string, "brnch_vanished");

    const state = await chatApp.getChatState(chatId);
    expect(state.branch.id).toBe(branchA as string); // the root fallback repaired the pointer
    expect((await stores.chats.getById(chatId as string))?.activeBranchId).toBe(branchA as string);
    const tracker = await readState(chatId);
    expect(tracker.shortTermGoals.map((g) => g.id)).toEqual(["t1"]); // re-filled from the root's plan — ONLY if the hook fired
    expect(tracker.planProjectedFromBranchId).toBe(branchA as string);
  });

  test("a chat left with zero branches auto-creates a root on load and reconciles it", async () => {
    const { chatId, branchA } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "active")]));
    expect((await readState(chatId)).shortTermGoals.map((g) => g.id)).toEqual(["t1"]);

    // DB damage the second fallback exists for: every branch row gone. Raw
    // SQL by table name on purpose — the store's delete refuses the last
    // branch, so the damage itself must bypass it.
    stores.db.$client.run("DELETE FROM chat_branches WHERE chat_id = ?", [chatId as string]);

    const state = await chatApp.getChatState(chatId);
    expect(state.branch.parentBranchId).toBeNull(); // a fresh root was auto-created
    const tracker = await readState(chatId);
    expect(tracker.shortTermGoals).toEqual([]); // the fresh root has no plan → the goals were released
    expect(tracker.planProjectedFromBranchId).toBe(state.branch.id); // the source follows the new ACTIVE branch
  });
});

describe("the branch-plan PUT route (A5 through the real route)", () => {
  test("PUT on the ACTIVE branch projects the tracker and turns it on", async () => {
    const { chatId, branchA } = await makeWorld();
    expect(await readEnabled(chatId)).toBe(false); // default off — A5 turns it on

    const res = await putPlan(chatId as string, branchA as string, planOf([
      task("t1", "Reach the gates", "active"),
      task("t2", "Lift the siege", "pending"),
    ]));
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { plan: WirePlan }).plan;
    expect(saved.tasks.map((t) => t.status)).toEqual(["active", "pending"]); // normalized, as before

    const tracker = await readState(chatId);
    expect(tracker.mode).toBe(OBJECTIVE_MODE.goals);
    expect(tracker.longTermGoal).toBeNull(); // A2 — the premise never reaches the RP prompt
    expect(tracker.shortTermGoals.map((g) => g.id)).toEqual(["t1", "t2"]);
    expect(tracker.planProjectedFromBranchId).toBe(branchA as string);
    expect(await readEnabled(chatId)).toBe(true); // A5
  });

  test("PUT on a NON-active branch saves the plan and leaves the tracker byte-identical", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    await storyPlanSync.applyPlan(chatId, branchA, planOf([task("t1", "A first", "active")]));
    const before = await readState(chatId);

    const res = await putPlan(chatId as string, branchB as string, planOf([task("t9", "B side plan", "active")]));
    expect(res.status).toBe(200);
    expect(await readState(chatId)).toEqual(before); // the tracker did not move

    const fetched = await app.request(planUrl(chatId as string, branchB as string));
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { plan: WirePlan }).plan.tasks.map((t) => t.id)).toEqual(["t9"]); // the plan IS saved
  });

  test("the route's 422/404 pair survives the delegation", async () => {
    const { chatId, branchA } = await makeWorld();
    const garbage = await putPlan(chatId as string, branchA as string, "garbage");
    expect(garbage.status).toBe(422);
    const body = (await garbage.json()) as { error: { details?: { code?: string } } };
    expect(body.error.details?.code).toBe("agent_plan_invalid");

    const unknownBranch = await putPlan(chatId as string, "brnch_does_not_exist", planOf([task("t1", "A first", "active")]));
    expect(unknownBranch.status).toBe(404);
  });
});

describe("reconcile failures never fail the underlying operation", () => {
  test("a throwing reconciler is logged and swallowed — activation still succeeds and stays usable", async () => {
    const { chatId, branchA, branchB } = await makeWorld();
    // A second service instance for the failure policy: its reconciler
    // throws, and neither activation may surface that (log+swallow).
    const broken = new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls, stores.experiences, stores);
    broken.registerActiveBranchReconciler(async () => {
      throw new Error("reconcile boom");
    });

    const chat = await broken.activateBranch(chatId, branchB); // resolves — the repair failed, not the activation
    expect(chat.activeBranchId).toBe(branchB as string);
    const back = await broken.activateBranch(chatId, branchA); // the path stays usable
    expect(back.activeBranchId).toBe(branchA as string);
  });
});

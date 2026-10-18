import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { AgentPlan, AgentPlanOwner } from "@vibe-tavern/domain";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { AgentPlanStore } from "../src/stores/agent-plan-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// SC-0h — chat-branch-owned agent plans. Same store class, new owner arm and
// NEW table (agent_branch_plans): a (chat, branch) pair instead of a script
// id. Mirrors experience-copilot-chat-owner.test.ts (SC-0a): the same
// character → chat → branches bootstrap (the owner columns carry real FKs, so
// the parent rows must exist and cascade deletes are testable) and the same
// advancing-clock/id fixtures as agent-plan-store.test.ts.

const FIXED_NOW = "2026-06-15T00:00:00.000Z";
let clockBase = Date.parse(FIXED_NOW);
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1_000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_sc0h_${++idCounter}` };

const BRANCH_OWNER: AgentPlanOwner = { kind: "chatBranch", chatId: "chat_1", branchId: "brnch_1" };
const OTHER_BRANCH_OWNER: AgentPlanOwner = { kind: "chatBranch", chatId: "chat_1", branchId: "brnch_2" };
const SCRIPT_OWNER: AgentPlanOwner = { kind: "script", scriptId: "script_sc0h" };
const BRANCH_PLAN: AgentPlan = {
  goal: "Keep the sidechat on the plot",
  constraints: ["No spoilers past the frontier"],
  tasks: [{ id: "task_1", title: "Draft", body: "Ask about the frontier.", status: "active" }],
};

/** character → chat → branches. createDb(":memory:") runs the real migrations,
 *  so agent_branch_plans (migration 0118) is present. */
function bootstrap(db: Awaited<ReturnType<typeof createDb>>, chatId: string, branchIds: string[]) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chats).values({
    id: chatId, characterId: "char_1", personaId: null,
    activeBranchId: branchIds[0]!, promptPresetId: null,
    title: "Test chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  for (const [i, branchId] of branchIds.entries()) {
    db.insert(schema.chatBranches).values({
      id: branchId, chatId, parentBranchId: null,
      forkedFromMessageId: null, label: i === 0 ? "main" : "fork", createdAt: FIXED_NOW,
    }).run();
  }
}

async function setup(chatId = "chat_1", branchIds = ["brnch_1", "brnch_2"]) {
  clockStep = 0;
  const db = await createDb(":memory:");
  bootstrap(db, chatId, branchIds);
  const store = new AgentPlanStore(db, { clock: makeClock(), idGenerator: idGen });
  return { db, store };
}

describe("AgentPlanStore — chat-branch owners (SC-0h)", () => {
  test("save/get round-trips a branch plan; no row reads null", async () => {
    const { store } = await setup();

    expect(await store.get(BRANCH_OWNER)).toBeNull();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);
    expect(await store.get(BRANCH_OWNER)).toEqual(BRANCH_PLAN);
  });

  test("owners are isolated — the pair, the neighbor branch, and script owners never collide", async () => {
    const { store } = await setup();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);
    const otherPlan: AgentPlan = { ...BRANCH_PLAN, goal: "Neighbor branch goal" };
    await store.save(OTHER_BRANCH_OWNER, otherPlan);
    const scriptPlan: AgentPlan = { ...BRANCH_PLAN, goal: "Script goal" };
    await store.save(SCRIPT_OWNER, scriptPlan);

    expect((await store.get(OTHER_BRANCH_OWNER))?.goal).toBe("Neighbor branch goal");
    expect((await store.get(SCRIPT_OWNER))?.goal).toBe("Script goal");
    expect((await store.get(BRANCH_OWNER))?.goal).toBe("Keep the sidechat on the plot");
  });

  test("upsert rewrites content, bumps updated_at, and keeps one row per pair", async () => {
    const { db, store } = await setup();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);
    const before = await db
      .select()
      .from(schema.agentBranchPlans)
      .where(eq(schema.agentBranchPlans.branchId, "brnch_1"))
      .get();
    const replacement: AgentPlan = { ...BRANCH_PLAN, goal: "Revised branch goal" };

    await store.save(BRANCH_OWNER, replacement);

    const rows = await db.select().from(schema.agentBranchPlans).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before?.id);
    expect(rows[0]!.updatedAt > before!.updatedAt).toBe(true);
    expect(await store.get(BRANCH_OWNER)).toEqual(replacement);
  });

  test("DB layer: the unique (chat_id, branch_id) index rejects a second row for a pair", async () => {
    const { db, store } = await setup();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);

    expect(() => {
      db.insert(schema.agentBranchPlans).values({
        id: "agent_branch_dup", chatId: "chat_1", branchId: "brnch_1",
        contentJson: JSON.stringify(BRANCH_PLAN),
        createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
      }).run();
    }).toThrow();
  });

  test("script paths unchanged: a branch write never touches agent_plans and vice versa", async () => {
    const { db, store } = await setup();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);
    await store.save(SCRIPT_OWNER, BRANCH_PLAN);

    await store.save(BRANCH_OWNER, { ...BRANCH_PLAN, goal: "branch again" });
    await store.save(SCRIPT_OWNER, { ...BRANCH_PLAN, goal: "script again" });

    const scriptRows = await db.select().from(schema.agentPlans).all();
    expect(scriptRows).toHaveLength(1);
    expect(scriptRows[0]!.scriptId).toBe("script_sc0h");
    const branchRows = await db.select().from(schema.agentBranchPlans).all();
    expect(branchRows).toHaveLength(1);
    expect((await store.get(BRANCH_OWNER))?.goal).toBe("branch again");
    expect((await store.get(SCRIPT_OWNER))?.goal).toBe("script again");
  });

  test("deleting the branch cascades its plan — the neighbor branch's plan survives", async () => {
    const { db, store } = await setup();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);
    await store.save(OTHER_BRANCH_OWNER, { ...BRANCH_PLAN, goal: "Survivor" });
    await store.save(SCRIPT_OWNER, BRANCH_PLAN);

    db.delete(schema.chatBranches).where(eq(schema.chatBranches.id, "brnch_1")).run();

    expect(await store.get(BRANCH_OWNER)).toBeNull();
    expect((await store.get(OTHER_BRANCH_OWNER))?.goal).toBe("Survivor");
    // A script plan and the chat row itself survive a branch delete.
    expect((await store.get(SCRIPT_OWNER))?.goal).toBe("Keep the sidechat on the plot");
    expect(
      await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_1")).all(),
    ).toHaveLength(1);
  });

  test("deleting the chat cascades every branch plan it owns; script plans survive", async () => {
    const { db, store } = await setup();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);
    await store.save(OTHER_BRANCH_OWNER, BRANCH_PLAN);
    await store.save(SCRIPT_OWNER, BRANCH_PLAN);

    db.delete(schema.chats).where(eq(schema.chats.id, "chat_1")).run();

    expect(await db.select().from(schema.agentBranchPlans).all()).toEqual([]);
    expect(await store.get(BRANCH_OWNER)).toBeNull();
    expect((await store.get(SCRIPT_OWNER))?.goal).toBe("Keep the sidechat on the plot");
  });

  test("returns null without throwing for malformed branch content_json", async () => {
    const { db, store } = await setup();
    await store.save(BRANCH_OWNER, BRANCH_PLAN);
    await db
      .update(schema.agentBranchPlans)
      .set({ contentJson: "not json" })
      .where(eq(schema.agentBranchPlans.branchId, "brnch_1"))
      .run();

    expect(await store.get(BRANCH_OWNER)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentPlan, AgentPlanOwner } from "@vibe-tavern/domain";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import { agentPlans } from "../src/db-schema.js";
import { AgentPlanStore } from "../src/stores/agent-plan-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

let clockBase = Date.parse("2026-10-01T00:00:00.000Z");
let clockStep = 0;
const testClock: StoreClock = {
  now: () => new Date(clockBase + clockStep++ * 1_000).toISOString(),
};

let idCounter = 0;
const testIdGen: StoreIdGenerator = {
  next: (prefix) => `${prefix}_test_${++idCounter}`,
};

const OWNER: AgentPlanOwner = { kind: "script", scriptId: "script_agent_plan" };
const FIRST_PLAN: AgentPlan = {
  goal: "Publish a polished script",
  constraints: ["Keep it local-first"],
  tasks: [{ id: "task_1", title: "Draft", body: "Write the opening scene.", status: "pending" }],
};

async function setup() {
  clockStep = 0;
  const db = await createDb(":memory:");
  const store = new AgentPlanStore(db, { clock: testClock, idGenerator: testIdGen });
  return { db, store };
}

describe("AgentPlanStore", () => {
  test("CRUD saves and retrieves a plan", async () => {
    const { store } = await setup();

    expect(await store.get(OWNER)).toBeNull();
    await store.save(OWNER, FIRST_PLAN);
    expect(await store.get(OWNER)).toEqual(FIRST_PLAN);
  });

  test("allows exactly one row per script", async () => {
    const { db, store } = await setup();
    await store.save(OWNER, FIRST_PLAN);

    expect(() => db.insert(agentPlans).values({
      id: "agent_plan_duplicate",
      scriptId: OWNER.scriptId,
      contentJson: JSON.stringify(FIRST_PLAN),
      createdAt: testClock.now(),
      updatedAt: testClock.now(),
    }).run()).toThrow();
  });

  test("upsert rewrites content and bumps updated_at", async () => {
    const { db, store } = await setup();
    await store.save(OWNER, FIRST_PLAN);
    const before = await db.select().from(agentPlans).where(eq(agentPlans.scriptId, OWNER.scriptId)).get();
    const replacement: AgentPlan = {
      goal: "Revise the script",
      constraints: [],
      tasks: [{ id: "task_2", title: "Review", body: "Review every branch.", status: "active" }],
    };

    await store.save(OWNER, replacement);

    const after = await db.select().from(agentPlans).where(eq(agentPlans.scriptId, OWNER.scriptId)).get();
    expect(after?.id).toBe(before?.id);
    expect(after?.updatedAt > before!.updatedAt).toBe(true);
    expect(await store.get(OWNER)).toEqual(replacement);
  });

  test("returns null without throwing for malformed content_json", async () => {
    const { db, store } = await setup();
    await store.save(OWNER, FIRST_PLAN);
    await db
      .update(agentPlans)
      .set({ contentJson: "not json" })
      .where(eq(agentPlans.scriptId, OWNER.scriptId))
      .run();

    expect(await store.get(OWNER)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  createAgentPlanTools,
  type AgentPlanToolOptions,
} from "../src/domain/agent-plan/agent-plan-tools.js";

const ctx = { messages: [], toolCallId: "t", abort: () => {} } as never;

interface ToolSchemaProbe {
  inputSchema: { safeParse(value: unknown): { success: boolean } };
}

const PLAN = {
  goal: "Ship the plan tools",
  constraints: ["Keep the script owner stable"],
  tasks: [
    { id: "contract", title: "Define the contract", body: "Add the schema.", status: "completed" },
    { id: "tools", title: "Build the tools", body: "Wire plan and read_plan.", status: "active" },
  ],
} as const;

describe("agent-plan-tools", () => {
  test("plan input is an OBJECT root `{plan}` — bare plans and `{}` are rejected", () => {
    const tools = createAgentPlanTools({
      load: async () => null,
      save: async () => {},
    }) as unknown as { plan: ToolSchemaProbe };

    expect(tools.plan.inputSchema.safeParse(PLAN).success).toBe(false);
    expect(tools.plan.inputSchema.safeParse({}).success).toBe(false);
    expect(tools.plan.inputSchema.safeParse({ plan: PLAN }).success).toBe(true);
  });

  test("two active tasks return a model-correctable tool error without saving", async () => {
    let saveCount = 0;
    const tools = createAgentPlanTools({
      load: async () => null,
      save: async () => {
        saveCount += 1;
      },
    });
    const twoActive = {
      ...PLAN,
      tasks: [
        { ...PLAN.tasks[0], status: "active" as const },
        PLAN.tasks[1],
      ],
    };

    await expect(tools.plan.execute({ plan: twoActive }, ctx)).rejects.toThrow(
      "at most one task can be active",
    );
    expect(saveCount).toBe(0);
  });

  test("a plan write is returned by read_plan with its active-title and remaining summary", async () => {
    let saved: typeof PLAN | null = null;
    const tools = createAgentPlanTools({
      load: async () => saved,
      save: async (plan) => {
        saved = plan;
      },
    });

    const result = await tools.plan.execute({ plan: PLAN }, ctx);
    expect(result).toEqual({ ok: true, activeTitle: "Build the tools", remaining: 1 });
    expect(await tools.read_plan.execute({}, ctx)).toEqual(PLAN);
  });

  test("read_plan returns `{ empty: true }` when the script has no plan", async () => {
    const tools = createAgentPlanTools({
      load: async () => null,
      save: async () => {},
    });

    expect(await tools.read_plan.execute({}, ctx)).toEqual({ empty: true });
  });
});

describe("agent-plan-tools — owner + read-only mode (SC-0h)", () => {
  const scriptOwner: AgentPlanToolOptions["owner"] = { kind: "script", scriptId: "script_1" };
  const branchOwner: AgentPlanToolOptions["owner"] = {
    kind: "chatBranch",
    chatId: "chat_1",
    branchId: "brnch_1",
  };

  test("read-only mode exposes ONLY read_plan — no plan write reaches the model", async () => {
    let saveCount = 0;
    const tools = createAgentPlanTools(
      {
        load: async () => null,
        save: async () => {
          saveCount += 1;
        },
      },
      { owner: branchOwner, readOnly: true },
    );

    expect(Object.keys(tools).sort()).toEqual(["read_plan"]);
    expect(tools.plan).toBeUndefined();
    // The exposed reader still works over the branch owner's plan store.
    expect(await tools.read_plan.execute({}, ctx)).toEqual({ empty: true });
    expect(saveCount).toBe(0);
  });

  test("the branch owner scopes the read_plan description to the chat branch; the script wording stays byte-identical", () => {
    const readOnly = createAgentPlanTools(
      { load: async () => null, save: async () => {} },
      { owner: branchOwner, readOnly: true },
    ) as unknown as { read_plan: { description: string } };
    expect(readOnly.read_plan.description).toBe("Read the full current plan for this chat branch.");

    // The pre-SC-0h surface (owner absent OR script owner) keeps the exact
    // wording the script/experience kinds have always shown the model.
    const noOwner = createAgentPlanTools(
      { load: async () => null, save: async () => {} },
    ) as unknown as { read_plan: { description: string } };
    expect(noOwner.read_plan.description).toBe("Read the full current plan for this script.");

    const scriptScoped = createAgentPlanTools(
      { load: async () => null, save: async () => {} },
      { owner: scriptOwner },
    ) as unknown as { plan: { description: string } };
    expect(scriptScoped.plan.description).toContain(
      "Replace the full durable plan for this script",
    );
  });
});

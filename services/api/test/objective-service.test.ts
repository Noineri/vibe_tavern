/**
 * ObjectiveService (INSIGHTS_PLAN INS-3b + INS-3c).
 *
 * Two layers of coverage:
 *  1. The PURE helpers (parseTaskList, parseCheckVerdict, selectActiveTask,
 *     advanceAfterCompletion) — the parse / select / advance logic, no DB, no LLM.
 *  2. The SERVICE end-to-end via the injected `execute` + `resolvePrompt` (DI,
 *     per AGENTS.md §1.4 — the deps are injected, NOT mocked globally):
 *     generateTasks → tree; getActiveTask → first pending; checkCompletion
 *     advances; CRUD round-trips; AND the prompt handed to the executor is built
 *     by the InsightsAssembler (recent window + instruction as the final user
 *     message). The old `withObjectiveInstructionAsFinalUserMessage` boundary
 *     (INS-3b) now lives in the assembler test — relocated, not deleted — and is
 *     re-pinned here at the service→executor seam.
 *
 * The store is a tiny stub (getById + updateInsightsObjectiveState) — the
 * service only touches those two chat-store methods.
 */
import { describe, it, expect } from "bun:test";
import type { ObjectiveState } from "@vibe-tavern/domain";
import { OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import {
  ObjectiveService,
  defaultObjectiveState,
  parseTaskList,
  parseCheckVerdict,
  selectActiveTask,
  advanceAfterCompletion,
} from "../src/domain/insights/objective-service.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";

// ─── pure helpers ───────────────────────────────────────────────────────────

describe("parseTaskList (INS-3b)", () => {
  it("parses numbered '1.' lines into pending tasks in order", () => {
    const tasks = parseTaskList("1. Reach the city\n2. Find the contact\n3. Escape");
    expect(tasks.map((t) => t.description)).toEqual(["Reach the city", "Find the contact", "Escape"]);
    expect(tasks.every((t) => t.status === OBJECTIVE_TASK_STATUS.pending)).toBe(true);
    expect(tasks[0].id).toBe("obj_task_1");
  });

  it("accepts '1)' and bullet '-' / '*' markers", () => {
    const tasks = parseTaskList("1) First\n- Second\n* Third");
    expect(tasks.map((t) => t.description)).toEqual(["First", "Second", "Third"]);
  });

  it("ignores non-list chatter/preamble so it never pollutes the route", () => {
    const tasks = parseTaskList("Here is the plan:\n\n1. Real task\nsome commentary\n2. Another real one");
    expect(tasks.map((t) => t.description)).toEqual(["Real task", "Another real one"]);
  });

  it("returns an empty array when nothing parses", () => {
    expect(parseTaskList("no list here at all")).toEqual([]);
  });
});

describe("parseCheckVerdict (INS-3b)", () => {
  it("treats DONE / COMPLETED / FINISHED / YES as complete (case-insensitive)", () => {
    expect(parseCheckVerdict("DONE")).toBe(true);
    expect(parseCheckVerdict("the task is completed.")).toBe(true);
    expect(parseCheckVerdict("Yes, it's finished.")).toBe(true);
  });
  it("defaults to NOT complete for PENDING or garbled output (never falsely advances)", () => {
    expect(parseCheckVerdict("PENDING")).toBe(false);
    expect(parseCheckVerdict("")).toBe(false);
    expect(parseCheckVerdict("asdfgh")).toBe(false);
  });
});

describe("selectActiveTask + advanceAfterCompletion (INS-3b)", () => {
  const pending = (id: string, description = id) => ({ id, description, status: OBJECTIVE_TASK_STATUS.pending as const });

  it("selectActiveTask returns the first pending when none is active", () => {
    const tasks = [pending("t1"), pending("t2")];
    expect(selectActiveTask(tasks)?.id).toBe("t1");
  });

  it("selectActiveTask prefers an 'active' task over an earlier 'pending'", () => {
    const tasks = [pending("t1"), { id: "t2", description: "t2", status: OBJECTIVE_TASK_STATUS.active }];
    expect(selectActiveTask(tasks)?.id).toBe("t2");
  });

  it("selectActiveTask returns null when the route is exhausted (all completed/abandoned)", () => {
    const tasks = [
      { id: "t1", description: "x", status: OBJECTIVE_TASK_STATUS.completed },
      { id: "t2", description: "y", status: OBJECTIVE_TASK_STATUS.abandoned },
    ];
    expect(selectActiveTask(tasks)).toBeNull();
  });

  it("advanceAfterCompletion marks the current target completed (next pending becomes the target)", () => {
    const tasks = [pending("t1"), pending("t2"), pending("t3")];
    const advanced = advanceAfterCompletion(tasks);
    expect(advanced[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(advanced[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect(selectActiveTask(advanced)?.id).toBe("t2");
  });

  it("advanceAfterCompletion is a no-op when there is no active target", () => {
    const tasks = [{ id: "t1", description: "x", status: OBJECTIVE_TASK_STATUS.completed }];
    expect(advanceAfterCompletion(tasks)).toEqual(tasks);
  });
});

// ─── service (DI execute + resolvePrompt) ───────────────────────────────────

function makeMockStores(initial: Record<string, unknown> | null = null): { stores: StoreContainer; readState: () => Record<string, unknown> } {
  let state: Record<string, unknown> = initial ?? {};
  const stores = {
    chats: {
      getById: async () => ({ insightsObjectiveState: state }),
      updateInsightsObjectiveState: async (_id: string, input: { insightsObjectiveState?: Record<string, unknown> }) => {
        if (input.insightsObjectiveState !== undefined) state = input.insightsObjectiveState;
        return { insightsObjectiveState: state };
      },
    },
  } as unknown as StoreContainer;
  return { stores, readState: () => state };
}

// Variant of makeMockStores that takes a typed ObjectiveState (non-null).
function makeMockStates(initial: ObjectiveState): { stores: StoreContainer } {
  return { stores: makeMockStores(initial as unknown as Record<string, unknown>).stores };
}

const context: PromptAssemblyContext = {
  identity: { chatId: "chat_1" },
  character: { id: "char_1", name: "Aria", description: "A fire mage." },
  chat: {
    recentMessages: [
      { id: "m1", role: "user", content: "I draw my sword." },
      { id: "m2", role: "assistant", content: "The warlord sneers." },
    ],
  },
} as PromptAssemblyContext;
const profile = {} as never; // fake execute ignores it

/**
 * Build a service whose `execute` captures the prompt it receives (so the test
 * can pin the service→executor seam) and returns `reply`; whose `resolvePrompt`
 * returns `promptBase` (standing in for the override-or-default .md resolution).
 */
function serviceWith(
  stores: StoreContainer,
  reply: string,
  promptBase = "BASE-INSTRUCTION",
): { service: ObjectiveService; capturedPrompt: () => ProviderExecutionInput["prompt"] | null } {
  let captured: ProviderExecutionInput["prompt"] | null = null;
  const execute = async (input: ProviderExecutionInput) => {
    captured = input.prompt;
    return { text: reply } as never; // service only reads result.text
  };
  const resolvePrompt = async () => promptBase;
  return { service: new ObjectiveService(stores, null as never, null as never, execute as never, resolvePrompt as never), capturedPrompt: () => captured };
}

describe("ObjectiveService (INS-3b logic + INS-3c assembler wiring)", () => {
  it("generateTasks parses the LLM list into a pending route, then getActiveTask returns the first", async () => {
    const { stores, readState } = makeMockStores({ objectiveDescription: "Defeat the warlord", tasks: [], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" });
    const { service } = serviceWith(stores, "1. Reach the city gates\n2. Confront the warlord\n3. End the siege");

    const state = await service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    expect(state.tasks.map((t) => t.description)).toEqual(["Reach the city gates", "Confront the warlord", "End the siege"]);
    expect(state.objectiveDescription).toBe("Defeat the warlord"); // preserved
    expect((await service.getActiveTask("chat_1" as never))?.description).toBe("Reach the city gates");

    // Persisted: readState reflects the saved tasks.
    expect((readState() as ObjectiveState).tasks).toHaveLength(3);
  });

  it("generateTasks throws when the LLM produces no parseable tasks", async () => {
    const { stores } = makeMockStores();
    const { service } = serviceWith(stores, "I cannot help with that.");
    await expect(service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context })).rejects.toThrow();
  });

  it("checkCompletion advances the route when the LLM says DONE", async () => {
    const initial: ObjectiveState = {
      objectiveDescription: "Escape",
      tasks: [
        { id: "t1", description: "Pick the lock", status: OBJECTIVE_TASK_STATUS.pending },
        { id: "t2", description: "Run", status: OBJECTIVE_TASK_STATUS.pending },
      ],
      autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "",
    };
    const { stores } = makeMockStates(initial);
    const { service } = serviceWith(stores, "DONE");

    const after = await service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", context });
    expect(after.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(after.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect((await service.getActiveTask("chat_1" as never))?.description).toBe("Run");
  });

  it("checkCompletion is a no-op when the LLM says PENDING", async () => {
    const initial: ObjectiveState = {
      objectiveDescription: "x",
      tasks: [{ id: "t1", description: "Stay put", status: OBJECTIVE_TASK_STATUS.pending }],
      autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "",
    };
    const { stores } = makeMockStates(initial);
    const { service } = serviceWith(stores, "PENDING");

    const after = await service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", context });
    expect(after.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("CRUD: addTask appends pending; updateTask patches; deleteTask removes; unknown id throws", async () => {
    const initial: ObjectiveState = { objectiveDescription: "x", tasks: [{ id: "t1", description: "first", status: OBJECTIVE_TASK_STATUS.pending }], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, null as never, null as never, async () => ({ text: "" }) as never);

    const withAdded = await service.addTask("chat_1" as never, "second");
    expect(withAdded.tasks).toHaveLength(2);
    expect(withAdded.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);

    const withUpdated = await service.updateTask("chat_1" as never, "t1", { status: OBJECTIVE_TASK_STATUS.abandoned, description: "skipped" });
    expect(withUpdated.tasks[0]).toEqual({ id: "t1", description: "skipped", status: OBJECTIVE_TASK_STATUS.abandoned });

    const withDeleted = await service.deleteTask("chat_1" as never, "t1");
    expect(withDeleted.tasks.find((t) => t.id === "t1")).toBeUndefined();

    await expect(service.updateTask("chat_1" as never, "nope", { description: "x" })).rejects.toThrow();
    await expect(service.deleteTask("chat_1" as never, "nope")).rejects.toThrow();
  });

  it("setObjectiveDescription sets the high-level goal on an empty chat", async () => {
    const { stores } = makeMockStores();
    const service = new ObjectiveService(stores, null as never, null as never, async () => ({ text: "" }) as never);
    const state = await service.setObjectiveDescription("chat_1" as never, "Survive the winter");
    expect(state.objectiveDescription).toBe("Survive the winter");
  });

  // ─── INS-3c: the prompt handed to the executor is built by the assembler ──
  // Re-pins the boundary the old withObjectiveInstructionAsFinalUserMessage test
  // held: the recent window reaches the model as real turns and the instruction
  // is the FINAL user message (now composed from the resolved base + dynamic
  // context, shaped by the InsightsAssembler — no caller-built contextPrompt).

  it("generateTasks hands the executor the RP context + the composed instruction as the final user message", async () => {
    const { stores } = makeMockStores({ objectiveDescription: "Defeat the warlord", tasks: [], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" });
    const { service, capturedPrompt } = serviceWith(stores, "1. Fight");

    await service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    const messages = (capturedPrompt()!.finalPayload as { messages: Array<{ role: string; content: string; layerId?: string }> }).messages;
    // The character context reaches the insight model (it sees the RP world).
    expect(messages.some((m) => m.content.includes("A fire mage."))).toBe(true);
    // The recent window is preserved as real turns.
    expect(messages.some((m) => m.content === "I draw my sword." && m.role === "user")).toBe(true);
    // The final user message = resolved base (override-or-default) + dynamic objective context.
    const last = messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.layerId).toBe("insights_instruction");
    expect(last.content).toContain("BASE-INSTRUCTION");
    expect(last.content).toContain("Objective: Defeat the warlord");
  });

  it("the override flows through resolvePrompt: a custom generatePrompt replaces the default base", async () => {
    const { stores } = makeMockStores({ objectiveDescription: "Escape", tasks: [], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "MY-CUSTOM-GEN-PROMPT", checkPrompt: "", injectPrompt: "" });
    // resolvePrompt receives the override; a real loader would return it verbatim.
    let receivedOverride: string | null = null;
    const execute = async () => ({ text: "1. Go" }) as never;
    const resolvePrompt = async (_key: string, override?: string) => {
      receivedOverride = override ?? null;
      return override?.trim() || "DEFAULT";
    };
    const service = new ObjectiveService(stores, null as never, null as never, execute as never, resolvePrompt as never);

    await service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    expect(receivedOverride).toBe("MY-CUSTOM-GEN-PROMPT");
  });
});

describe("ObjectiveService.triggerAutoCheck (INS-4 orchestration)", () => {
  /** Build a service wired for the auto-check path: a chat with insightsConfig +
   *  a messages store, a stub sessionRuntime.chatLifecycle.buildPipelineContext,
   *  and a stub providerProfiles.resolveActiveProviderProfile. The trailing-lock
   *  mechanics are unit-tested in background-task-locks.test.ts; this pins the
   *  orchestration: gate (enabled / frequency / assistant count) → context build
   *  → check, with the closure rebuilding context on each invocation. */
  function makeTriggerService(opts: {
    objectiveEnabled: boolean;
    autoCheckFrequency: number;
    assistantCount: number;
    tasks?: ObjectiveTask[];
    reply?: string;
    hasProvider?: boolean;
    model?: string;
  }): {
    service: ObjectiveService;
    getBuildCalls: () => number;
    getExecuteCalls: () => number;
    readState: () => ObjectiveState;
  } {
    const { objectiveEnabled, autoCheckFrequency, assistantCount, tasks = [], reply = "DONE", hasProvider = true, model = "gpt-test" } = opts;
    // Deliberately the PRE-model-selection persisted shape: getState must
    // normalize it to useChatModel:true so existing chats keep auto-checking.
    const baseState = {
      objectiveDescription: "Defeat the warlord",
      tasks,
      autoCheckFrequency,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    } satisfies Omit<ObjectiveState, "useChatModel" | "providerProfileId" | "model">;
    let state: Record<string, unknown> = baseState as unknown as Record<string, unknown>;
    const messages = Array.from({ length: assistantCount }, (_, i) => ({ id: `a${i}`, role: "assistant", position: i, content: `msg ${i}` }));
    const stores = {
      chats: {
        getById: async () => ({ id: "chat_1", activeBranchId: "branch_1", insightsConfig: { objectiveEnabled }, insightsObjectiveState: state }),
        updateInsightsObjectiveState: async (_id: string, input: { insightsObjectiveState?: Record<string, unknown> }) => {
          if (input.insightsObjectiveState !== undefined) state = input.insightsObjectiveState;
          return { insightsObjectiveState: state };
        },
      },
      messages: { getMessages: async () => messages },
    } as unknown as StoreContainer;
    let buildCalls = 0;
    let executeCalls = 0;
    const sessionRuntime = {
      chatLifecycle: {
        buildPipelineContext: async () => {
          buildCalls += 1;
          return { context };
        },
      },
    } as never;
    const providerProfiles = {
      resolveActiveProviderProfile: async () => (hasProvider ? { id: "prof_1", defaultModel: model } : null),
    } as never;
    const execute = async () => {
      executeCalls += 1;
      return { text: reply } as never;
    };
    const resolvePrompt = async () => "BASE-INSTRUCTION";
    const service = new ObjectiveService(stores, sessionRuntime, providerProfiles, execute as never, resolvePrompt as never);
    return {
      service,
      getBuildCalls: () => buildCalls,
      getExecuteCalls: () => executeCalls,
      readState: () => state as unknown as ObjectiveState,
    };
  }

  it("no-ops when objective is disabled (no provider lookup, no context build)", async () => {
    const t = makeTriggerService({ objectiveEnabled: false, autoCheckFrequency: 1, assistantCount: 1 });
    await t.service.triggerAutoCheck("chat_1");
    expect(t.getBuildCalls()).toBe(0);
    expect(t.getExecuteCalls()).toBe(0);
  });

  it("no-ops when autoCheckFrequency is 0 (manual only)", async () => {
    const t = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 0, assistantCount: 5 });
    await t.service.triggerAutoCheck("chat_1");
    expect(t.getBuildCalls()).toBe(0);
    expect(t.getExecuteCalls()).toBe(0);
  });

  it("gates on the assistant-message count modulo frequency (every N messages)", async () => {
    // frequency 3: counts 1 and 2 do not trigger; count 3 does.
    const off1 = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 3, assistantCount: 1 });
    await off1.service.triggerAutoCheck("chat_1");
    expect(off1.getExecuteCalls()).toBe(0);
    const off2 = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 3, assistantCount: 2 });
    await off2.service.triggerAutoCheck("chat_1");
    expect(off2.getExecuteCalls()).toBe(0);
    const on3 = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 3,
      assistantCount: 3,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });
    await on3.service.triggerAutoCheck("chat_1");
    expect(on3.getExecuteCalls()).toBe(1);
    expect(on3.readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("skips silently when no active provider profile is configured", async () => {
    const t = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 1, assistantCount: 1, hasProvider: false });
    await t.service.triggerAutoCheck("chat_1");
    expect(t.getBuildCalls()).toBe(0);
    expect(t.getExecuteCalls()).toBe(0);
  });

  it("builds context via chatLifecycle and advances the active task on a DONE verdict", async () => {
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });
    await t.service.triggerAutoCheck("chat_1");
    expect(t.getBuildCalls()).toBe(1); // context built via the session runtime
    expect(t.getExecuteCalls()).toBe(1);
    expect(t.readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("does not advance when the LLM says PENDING", async () => {
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      reply: "PENDING",
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });
    await t.service.triggerAutoCheck("chat_1");
    expect(t.getExecuteCalls()).toBe(1);
    expect(t.readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("resolves a separately pinned provider/model instead of the active chat profile", async () => {
    let activeCalls = 0;
    let pinnedCalls = 0;
    const providerProfiles = {
      resolveActiveProviderProfile: async () => {
        activeCalls += 1;
        return { id: "prof_active", defaultModel: "chat-model" };
      },
      getProviderProfile: async (id: string) => {
        pinnedCalls += 1;
        expect(id).toBe("prof_pinned");
        return { id, defaultModel: "provider-default" };
      },
    } as never;
    const service = new ObjectiveService({} as StoreContainer, {} as never, providerProfiles, async () => ({ text: "" }) as never, async () => "");

    const resolved = await service.resolveInsightProvider({
      ...defaultObjectiveState(),
      useChatModel: false,
      providerProfileId: "prof_pinned",
      model: "secondary-model",
    });

    expect(activeCalls).toBe(0);
    expect(pinnedCalls).toBe(1);
    expect(resolved?.profile.id).toBe("prof_pinned");
    expect(resolved?.model).toBe("secondary-model");
  });
});

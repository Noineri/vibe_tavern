/**
 * ObjectiveService (INSIGHTS_PLAN INS-3b + INS-3c).
 *
 * Two layers of coverage:
 *  1. The PURE helpers (parseTaskList, parseCheckVerdict, selectActiveTask,
 *     advanceAfterCompletion) — strict JSON parse / select / advance logic, no DB, no LLM.
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

describe("parseTaskList (OFA-1)", () => {
  it("parses a strict structured task route into pending tasks in order", () => {
    const tasks = parseTaskList('{"tasks":[{"description":"Reach the city"},{"description":"Find the contact"},{"description":"Escape"}]}');
    expect(tasks.map((t) => t.description)).toEqual(["Reach the city", "Find the contact", "Escape"]);
    expect(tasks.every((t) => t.status === OBJECTIVE_TASK_STATUS.pending)).toBe(true);
    expect(tasks.map((t) => t.id)).toEqual(["obj_task_1", "obj_task_2", "obj_task_3"]);
  });

  it("accepts fenced JSON but rejects free-text lists, empty tasks, and unknown fields", () => {
    expect(parseTaskList('```json\n{"tasks":[{"description":"First"}]}\n```')[0].description).toBe("First");
    expect(() => parseTaskList("1. First\n2. Second")).toThrow();
    expect(() => parseTaskList('{"tasks":[]}')).toThrow();
    expect(() => parseTaskList('{"tasks":[{"description":"First","status":"active"}]}')).toThrow();
  });
});

describe("parseCheckVerdict (OFA-1)", () => {
  it("accepts only the schema-validated boolean verdict", () => {
    expect(parseCheckVerdict('{"completed":true}')).toBe(true);
    expect(parseCheckVerdict('{"completed":false}')).toBe(false);
    expect(parseCheckVerdict('```json\n{"completed":false}\n```')).toBe(false);
  });

  it("rejects negative prose and malformed or ambiguous output instead of advancing", () => {
    expect(() => parseCheckVerdict("NOT DONE")).toThrow();
    expect(() => parseCheckVerdict("No, the task is not complete")).toThrow();
    expect(() => parseCheckVerdict('{"completed":"yes"}')).toThrow();
    expect(() => parseCheckVerdict("")).toThrow();
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
    const { service } = serviceWith(stores, '{"tasks":[{"description":"Reach the city gates"},{"description":"Confront the warlord"},{"description":"End the siege"}]}');

    const state = await service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    expect(state.tasks.map((t) => t.description)).toEqual(["Reach the city gates", "Confront the warlord", "End the siege"]);
    expect(state.objectiveDescription).toBe("Defeat the warlord"); // preserved
    expect((await service.getActiveTask("chat_1" as never))?.description).toBe("Reach the city gates");

    // Persisted: readState reflects the saved tasks.
    expect((readState() as ObjectiveState).tasks).toHaveLength(3);
  });

  it("generateTasks preserves the previous route when the LLM output is malformed", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Keep this route", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial as unknown as Record<string, unknown>);
    const { service } = serviceWith(stores, "I cannot help with that.");
    await expect(service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context })).rejects.toThrow();
    expect((readState() as ObjectiveState).tasks).toEqual(initial.tasks);
  });

  it("does not persist a generation result when cancellation wins after the LLM await", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Keep this route", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial as unknown as Record<string, unknown>);
    let releaseExecute: ((value: { text: string }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute = async () => new Promise<{ text: string }>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, null as never, null as never, execute as never, async () => "BASE");
    const controller = new AbortController();

    const pending = service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context, signal: controller.signal });
    await started;
    controller.abort();
    releaseExecute?.({ text: '{"tasks":[{"description":"Overwrite"}]}' });

    await expect(pending).rejects.toThrow();
    expect((readState() as ObjectiveState).tasks).toEqual(initial.tasks);
  });

  it("does not overwrite a task edit made while generation is in flight", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Original route", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial as unknown as Record<string, unknown>);
    let releaseExecute: ((value: { text: string }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute = async () => new Promise<{ text: string }>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, null as never, null as never, execute as never, async () => "BASE");

    const pending = service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    await started;
    await service.updateTask("chat_1" as never, "t1", { description: "User-edited route" });
    releaseExecute?.({ text: '{"tasks":[{"description":"Stale generated route"}]}' });

    const result = await pending;
    expect(result.tasks[0].description).toBe("User-edited route");
    expect((readState() as ObjectiveState).tasks[0].description).toBe("User-edited route");
  });

  it("merges generated tasks into fresh config changed during the LLM await", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Original route", status: OBJECTIVE_TASK_STATUS.pending }],
      injectionDepth: 1,
    };
    const { stores, readState } = makeMockStores(initial as unknown as Record<string, unknown>);
    let releaseExecute: ((value: { text: string }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute = async () => new Promise<{ text: string }>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, null as never, null as never, execute as never, async () => "BASE");

    const pending = service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    await started;
    await service.updateObjectiveConfig("chat_1" as never, { injectionDepth: 7 });
    releaseExecute?.({ text: '{"tasks":[{"description":"Fresh generated route"}]}' });

    const result = await pending;
    expect(result.tasks[0].description).toBe("Fresh generated route");
    expect(result.injectionDepth).toBe(7);
    expect((readState() as ObjectiveState).injectionDepth).toBe(7);
  });

  it("does not lose a config write started after the generation commit read", async () => {
    let state: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Original route", status: OBJECTIVE_TASK_STATUS.pending }],
      injectionDepth: 1,
    };
    let updateCalls = 0;
    let releaseFirstSave: (() => void) | undefined;
    let markFirstSaveStarted: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolve) => { markFirstSaveStarted = resolve; });
    const stores = {
      chats: {
        getById: async () => ({ insightsObjectiveState: state }),
        updateInsightsObjectiveState: async (_id: string, input: { insightsObjectiveState?: Record<string, unknown> }) => {
          updateCalls += 1;
          const next = input.insightsObjectiveState as unknown as ObjectiveState;
          if (updateCalls === 1) {
            markFirstSaveStarted?.();
            await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
          }
          state = next;
          return { insightsObjectiveState: state };
        },
      },
    } as unknown as StoreContainer;
    const service = new ObjectiveService(
      stores,
      null as never,
      null as never,
      async () => ({ text: '{"tasks":[{"description":"Generated route"}]}' }) as never,
      async () => "BASE",
    );

    const generation = service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    await firstSaveStarted;
    const config = service.updateObjectiveConfig("chat_1" as never, { injectionDepth: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstSave?.();
    await Promise.all([generation, config]);

    expect(state.tasks[0].description).toBe("Generated route");
    expect(state.injectionDepth).toBe(7);
    expect(updateCalls).toBe(2);
  });

  it("serializes generate and check LLM work per chat", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Wait", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores } = makeMockStores(initial as unknown as Record<string, unknown>);
    const releases: Array<(value: { text: string }) => void> = [];
    let executeCalls = 0;
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const execute = async () => {
      const call = executeCalls++;
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      return new Promise<{ text: string }>((resolve) => {
        releases[call] = (value) => {
          activeExecutions -= 1;
          resolve(value);
        };
      });
    };
    const service = new ObjectiveService(stores, null as never, null as never, execute as never, async () => "BASE");

    const generate = service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    while (executeCalls < 1) await Promise.resolve();
    const check = service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", context });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeFirstRelease = executeCalls;

    releases[0]?.({ text: '{"tasks":[{"description":"Generated task"}]}' });
    while (executeCalls < 2) await Promise.resolve();
    releases[1]?.({ text: '{"completed":false}' });
    await Promise.all([generate, check]);

    expect(callsBeforeFirstRelease).toBe(1);
    expect(maxActiveExecutions).toBe(1);
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
    const { service } = serviceWith(stores, '{"completed":true}');

    const after = await service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", context });
    expect(after.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(after.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect((await service.getActiveTask("chat_1" as never))?.description).toBe("Run");
  });

  it("does not complete a target edited while its check is in flight", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Pick the lock", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial as unknown as Record<string, unknown>);
    let releaseExecute: ((value: { text: string }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute = async () => new Promise<{ text: string }>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, null as never, null as never, execute as never, async () => "BASE");

    const pending = service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", context });
    await started;
    await service.updateTask("chat_1" as never, "t1", { description: "Find another exit" });
    releaseExecute?.({ text: '{"completed":true}' });

    const result = await pending;
    expect(result.tasks[0]).toEqual({ id: "t1", description: "Find another exit", status: OBJECTIVE_TASK_STATUS.pending });
    expect((readState() as ObjectiveState).tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("checkCompletion is a no-op when the LLM says PENDING", async () => {
    const initial: ObjectiveState = {
      objectiveDescription: "x",
      tasks: [{ id: "t1", description: "Stay put", status: OBJECTIVE_TASK_STATUS.pending }],
      autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "",
    };
    const { stores } = makeMockStates(initial);
    const { service } = serviceWith(stores, '{"completed":false}');

    const after = await service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", context });
    expect(after.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("does not advance a task when completion checking is cancelled after the LLM await", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Wait", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial as unknown as Record<string, unknown>);
    let releaseExecute: ((value: { text: string }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute = async () => new Promise<{ text: string }>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, null as never, null as never, execute as never, async () => "BASE");
    const controller = new AbortController();

    const pending = service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", context, signal: controller.signal });
    await started;
    controller.abort();
    releaseExecute?.({ text: '{"completed":true}' });

    await expect(pending).rejects.toThrow();
    expect((readState() as ObjectiveState).tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
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

  it("reorders the complete route and rejects incomplete or duplicate permutations", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      tasks: [
        { id: "t1", description: "first", status: OBJECTIVE_TASK_STATUS.pending },
        { id: "t2", description: "second", status: OBJECTIVE_TASK_STATUS.active },
        { id: "t3", description: "third", status: OBJECTIVE_TASK_STATUS.pending },
      ],
    };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, null as never, null as never, async () => ({ text: "" }) as never);

    const reordered = await service.reorderTasks("chat_1" as never, ["t2", "t1", "t3"]);
    expect(reordered.tasks.map((task) => task.id)).toEqual(["t2", "t1", "t3"]);
    await expect(service.reorderTasks("chat_1" as never, ["t1", "t2"])).rejects.toThrow("complete permutation");
    await expect(service.reorderTasks("chat_1" as never, ["t1", "t1", "t3"])).rejects.toThrow("complete permutation");
  });

  it("defaults and normalizes contextWindow to a positive integer", async () => {
    expect(defaultObjectiveState().contextWindow).toBe(10);
    const { stores } = makeMockStores({ ...defaultObjectiveState(), contextWindow: 3.8 });
    const service = new ObjectiveService(stores, null as never, null as never, async () => ({ text: "" }) as never);
    expect((await service.getState("chat_1" as never)).contextWindow).toBe(3);
    expect((await service.updateObjectiveConfig("chat_1" as never, { contextWindow: 6 })).contextWindow).toBe(6);
  });

  it("setting a task active deterministically demotes every other active task", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      tasks: [
        { id: "t1", description: "first", status: OBJECTIVE_TASK_STATUS.active },
        { id: "t2", description: "second", status: OBJECTIVE_TASK_STATUS.pending },
      ],
    };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, null as never, null as never, async () => ({ text: "" }) as never);

    const updated = await service.updateTask("chat_1" as never, "t2", { status: OBJECTIVE_TASK_STATUS.active });
    expect(updated.tasks.map((task) => task.status)).toEqual([
      OBJECTIVE_TASK_STATUS.pending,
      OBJECTIVE_TASK_STATUS.active,
    ]);
  });

  it("normalizes stored tasks to valid non-empty statuses with at most one active task", async () => {
    const { stores } = makeMockStores({
      ...defaultObjectiveState(),
      tasks: [
        { id: "t1", description: "  first  ", status: OBJECTIVE_TASK_STATUS.active },
        { id: "t2", description: "second", status: OBJECTIVE_TASK_STATUS.active },
        { id: "t3", description: "invalid", status: "done" },
        { id: "t4", description: "   ", status: OBJECTIVE_TASK_STATUS.pending },
      ],
    });
    const service = new ObjectiveService(stores, null as never, null as never, async () => ({ text: "" }) as never);

    const normalized = await service.getState("chat_1" as never);
    expect(normalized.tasks).toEqual([
      { id: "t1", description: "first", status: OBJECTIVE_TASK_STATUS.active },
      { id: "t2", description: "second", status: OBJECTIVE_TASK_STATUS.pending },
    ]);
  });

  it("rejects empty task and objective descriptions at the persistence boundary", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Keep this",
      tasks: [{ id: "t1", description: "Keep this task", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, null as never, null as never, async () => ({ text: "" }) as never);

    await expect(service.addTask("chat_1" as never, "   ")).rejects.toThrow("required");
    await expect(service.updateTask("chat_1" as never, "t1", { description: "   " })).rejects.toThrow("required");
    await expect(service.setObjectiveDescription("chat_1" as never, "   ")).rejects.toThrow("required");
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
    const { service, capturedPrompt } = serviceWith(stores, '{"tasks":[{"description":"Fight"}]}');

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
    const execute = async () => ({ text: '{"tasks":[{"description":"Go"}]}' }) as never;
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
  const trigger = (branchId = "branch_1", messageId = "message_1") => ({ chatId: "chat_1", branchId, messageId });
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
    contextWindow?: number;
    tasks?: ObjectiveTask[];
    reply?: string;
    hasProvider?: boolean;
    model?: string;
    executeOverride?: () => Promise<{ text: string }>;
  }): {
    service: ObjectiveService;
    getBuildCalls: () => number;
    getRecentMessageLimit: () => number | undefined;
    getExecuteCalls: () => number;
    getMessageBranchIds: () => string[];
    getContextBranchIds: () => string[];
    readState: () => ObjectiveState;
  } {
    const { objectiveEnabled, autoCheckFrequency, assistantCount, contextWindow = 10, tasks = [], reply = '{"completed":true}', hasProvider = true, model = "gpt-test", executeOverride } = opts;
    // Deliberately the PRE-model-selection persisted shape: getState must
    // normalize it to useChatModel:true so existing chats keep auto-checking.
    const baseState = {
      objectiveDescription: "Defeat the warlord",
      tasks,
      autoCheckFrequency,
      contextWindow,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    } satisfies Omit<ObjectiveState, "useChatModel" | "providerProfileId" | "model">;
    let state: Record<string, unknown> = baseState as unknown as Record<string, unknown>;
    const messages = Array.from({ length: assistantCount }, (_, i) => ({ id: `a${i}`, role: "assistant", position: i, content: `msg ${i}` }));
    const messageBranchIds: string[] = [];
    const contextBranchIds: string[] = [];
    const stores = {
      chats: {
        getById: async () => ({ id: "chat_1", activeBranchId: "branch_1", insightsConfig: { objectiveEnabled }, insightsObjectiveState: state }),
        updateInsightsObjectiveState: async (_id: string, input: { insightsObjectiveState?: Record<string, unknown> }) => {
          if (input.insightsObjectiveState !== undefined) state = input.insightsObjectiveState;
          return { insightsObjectiveState: state };
        },
      },
      messages: { getMessages: async (branchId: string) => {
        messageBranchIds.push(branchId);
        return messages;
      } },
    } as unknown as StoreContainer;
    let buildCalls = 0;
    let recentMessageLimit: number | undefined;
    let executeCalls = 0;
    const sessionRuntime = {
      chatLifecycle: {
        buildPipelineContext: async (input: { recentMessageLimit?: number; branchId?: string }) => {
          buildCalls += 1;
          recentMessageLimit = input.recentMessageLimit;
          if (input.branchId) contextBranchIds.push(input.branchId);
          return { context };
        },
      },
    } as never;
    const providerProfiles = {
      resolveActiveProviderProfile: async () => (hasProvider ? { id: "prof_1", defaultModel: model } : null),
    } as never;
    const execute = async () => {
      executeCalls += 1;
      return executeOverride ? executeOverride() : { text: reply } as never;
    };
    const resolvePrompt = async () => "BASE-INSTRUCTION";
    const service = new ObjectiveService(stores, sessionRuntime, providerProfiles, execute as never, resolvePrompt as never);
    return {
      service,
      getBuildCalls: () => buildCalls,
      getRecentMessageLimit: () => recentMessageLimit,
      getExecuteCalls: () => executeCalls,
      getMessageBranchIds: () => messageBranchIds,
      getContextBranchIds: () => contextBranchIds,
      readState: () => state as unknown as ObjectiveState,
    };
  }

  it("no-ops when objective is disabled (no provider lookup, no context build)", async () => {
    const t = makeTriggerService({ objectiveEnabled: false, autoCheckFrequency: 1, assistantCount: 1 });
    await t.service.triggerAutoCheck(trigger());
    expect(t.getBuildCalls()).toBe(0);
    expect(t.getExecuteCalls()).toBe(0);
  });

  it("no-ops when autoCheckFrequency is 0 (manual only)", async () => {
    const t = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 0, assistantCount: 5 });
    await t.service.triggerAutoCheck(trigger());
    expect(t.getBuildCalls()).toBe(0);
    expect(t.getExecuteCalls()).toBe(0);
  });

  it("gates on the assistant-message count modulo frequency (every N messages)", async () => {
    // frequency 3: counts 1 and 2 do not trigger; count 3 does.
    const off1 = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 3, assistantCount: 1 });
    await off1.service.triggerAutoCheck(trigger());
    expect(off1.getExecuteCalls()).toBe(0);
    const off2 = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 3, assistantCount: 2 });
    await off2.service.triggerAutoCheck(trigger());
    expect(off2.getExecuteCalls()).toBe(0);
    const on3 = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 3,
      assistantCount: 3,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });
    await on3.service.triggerAutoCheck(trigger());
    expect(on3.getExecuteCalls()).toBe(1);
    expect(on3.readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("skips silently when no active provider profile is configured", async () => {
    const t = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 1, assistantCount: 1, hasProvider: false });
    await t.service.triggerAutoCheck(trigger());
    expect(t.getBuildCalls()).toBe(0);
    expect(t.getExecuteCalls()).toBe(0);
  });

  it("builds context via chatLifecycle and advances the active task on a DONE verdict", async () => {
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      contextWindow: 4,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });
    await t.service.triggerAutoCheck(trigger("branch_committed", "message_committed"));
    expect(t.getBuildCalls()).toBe(1); // context built via the session runtime
    expect(t.getRecentMessageLimit()).toBe(4);
    expect(t.getMessageBranchIds()).toEqual(["branch_committed"]);
    expect(t.getContextBranchIds()).toEqual(["branch_committed"]);
    expect(t.getExecuteCalls()).toBe(1);
    expect(t.readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("returns immediately when there is no forward-state job to join", async () => {
    const t = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 1, assistantCount: 1 });

    await t.service.waitForForwardState("chat_1" as never);

    expect(t.getExecuteCalls()).toBe(0);
  });

  it("joins the in-flight auto-check through its committed state update", async () => {
    let markStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
      executeOverride: async () => {
        markStarted?.();
        await gate;
        return { text: '{"completed":true}' };
      },
    });

    const automatic = t.service.triggerAutoCheck(trigger());
    await started;
    let joined = false;
    const joining = t.service.waitForForwardState("chat_1" as never).then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(t.readState().tasks[0]?.status).toBe(OBJECTIVE_TASK_STATUS.pending);

    release?.();
    await Promise.all([automatic, joining]);

    expect(joined).toBe(true);
    expect(t.readState().tasks[0]?.status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("cancels only the waiter while the shared auto-check keeps running", async () => {
    let markStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
      executeOverride: async () => {
        markStarted?.();
        await gate;
        return { text: '{"completed":true}' };
      },
    });

    const automatic = t.service.triggerAutoCheck(trigger());
    await started;
    const controller = new AbortController();
    const joining = t.service.waitForForwardState("chat_1" as never, controller.signal);
    controller.abort(new Error("cancel forward-state wait"));

    await expect(joining).rejects.toThrow("cancel forward-state wait");
    expect(t.readState().tasks[0]?.status).toBe(OBJECTIVE_TASK_STATUS.pending);

    release?.();
    await automatic;
    expect(t.readState().tasks[0]?.status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("keeps ordinary config writes available while the forward-state LLM is running", async () => {
    let markStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
      executeOverride: async () => {
        markStarted?.();
        await gate;
        return { text: '{"completed":false}' };
      },
    });

    const automatic = t.service.triggerAutoCheck(trigger());
    await started;
    await t.service.updateObjectiveConfig("chat_1" as never, { injectionDepth: 7 });

    expect(t.readState().injectionDepth).toBe(7);
    release?.();
    await automatic;
    expect(t.readState().injectionDepth).toBe(7);
  });

  it("serializes a manual generation against an auto-check for the same chat", async () => {
    let state: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      autoCheckFrequency: 1,
      tasks: [{ id: "t1", description: "Wait", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const stores = {
      chats: {
        getById: async () => ({ id: "chat_1", activeBranchId: "branch_1", insightsConfig: { objectiveEnabled: true }, insightsObjectiveState: state }),
        updateInsightsObjectiveState: async (_id: string, input: { insightsObjectiveState?: ObjectiveState }) => {
          if (input.insightsObjectiveState) state = input.insightsObjectiveState;
          return { insightsObjectiveState: state };
        },
      },
      messages: { getMessages: async () => [{ id: "message_1", role: "assistant", position: 0, content: "reply" }] },
    } as unknown as StoreContainer;
    const sessionRuntime = { chatLifecycle: { buildPipelineContext: async () => ({ context }) } } as never;
    const providerProfiles = { resolveActiveProviderProfile: async () => ({ id: "profile_1", defaultModel: "model_1" }) } as never;
    let executeCalls = 0;
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const execute = async () => {
      executeCalls += 1;
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      if (executeCalls === 1) {
        markFirstStarted?.();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        activeExecutions -= 1;
        return { text: '{"tasks":[{"description":"Generated task"}]}' } as never;
      }
      activeExecutions -= 1;
      return { text: '{"completed":false}' } as never;
    };
    const service = new ObjectiveService(stores, sessionRuntime, providerProfiles, execute as never, async () => "BASE");

    const manual = service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", context });
    await firstStarted;
    const automatic = service.triggerAutoCheck(trigger());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executeCalls).toBe(1);
    releaseFirst?.();
    await Promise.all([manual, automatic]);

    expect(executeCalls).toBe(2);
    expect(maxActiveExecutions).toBe(1);
  });

  it("uses the latest immutable branch for a trailing event from another branch", async () => {
    const state: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      autoCheckFrequency: 1,
      tasks: [{ id: "t1", description: "Wait", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const messageBranchIds: string[] = [];
    const contextBranchIds: string[] = [];
    const stores = {
      chats: {
        // Simulate the UI switching elsewhere while the committed event still
        // identifies the branch whose assistant message caused the trigger.
        getById: async () => ({ id: "chat_1", activeBranchId: "branch_switched", insightsConfig: { objectiveEnabled: true }, insightsObjectiveState: state }),
        updateInsightsObjectiveState: async () => ({ insightsObjectiveState: state }),
      },
      messages: { getMessages: async (branchId: string) => {
        messageBranchIds.push(branchId);
        return [{ id: `message_${branchId}`, role: "assistant", position: 0, content: "reply" }];
      } },
    } as unknown as StoreContainer;
    const sessionRuntime = {
      chatLifecycle: {
        buildPipelineContext: async (input: { branchId: string }) => {
          contextBranchIds.push(input.branchId);
          return { context };
        },
      },
    } as never;
    let executeCalls = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const execute = async () => {
      executeCalls += 1;
      if (executeCalls === 1) {
        markFirstStarted?.();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { text: '{"completed":false}' } as never;
    };
    const providerProfiles = { resolveActiveProviderProfile: async () => ({ id: "profile_1", defaultModel: "model_1" }) } as never;
    const service = new ObjectiveService(stores, sessionRuntime, providerProfiles, execute as never, async () => "BASE");

    const first = service.triggerAutoCheck(trigger("branch_a", "message_a"));
    await firstStarted;
    await service.triggerAutoCheck(trigger("branch_b", "message_b"));
    let joined = false;
    const joining = service.waitForForwardState("chat_1" as never).then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);

    releaseFirst?.();
    await Promise.all([first, joining]);

    expect(joined).toBe(true);
    expect(messageBranchIds).toEqual(["branch_a", "branch_b"]);
    expect(contextBranchIds).toEqual(["branch_a", "branch_b"]);
    expect(executeCalls).toBe(2);
  });

  it("does not advance when the LLM says PENDING", async () => {
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      reply: '{"completed":false}',
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });
    await t.service.triggerAutoCheck(trigger());
    expect(t.getExecuteCalls()).toBe(1);
    expect(t.readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("ignores a stored secondary-model pin while using the chat model", async () => {
    let activeCalls = 0;
    let pinnedCalls = 0;
    const providerProfiles = {
      resolveActiveProviderProfile: async () => {
        activeCalls += 1;
        return { id: "prof_active", defaultModel: "chat-model" };
      },
      getProviderProfile: async () => {
        pinnedCalls += 1;
        return { id: "prof_pinned", defaultModel: "secondary-default" };
      },
    } as never;
    const service = new ObjectiveService({} as StoreContainer, {} as never, providerProfiles, async () => ({ text: "" }) as never, async () => "");

    const resolved = await service.resolveInsightProvider({
      ...defaultObjectiveState(),
      useChatModel: true,
      providerProfileId: "prof_pinned",
      model: "secondary-model",
    });

    expect(activeCalls).toBe(1);
    expect(pinnedCalls).toBe(0);
    expect(resolved?.profile.id).toBe("prof_active");
    expect(resolved?.model).toBe("chat-model");
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

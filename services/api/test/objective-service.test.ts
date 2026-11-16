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
import type { ChatId, ObjectiveLongTermGoal, ObjectiveMode, ObjectiveState, ObjectiveTask, ObjectiveTaskStatus } from "@vibe-tavern/domain";
import { brandId, defaultObjectiveState, normalizeObjectiveState, OBJECTIVE_MODE, OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import {
  ObjectiveService,
  parseTaskList,
  parseGoalsResult,
  parseCheckVerdict,
  selectActiveTask,
  advanceAfterCompletion,
} from "../src/domain/insights/objective-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { GenerationResult, ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { makeMessageRow, makeObjectiveChatRow, makeObjectiveStores, makeSessionRuntime } from "./insights-test-builders.js";
import { makeProviderProfileRow } from "./copilot-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";
import { unusedObjectiveDeps } from "./objective-service-fixture.js";

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

/** The service's real ctor seams (objective-service.ts keeps its Execute /
 *  ResolvePrompt aliases private): derived FROM the class these tests
 *  construct, so a ctor signature change re-types every double here. */
type Execute = ConstructorParameters<typeof ObjectiveService>[3];
type ResolvePrompt = ConstructorParameters<typeof ObjectiveService>[4];

/** A real GenerationResult — the fake execute's full return type. The service
 *  reads only `.text` (objective-service.ts:238/:240); providerResponse is the
 *  required trace member, never read on these paths. */
function execResult(text: string): GenerationResult {
  return { text, providerResponse: { mode: "nonstream", steps: [] } };
}

function makeMockStores(initial: unknown = {}): { stores: StoreContainer; readState: () => ObjectiveState } {
  // `initial` is the stored insights_objective_state JSON blob — the domain's
  // own parse seam takes it as `unknown` (normalizeObjectiveState) because
  // legacy/corrupt fixtures (invalid statuses, duplicate actives) are
  // deliberately outside ObjectiveState. Normalized once here; every later
  // write is a service-produced ObjectiveState.
  let state: ObjectiveState = normalizeObjectiveState(initial);
  const stores = makeObjectiveStores({
    chats: {
      getById: async () => makeObjectiveChatRow(state),
      updateInsightsObjectiveState: async (_id, input) => {
        if (input.insightsObjectiveState !== undefined) state = { ...input.insightsObjectiveState };
        return makeObjectiveChatRow(state);
      },
    },
  });
  return { stores, readState: () => state };
}

// Variant of makeMockStores that takes a typed ObjectiveState (non-null).
function makeMockStates(initial: ObjectiveState): { stores: StoreContainer } {
  return { stores: makeMockStores(initial).stores };
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
const profile = makeProviderProfileRow(); // fake execute ignores it

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
  const execute: Execute = async (input) => {
    captured = input.prompt;
    return execResult(reply); // service only reads result.text
  };
  const resolvePrompt: ResolvePrompt = async () => promptBase;
  return { service: new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, resolvePrompt), capturedPrompt: () => captured };
}

describe("ObjectiveService (INS-3b logic + INS-3c assembler wiring)", () => {
  it("generateTasks auto-activates the first task and leaves the rest pending, so getActiveTask returns the first", async () => {
    const { stores, readState } = makeMockStores({ objectiveDescription: "Defeat the warlord", tasks: [], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" });
    const { service } = serviceWith(stores, '{"tasks":[{"description":"Reach the city gates"},{"description":"Confront the warlord"},{"description":"End the siege"}]}');

    const state = await service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    expect(state.tasks.map((t) => t.description)).toEqual(["Reach the city gates", "Confront the warlord", "End the siege"]);
    expect(state.objectiveDescription).toBe("Defeat the warlord"); // preserved
    // The first generated task is explicitly 'active' (the current target); the
    // rest stay 'pending' until reached. This is what makes the freshly
    // generated route immediately show a current task in the UI.
    expect(state.tasks.map((t) => t.status)).toEqual([
      OBJECTIVE_TASK_STATUS.active,
      OBJECTIVE_TASK_STATUS.pending,
      OBJECTIVE_TASK_STATUS.pending,
    ]);
    expect((await service.getActiveTask(brandId<ChatId>("chat_1")))?.description).toBe("Reach the city gates");

    // Persisted: readState reflects the saved tasks with the same activation.
    const persisted = readState().tasks;
    expect(persisted).toHaveLength(3);
    expect(persisted[0].status).toBe(OBJECTIVE_TASK_STATUS.active);
    expect(persisted[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("generateTasks preserves the previous route when the LLM output is malformed", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Keep this route", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial);
    const { service } = serviceWith(stores, "I cannot help with that.");
    await expect(service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context })).rejects.toThrow();
    expect(readState().tasks).toEqual(initial.tasks);
  });

  it("does not persist a generation result when cancellation wins after the LLM await", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Keep this route", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial);
    let releaseExecute: ((value: GenerationResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute: Execute = async () => new Promise<GenerationResult>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");
    const controller = new AbortController();

    const pending = service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context, signal: controller.signal });
    await started;
    controller.abort();
    releaseExecute?.(execResult('{"tasks":[{"description":"Overwrite"}]}'));

    await expect(pending).rejects.toThrow();
    expect(readState().tasks).toEqual(initial.tasks);
  });

  it("does not overwrite a task edit made while generation is in flight", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Original route", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial);
    let releaseExecute: ((value: GenerationResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute: Execute = async () => new Promise<GenerationResult>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");

    const pending = service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await started;
    await service.updateTask(brandId<ChatId>("chat_1"), "t1", { description: "User-edited route" });
    releaseExecute?.(execResult('{"tasks":[{"description":"Stale generated route"}]}'));

    const result = await pending;
    expect(result.tasks[0].description).toBe("User-edited route");
    expect(readState().tasks[0].description).toBe("User-edited route");
  });

  it("merges generated tasks into fresh config changed during the LLM await", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Original route", status: OBJECTIVE_TASK_STATUS.pending }],
      injectionDepth: 1,
    };
    const { stores, readState } = makeMockStores(initial);
    let releaseExecute: ((value: GenerationResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute: Execute = async () => new Promise<GenerationResult>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");

    const pending = service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await started;
    await service.updateObjectiveConfig(brandId<ChatId>("chat_1"), { injectionDepth: 7 });
    releaseExecute?.(execResult('{"tasks":[{"description":"Fresh generated route"}]}'));

    const result = await pending;
    expect(result.tasks[0].description).toBe("Fresh generated route");
    expect(result.injectionDepth).toBe(7);
    expect(readState().injectionDepth).toBe(7);
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
    const stores = makeObjectiveStores({
      chats: {
        getById: async () => makeObjectiveChatRow(state),
        updateInsightsObjectiveState: async (_id, input) => {
          updateCalls += 1;
          const next = input.insightsObjectiveState;
          if (updateCalls === 1) {
            markFirstSaveStarted?.();
            await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
          }
          if (next !== undefined) state = next;
          return makeObjectiveChatRow(state);
        },
      },
    });
    const service = new ObjectiveService(
      stores,
      unusedObjectiveDeps,
      unusedObjectiveDeps,
      async () => execResult('{"tasks":[{"description":"Generated route"}]}'),
      async () => "BASE",
    );

    const generation = service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await firstSaveStarted;
    const config = service.updateObjectiveConfig(brandId<ChatId>("chat_1"), { injectionDepth: 7 });
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
    const { stores } = makeMockStores(initial);
    const releases: Array<(value: GenerationResult) => void> = [];
    let executeCalls = 0;
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const execute: Execute = async () => {
      const call = executeCalls++;
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      return new Promise<GenerationResult>((resolve) => {
        releases[call] = (value) => {
          activeExecutions -= 1;
          resolve(value);
        };
      });
    };
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");

    const generate = service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    while (executeCalls < 1) await Promise.resolve();
    const check = service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeFirstRelease = executeCalls;

    releases[0]?.(execResult('{"tasks":[{"description":"Generated task"}]}'));
    while (executeCalls < 2) await Promise.resolve();
    releases[1]?.(execResult('{"completed":false}'));
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

    const after = await service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    expect(after.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(after.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect((await service.getActiveTask(brandId<ChatId>("chat_1")))?.description).toBe("Run");
  });

  it("does not complete a target edited while its check is in flight", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Pick the lock", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial);
    let releaseExecute: ((value: GenerationResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute: Execute = async () => new Promise<GenerationResult>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");

    const pending = service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await started;
    await service.updateTask(brandId<ChatId>("chat_1"), "t1", { description: "Find another exit" });
    releaseExecute?.(execResult('{"completed":true}'));

    const result = await pending;
    expect(result.tasks[0]).toEqual({ id: "t1", description: "Find another exit", status: OBJECTIVE_TASK_STATUS.pending });
    expect(readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("checkCompletion is a no-op when the LLM says PENDING", async () => {
    const initial: ObjectiveState = {
      objectiveDescription: "x",
      tasks: [{ id: "t1", description: "Stay put", status: OBJECTIVE_TASK_STATUS.pending }],
      autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "",
    };
    const { stores } = makeMockStates(initial);
    const { service } = serviceWith(stores, '{"completed":false}');

    const after = await service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    expect(after.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("does not advance a task when completion checking is cancelled after the LLM await", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      tasks: [{ id: "t1", description: "Wait", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial);
    let releaseExecute: ((value: GenerationResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute: Execute = async () => new Promise<GenerationResult>((resolve) => {
      releaseExecute = resolve;
      markStarted?.();
    });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");
    const controller = new AbortController();

    const pending = service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context, signal: controller.signal });
    await started;
    controller.abort();
    releaseExecute?.(execResult('{"completed":true}'));

    await expect(pending).rejects.toThrow();
    expect(readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("CRUD: addTask appends pending; updateTask patches; deleteTask removes; unknown id throws", async () => {
    const initial: ObjectiveState = { objectiveDescription: "x", tasks: [{ id: "t1", description: "first", status: OBJECTIVE_TASK_STATUS.pending }], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));

    const withAdded = await service.addTask(brandId<ChatId>("chat_1"), "second");
    expect(withAdded.tasks).toHaveLength(2);
    expect(withAdded.tasks[1].status).toBe(OBJECTIVE_TASK_STATUS.pending);

    const withUpdated = await service.updateTask(brandId<ChatId>("chat_1"), "t1", { status: OBJECTIVE_TASK_STATUS.abandoned, description: "skipped" });
    expect(withUpdated.tasks[0]).toEqual({ id: "t1", description: "skipped", status: OBJECTIVE_TASK_STATUS.abandoned });

    const withDeleted = await service.deleteTask(brandId<ChatId>("chat_1"), "t1");
    expect(withDeleted.tasks.find((t) => t.id === "t1")).toBeUndefined();

    await expect(service.updateTask(brandId<ChatId>("chat_1"), "nope", { description: "x" })).rejects.toThrow();
    await expect(service.deleteTask(brandId<ChatId>("chat_1"), "nope")).rejects.toThrow();
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
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));

    const reordered = await service.reorderTasks(brandId<ChatId>("chat_1"), ["t2", "t1", "t3"]);
    expect(reordered.tasks.map((task) => task.id)).toEqual(["t2", "t1", "t3"]);
    await expect(service.reorderTasks(brandId<ChatId>("chat_1"), ["t1", "t2"])).rejects.toThrow("complete permutation");
    await expect(service.reorderTasks(brandId<ChatId>("chat_1"), ["t1", "t1", "t3"])).rejects.toThrow("complete permutation");
  });

  it("defaults and normalizes contextWindow to a positive integer", async () => {
    expect(defaultObjectiveState().contextWindow).toBe(5);
    const { stores } = makeMockStores({ ...defaultObjectiveState(), contextWindow: 3.8 });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));
    expect((await service.getState(brandId<ChatId>("chat_1"))).contextWindow).toBe(3);
    expect((await service.updateObjectiveConfig(brandId<ChatId>("chat_1"), { contextWindow: 6 })).contextWindow).toBe(6);
  });

  it("defaults, normalizes, and clears the persisted auto-check event count in manual mode", async () => {
    expect(defaultObjectiveState().autoCheckEventCount).toBe(0);
    const { stores } = makeMockStores({ ...defaultObjectiveState(), autoCheckFrequency: 3, autoCheckEventCount: 4.8 });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));
    expect((await service.getState(brandId<ChatId>("chat_1"))).autoCheckEventCount).toBe(4);
    expect((await service.updateObjectiveConfig(brandId<ChatId>("chat_1"), { autoCheckFrequency: 0 })).autoCheckEventCount).toBe(0);
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
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));

    const updated = await service.updateTask(brandId<ChatId>("chat_1"), "t2", { status: OBJECTIVE_TASK_STATUS.active });
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
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));

    const normalized = await service.getState(brandId<ChatId>("chat_1"));
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
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));

    await expect(service.addTask(brandId<ChatId>("chat_1"), "   ")).rejects.toThrow("required");
    await expect(service.updateTask(brandId<ChatId>("chat_1"), "t1", { description: "   " })).rejects.toThrow("required");
    await expect(service.setObjectiveDescription(brandId<ChatId>("chat_1"), "   ")).rejects.toThrow("required");
  });

  it("setObjectiveDescription sets the high-level goal on an empty chat", async () => {
    const { stores } = makeMockStores();
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""));
    const state = await service.setObjectiveDescription(brandId<ChatId>("chat_1"), "Survive the winter");
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

    await service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
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
    const execute: Execute = async () => execResult('{"tasks":[{"description":"Go"}]}');
    const resolvePrompt: ResolvePrompt = async (_key, override) => {
      receivedOverride = override ?? null;
      return override?.trim() || "DEFAULT";
    };
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, resolvePrompt);

    await service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    expect(receivedOverride).toBe("MY-CUSTOM-GEN-PROMPT");
  });
});

describe("ObjectiveService.triggerAutoCheck (INS-4 orchestration)", () => {
  const trigger = (branchId = "branch_1", messageId = "message_1") => ({ chatId: "chat_1", branchId, messageId });
  /** Build a service wired for the auto-check path: a chat with insightsConfig +
   *  a messages store, a stub sessionRuntime.chatLifecycle.buildPipelineContext,
   *  and a stub providerProfiles.resolveActiveProviderProfile. The trailing-lock
   *  mechanics are unit-tested in background-task-locks.test.ts; this pins the
   *  orchestration: gate (enabled / persisted qualifying-event cadence) →
   *  context build → check, with the closure rebuilding context on each invocation. */
  function makeTriggerService(opts: {
    objectiveEnabled: boolean;
    autoCheckFrequency: number;
    assistantCount: number;
    contextWindow?: number;
    mode?: ObjectiveMode;
    tasks?: ObjectiveTask[];
    longTermGoal?: ObjectiveLongTermGoal | null;
    shortTermGoals?: ObjectiveTask[];
    reply?: string;
    hasProvider?: boolean;
    model?: string;
    executeOverride?: () => Promise<GenerationResult>;
  }): {
    service: ObjectiveService;
    getBuildCalls: () => number;
    getRecentMessageLimit: () => number | undefined;
    getExecuteCalls: () => number;
    getContextBranchIds: () => string[];
    readState: () => ObjectiveState;
  } {
    const { objectiveEnabled, autoCheckFrequency, assistantCount, contextWindow = 10, mode = OBJECTIVE_MODE.route, tasks = [], longTermGoal = null, shortTermGoals = [], reply = '{"completed":true}', hasProvider = true, model = "gpt-test", executeOverride } = opts;
    // Deliberately the PRE-model-selection persisted shape: getState must
    // normalize it to useChatModel:true so existing chats keep auto-checking.
    const baseState = {
      mode,
      objectiveDescription: "Defeat the warlord",
      tasks,
      longTermGoal,
      shortTermGoals,
      autoCheckFrequency,
      contextWindow,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    } satisfies Omit<ObjectiveState, "autoCheckEventCount" | "useChatModel" | "providerProfileId" | "model">;
    let state: Partial<ObjectiveState> = baseState;
    // Legacy assistant rows deliberately remain available so cadence tests
    // prove that seed/imported history no longer influences auto-checking.
    const messages = Array.from({ length: assistantCount }, (_, i) =>
      makeMessageRow({ id: `a${i}`, role: "assistant", position: i, content: `legacy msg ${i}` }));
    const contextBranchIds: string[] = [];
    const stores = makeObjectiveStores({
      chats: {
        getById: async () => makeObjectiveChatRow(state, { objectiveEnabled }),
        updateInsightsObjectiveState: async (_id, input) => {
          if (input.insightsObjectiveState !== undefined) state = { ...input.insightsObjectiveState };
          return makeObjectiveChatRow(state, { objectiveEnabled });
        },
      },
      messages: { getMessages: async () => messages },
    });
    let buildCalls = 0;
    let recentMessageLimit: number | undefined;
    let executeCalls = 0;
    const sessionRuntime = makeSessionRuntime({
      chatLifecycle: {
        buildPipelineContext: async (input) => {
          buildCalls += 1;
          recentMessageLimit = input.recentMessageLimit;
          if (input.branchId) contextBranchIds.push(input.branchId);
          return { context };
        },
      },
    });
    const providerProfiles = strictTestDouble<ProviderProfileService>(
      { resolveActiveProviderProfile: async () => (hasProvider ? makeProviderProfileRow({ id: "prof_1", defaultModel: model }) : null) },
      "ProviderProfileService (objective auto-check)",
    );
    const execute: Execute = async () => {
      executeCalls += 1;
      return executeOverride ? executeOverride() : execResult(reply);
    };
    const resolvePrompt: ResolvePrompt = async () => "BASE-INSTRUCTION";
    const service = new ObjectiveService(stores, sessionRuntime, providerProfiles, execute, resolvePrompt);
    return {
      service,
      getBuildCalls: () => buildCalls,
      getRecentMessageLimit: () => recentMessageLimit,
      getExecuteCalls: () => executeCalls,
      getContextBranchIds: () => contextBranchIds,
      // The state the service persists is the full normalized ObjectiveState;
      // every readState() assertion reads either a baseState field or a
      // post-commit field — the downcast only widens the fixture's honest
      // Partial back to the domain type (no erasure: same reference).
      readState: () => state as ObjectiveState,
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

  it("auto-checks the selected short-term goal in goals mode (not the hidden route)", async () => {
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      mode: OBJECTIVE_MODE.goals,
      tasks: [],
      longTermGoal: { description: "Free the city", status: OBJECTIVE_TASK_STATUS.pending },
      shortTermGoals: [
        { id: "s1", description: "Reach the gate", status: OBJECTIVE_TASK_STATUS.active },
        { id: "s2", description: "Find an ally", status: OBJECTIVE_TASK_STATUS.pending },
      ],
      reply: '{"completed":true}',
    });

    await t.service.triggerAutoCheck(trigger());

    expect(t.getBuildCalls()).toBe(1);
    expect(t.getExecuteCalls()).toBe(1);
    expect(t.readState().shortTermGoals[0]?.status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(t.readState().shortTermGoals[1]?.status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect(t.readState().longTermGoal?.status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect(t.readState().autoCheckEventCount).toBe(0);
  });

  it("counts qualifying append events since the last check and ignores legacy assistant rows", async () => {
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 3,
      assistantCount: 50,
      reply: '{"completed":false}',
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });

    await t.service.triggerAutoCheck(trigger("branch_1", "message_1"));
    expect(t.getExecuteCalls()).toBe(0);
    expect(t.readState().autoCheckEventCount).toBe(1);

    await t.service.triggerAutoCheck(trigger("branch_1", "message_2"));
    expect(t.getExecuteCalls()).toBe(0);
    expect(t.readState().autoCheckEventCount).toBe(2);

    await t.service.triggerAutoCheck(trigger("branch_1", "message_3"));
    expect(t.getExecuteCalls()).toBe(1);
    expect(t.readState().autoCheckEventCount).toBe(0);
  });

  it("retains the qualifying-event count when no active provider profile is configured", async () => {
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 1,
      hasProvider: false,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
    });
    await t.service.triggerAutoCheck(trigger());
    expect(t.getBuildCalls()).toBe(0);
    expect(t.getExecuteCalls()).toBe(0);
    expect(t.readState().autoCheckEventCount).toBe(1);
  });

  it("retains cadence after a failed check and retries on the next qualifying event", async () => {
    let attempts = 0;
    const t = makeTriggerService({
      objectiveEnabled: true,
      autoCheckFrequency: 1,
      assistantCount: 0,
      tasks: [{ id: "obj_task_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending }],
      executeOverride: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider failed");
        return execResult('{"completed":false}');
      },
    });

    await t.service.triggerAutoCheck(trigger("branch_1", "message_1"));
    expect(t.readState().autoCheckEventCount).toBe(1);

    await t.service.triggerAutoCheck(trigger("branch_1", "message_2"));
    expect(attempts).toBe(2);
    expect(t.readState().autoCheckEventCount).toBe(0);
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
    expect(t.getContextBranchIds()).toEqual(["branch_committed"]);
    expect(t.getExecuteCalls()).toBe(1);
    expect(t.readState().tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("returns immediately when there is no forward-state job to join", async () => {
    const t = makeTriggerService({ objectiveEnabled: true, autoCheckFrequency: 1, assistantCount: 1 });

    await t.service.waitForForwardState(brandId<ChatId>("chat_1"));

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
        return execResult('{"completed":true}');
      },
    });

    const automatic = t.service.triggerAutoCheck(trigger());
    await started;
    let joined = false;
    const joining = t.service.waitForForwardState(brandId<ChatId>("chat_1")).then(() => { joined = true; });
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
        return execResult('{"completed":true}');
      },
    });

    const automatic = t.service.triggerAutoCheck(trigger());
    await started;
    const controller = new AbortController();
    const joining = t.service.waitForForwardState(brandId<ChatId>("chat_1"), controller.signal);
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
        return execResult('{"completed":false}');
      },
    });

    const automatic = t.service.triggerAutoCheck(trigger());
    await started;
    await t.service.updateObjectiveConfig(brandId<ChatId>("chat_1"), { injectionDepth: 7 });

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
    const stores = makeObjectiveStores({
      chats: {
        getById: async () => makeObjectiveChatRow(state, { objectiveEnabled: true }),
        updateInsightsObjectiveState: async (_id, input) => {
          if (input.insightsObjectiveState) state = input.insightsObjectiveState;
          return makeObjectiveChatRow(state, { objectiveEnabled: true });
        },
      },
      messages: { getMessages: async () => [makeMessageRow({ id: "message_1", role: "assistant", position: 0, content: "reply" })] },
    });
    const sessionRuntime = makeSessionRuntime({ chatLifecycle: { buildPipelineContext: async () => ({ context }) } });
    const providerProfiles = strictTestDouble<ProviderProfileService>(
      { resolveActiveProviderProfile: async () => makeProviderProfileRow({ id: "profile_1", defaultModel: "model_1" }) },
      "ProviderProfileService (manual-vs-auto serialization)",
    );
    let executeCalls = 0;
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const execute: Execute = async () => {
      executeCalls += 1;
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      if (executeCalls === 1) {
        markFirstStarted?.();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        activeExecutions -= 1;
        return execResult('{"tasks":[{"description":"Generated task"}]}');
      }
      activeExecutions -= 1;
      return execResult('{"completed":false}');
    };
    const service = new ObjectiveService(stores, sessionRuntime, providerProfiles, execute, async () => "BASE");

    const manual = service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await firstStarted;
    const automatic = service.triggerAutoCheck(trigger());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executeCalls).toBe(1);
    releaseFirst?.();
    await Promise.all([manual, automatic]);

    expect(executeCalls).toBe(2);
    expect(maxActiveExecutions).toBe(1);
  });

  it("coalesces rapid events into one fresh trailing check without under-counting them", async () => {
    let state: ObjectiveState = {
      ...defaultObjectiveState(),
      objectiveDescription: "Escape",
      autoCheckFrequency: 1,
      tasks: [{ id: "t1", description: "Wait", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const contextBranchIds: string[] = [];
    const stores = makeObjectiveStores({
      chats: {
        // Simulate the UI switching elsewhere while the committed event still
        // identifies the branch whose assistant message caused the trigger.
        getById: async () => makeObjectiveChatRow(state, { activeBranchId: "branch_switched", objectiveEnabled: true }),
        updateInsightsObjectiveState: async (_id, input) => {
          if (input.insightsObjectiveState) state = input.insightsObjectiveState;
          return makeObjectiveChatRow(state, { activeBranchId: "branch_switched", objectiveEnabled: true });
        },
      },
      messages: { getMessages: async () => [] },
    });
    const sessionRuntime = makeSessionRuntime({
      chatLifecycle: {
        buildPipelineContext: async (input) => {
          if (input.branchId) contextBranchIds.push(input.branchId);
          return { context };
        },
      },
    });
    let executeCalls = 0;
    const eventCountsAtExecution: number[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const execute: Execute = async () => {
      executeCalls += 1;
      eventCountsAtExecution.push(state.autoCheckEventCount);
      if (executeCalls === 1) {
        markFirstStarted?.();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return execResult('{"completed":false}');
    };
    const providerProfiles = strictTestDouble<ProviderProfileService>(
      { resolveActiveProviderProfile: async () => makeProviderProfileRow({ id: "profile_1", defaultModel: "model_1" }) },
      "ProviderProfileService (event coalescing)",
    );
    const service = new ObjectiveService(stores, sessionRuntime, providerProfiles, execute, async () => "BASE");

    const first = service.triggerAutoCheck(trigger("branch_a", "message_a"));
    await firstStarted;
    await service.triggerAutoCheck(trigger("branch_b", "message_b"));
    await service.triggerAutoCheck(trigger("branch_c", "message_c"));
    let joined = false;
    const joining = service.waitForForwardState(brandId<ChatId>("chat_1")).then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);

    releaseFirst?.();
    await Promise.all([first, joining]);

    expect(joined).toBe(true);
    expect(contextBranchIds).toEqual(["branch_a", "branch_c"]);
    expect(executeCalls).toBe(2);
    expect(eventCountsAtExecution).toEqual([1, 2]);
    expect(state.autoCheckEventCount).toBe(0);
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
    const providerProfiles = strictTestDouble<ProviderProfileService>(
      {
        resolveActiveProviderProfile: async () => {
          activeCalls += 1;
          return makeProviderProfileRow({ id: "prof_active", defaultModel: "chat-model" });
        },
        getProviderProfile: async () => {
          pinnedCalls += 1;
          return makeProviderProfileRow({ id: "prof_pinned", defaultModel: "secondary-default" });
        },
      },
      "ProviderProfileService (secondary-pin ignored)",
    );
    const service = new ObjectiveService({} as StoreContainer, unusedObjectiveDeps, providerProfiles, async () => execResult(""), async () => "");

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
    const providerProfiles = strictTestDouble<ProviderProfileService>(
      {
        resolveActiveProviderProfile: async () => {
          activeCalls += 1;
          return makeProviderProfileRow({ id: "prof_active", defaultModel: "chat-model" });
        },
        getProviderProfile: async (id) => {
          pinnedCalls += 1;
          expect(id).toBe("prof_pinned");
          return makeProviderProfileRow({ id, defaultModel: "provider-default" });
        },
      },
      "ProviderProfileService (separate pin)",
    );
    const service = new ObjectiveService({} as StoreContainer, unusedObjectiveDeps, providerProfiles, async () => execResult(""), async () => "");

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

describe("ObjectiveService — goals mode (OGM)", () => {
  it("parseGoalsResult parses one long-term + a short-term list, all pending", () => {
    const parsed = parseGoalsResult('{"longTerm":{"description":"Liberate the city"},"shortTerm":[{"description":"Reach the gates"},{"description":"Bribe the guard"}]}');
    expect(parsed.longTermGoal).toEqual({ description: "Liberate the city", status: OBJECTIVE_TASK_STATUS.pending });
    expect(parsed.shortTermGoals).toEqual([
      { id: "obj_st_1", description: "Reach the gates", status: OBJECTIVE_TASK_STATUS.pending },
      { id: "obj_st_2", description: "Bribe the guard", status: OBJECTIVE_TASK_STATUS.pending },
    ]);
  });

  it("parseGoalsResult rejects malformed goals JSON", () => {
    expect(() => parseGoalsResult('{"longTerm":{"description":"x"}}')).toThrow(); // missing shortTerm
    expect(() => parseGoalsResult("nope")).toThrow();
  });

  it("generateTasks (goals) auto-activates the first short-term, sets the long-term pending, and requests the goals prompt", async () => {
    const initial: ObjectiveState = { ...defaultObjectiveState(), mode: OBJECTIVE_MODE.goals };
    const { stores } = makeMockStates(initial);
    let resolvedKey = "";
    const execute: Execute = async () => execResult('{"longTerm":{"description":"Free the city"},"shortTerm":[{"description":"Reach gates"},{"description":"Find ally"}]}');
    const resolvePrompt: ResolvePrompt = async (key) => { resolvedKey = key; return "GOAL-BASE"; };
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, resolvePrompt);

    const state = await service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    expect(resolvedKey).toBe("objectiveGenerateGoals");
    expect(state.mode).toBe(OBJECTIVE_MODE.goals);
    expect(state.longTermGoal).toEqual({ description: "Free the city", status: OBJECTIVE_TASK_STATUS.pending });
    expect(state.shortTermGoals.map((g) => [g.description, g.status])).toEqual([
      ["Reach gates", OBJECTIVE_TASK_STATUS.active],
      ["Find ally", OBJECTIVE_TASK_STATUS.pending],
    ]);
  });

  it("generateTasks (goals) discards a stale result when the goals are edited mid-flight", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      mode: OBJECTIVE_MODE.goals,
      longTermGoal: { description: "Keep", status: OBJECTIVE_TASK_STATUS.pending },
      shortTermGoals: [{ id: "g1", description: "Old", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores, readState } = makeMockStores(initial);
    let releaseExecute: ((value: GenerationResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute: Execute = async () => new Promise<GenerationResult>((resolve) => { releaseExecute = resolve; markStarted?.(); });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");

    const pending = service.generateTasks({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await started;
    await service.addShortTermGoal(brandId<ChatId>("chat_1"), "User-added goal");
    releaseExecute?.(execResult('{"longTerm":{"description":"Stale"},"shortTerm":[{"description":"x"}]}'));

    const result = await pending;
    // Stale generation discarded (goalsRevision changed); the user's edit survives.
    expect(result.shortTermGoals.some((g) => g.description === "User-added goal")).toBe(true);
    expect(result.longTermGoal?.description).toBe("Keep");
    expect(readState().shortTermGoals).toHaveLength(2);
  });

  it("checkCompletion (goals) completes the selected short-term; the long-term is never auto-checked", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      mode: OBJECTIVE_MODE.goals,
      longTermGoal: { description: "Free the city", status: OBJECTIVE_TASK_STATUS.pending },
      shortTermGoals: [
        { id: "g1", description: "Reach gates", status: OBJECTIVE_TASK_STATUS.active },
        { id: "g2", description: "Find ally", status: OBJECTIVE_TASK_STATUS.pending },
      ],
    };
    const { stores } = makeMockStates(initial);
    const { service } = serviceWith(stores, '{"completed":true}');
    const state = await service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    expect(state.shortTermGoals.find((g) => g.id === "g1")?.status).toBe(OBJECTIVE_TASK_STATUS.completed);
    expect(state.longTermGoal?.status).toBe(OBJECTIVE_TASK_STATUS.pending);
    expect(state.shortTermGoals.find((g) => g.id === "g2")?.status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("checkCompletion (goals) discards its verdict when the mode switches during the LLM await", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      mode: OBJECTIVE_MODE.goals,
      longTermGoal: { description: "Free the city", status: OBJECTIVE_TASK_STATUS.pending },
      shortTermGoals: [{ id: "g1", description: "Reach gates", status: OBJECTIVE_TASK_STATUS.active }],
    };
    const { stores } = makeMockStates(initial);
    let releaseExecute: ((value: GenerationResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const execute: Execute = async () => new Promise<GenerationResult>((resolve) => { releaseExecute = resolve; markStarted?.(); });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");

    const checking = service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    await started;
    await service.setObjectiveMode(brandId<ChatId>("chat_1"), OBJECTIVE_MODE.route);
    releaseExecute?.(execResult('{"completed":true}'));
    const state = await checking;

    expect(state.mode).toBe(OBJECTIVE_MODE.route);
    expect(state.shortTermGoals[0]?.status).toBe(OBJECTIVE_TASK_STATUS.active);
  });

  it("checkCompletion (goals) is a no-op when no short-term is active/pending", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      mode: OBJECTIVE_MODE.goals,
      longTermGoal: { description: "Done arc", status: OBJECTIVE_TASK_STATUS.completed },
      shortTermGoals: [{ id: "g1", description: "Only", status: OBJECTIVE_TASK_STATUS.completed }],
    };
    const { stores } = makeMockStates(initial);
    let executed = false;
    const execute: Execute = async () => { executed = true; return execResult('{"completed":true}'); };
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");
    const state = await service.checkCompletion({ chatId: brandId<ChatId>("chat_1"), profile, model: "m", context });
    expect(executed).toBe(false);
    expect(state.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.completed);
  });

  it("setObjectiveMode switches modes and preserves the other mode's data", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      mode: OBJECTIVE_MODE.route,
      objectiveDescription: "Route goal",
      tasks: [{ id: "t1", description: "Route task", status: OBJECTIVE_TASK_STATUS.pending }],
    };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""), async () => "BASE");
    const goals = await service.setObjectiveMode(brandId<ChatId>("chat_1"), OBJECTIVE_MODE.goals);
    expect(goals.mode).toBe(OBJECTIVE_MODE.goals);
    expect(goals.tasks).toHaveLength(1); // route data preserved across the switch
    const back = await service.setObjectiveMode(brandId<ChatId>("chat_1"), OBJECTIVE_MODE.route);
    expect(back.mode).toBe(OBJECTIVE_MODE.route);
    expect(back.tasks[0].description).toBe("Route task");
  });

  it("updateLongTermGoal creates (pending) then cycles status", async () => {
    const initial: ObjectiveState = { ...defaultObjectiveState(), mode: OBJECTIVE_MODE.goals };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""), async () => "BASE");
    const created = await service.updateLongTermGoal(brandId<ChatId>("chat_1"), { description: "Liberate the city" });
    expect(created.longTermGoal).toEqual({ description: "Liberate the city", status: OBJECTIVE_TASK_STATUS.pending });
    const done = await service.updateLongTermGoal(brandId<ChatId>("chat_1"), { status: OBJECTIVE_TASK_STATUS.completed });
    expect(done.longTermGoal).toEqual({ description: "Liberate the city", status: OBJECTIVE_TASK_STATUS.completed });
  });

  it("updateLongTermGoal rejects an empty description and an unknown status", async () => {
    const initial: ObjectiveState = { ...defaultObjectiveState(), mode: OBJECTIVE_MODE.goals };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""), async () => "BASE");
    await expect(service.updateLongTermGoal(brandId<ChatId>("chat_1"), { description: "   " })).rejects.toThrow();
    // "bogus" is deliberately outside ObjectiveTaskStatus — the runtime status
    // guard (isObjectiveTaskStatus) is what this pins; the narrow cast is the
    // fixture seam for out-of-domain input (agent-kind-registry.test.ts:190 idiom).
    await expect(service.updateLongTermGoal(brandId<ChatId>("chat_1"), { status: "bogus" as ObjectiveTaskStatus })).rejects.toThrow();
  });

  it("addShortTermGoal / updateShortTermGoal / deleteShortTermGoal round-trip", async () => {
    const initial: ObjectiveState = { ...defaultObjectiveState(), mode: OBJECTIVE_MODE.goals };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""), async () => "BASE");
    const added = await service.addShortTermGoal(brandId<ChatId>("chat_1"), "Reach the gates");
    const id = added.shortTermGoals[0].id;
    expect(added.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
    const updated = await service.updateShortTermGoal(brandId<ChatId>("chat_1"), id, { description: "Reach the gates at dawn" });
    expect(updated.shortTermGoals[0].description).toBe("Reach the gates at dawn");
    const deleted = await service.deleteShortTermGoal(brandId<ChatId>("chat_1"), id);
    expect(deleted.shortTermGoals).toHaveLength(0);
    await expect(service.updateShortTermGoal(brandId<ChatId>("chat_1"), id, { description: "x" })).rejects.toThrow();
  });

  it("selectShortTermGoal sets exactly one short-term active (demotes the previous active)", async () => {
    const initial: ObjectiveState = {
      ...defaultObjectiveState(),
      mode: OBJECTIVE_MODE.goals,
      shortTermGoals: [
        { id: "g1", description: "A", status: OBJECTIVE_TASK_STATUS.active },
        { id: "g2", description: "B", status: OBJECTIVE_TASK_STATUS.pending },
      ],
    };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""), async () => "BASE");
    const state = await service.selectShortTermGoal(brandId<ChatId>("chat_1"), "g2");
    expect(state.shortTermGoals.find((g) => g.id === "g2")?.status).toBe(OBJECTIVE_TASK_STATUS.active);
    expect(state.shortTermGoals.find((g) => g.id === "g1")?.status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("getState backfills goals defaults, defaults absent mode to route, and collapses duplicate actives", async () => {
    const { stores } = makeMockStores({
      // legacy blob: no mode/goals fields; duplicate actives must collapse to one each.
      tasks: [{ id: "t1", description: "T", status: "active" }, { id: "t2", description: "T2", status: "active" }],
      shortTermGoals: [{ id: "s1", description: "S", status: "active" }, { id: "s2", description: "S2", status: "active" }],
    });
    const service = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps, async () => execResult(""), async () => "BASE");
    const state = await service.getState(brandId<ChatId>("chat_1"));
    expect(state.mode).toBe(OBJECTIVE_MODE.route); // absent → route
    expect(state.longTermGoal).toBeNull();
    expect(state.shortTermGoals).toHaveLength(2);
    expect(state.shortTermGoals.filter((g) => g.status === OBJECTIVE_TASK_STATUS.active)).toHaveLength(1);
    expect(state.shortTermGoals[0].status).toBe(OBJECTIVE_TASK_STATUS.active);
    expect(state.tasks.filter((t) => t.status === OBJECTIVE_TASK_STATUS.active)).toHaveLength(1);
  });
});

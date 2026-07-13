/**
 * ObjectiveService (INSIGHTS_PLAN INS-3b).
 *
 * Two layers of coverage:
 *  1. The PURE helpers (parseTaskList, parseCheckVerdict, selectActiveTask,
 *     advanceAfterCompletion, withObjectiveInstructionAsFinalUserMessage) — the
 *     parse / select / advance logic, no DB, no LLM.
 *  2. The SERVICE end-to-end via the injected `execute` (DI, per AGENTS.md §1.4 —
 *     the dep is injected, NOT mocked globally): generateTasks → tree;
 *     getActiveTask → first pending; checkCompletion advances; CRUD round-trips.
 *
 * The store is a tiny stub (getById + updateInsightsObjectiveState) — the
 * service only touches those two chat-store methods.
 */
import { describe, it, expect } from "bun:test";
import type { AssemblePromptResponse, ObjectiveState } from "@vibe-tavern/domain";
import { OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import {
  ObjectiveService,
  parseTaskList,
  parseCheckVerdict,
  selectActiveTask,
  advanceAfterCompletion,
  withObjectiveInstructionAsFinalUserMessage,
} from "../src/domain/insights/objective-service.js";

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

describe("withObjectiveInstructionAsFinalUserMessage (INS-3b)", () => {
  it("appends the instruction as the final user message, preserving prior messages", () => {
    const prompt = { finalPayload: { messages: [{ role: "system", content: "ctx" }] } } as unknown as AssemblePromptResponse;
    const out = withObjectiveInstructionAsFinalUserMessage(prompt, "Do the thing.");
    const messages = (out.finalPayload as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "ctx" });
    expect(messages[1]).toEqual({ role: "user", content: "Do the thing.", layerId: "objective_instruction" });
  });
});

// ─── service (DI execute) ───────────────────────────────────────────────────

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

const contextPrompt = { finalPayload: { messages: [{ role: "system", content: "Recent RP context." }] } } as unknown as AssemblePromptResponse;
const profile = {} as never; // fake execute ignores it

function serviceWith(stores: StoreContainer, reply: string) {
  const execute = async () => ({ text: reply }) as never; // service only reads result.text
  return new ObjectiveService(stores, execute as never);
}

describe("ObjectiveService (INS-3b)", () => {
  it("generateTasks parses the LLM list into a pending route, then getActiveTask returns the first", async () => {
    const { stores, readState } = makeMockStores({ objectiveDescription: "Defeat the warlord", tasks: [], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" });
    const service = serviceWith(stores, "1. Reach the city gates\n2. Confront the warlord\n3. End the siege");

    const state = await service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", contextPrompt });
    expect(state.tasks.map((t) => t.description)).toEqual(["Reach the city gates", "Confront the warlord", "End the siege"]);
    expect(state.objectiveDescription).toBe("Defeat the warlord"); // preserved
    expect((await service.getActiveTask("chat_1" as never))?.description).toBe("Reach the city gates");

    // Persisted: readState reflects the saved tasks.
    expect((readState() as ObjectiveState).tasks).toHaveLength(3);
  });

  it("generateTasks throws when the LLM produces no parseable tasks", async () => {
    const { stores } = makeMockStores();
    const service = serviceWith(stores, "I cannot help with that.");
    await expect(service.generateTasks({ chatId: "chat_1" as never, profile, model: "m", contextPrompt })).rejects.toThrow();
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
    const service = serviceWith(stores, "DONE");

    const after = await service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", contextPrompt });
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
    const service = serviceWith(stores, "PENDING");

    const after = await service.checkCompletion({ chatId: "chat_1" as never, profile, model: "m", contextPrompt });
    expect(after.tasks[0].status).toBe(OBJECTIVE_TASK_STATUS.pending);
  });

  it("CRUD: addTask appends pending; updateTask patches; deleteTask removes; unknown id throws", async () => {
    const initial: ObjectiveState = { objectiveDescription: "x", tasks: [{ id: "t1", description: "first", status: OBJECTIVE_TASK_STATUS.pending }], autoCheckFrequency: 0, injectionDepth: 1, generatePrompt: "", checkPrompt: "", injectPrompt: "" };
    const { stores } = makeMockStates(initial);
    const service = new ObjectiveService(stores, async () => ({ text: "" }) as never);

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
    const service = new ObjectiveService(stores, async () => ({ text: "" }) as never);
    const state = await service.setObjectiveDescription("chat_1" as never, "Survive the winter");
    expect(state.objectiveDescription).toBe("Survive the winter");
  });
});

// Variant of makeMockStores that takes a typed ObjectiveState (non-null).
function makeMockStates(initial: ObjectiveState): { stores: StoreContainer } {
  return { stores: makeMockStores(initial as unknown as Record<string, unknown>).stores };
}

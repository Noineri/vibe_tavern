/**
 * Objective Tracker prompt-layer emission (INSIGHTS_PLAN INS-3).
 *
 * Pins that `assemblePrompt` emits exactly ONE `objective_task` layer at
 * priority 180, position `in_chat`, with `injectionDepth` from the context,
 * and the active-task text formatted via PROMPT_FORMAT.objectiveTask — and that
 * it emits NOTHING when `context.objectiveTask` is null/undefined (objective off
 * or no active task → zero added tokens). Pure pipeline test: no DB, no LLM.
 */
import { describe, it, expect } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";

function baseContext(overrides = {}) {
  return {
    identity: { chatId: "chat_1" },
    chat: {
      recentMessages: [
        { id: "msg_1", role: "user", content: "Hello." },
        { id: "msg_2", role: "assistant", content: "Hi there." },
      ],
    },
    character: {
      id: "char_1",
      name: "Aria",
      description: "A fire mage.",
      scenario: "The tower burns.",
      systemPrompt: null,
    },
    ...overrides,
  };
}

describe("assemblePrompt — objective_task layer (INS-3)", () => {
  it("emits the objective_task layer when context.objectiveTask is present", () => {
    const result = assemblePrompt(
      baseContext({
        objectiveTask: { description: "Reach the burning tower", injectPrompt: "", injectionDepth: 1 },
      }),
    );
    const layer = result.layers.find((l) => l.id === "objective_task");
    expect(layer).toBeDefined();
    expect(layer!.sourceType).toBe("objective_task");
    expect(layer!.position).toBe("in_chat");
    expect(layer!.injectionDepth).toBe(1);
    expect(layer!.text).toBe("[Active objective] Reach the burning tower");
  });

  it("uses the custom injectPrompt as the framing lead when provided", () => {
    const result = assemblePrompt(
      baseContext({
        objectiveTask: {
          description: "Reach the burning tower",
          injectPrompt: "Pursue the current objective with focus.",
          injectionDepth: 1,
        },
      }),
    );
    const layer = result.layers.find((l) => l.id === "objective_task");
    expect(layer!.text).toBe("Pursue the current objective with focus.\n[Active objective] Reach the burning tower");
  });

  it("respects injectionDepth > 1 (depth N = N messages from the end)", () => {
    const result = assemblePrompt(
      baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "Turn 1 user." },
            { id: "msg_2", role: "assistant", content: "Turn 2 assistant." },
            { id: "msg_3", role: "user", content: "Turn 3 user." },
            { id: "msg_4", role: "assistant", content: "Turn 4 assistant." },
          ],
        },
        objectiveTask: { description: "Climb the wall", injectPrompt: "", injectionDepth: 3 },
      }),
    );
    const layer = result.layers.find((l) => l.id === "objective_task");
    expect(layer!.injectionDepth).toBe(3);

    const msgs = result.finalPayload.messages as Array<{ role: string; content: string }>;
    const objIdx = msgs.findIndex((m) => m.content === "[Active objective] Climb the wall");
    expect(objIdx).toBeGreaterThan(0);
    expect(msgs[objIdx - 1]).toMatchObject({ role: "user", content: "Turn 1 user." });
    expect(msgs.slice(objIdx + 1).map((m) => m.content)).toEqual([
      "Turn 2 assistant.",
      "Turn 3 user.",
      "Turn 4 assistant.",
    ]);
  });

  it("emits the long-term goal just above the active objective in goals mode", () => {
    const result = assemblePrompt(
      baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "Turn 1 user." },
            { id: "msg_2", role: "assistant", content: "Turn 2 assistant." },
            { id: "msg_3", role: "user", content: "Turn 3 user." },
            { id: "msg_4", role: "assistant", content: "Turn 4 assistant." },
          ],
        },
        preset: {
          id: "preset_1",
          text: "System.",
          advancedMode: true,
          mergeConsecutiveRoles: false,
        },
        objectiveLongTerm: { description: "Free the city", injectPrompt: "Remember the arc.", injectionDepth: 2 },
        objectiveTask: { description: "Reach the gate", injectPrompt: "", injectionDepth: 2 },
      }),
    );
    const longTerm = result.layers.find((layer) => layer.id === "objective_long_term");
    const active = result.layers.find((layer) => layer.id === "objective_task");
    expect(longTerm).toMatchObject({ sourceType: "objective_long_term", position: "in_chat", priority: 178, injectionDepth: 2 });
    expect(longTerm?.text).toBe("Remember the arc.\n[Long-term goal] Free the city");
    expect(active).toMatchObject({ priority: 180, injectionDepth: 2 });
    expect(result.layers.filter((layer) => layer.id === "objective_long_term")).toHaveLength(1);

    const msgs = result.finalPayload.messages as Array<{ role: string; content: string }>;
    const longTermIdx = msgs.findIndex((m) => m.content === "Remember the arc.\n[Long-term goal] Free the city");
    const activeIdx = msgs.findIndex((m) => m.content === "[Active objective] Reach the gate");
    expect(longTermIdx).toBeGreaterThan(0);
    expect(activeIdx).toBe(longTermIdx + 1);
    expect(msgs.slice(activeIdx + 1).map((m) => m.content)).toEqual([
      "Turn 3 user.",
      "Turn 4 assistant.",
    ]);
  });

  it("emits no long-term layer when objectiveLongTerm is null/absent", () => {
    expect(assemblePrompt(baseContext({ objectiveLongTerm: null })).layers.find((layer) => layer.id === "objective_long_term")).toBeUndefined();
    expect(assemblePrompt(baseContext()).layers.find((layer) => layer.id === "objective_long_term")).toBeUndefined();
  });

  it("emits NO objective_task layer when context.objectiveTask is null", () => {
    const result = assemblePrompt(baseContext({ objectiveTask: null }));
    expect(result.layers.find((l) => l.id === "objective_task")).toBeUndefined();
  });

  it("emits NO objective_task layer when context.objectiveTask is absent (objective off / no active task)", () => {
    const result = assemblePrompt(baseContext());
    expect(result.layers.find((l) => l.id === "objective_task")).toBeUndefined();
  });

  it("emits exactly one objective_task layer (no duplication)", () => {
    const result = assemblePrompt(
      baseContext({
        objectiveTask: { description: "Solo task", injectPrompt: "", injectionDepth: 1 },
      }),
    );
    expect(result.layers.filter((l) => l.id === "objective_task")).toHaveLength(1);
  });
});

/**
 * Request-local one-shot instruction layer (director message tools DMT-12).
 *
 * Pins that `assemblePrompt` turns `context.requestInstruction` into exactly
 * ONE `user` `in_chat` layer at depth 1 carrying the approved literal text —
 * budgeted by the history-compaction planner (never free-floating), ordered
 * after same-depth steering injections, merged only by the ordinary final
 * role-merging (with layer attribution retained), identical across
 * simple/advanced presets — and that the NEXT assembly without the input
 * contains no trace of it (request-local lifetime), while the summary entry
 * point can never inherit it either. Pure pipeline test: no DB, no LLM.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { assemblePrompt, assembleSummaryPrompt } from "../src/assemble.ts";
import { setSeparatorSideFn, setTokenCountFn } from "../src/compaction.ts";

const INSTRUCTION = "Keep the reply under three sentences and avoid the cellar scene.";

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    identity: { chatId: "chat_1" },
    character: {
      id: "char_1",
      name: "Aria",
      description: "A fire mage.",
      systemPrompt: null,
    },
    chat: {
      recentMessages: [
        { id: "msg_1", role: "user", content: "Hello." },
        { id: "msg_2", role: "assistant", content: "Hi there." },
        { id: "msg_3", role: "user", content: "What is behind the door?" },
        { id: "msg_4", role: "assistant", content: "The door creaks open." },
      ],
    },
    ...overrides,
  };
}

/** Advanced-mode preset without role merging: every layer stays a separate
 *  payload message, so payload placement can be asserted positionally. */
function advancedNoMerge() {
  return { id: "preset_1", text: "RP system prompt.", advancedMode: true, mergeConsecutiveRoles: false };
}

beforeEach(() => {
  // Deterministic, tokenizer-free accounting (length = tokens) and a neutral
  // separator-side answer so compaction arithmetic is exact in this file.
  setTokenCountFn((text) => text.length);
  setSeparatorSideFn(null);
});

describe("assemblePrompt — request_instruction layer (DMT-12)", () => {
  it("emits exactly one user layer at depth 1 carrying the literal approved text", () => {
    const result = assemblePrompt(baseContext({ requestInstruction: INSTRUCTION }));
    const matches = result.layers.filter((layer) => layer.id === "request_instruction");
    expect(matches).toHaveLength(1);
    const layer = matches[0]!;
    expect(layer.sourceType).toBe("request_instruction");
    expect(layer.sourceId).toBe("chat_1");
    expect(layer.sourceName).toBe("Request Instruction");
    expect(layer.position).toBe("in_chat");
    expect(layer.injectionDepth).toBe(1);
    expect(layer.role).toBe("user");
    expect(layer.enabled).toBe(true);
    expect(layer.priority).toBe(190);
    // The approved literal — no wrapper label, no rewrite.
    expect(layer.text).toBe(INSTRUCTION);
    expect(layer.tokenCount).toBe(INSTRUCTION.length);
  });

  it("emits no layer for a blank or whitespace-only instruction", () => {
    const blank = assemblePrompt(baseContext({ requestInstruction: "   " }));
    expect(blank.layers.find((layer) => layer.id === "request_instruction")).toBeUndefined();
    const absent = assemblePrompt(baseContext({ requestInstruction: null }));
    expect(absent.layers.find((layer) => layer.id === "request_instruction")).toBeUndefined();
  });

  it("places the instruction one message from the end of the provider payload", () => {
    const result = assemblePrompt(
      baseContext({ preset: advancedNoMerge(), requestInstruction: INSTRUCTION }),
    );
    const messages = result.finalPayload.messages;
    const index = messages.findIndex((message) => message.layerId === "request_instruction");
    expect(index).toBeGreaterThan(-1);
    expect(messages[index]).toMatchObject({ role: "user", content: INSTRUCTION });
    // Depth 1: between the last two history messages — right before the reply
    // being regenerated.
    expect(messages[index - 1]).toMatchObject({ messageId: "msg_3" });
    expect(messages[index + 1]).toMatchObject({ messageId: "msg_4" });
  });

  it("clamps depth 1 onto an empty history (instruction becomes the only chat message)", () => {
    const result = assemblePrompt(
      baseContext({
        chat: { recentMessages: [] },
        preset: advancedNoMerge(),
        requestInstruction: INSTRUCTION,
      }),
    );
    expect(result.layers.find((layer) => layer.id === "recent_history")).toBeUndefined();
    const messages = result.finalPayload.messages;
    const index = messages.findIndex((message) => message.layerId === "request_instruction");
    expect(index).toBe(messages.length - 1);
    expect(messages[index]).toMatchObject({ role: "user", content: INSTRUCTION });
  });

  it("clamps depth 1 onto a single-message history (instruction lands BEFORE that message)", () => {
    const result = assemblePrompt(
      baseContext({
        chat: { recentMessages: [{ id: "msg_1", role: "user", content: "Only turn." }] },
        preset: advancedNoMerge(),
        requestInstruction: INSTRUCTION,
      }),
    );
    const messages = result.finalPayload.messages;
    const index = messages.findIndex((message) => message.layerId === "request_instruction");
    expect(index).toBeGreaterThan(-1);
    expect(messages[index]).toMatchObject({ role: "user", content: INSTRUCTION });
    expect(messages[index + 1]).toMatchObject({ messageId: "msg_1", role: "user" });
  });

  it("is identical across no-preset, simple and advanced presets", () => {
    const simplePreset = { id: "preset_1", text: "RP system prompt." };
    const advancedPreset = { id: "preset_1", text: "RP system prompt.", advancedMode: true };
    const expected = {
      sourceType: "request_instruction",
      sourceId: "chat_1",
      sourceName: "Request Instruction",
      position: "in_chat",
      injectionDepth: 1,
      role: "user",
      priority: 190,
      text: INSTRUCTION,
    };
    for (const preset of [undefined, simplePreset, advancedPreset]) {
      const result = assemblePrompt(baseContext({ preset, requestInstruction: INSTRUCTION }));
      const layer = result.layers.find((candidate) => candidate.id === "request_instruction");
      expect(layer).toMatchObject(expected);
    }
  });

  it("participates in the token budget: its tokens compact history instead of riding free", () => {
    // Length tokenizer + uniform 50-char messages: full history pieces are
    // "USER: AAA…" (56) and "ASSISTANT: AAA…" (61), joined with "\n\n".
    const longHistory = Array.from({ length: 6 }, (_, index) => ({
      id: `msg_${index + 1}`,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "A".repeat(50),
    }));
    const budgetInstruction = "Shorten your next reply."; // 24 tokens under the length counter
    const without = assemblePrompt(
      baseContext({ chat: { recentMessages: longHistory }, config: { contextBudget: 400 } }),
    );
    const withLayer = assemblePrompt(
      baseContext({
        chat: { recentMessages: longHistory },
        config: { contextBudget: 400 },
        requestInstruction: budgetInstruction,
      }),
    );
    // Without the instruction all six messages fit (non-history 28 + history 361 = 389 ≤ 400).
    expect(without.compactionSummary).toBeNull();
    // With it the instruction's 24 tokens (28 + 24 + 303 = 355) push the oldest
    // message out of the budget: the layer cost is paid by history, not added
    // on top.
    expect(withLayer.compactionSummary).toContain("Kept 5 of 6");
    const historyTokens = (result: ReturnType<typeof assemblePrompt>) =>
      result.layers.find((layer) => layer.id === "recent_history")!.tokenCount;
    expect(historyTokens(without)).toBe(361);
    expect(historyTokens(withLayer)).toBe(303);
    expect(without.totalTokenEstimate).toBe(389);
    expect(withLayer.totalTokenEstimate).toBe(355);
  });

  it("coexists with same-depth steering injections and deeper ordering rules", () => {
    const result = assemblePrompt(
      baseContext({
        preset: advancedNoMerge(),
        objectiveTask: { description: "Fight the dragon", injectPrompt: "", injectionDepth: 1 },
        chat: {
          recentMessages: baseContext().chat.recentMessages,
          scriptInjections: [{ content: "Script note", role: "system" }],
        },
        requestInstruction: INSTRUCTION,
      }),
    );
    // Layer level: both depth-1 injections declared, plus the depth-0 script one.
    expect(result.layers.find((layer) => layer.id === "objective_task")).toMatchObject({ injectionDepth: 1 });
    expect(result.layers.find((layer) => layer.id === "request_instruction")).toMatchObject({ injectionDepth: 1, role: "user" });
    expect(result.layers.find((layer) => layer.id === "script_injection_0")).toMatchObject({ injectionDepth: 0 });
    // Payload level: scene/objective steering first, then the instruction
    // (closest to the regenerated reply), then history tail, then the depth-0
    // script injection as the very last message.
    const messages = result.finalPayload.messages;
    const objectiveIndex = messages.findIndex((message) => message.layerId === "objective_task");
    const instructionIndex = messages.findIndex((message) => message.layerId === "request_instruction");
    const targetIndex = messages.findIndex((message) => message.messageId === "msg_4");
    const scriptIndex = messages.findIndex((message) => message.layerId === "script_injection_0");
    expect(objectiveIndex).toBeLessThan(instructionIndex);
    expect(instructionIndex).toBe(targetIndex - 1);
    expect(targetIndex).toBeLessThan(scriptIndex);
    expect(scriptIndex).toBe(messages.length - 1);
  });

  it("survives the ordinary simple-mode role merge while keeping layer attribution", () => {
    // Simple mode merges same-role messages unconditionally. Depth 1 puts the
    // user-role instruction right before the trailing user message, so the
    // squash absorbs the history message INTO the instruction message — the
    // merged message keeps the layer id and records what it absorbed.
    const result = assemblePrompt(
      baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "First." },
            { id: "msg_2", role: "assistant", content: "Second." },
            { id: "msg_3", role: "user", content: "Third." },
          ],
        },
        requestInstruction: INSTRUCTION,
      }),
    );
    const messages = result.finalPayload.messages;
    const merged = messages[messages.length - 1];
    expect(merged).toMatchObject({
      role: "user",
      layerId: "request_instruction",
      content: `${INSTRUCTION}\n\nThird.`,
    });
    expect(merged!.mergedFrom).toEqual([{ messageId: "msg_3" }]);
    // The assistant reply right before it is untouched.
    expect(messages[messages.length - 2]).toMatchObject({ role: "assistant", messageId: "msg_2" });
  });

  it("leaves no trace on the next assembly without the input (request-local lifetime)", () => {
    const armed = assemblePrompt(baseContext({ requestInstruction: INSTRUCTION }));
    expect(armed.layers.some((layer) => layer.id === "request_instruction")).toBe(true);
    const disarmed = assemblePrompt(baseContext());
    const pristine = assemblePrompt(baseContext());
    expect(disarmed.layers.some((layer) => layer.id === "request_instruction")).toBe(false);
    expect(JSON.stringify(disarmed.finalPayload)).not.toContain(INSTRUCTION);
    // Byte-identical output to an assembly that never saw the field.
    expect(JSON.stringify(disarmed)).toBe(JSON.stringify(pristine));
  });

  it("resolves macros exactly as an ordinary chat message would", () => {
    const result = assemblePrompt(baseContext({ requestInstruction: "Reply as {{char}} quietly." }));
    const layer = result.layers.find((candidate) => candidate.id === "request_instruction");
    expect(layer!.text).toBe("Reply as Aria quietly.");
  });

  it("never reaches the summary entry point (summaries do not inherit the instruction)", () => {
    const summary = assembleSummaryPrompt(baseContext({ requestInstruction: INSTRUCTION }));
    expect(summary.layers.some((layer) => layer.id === "request_instruction")).toBe(false);
    expect(JSON.stringify(summary.finalPayload)).not.toContain(INSTRUCTION);
  });
});

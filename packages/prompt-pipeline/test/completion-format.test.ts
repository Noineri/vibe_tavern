/**
 * Generation-format threading through assembly (LOCAL_SUPPORT_PLAN LS-3b):
 * the preset's `generationFormat` rides the assembly result as
 * `completionFormat` — exported like `prefill` so the orchestrator can thread
 * it to the TC completion seam. Absent preset / absent field → null (auto).
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";
import { setTokenCountFn } from "../src/compaction.ts";
import type { PromptAssemblyContext } from "../src/types.ts";
import type { GenerationFormat } from "@vibe-tavern/domain";

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

const MANUAL_FORMAT: GenerationFormat = {
  mode: "manual",
  inputSequence: "<|im_start|>user",
  outputSequence: "<|im_start|>assistant",
  wrap: true,
};

describe("assemblePrompt — completionFormat threading (LS-3b)", () => {
  beforeAll(() => setTokenCountFn((text: string) => text.length));

  it("a preset generationFormat rides the result as completionFormat", () => {
    const result = assemblePrompt(baseContext({
      preset: { id: "preset_1", text: "System.", generationFormat: MANUAL_FORMAT },
    }));
    expect(result.completionFormat).toEqual(MANUAL_FORMAT);
  });

  it("no preset (or no format field) → null (auto)", () => {
    const noPreset = assemblePrompt(baseContext());
    expect(noPreset.completionFormat).toBeNull();

    const plainPreset = assemblePrompt(baseContext({
      preset: { id: "preset_1", text: "System." },
    }));
    expect(plainPreset.completionFormat).toBeNull();
  });

  it("an auto-mode format passes through unchanged (the manual fields are ignored downstream)", () => {
    const auto: GenerationFormat = { mode: "auto", inputSequence: "U:" };
    const result = assemblePrompt(baseContext({
      preset: { id: "preset_1", text: "System.", generationFormat: auto },
    }));
    expect(result.completionFormat).toEqual(auto);
  });
});

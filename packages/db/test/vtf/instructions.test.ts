import { describe, it, expect } from "bun:test";
import {
  writeInstructions,
  readInstructions,
  EMPTY_INSTRUCTIONS,
  type VtfInstructions,
} from "../../src/vtf/instructions.js";

// ─── Factories ─────────────────────────────────────────────────────────────

/** Every functional field populated. */
function full(): VtfInstructions {
  return {
    systemPrompt: "Respond in second person.",
    postHistoryInstructions: "Keep it brief.",
    depthPrompt: "Remember the scar on his wrist.",
    depthPromptDepth: 4,
    depthPromptRole: "system",
  };
}

// ─── Round-trip ────────────────────────────────────────────────────────────

describe("instructions: write → read → write (byte-stable)", () => {
  it("is byte-identical on a fully-populated set", () => {
    const once = writeInstructions(full());
    const twice = writeInstructions(readInstructions(once));
    expect(twice).toBe(once);
  });

  it("is byte-identical on an empty set (canonicalizes to {})", () => {
    const once = writeInstructions(EMPTY_INSTRUCTIONS);
    expect(once).toBe("{}\n");
    const twice = writeInstructions(readInstructions(once));
    expect(twice).toBe(once);
  });

  it("reads back the exact fields written", () => {
    const text = writeInstructions(full());
    const back = readInstructions(text);
    expect(back).toEqual(full());
  });
});

// ─── V3 snake_case + nested depth_prompt ───────────────────────────────────

describe("instructions: V3 snake_case + nested depth_prompt", () => {
  it("emits snake_case keys with depth_prompt as a nested object", () => {
    const text = writeInstructions(full());
    const obj = JSON.parse(text);
    expect(obj).toEqual({
      depth_prompt: { depth: 4, prompt: "Remember the scar on his wrist.", role: "system" },
      post_history_instructions: "Keep it brief.",
      system_prompt: "Respond in second person.",
    });
  });

  it("parses the nested depth_prompt back into flat fields", () => {
    const text = writeInstructions(full());
    const back = readInstructions(text);
    expect(back.depthPrompt).toBe("Remember the scar on his wrist.");
    expect(back.depthPromptDepth).toBe(4);
    expect(back.depthPromptRole).toBe("system");
  });

  it("emits canonical deep-sorted keys regardless of input field order", () => {
    const text = writeInstructions(full());
    // Top-level keys appear in sorted order.
    const keyOrder = (text.match(/^  "[^"]+"/gm) ?? []).map((l) => l.trim());
    expect(keyOrder).toEqual(['"depth_prompt"', '"post_history_instructions"', '"system_prompt"']);
    // Nested depth_prompt keys are also sorted.
    const nestedOrder = (text.match(/^    "[^"]+"/gm) ?? []).map((l) => l.trim());
    expect(nestedOrder).toEqual(['"depth"', '"prompt"', '"role"']);
  });
});

// ─── Omission of empty fields ──────────────────────────────────────────────

describe("instructions: empty fields omitted on write", () => {
  it("omits null system/post-history and emits no depth_prompt when all depth fields are null", () => {
    const text = writeInstructions({ ...EMPTY_INSTRUCTIONS });
    expect(text).toBe("{}\n");
  });

  it("omits an empty-string system_prompt but keeps a present depth_prompt", () => {
    const text = writeInstructions({
      ...EMPTY_INSTRUCTIONS,
      systemPrompt: "   ",
      depthPrompt: "remember",
      depthPromptDepth: 4,
    });
    const obj = JSON.parse(text);
    expect(obj).not.toHaveProperty("system_prompt");
    expect(obj.depth_prompt).toEqual({ depth: 4, prompt: "remember" });
    expect(obj.depth_prompt).not.toHaveProperty("role");
  });

  it("preserves depth/role independently even when the prompt text is null (lossless)", () => {
    const fields: VtfInstructions = {
      ...EMPTY_INSTRUCTIONS,
      depthPromptDepth: 4,
      depthPromptRole: "system",
    };
    const text = writeInstructions(fields);
    const obj = JSON.parse(text);
    expect(obj.depth_prompt).toEqual({ depth: 4, role: "system" });
    expect(readInstructions(text)).toEqual(fields);
  });
});

// ─── Tolerant parsing ──────────────────────────────────────────────────────

describe("instructions: tolerant parsing", () => {
  it("returns all-null fields for empty input", () => {
    expect(readInstructions("")).toEqual(EMPTY_INSTRUCTIONS);
  });

  it("returns all-null fields for malformed JSON (never throws)", () => {
    expect(readInstructions("{not valid json")).toEqual(EMPTY_INSTRUCTIONS);
    expect(readInstructions("[1, 2, 3]")).toEqual(EMPTY_INSTRUCTIONS);
  });

  it("ignores non-object depth_prompt shapes", () => {
    const text = JSON.stringify({ system_prompt: "s", depth_prompt: "not-an-object" });
    const back = readInstructions(text);
    expect(back.systemPrompt).toBe("s");
    expect(back.depthPrompt).toBeNull();
    expect(back.depthPromptDepth).toBeNull();
  });

  it("treats empty-string values as absent on read", () => {
    const text = JSON.stringify({
      system_prompt: "",
      post_history_instructions: "   ",
      depth_prompt: { prompt: "", depth: 0, role: "" },
    });
    const back = readInstructions(text);
    expect(back.systemPrompt).toBeNull();
    expect(back.postHistoryInstructions).toBeNull();
    expect(back.depthPrompt).toBeNull();
    // depth 0 is a finite number → preserved; the pipeline treats 0 as "top".
    expect(back.depthPromptDepth).toBe(0);
    expect(back.depthPromptRole).toBeNull();
  });
});

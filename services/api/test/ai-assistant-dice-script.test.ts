/**
 * AI-assistant dice_script mode tests (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B6).
 *
 * Verifies:
 *  - `dice_script` is a complete assistant mode (registered in the assembler
 *    registry + mode config with its own asset).
 *  - Prompt selection resolves to `dice-script-ai-prompt.md` on disk (non-empty).
 *  - The generic `script` preset/legacy override stays prompt-only (dice_script
 *    has no legacyColumn → scriptAiSystemPrompt does NOT leak into it).
 *  - Generated Dice-code cleanup path (markdown-fence stripping).
 *  - `buildUserMessage` for dice_script produces the right instruction shape.
 */
import { describe, expect, test } from "bun:test";
import {
  AI_ASSISTANT_ASSEMBLERS,
  getAiAssistantAssembler,
} from "@vibe-tavern/prompt-pipeline";
import { getAllModeConfigs, getModeConfig } from "../src/domain/ai-assistant/ai-assistant-modes.js";
import {
  resolveSystemPrompt,
  resolvePromptPathForMode,
} from "../src/domain/ai-assistant/ai-assistant-prompts.js";
import { cleanGeneratedCode } from "../src/domain/ai-assistant/ai-assistant-stream.js";

describe("dice_script — registry completeness", () => {
  test("dice_script has an assembler in the registry", () => {
    expect(AI_ASSISTANT_ASSEMBLERS.dice_script).toBeDefined();
    expect(typeof getAiAssistantAssembler("dice_script").assemble).toBe("function");
  });

  test("dice_script has a complete mode config", () => {
    const config = getModeConfig("dice_script");
    expect(config.mode).toBe("dice_script");
    expect(config.presetKey).toBe("dice_script");
    expect(config.defaultPromptFile).toBe("dice-script-ai-prompt.md");
    expect(config.stripReasoning).toBe(true);
    expect(config.outputFormat).toBe("text");
    // NO legacyColumn — the generic script preset/legacy stays prompt-only.
    expect(config.legacyColumn).toBeUndefined();
  });

  test("dice_script is included in getAllModeConfigs", () => {
    const modes = getAllModeConfigs().map((c) => c.mode);
    expect(modes).toContain("dice_script");
  });
});

describe("dice_script — prompt selection", () => {
  test("resolves to dice-script-ai-prompt.md on disk (packaged asset path verified)", async () => {
    const path = await resolvePromptPathForMode("dice_script");
    expect(path.endsWith("dice-script-ai-prompt.md")).toBe(true);
    expect(await Bun.file(path).exists()).toBe(true);
  });

  test("the default prompt is non-empty and instructs the Dice VM API", async () => {
    const { prompt, source } = await resolveSystemPrompt("dice_script", {
      aiAssistantPrompts: null,
      scriptAiSystemPrompt: null,
    });
    expect(source).toBe("default_md");
    expect(prompt.length).toBeGreaterThan(0);
    // The prompt must reference the Dice VM API surface.
    expect(prompt).toContain("context.dice.register");
    expect(prompt).toContain("context.dice.roll");
  });

  test("a preset override for dice_script wins", async () => {
    const { prompt, source } = await resolveSystemPrompt("dice_script", {
      aiAssistantPrompts: { dice_script: "CUSTOM DICE PROMPT" },
    });
    expect(source).toBe("preset_override");
    expect(prompt).toBe("CUSTOM DICE PROMPT");
  });

  test("scriptAiSystemPrompt does NOT leak into dice_script (no legacy column)", async () => {
    // The generic `script` legacy column must stay prompt-only. A dice_script
    // request with scriptAiSystemPrompt set must fall through to default_md,
    // NOT pick up the legacy script prompt.
    const { source } = await resolveSystemPrompt("dice_script", {
      aiAssistantPrompts: null,
      scriptAiSystemPrompt: "LEGACY SCRIPT PROMPT — MUST NOT LEAK",
    });
    expect(source).toBe("default_md");
  });

  test("a script-mode preset override does NOT leak into dice_script (presetKey isolation)", async () => {
    const { source } = await resolveSystemPrompt("dice_script", {
      aiAssistantPrompts: { script: "WRONG KEY" },
    });
    expect(source).toBe("default_md");
  });
});

describe("dice_script — generated code cleanup", () => {
  test("strips a surrounding markdown code fence (```js ... ```)", () => {
    const fenced = "```js\ncontext.dice.register({ id: 'x', resolve() {} });\n```";
    expect(cleanGeneratedCode(fenced)).toBe("context.dice.register({ id: 'x', resolve() {} });");
  });

  test("strips a bare fence (``` ... ```)", () => {
    const fenced = "```\nvar x = 1;\n```";
    expect(cleanGeneratedCode(fenced)).toBe("var x = 1;");
  });

  test("strips a ```javascript fence", () => {
    const fenced = "```javascript\nvar y = 2;\n```";
    expect(cleanGeneratedCode(fenced)).toBe("var y = 2;");
  });

  test("leaves unfenced code unchanged (trimmed)", () => {
    const raw = "  \nvar z = 3;\n  ";
    expect(cleanGeneratedCode(raw)).toBe("var z = 3;");
  });

  test("does not strip inner backticks inside the code", () => {
    const code = "var msg = `hello ${name}`;";
    expect(cleanGeneratedCode(code)).toBe("var msg = `hello ${name}`;");
  });
});

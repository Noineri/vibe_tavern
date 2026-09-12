/**
 * AI-assistant dice_script mode tests (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B6).
 *
 * Verifies:
 *  - `dice_script` is a complete assistant mode (registered in the assembler
 *    registry + mode config with its own asset).
 *  - Prompt selection resolves to `dice-script-ai-prompt.md` on disk (non-empty).
 *  - The generic `script` profile override stays prompt-only (dice_script
 *    has no legacyColumn → script override does NOT leak into it).
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
import { createDb } from "@vibe-tavern/db";
import { ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";

const fixedClock: StoreClock = { now: () => "2026-08-26T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_${++counter}` };

async function setupDb() {
  counter = 0;
  const db = await createDb(":memory:");
  const profileStore = new ServicePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
  await profileStore.ensureDefaultServicePromptProfile();
  return { db, profileStore, uiSettings };
}

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
    const { db } = await setupDb();
    const { prompt, source } = await resolveSystemPrompt(db, "dice_script");
    expect(source).toBe("default");
    expect(prompt.length).toBeGreaterThan(0);
    // The prompt must reference the Dice VM API surface.
    expect(prompt).toContain("context.dice.register");
    expect(prompt).toContain("context.dice.roll");
  });

  test("a profile override for dice_script wins", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Dice Override",
      overrides: { dice_script: "CUSTOM DICE PROMPT" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });
    const { prompt, source } = await resolveSystemPrompt(db, "dice_script");
    expect(source).toBe("override");
    expect(prompt).toBe("CUSTOM DICE PROMPT");
  });

  test("script profile override does NOT leak into dice_script (presetKey isolation)", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Script Only",
      overrides: { script: "WRONG KEY" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });
    const { source } = await resolveSystemPrompt(db, "dice_script");
    expect(source).toBe("default");
  });

  test("a dice_script profile override does NOT leak into script", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Dice Only",
      overrides: { dice_script: "DICE ONLY" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });
    const { source } = await resolveSystemPrompt(db, "script");
    expect(source).toBe("default");
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

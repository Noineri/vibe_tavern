import { describe, expect, it } from "bun:test";
import { createDb } from "@vibe-tavern/db";
import { ServicePromptProfileStore } from "@vibe-tavern/db";
import { UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { resolveSystemPrompt, getDefaultPromptForMode } from "../src/domain/ai-assistant/ai-assistant-prompts.js";
import { resolvePromptAssetPath, loadPromptAsset } from "../src/shared/prompt-asset-loader.js";
import { getDefaultPromptFile } from "../src/domain/ai-assistant/ai-assistant-modes.js";

import { getModeConfig } from "../src/domain/ai-assistant/ai-assistant-modes.ts";

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

describe("scene_schema prompt — format-aware default selection", () => {
  it("getDefaultPromptFile selects the xml file under xml and the json file otherwise", () => {
    expect(getDefaultPromptFile("scene_schema", "json")).toBe("scene-schema-json.md");
    expect(getDefaultPromptFile("scene_schema", "xml")).toBe("scene-schema-xml.md");
    expect(getDefaultPromptFile("scene_schema")).toBe("scene-schema-json.md");
  });

  it("both format files resolve to an existing path on disk", async () => {
    for (const file of ["scene-schema-json.md", "scene-schema-xml.md"]) {
      const path = await resolvePromptAssetPath(file);
      expect(await Bun.file(path).exists(), `${file} did not resolve to an existing file`).toBe(true);
      expect((await loadPromptAsset(file)).length).toBeGreaterThan(0);
    }
  });

  it("the xml prompt enforces XML-safe key names; the json prompt allows free keys", async () => {
    const json = await getDefaultPromptForMode("scene_schema", "json");
    const xml = await getDefaultPromptForMode("scene_schema", "xml");
    expect(json).toContain("$type");
    expect(xml).toContain("$type");
    expect(xml).toContain("XML-safe names required");
    expect(xml).toContain("A-Za-z");
    expect(json).toContain("spaces and non-ASCII are fine");
    expect(xml).not.toContain("spaces and non-ASCII are fine");
  });

  it("resolveSystemPrompt threads promptFormat into the default branch (no profile override)", async () => {
    const { db } = await setupDb();
    const xml = await resolveSystemPrompt(db, "scene_schema", { promptFormat: "xml" });
    const json = await resolveSystemPrompt(db, "scene_schema", { promptFormat: "json" });
    expect(xml.source).toBe("default");
    expect(json.source).toBe("default");
    expect(xml.prompt).toContain("XML-safe names required");
    expect(json.prompt).toContain("spaces and non-ASCII are fine");
  });

  it("a profile override wins regardless of promptFormat (overrides are format-agnostic)", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Schema Override",
      overrides: { scene_schema: "CUSTOM SCHEMA PROMPT — ignore format." },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });
    for (const promptFormat of ["json", "xml", undefined] as const) {
      const result = await resolveSystemPrompt(db, "scene_schema", { promptFormat });
      expect(result.source).toBe("override");
      expect(result.prompt).toBe("CUSTOM SCHEMA PROMPT — ignore format.");
    }
  });

  it("profile override for script mode wins over asset", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Script Override",
      overrides: { script: "CUSTOM SCRIPT PROMPT" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });
    const result = await resolveSystemPrompt(db, "script");
    expect(result.source).toBe("override");
    expect(result.prompt).toBe("CUSTOM SCRIPT PROMPT");
  });

  it("with no profile, xml format still selects the xml default file", async () => {
    const { db } = await setupDb();
    const result = await resolveSystemPrompt(db, "scene_schema", { promptFormat: "xml" });
    expect(result.source).toBe("default");
    expect(result.prompt).toContain("XML-safe names required");
  });
});

const MESSAGE_EDITOR_MODES = [
  { mode: "message_edit", asset: "message-edit-ai-prompt.md" },
  { mode: "message_merge", asset: "message-merge-ai-prompt.md" },
] as const;

describe("message editor prompt modes", () => {
  for (const { mode, asset } of MESSAGE_EDITOR_MODES) {
    it(`uses an independent text-mode configuration when mode is ${mode}`, () => {
      const config = getModeConfig(mode);
      expect(config.mode).toBe(mode);
      expect(config.presetKey).toBe(mode);
      expect(config.defaultPromptFile).toBe(asset);
      expect(config.outputFormat).toBe("text");
      expect(config.stripReasoning).toBe(false);
      expect(getDefaultPromptFile(mode)).toBe(asset);
    });

    it(`resolves its default asset and only its own profile override when mode is ${mode}`, async () => {
      const { db, profileStore, uiSettings } = await setupDb();
      const defaultResult = await resolveSystemPrompt(db, mode);
      expect(defaultResult.source).toBe("default");
      const assetPath = await resolvePromptAssetPath(asset);
      expect(await Bun.file(assetPath).exists()).toBe(true);
      expect((await getDefaultPromptForMode(mode)).length).toBeGreaterThan(0);

      const profile = await profileStore.createServicePromptProfile({
        name: "Editor Override",
        overrides: { [mode]: "OVERRIDE_TOKEN" },
      });
      await uiSettings.update({ activeServicePromptProfileId: profile.id });
      const overrideResult = await resolveSystemPrompt(db, mode);
      expect(overrideResult).toEqual({ prompt: "OVERRIDE_TOKEN", source: "override" });
    });
  }
});

import { describe, expect, it } from "bun:test";
import { resolveSystemPrompt, getDefaultPromptForMode } from "../src/domain/ai-assistant/ai-assistant-prompts.js";
import { resolvePromptAssetPath, loadPromptAsset } from "../src/shared/prompt-asset-loader.js";
import { getDefaultPromptFile } from "../src/domain/ai-assistant/ai-assistant-modes.js";

// scene_schema is format-aware: the DEFAULT prompt file (json vs xml) is selected
// by the request's promptFormat, while a preset override wins regardless. These
// tests pin the format-selection crux of step 4 (option A): the schema is always
// JSON DSL, but under xml the prompt enforces XML-safe key names.

import { getModeConfig } from "../src/domain/ai-assistant/ai-assistant-modes.ts";

describe("scene_schema prompt — format-aware default selection", () => {
	it("getDefaultPromptFile selects the xml file under xml and the json file otherwise", () => {
		expect(getDefaultPromptFile("scene_schema", "json")).toBe("scene-schema-json.md");
		expect(getDefaultPromptFile("scene_schema", "xml")).toBe("scene-schema-xml.md");
		// No format → the json default (the config's defaultPromptFile).
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
		// Both are DSL prompts that emit one JSON schema object.
		expect(json).toContain("$type");
		expect(xml).toContain("$type");
		// The xml variant carries the XML-name rule + the tag-name regex.
		expect(xml).toContain("XML-safe names required");
		expect(xml).toContain("A-Za-z");
		// The json variant explicitly permits spaces/non-ASCII keys.
		expect(json).toContain("spaces and non-ASCII are fine");
		// The xml variant must NOT advertise that freedom.
		expect(xml).not.toContain("spaces and non-ASCII are fine");
	});

	it("resolveSystemPrompt threads promptFormat into the default-md branch", async () => {
		const xml = await resolveSystemPrompt("scene_schema", { aiAssistantPrompts: null, promptFormat: "xml" });
		const json = await resolveSystemPrompt("scene_schema", { aiAssistantPrompts: null, promptFormat: "json" });
		expect(xml.source).toBe("default_md");
		expect(json.source).toBe("default_md");
		expect(xml.prompt).toContain("XML-safe names required");
		expect(json.prompt).toContain("spaces and non-ASCII are fine");
	});

	it("a preset override wins regardless of promptFormat (overrides are format-agnostic)", async () => {
		const override = { scene_schema: "CUSTOM SCHEMA PROMPT — ignore format." };
		for (const promptFormat of ["json", "xml", undefined] as const) {
			const result = await resolveSystemPrompt("scene_schema", { aiAssistantPrompts: override, promptFormat });
			expect(result.source).toBe("preset_override");
			expect(result.prompt).toBe("CUSTOM SCHEMA PROMPT — ignore format.");
		}
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

    it(`resolves its default asset and only its own preset override when mode is ${mode}`, async () => {
      const defaultResult = await resolveSystemPrompt(mode, { aiAssistantPrompts: null });
      const overrideResult = await resolveSystemPrompt(mode, {
        aiAssistantPrompts: { [mode]: "OVERRIDE_TOKEN" },
      });
      const assetPath = await resolvePromptAssetPath(asset);

      expect(defaultResult.source).toBe("default_md");
      expect((await Bun.file(assetPath).exists())).toBe(true);
      expect((await getDefaultPromptForMode(mode)).length).toBeGreaterThan(0);
      expect(overrideResult).toEqual({ prompt: "OVERRIDE_TOKEN", source: "preset_override" });
    });
  }
});

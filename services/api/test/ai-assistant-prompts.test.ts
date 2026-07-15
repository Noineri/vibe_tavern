import { describe, expect, it } from "bun:test";
import { resolveSystemPrompt, getDefaultPromptForMode } from "../src/domain/ai-assistant/ai-assistant-prompts.js";
import { resolvePromptAssetPath, loadPromptAsset } from "../src/shared/prompt-asset-loader.js";
import { getDefaultPromptFile } from "../src/domain/ai-assistant/ai-assistant-modes.js";

// scene_schema is format-aware: the DEFAULT prompt file (json vs xml) is selected
// by the request's promptFormat, while a preset override wins regardless. These
// tests pin the format-selection crux of step 4 (option A): the schema is always
// JSON DSL, but under xml the prompt enforces XML-safe key names.

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

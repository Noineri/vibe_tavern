/**
 * Characterization tests for the shared prompt-asset loader + the AI-assistant
 * mode-keyed surface rewired onto it.
 *
 * Two layers are pinned here, both previously uncovered (§1 — characterization
 * test written alongside the consolidation in PROMPT_ASSET_LOADER_CONSOLIDATION.md):
 *
 *  1. `shared/prompt-asset-loader.ts` — the candidate-path ladder (env override →
 *     standalone artifact → API source assets → cwd source → build output) and
 *     the no-cache freshness contract: every `loadPromptAsset` call re-reads, so
 *     an external edit to the resolved file is visible on the next call without a
 *     restart. The env-override test is the one that pins the behavioral
 *     reconciliation the consolidation report flagged: there is exactly one
 *     canonical candidate order, and env wins.
 *  2. `domain/ai-assistant/ai-assistant-prompts.ts` — after the rewire,
 *     resolution delegates to the shared loader; the mode-keyed public surface
 *     (`resolvePromptPathForMode`, `getDefaultPromptForMode`) stays intact, and
 *     `resolveSystemPrompt`'s fallback chain (preset_override → preset_legacy →
 *     default_md) is pure logic worth pinning in its own right.
 *
 * No cache → no cross-test isolation work needed: every load reads fresh, so the
 * old `beforeEach(clear…Cache)` hooks are gone and the freshness tests assert the
 * live-edit behavior directly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { AiAssistantMode } from "@vibe-tavern/prompt-pipeline";

import { getAllModeConfigs, getModeConfig } from "../src/domain/ai-assistant/ai-assistant-modes.js";
import {
	getDefaultPromptForMode,
	resolvePromptPathForMode,
	resolveSystemPrompt,
} from "../src/domain/ai-assistant/ai-assistant-prompts.js";
import { loadPromptAsset, resolvePromptAssetPath } from "../src/shared/prompt-asset-loader.js";

// Every mode's prompt file, for parameterized assertions.
const ALL_MODES = getAllModeConfigs().map((c) => c.mode);

describe("prompt-asset-loader — shared resolver", () => {
	describe("resolvePromptAssetPath", () => {
		test("resolves every assistant prompt file to an existing path on disk", async () => {
			for (const config of getAllModeConfigs()) {
				const path = await resolvePromptAssetPath(config.defaultPromptFile);
				expect(await Bun.file(path).exists(), `${config.defaultPromptFile} did not resolve to an existing file`).toBe(true);
			}
		});

		test("env override (RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR) wins over bundled assets", async () => {
			const tmp = await mkdtemp(join(tmpdir(), "vt-prompts-"));
			try {
				const filename = getModeConfig("script").defaultPromptFile;
				const overridePath = join(tmp, filename);
				const overrideContent = "# OVERRIDE FROM ENV DIR\nunique-marker-9f3c\n";
				await Bun.write(overridePath, overrideContent);

				const prev = process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR;
				process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR = tmp;
				try {
					const resolved = await resolvePromptAssetPath(filename);
					expect(resolved).toBe(overridePath);

					// And the content loads from the override location.
					expect(await loadPromptAsset(filename)).toBe(overrideContent);
				} finally {
					if (prev === undefined) delete process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR;
					else process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR = prev;
				}
			} finally {
				await rm(tmp, { recursive: true, force: true });
			}
		});

		test("falls back to the last candidate for an unknown file (so the read error names a real path)", async () => {
			const path = await resolvePromptAssetPath("nonexistent-prompt-xyz-9f3c.md");
			// The exact fallback path is not contractual; what matters is the read
			// surfaces a path-bearing error instead of returning null.
			expect(path.endsWith("nonexistent-prompt-xyz-9f3c.md")).toBe(true);
			expect(await Bun.file(path).exists()).toBe(false);
		});
	});

	describe("loadPromptAsset — freshness (no process cache)", () => {
		test("returns the current file content and reflects an external edit on the next call", async () => {
			const tmp = await mkdtemp(join(tmpdir(), "vt-prompts-"));
			try {
				const filename = getModeConfig("script").defaultPromptFile;
				const overridePath = join(tmp, filename);
				await Bun.write(overridePath, "# FIRST DRAFT\nmarker-aaa\n");

				const prev = process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR;
				process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR = tmp;
				try {
					// First read sees the initial content.
					expect(await loadPromptAsset(filename)).toBe("# FIRST DRAFT\nmarker-aaa\n");
					// Edit the resolved file in place; the next read must see it with no
					// restart and no manual cache clear.
					await Bun.write(overridePath, "# EDITED LIVE\nmarker-bbb\n");
					expect(await loadPromptAsset(filename)).toBe("# EDITED LIVE\nmarker-bbb\n");
				} finally {
					if (prev === undefined) delete process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR;
					else process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR = prev;
				}
			} finally {
				await rm(tmp, { recursive: true, force: true });
			}
		});
	});
});

describe("ai-assistant-prompts — rewire onto shared loader", () => {
	test("resolvePromptPathForMode resolves every mode to its configured defaultPromptFile on disk", async () => {
		for (const mode of ALL_MODES) {
			const config = getModeConfig(mode);
			const path = await resolvePromptPathForMode(mode);
			expect(path.endsWith(config.defaultPromptFile), `mode ${mode} did not resolve to ${config.defaultPromptFile}`).toBe(true);
			expect(await Bun.file(path).exists()).toBe(true);
		}
	});

	test("getDefaultPromptForMode returns non-empty content for every mode", async () => {
		for (const mode of ALL_MODES) {
			const content = await getDefaultPromptForMode(mode);
			expect(content.length, `mode ${mode} resolved to empty content`).toBeGreaterThan(0);
		}
	});

	test("getDefaultPromptForMode reflects an external edit live (assistant surface shares the loader)", async () => {
		// Pins the same freshness contract through the mode-keyed public surface,
		// not just the raw loader: an edit beside the executable is visible on the
		// next assistant-mode resolution without a restart.
		const tmp = await mkdtemp(join(tmpdir(), "vt-prompts-"));
		try {
			const filename = getModeConfig("script").defaultPromptFile;
			const overridePath = join(tmp, filename);
			await Bun.write(overridePath, "# ASSISTANT FIRST\n");
			const prev = process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR;
			process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR = tmp;
			try {
				expect(await getDefaultPromptForMode("script")).toBe("# ASSISTANT FIRST\n");
				await Bun.write(overridePath, "# ASSISTANT EDITED\n");
				expect(await getDefaultPromptForMode("script")).toBe("# ASSISTANT EDITED\n");
			} finally {
				if (prev === undefined) delete process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR;
				else process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR = prev;
			}
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("resolveSystemPrompt — fallback chain precedence", () => {
	// Pure logic for the override/legacy branches; the default_md branch reads the
	// file (covered by the rewire tests above). These pin the precedence that
	// determines which prompt actually reaches the model.

	test("preset_override wins when aiAssistantPrompts has the mode's presetKey", async () => {
		const { prompt, source } = await resolveSystemPrompt("script", {
			aiAssistantPrompts: { script: "CUSTOM OVERRIDE" },
			scriptAiSystemPrompt: "LEGACY VALUE",
		});
		expect(source).toBe("preset_override");
		expect(prompt).toBe("CUSTOM OVERRIDE");
	});

	test("preset_legacy wins for script mode when only scriptAiSystemPrompt is set", async () => {
		const { prompt, source } = await resolveSystemPrompt("script", {
			aiAssistantPrompts: null,
			scriptAiSystemPrompt: "LEGACY VALUE",
		});
		expect(source).toBe("preset_legacy");
		expect(prompt).toBe("LEGACY VALUE");
	});

	test("default_md when no overrides are present", async () => {
		const { prompt, source } = await resolveSystemPrompt("script", {
			aiAssistantPrompts: null,
			scriptAiSystemPrompt: null,
		});
		expect(source).toBe("default_md");
		expect(prompt.length).toBeGreaterThan(0);
	});

	test("override takes precedence over legacy when both are set", async () => {
		const { source } = await resolveSystemPrompt("script", {
			aiAssistantPrompts: { script: "OVERRIDE" },
			scriptAiSystemPrompt: "LEGACY",
		});
		expect(source).toBe("preset_override");
	});

	test("whitespace-only override is ignored (falls through to legacy/default)", async () => {
		const { source } = await resolveSystemPrompt("script", {
			aiAssistantPrompts: { script: "   \n\t  " },
			scriptAiSystemPrompt: null,
		});
		expect(source).toBe("default_md");
	});

	test("non-script mode ignores scriptAiSystemPrompt (no legacy column on other modes)", async () => {
		const { source } = await resolveSystemPrompt("lore_entry", {
			aiAssistantPrompts: null,
			scriptAiSystemPrompt: "SHOULD BE IGNORED",
		});
		expect(source).toBe("default_md");
	});

	test("override is keyed by presetKey (lore_entry mode → 'lore_entry' key)", async () => {
		const { prompt, source } = await resolveSystemPrompt("lore_entry", {
			aiAssistantPrompts: { lore_entry: "LORE OVERRIDE" },
		});
		expect(source).toBe("preset_override");
		expect(prompt).toBe("LORE OVERRIDE");
	});

	test("a mismatched presetKey does not match (script override does not leak into lore_entry)", async () => {
		const { source } = await resolveSystemPrompt("lore_entry", {
			aiAssistantPrompts: { script: "WRONG KEY OVERRIDE" },
		});
		expect(source).toBe("default_md");
	});
});

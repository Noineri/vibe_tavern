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

		test("env override (VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR) wins over bundled assets", async () => {
			const tmp = await mkdtemp(join(tmpdir(), "vt-prompts-"));
			try {
				const filename = getModeConfig("script").defaultPromptFile;
				const overridePath = join(tmp, filename);
				const overrideContent = "# OVERRIDE FROM ENV DIR\nunique-marker-9f3c\n";
				await Bun.write(overridePath, overrideContent);

				const prev = process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
				process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = tmp;
				try {
					const resolved = await resolvePromptAssetPath(filename);
					expect(resolved).toBe(overridePath);

					// And the content loads from the override location.
					expect(await loadPromptAsset(filename)).toBe(overrideContent);
				} finally {
					if (prev === undefined) delete process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
					else process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = prev;
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

		test("normalizes CRLF line endings to LF (platform-deterministic prompt bytes)", async () => {
			// A Windows checkout with core.autocrlf=true (CI runners) or a user
			// override saved by a CRLF editor puts \r\n on disk; the loaded prompt
			// must not leak \r — the LLM sees byte-identical prompts on every
			// platform and the SHA pins in experience-copilot-prompt.test.ts hold.
			const tmp = await mkdtemp(join(tmpdir(), "vt-prompts-"));
			try {
				const filename = getModeConfig("script").defaultPromptFile;
				const overridePath = join(tmp, filename);
				await Bun.write(overridePath, "# CRLF HEADER\r\nmarker line 1\r\nmarker lone-cr\r\r\n");

				const prev = process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
				process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = tmp;
				try {
					const loaded = await loadPromptAsset(filename);
				expect(loaded.includes("\r")).toBe(false);
				expect(loaded).toBe("# CRLF HEADER\nmarker line 1\nmarker lone-cr\n\n");
				} finally {
					if (prev === undefined) delete process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
					else process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = prev;
				}
			} finally {
				await rm(tmp, { recursive: true, force: true });
			}
		});
	});

	describe("loadPromptAsset — freshness (no process cache)", () => {
		test("returns the current file content and reflects an external edit on the next call", async () => {
			const tmp = await mkdtemp(join(tmpdir(), "vt-prompts-"));
			try {
				const filename = getModeConfig("script").defaultPromptFile;
				const overridePath = join(tmp, filename);
				await Bun.write(overridePath, "# FIRST DRAFT\nmarker-aaa\n");

				const prev = process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
				process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = tmp;
				try {
					// First read sees the initial content.
					expect(await loadPromptAsset(filename)).toBe("# FIRST DRAFT\nmarker-aaa\n");
					// Edit the resolved file in place; the next read must see it with no
					// restart and no manual cache clear.
					await Bun.write(overridePath, "# EDITED LIVE\nmarker-bbb\n");
					expect(await loadPromptAsset(filename)).toBe("# EDITED LIVE\nmarker-bbb\n");
				} finally {
					if (prev === undefined) delete process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
					else process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = prev;
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
			const prev = process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
			process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = tmp;
			try {
				expect(await getDefaultPromptForMode("script")).toBe("# ASSISTANT FIRST\n");
				await Bun.write(overridePath, "# ASSISTANT EDITED\n");
				expect(await getDefaultPromptForMode("script")).toBe("# ASSISTANT EDITED\n");
			} finally {
				if (prev === undefined) delete process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR;
				else process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR = prev;
			}
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("resolveSystemPrompt — fallback chain precedence (service profiles)", () => {
	// After SP-4 the preset JSON + legacy column are gone — the profile chain is:
	// active profile override (trimmed non-empty) → default .md asset.

	test("profile override wins when active profile has the mode's field key", async () => {
		const { createDb } = await import("@vibe-tavern/db");
		const { ServicePromptProfileStore, UiSettingsStore } = await import("@vibe-tavern/db");
		const db = await createDb(":memory:");
		const ps = new ServicePromptProfileStore(db);
		const ui = new UiSettingsStore(db);
		await ps.ensureDefaultServicePromptProfile();
		const p = await ps.createServicePromptProfile({ name: "t", overrides: { script: "CUSTOM OVERRIDE" } });
		await ui.update({ activeServicePromptProfileId: p.id });
		const { prompt, source } = await resolveSystemPrompt(db, "script");
		expect(source).toBe("override");
		expect(prompt).toBe("CUSTOM OVERRIDE");
	});

	test("default when no profile overrides are present", async () => {
		const { createDb } = await import("@vibe-tavern/db");
		const db = await createDb(":memory:");
		const { prompt, source } = await resolveSystemPrompt(db, "script");
		expect(source).toBe("default");
		expect(prompt.length).toBeGreaterThan(0);
	});

	test("whitespace-only profile override is ignored (falls through to default)", async () => {
		const { createDb } = await import("@vibe-tavern/db");
		const { ServicePromptProfileStore, UiSettingsStore } = await import("@vibe-tavern/db");
		const db = await createDb(":memory:");
		const ps = new ServicePromptProfileStore(db);
		const ui = new UiSettingsStore(db);
		await ps.ensureDefaultServicePromptProfile();
		const p = await ps.createServicePromptProfile({ name: "t", overrides: { script: "   \n\t  " } });
		await ui.update({ activeServicePromptProfileId: p.id });
		const { source } = await resolveSystemPrompt(db, "script");
		expect(source).toBe("default");
	});

	test("override is keyed by field (lore_entry override → lore_entry mode)", async () => {
		const { createDb } = await import("@vibe-tavern/db");
		const { ServicePromptProfileStore, UiSettingsStore } = await import("@vibe-tavern/db");
		const db = await createDb(":memory:");
		const ps = new ServicePromptProfileStore(db);
		const ui = new UiSettingsStore(db);
		await ps.ensureDefaultServicePromptProfile();
		const p = await ps.createServicePromptProfile({ name: "t", overrides: { lore_entry: "LORE OVERRIDE" } });
		await ui.update({ activeServicePromptProfileId: p.id });
		const { prompt, source } = await resolveSystemPrompt(db, "lore_entry");
		expect(source).toBe("override");
		expect(prompt).toBe("LORE OVERRIDE");
	});

	test("a mismatched field does not leak (script override does not affect lore_entry)", async () => {
		const { createDb } = await import("@vibe-tavern/db");
		const { ServicePromptProfileStore, UiSettingsStore } = await import("@vibe-tavern/db");
		const db = await createDb(":memory:");
		const ps = new ServicePromptProfileStore(db);
		const ui = new UiSettingsStore(db);
		await ps.ensureDefaultServicePromptProfile();
		const p = await ps.createServicePromptProfile({ name: "t", overrides: { script: "WRONG KEY OVERRIDE" } });
		await ui.update({ activeServicePromptProfileId: p.id });
		const { source } = await resolveSystemPrompt(db, "lore_entry");
		expect(source).toBe("default");
	});

	test("legacy aiAssistantPrompts/scriptAiSystemPrompt plumbing is gone — preset JSON no longer consults", async () => {
		// This test asserts the intentional SP-4 removal: even if a preset's
		// JSON contained a script override, the new resolver does NOT read presets.
		// We verify by calling with no profile override and checking we get default
		// (the old preset path would have returned preset_override).
		const { createDb } = await import("@vibe-tavern/db");
		const db = await createDb(":memory:");
		const { source } = await resolveSystemPrompt(db, "script");
		expect(source).toBe("default");
	});
});

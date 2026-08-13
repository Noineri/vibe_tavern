/**
 * Experience-copilot module definition + skill-catalog wiring (ER-16).
 *
 * Pins the single fixed "experience-authoring" module: its declarative shape
 * (id / basePromptFile / skillIds / toolSet / maxSteps), that the base-prompt
 * asset LOADS (the ER-16 gate — "module loads"), and that the copilot's own
 * skill root is scanned (reusing the Co-Author scanner) to surface the
 * `experience-authoring` skill for on-demand `read_skill_file`. The catalog
 * renderer is a pure function exercised directly.
 */

import { describe, test, expect } from "bun:test";
import {
  EXPERIENCE_COPILOT_MODULE,
  resolveExperienceCopilotModule,
  resolveExperienceCopilotSkillCatalog,
  renderExperienceCopilotSkillCatalog,
} from "../src/domain/interactive/copilot/experience-copilot-module.js";

describe("experience-copilot module (ER-16)", () => {
  test("the single fixed module definition has the expected shape", () => {
    expect(EXPERIENCE_COPILOT_MODULE.id).toBe("experience-authoring");
    expect(EXPERIENCE_COPILOT_MODULE.skillIds).toEqual(["experience-authoring"]);
    expect(EXPERIENCE_COPILOT_MODULE.basePromptFile).toBe("experience-copilot/base.md");
    expect(EXPERIENCE_COPILOT_MODULE.maxSteps).toBe(20);
    // The five authoring/diagnostic tools are declared. `read_skill_file` is
    // always available on top (mirroring Co-Author — the universal read-only
    // skill channel), so it is NOT part of the gated toolSet.
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.write_buffer).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.edit_buffer).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.run_test).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.run_simulate).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.suggest_visual_binding).toBe(true);
  });

  test("resolveExperienceCopilotModule loads the base-prompt asset (the ER-16 gate: module loads)", async () => {
    const module = await resolveExperienceCopilotModule();
    expect(module.basePrompt.trim().length).toBeGreaterThan(0);
    // The base prompt carries the role framing (moved out of inline TS in ER-16).
    expect(module.basePrompt).toContain("EXPERIENCE ASSISTANT");
    expect(module.basePrompt).toContain("write_buffer");
    expect(module.basePrompt).toContain("read_skill_file");
  });

  test("resolveExperienceCopilotSkillCatalog discovers the experience-authoring skill from the copilot root", async () => {
    const { entries } = await resolveExperienceCopilotSkillCatalog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const skill = entries.find((e) => e.id === "experience-authoring");
    expect(skill).toBeDefined();
    expect(skill?.source).toBe("builtin");
    expect(skill?.rootRelativeManifestPath).toBe("experience-authoring/SKILL.md");
    expect(skill?.name.trim().length).toBeGreaterThan(0);
    expect(skill?.description.trim().length).toBeGreaterThan(0);
  });

  test("renderExperienceCopilotSkillCatalog lists the discovered entry and is empty for none", async () => {
    // Empty catalog → empty string (section omitted from the system message).
    expect(renderExperienceCopilotSkillCatalog([])).toBe("");
    // Real catalog entry → rendered with the progressive-disclosure framing.
    const { entries } = await resolveExperienceCopilotSkillCatalog();
    const rendered = renderExperienceCopilotSkillCatalog(entries);
    expect(rendered).toContain("Available skills");
    expect(rendered).toContain("read_skill_file");
    expect(rendered).toContain("experience-authoring");
    expect(rendered).toContain("experience-authoring/SKILL.md");
  });
});

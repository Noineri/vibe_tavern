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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPERIENCE_COPILOT_MODULE,
  resolveExperienceCopilotModule,
  resolveExperienceCopilotSkillCatalog,
  resolveBuiltinCopilotProfile,
  renderExperienceCopilotSkillCatalog,
} from "../src/domain/interactive/copilot/experience-copilot-module.js";

describe("experience-copilot module (ER-16)", () => {
  test("the single fixed module definition has the expected shape", () => {
    expect(EXPERIENCE_COPILOT_MODULE.id).toBe("experience-authoring");
    expect(EXPERIENCE_COPILOT_MODULE.skillIds).toEqual(["experience-authoring", "grill-me"]);
    expect(EXPERIENCE_COPILOT_MODULE.basePromptFile).toBe("experience-copilot/base.md");
    // The seven authoring/diagnostic tools are declared. `read_skill_file` is
    // always available on top (mirroring Co-Author — the universal read-only
    // skill channel), so it is NOT part of the gated toolSet.
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.write_buffer).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.edit_buffer).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.run_test).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.run_simulate).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.suggest_visual_binding).toBe(true);
    // TAG-4: the todo + ask_user tools are enabled in the built-in seed.
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.todo).toBe(true);
    expect(EXPERIENCE_COPILOT_MODULE.toolSet.ask_user).toBe(true);
  });

  test("resolveExperienceCopilotModule loads the base-prompt asset (the ER-16 gate: module loads)", async () => {
    const module = await resolveExperienceCopilotModule();
    expect(module.basePrompt.trim().length).toBeGreaterThan(0);
    // The base prompt carries the role framing (moved out of inline TS in ER-16).
    expect(module.basePrompt).toContain("MINI-APP ASSISTANT");
    expect(module.basePrompt).toContain("write_buffer");
    expect(module.basePrompt).toContain("read_skill_file");
  });

  test("resolveExperienceCopilotSkillCatalog discovers the experience-authoring and grill-me skills from the copilot root", async () => {
    const { entries } = await resolveExperienceCopilotSkillCatalog();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const skill = entries.find((e) => e.id === "experience-authoring");
    expect(skill).toBeDefined();
    expect(skill?.source).toBe("builtin");
    expect(skill?.rootRelativeManifestPath).toBe("experience-authoring/SKILL.md");
    expect(skill?.name.trim().length).toBeGreaterThan(0);
    expect(skill?.description.trim().length).toBeGreaterThan(0);
    const grill = entries.find((e) => e.id === "grill-me");
    expect(grill).toBeDefined();
    expect(grill?.source).toBe("builtin");
    expect(grill?.rootRelativeManifestPath).toBe("grill-me/SKILL.md");
    expect(grill?.name).toBe("grill-me");
    expect(grill?.description.trim().length).toBeGreaterThan(0);
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

  test("resolveBuiltinCopilotProfile projects the module into a read-only seed (CP-4)", async () => {
    const profile = await resolveBuiltinCopilotProfile();
    expect(profile.id).toBe("builtin");
    expect(profile.isBuiltIn).toBe(true);
    expect(profile.name).toBe(EXPERIENCE_COPILOT_MODULE.name);
    expect(profile.skillIds).toEqual([...EXPERIENCE_COPILOT_MODULE.skillIds]);
    // The loaded base-prompt asset carries the role framing.
    expect(profile.basePrompt.trim().length).toBeGreaterThan(0);
    expect(profile.basePrompt).toContain("MINI-APP ASSISTANT");
    // toolSet projected through COPILOT_TOOL_KEYS → all 7 declared tools on
    // (TAG-4: todo + ask_user join the seed). maxSteps is no longer carried.
    expect(profile.toolSet).toEqual({
      write_buffer: true,
      edit_buffer: true,
      run_test: true,
      run_simulate: true,
      suggest_visual_binding: true,
      todo: true,
      ask_user: true,
    });
    expect(profile.maxSteps).toBeUndefined();
  });
});

describe("experience-copilot two-root skill catalog (CP-4)", () => {
  const tmpRoots: string[] = [];
  let userRoot = "";

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "copilot-skill-catalog-user-"));
    tmpRoots.push(userRoot);
  });
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const manifest = (name: string, desc: string) =>
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

  test("merges the user root alongside the built-in root", async () => {
    await mkdir(join(userRoot, "custom-skill"), { recursive: true });
    await Bun.write(join(userRoot, "custom-skill", "SKILL.md"), manifest("custom-skill", "a user skill"));

    const { entries } = await resolveExperienceCopilotSkillCatalog(userRoot);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("experience-authoring");
    expect(ids).toContain("custom-skill");

    const builtin = entries.find((e) => e.id === "experience-authoring");
    expect(builtin?.source).toBe("builtin");
    const user = entries.find((e) => e.id === "custom-skill");
    expect(user?.source).toBe("user");
    expect(user?.shadowsBuiltin).toBe(false);
  });

  test("a user skill with a built-in id shadows it (user precedence)", async () => {
    await mkdir(join(userRoot, "experience-authoring"), { recursive: true });
    await Bun.write(join(userRoot, "experience-authoring", "SKILL.md"), manifest("experience-authoring", "user override"));

    const { entries } = await resolveExperienceCopilotSkillCatalog(userRoot);
    const skill = entries.find((e) => e.id === "experience-authoring");
    expect(skill).toBeDefined();
    expect(skill?.source).toBe("user");
    expect(skill?.shadowsBuiltin).toBe(true);
    expect(skill?.description).toBe("user override");
  });
});

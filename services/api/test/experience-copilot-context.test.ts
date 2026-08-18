/**
 * CX-2: pinned-context loader unit tests — per-type resolution, dangling and
 * disabled skips, dedupe, skill body injection + missing-skill skip, and
 * render framing pins. Pure: deps are in-memory fakes, no store, no DOM.
 */

import { describe, test, expect } from "bun:test";
import type { ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import type { SkillCatalogEntry } from "../src/domain/coauthor/skills/skill-scanner.js";
import {
  getCopilotContextItems,
  renderAttachedContext,
  type CopilotContextDeps,
} from "../src/domain/interactive/copilot/experience-copilot-context.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

interface FakeCharacter { id: string; name: string; profile: string }
interface FakePersona { id: string; name: string; description: string }
interface FakeLorebook { id: string; enabled: boolean; entries: Array<{ id: string; title: string; content: string; enabled: boolean }> }
interface FakeScript { id: string; name: string; description: string; code: string }

function makeDeps(over: Partial<CopilotContextDeps> = {}): CopilotContextDeps {
  const characters = new Map<string, FakeCharacter>([
    ["char_1", { id: "char_1", name: "Alice", profile: "alice profile" }],
  ]);
  const personas = new Map<string, FakePersona>([
    ["persona_1", { id: "persona_1", name: "Narrator", description: "omniscient narrator" }],
  ]);
  const lorebooks = new Map<string, FakeLorebook>([
    [
      "lore_1",
      {
        id: "lore_1",
        enabled: true,
        entries: [
          { id: "entry_1", title: "City", content: "city content", enabled: true },
          { id: "entry_2", title: "Faction", content: "faction content", enabled: true },
          { id: "entry_3", title: "Dust", content: "dust content", enabled: false },
        ],
      },
    ],
    ["lore_disabled", { id: "lore_disabled", enabled: false, entries: [] }],
  ]);
  const scripts = new Map<string, FakeScript>([
    ["script_1", { id: "script_1", name: "Counter", description: "A counter experience", code: "export function main() {}" }],
  ]);
  const skills = new Map<string, SkillCatalogEntry>([
    [
      "my-skill",
      {
        id: "my-skill",
        source: "builtin",
        name: "My Skill",
        description: "does things",
        skillDir: "/skills/my-skill",
        manifestPath: "/skills/my-skill/SKILL.md",
        rootRelativeManifestPath: "my-skill/SKILL.md",
        shadowsBuiltin: false,
      },
    ],
  ]);
  const skillFiles = new Map<string, string>([["my-skill/SKILL.md", "---\nname: My Skill\n---\n# Instructions\nDo the thing."]]);

  return {
    characters: {
      getById: async (id: string) => characters.get(id) ?? null,
      getProfileMdText: async (id: string) => characters.get(id)?.profile ?? "",
    },
    personas: {
      getById: async (id: string) => personas.get(id) ?? null,
    },
    lorebooks: {
      getLorebook: async (id: string) => {
        const lb = lorebooks.get(id);
        return lb ? { id: lb.id, enabled: lb.enabled } : null;
      },
      listEntries: async (id: string) => lorebooks.get(id)?.entries ?? [],
    },
    scripts: {
      getById: async (id: string) => scripts.get(id) ?? null,
    },
    skills: {
      readCatalogEntry: async (id: string) => skills.get(id) ?? null,
      readFile: async (path: string) => skillFiles.get(path) ?? null,
    },
    ...over,
  };
}

const link = (targetType: ExperienceCopilotContextLink["targetType"], targetId: string): ExperienceCopilotContextLink =>
  ({ targetType, targetId });

// ─── Resolution ──────────────────────────────────────────────────────────────

describe("getCopilotContextItems (CX-2)", () => {
  test("empty links → empty items; empty render → empty string", async () => {
    const deps = makeDeps();
    expect(await getCopilotContextItems([], deps)).toEqual([]);
    expect(renderAttachedContext([])).toBe("");
  });

  test("character resolves its profile text with the character name as title", async () => {
    const deps = makeDeps();
    const items = await getCopilotContextItems([link("character", "char_1")], deps);
    expect(items).toEqual([{ type: "character", id: "char_1", title: "Alice", content: "alice profile" }]);
  });

  test("persona resolves its description as content", async () => {
    const deps = makeDeps();
    const items = await getCopilotContextItems([link("persona", "persona_1")], deps);
    expect(items).toEqual([{ type: "persona", id: "persona_1", title: "Narrator", content: "omniscient narrator" }]);
  });

  test("script with a description renders description + fenced code block", async () => {
    const deps = makeDeps();
    const items = await getCopilotContextItems([link("script", "script_1")], deps);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("A counter experience\n\n```js\nexport function main() {}\n```");
  });

  test("script without a description renders only the fenced code block", async () => {
    const deps = makeDeps({
      scripts: {
        getById: async (id: string) => (id === "script_2"
          ? { id: "script_2", name: "Bare", description: "   ", code: "return 1;" }
          : null),
      },
    });
    const items = await getCopilotContextItems([link("script", "script_2")], deps);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("```js\nreturn 1;\n```");
  });

  test("enabled lorebook expands to one item per ENABLED entry (entry ids)", async () => {
    const deps = makeDeps();
    const items = await getCopilotContextItems([link("lorebook", "lore_1")], deps);
    expect(items).toEqual([
      { type: "lorebook", id: "entry_1", title: "City", content: "city content" },
      { type: "lorebook", id: "entry_2", title: "Faction", content: "faction content" },
    ]);
  });

  test("disabled lorebook contributes nothing; enabled book with all-disabled entries contributes nothing", async () => {
    const deps = makeDeps({
      lorebooks: {
        getLorebook: async (id: string) =>
          id === "lore_empty" ? { id: "lore_empty", enabled: true } : null,
        listEntries: async (id: string) =>
          id === "lore_empty"
            ? [{ id: "e1", title: "Off", content: "x", enabled: false }]
            : [],
      },
    });
    expect(await getCopilotContextItems([link("lorebook", "lore_disabled")], deps)).toEqual([]);
    expect(await getCopilotContextItems([link("lorebook", "lore_empty")], deps)).toEqual([]);
  });

  test("dangling character/persona/script/lorebook links are skipped silently", async () => {
    const deps = makeDeps();
    const links = [
      link("character", "char_missing"),
      link("persona", "persona_missing"),
      link("script", "script_missing"),
      link("lorebook", "lore_missing"),
    ];
    expect(await getCopilotContextItems(links, deps)).toEqual([]);
  });

  test("skill arm: catalog entry + readable manifest → item with the full body", async () => {
    const deps = makeDeps();
    const items = await getCopilotContextItems([link("skill", "my-skill")], deps);
    expect(items).toEqual([
      {
        type: "skill",
        id: "my-skill",
        title: "My Skill",
        content: "---\nname: My Skill\n---\n# Instructions\nDo the thing.",
      },
    ]);
  });

  test("skill with no catalog entry is skipped; skill whose manifest read fails is skipped", async () => {
    const deps = makeDeps({
      skills: {
        readCatalogEntry: async (id: string) =>
          id === "broken" ? { ...skillsEntry("broken"), rootRelativeManifestPath: "broken/SKILL.md" } : null,
        readFile: async () => null,
      },
    });
    expect(await getCopilotContextItems([link("skill", "ghost")], deps)).toEqual([]);
    expect(await getCopilotContextItems([link("skill", "broken")], deps)).toEqual([]);
  });

  test("dedupe: a character linked twice injects once; a lorebook linked twice injects its entries once", async () => {
    const deps = makeDeps();
    const links = [
      link("character", "char_1"),
      link("character", "char_1"),
      link("lorebook", "lore_1"),
      link("lorebook", "lore_1"),
    ];
    const items = await getCopilotContextItems(links, deps);
    expect(items.filter((it) => it.type === "character")).toHaveLength(1);
    expect(items.filter((it) => it.type === "lorebook")).toHaveLength(2);
  });

  test("order is preserved; lorebook entries stay consecutive", async () => {
    const deps = makeDeps();
    const links = [link("skill", "my-skill"), link("lorebook", "lore_1"), link("character", "char_1")];
    const items = await getCopilotContextItems(links, deps);
    expect(items.map((it) => it.type)).toEqual(["skill", "lorebook", "lorebook", "character"]);
    expect(items[1].id).toBe("entry_1");
    expect(items[2].id).toBe("entry_2");
  });
});

// ─── Render ──────────────────────────────────────────────────────────────────

describe("renderAttachedContext (CX-2)", () => {
  test("mixed set renders the framing header and per-kind block headers incl. Skill", () => {
    const rendered = renderAttachedContext([
      { type: "character", id: "c1", title: "Alice", content: "profile" },
      { type: "skill", id: "s1", title: "My Skill", content: "body" },
    ]);
    expect(rendered.startsWith("# Pinned context (read-only reference — do NOT edit)")).toBe(true);
    expect(rendered).toContain("## [Character] Alice");
    expect(rendered).toContain("## [Skill] My Skill");
  });

  test("empty or whitespace title falls back to (untitled)", () => {
    const rendered = renderAttachedContext([
      { type: "persona", id: "p1", title: "   ", content: "body" },
    ]);
    expect(rendered).toContain("## [Persona] (untitled)");
  });

  test("exact render pin on a minimal 1-item case", () => {
    const rendered = renderAttachedContext([
      { type: "character", id: "c1", title: "A", content: "BODY" },
    ]);
    expect(rendered).toBe("# Pinned context (read-only reference — do NOT edit)\n## [Character] A\nBODY");
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function skillsEntry(id: string): SkillCatalogEntry {
  return {
    id,
    source: "builtin",
    name: id,
    description: "desc",
    skillDir: `/skills/${id}`,
    manifestPath: `/skills/${id}/SKILL.md`,
    rootRelativeManifestPath: `${id}/SKILL.md`,
    shadowsBuiltin: false,
  };
}

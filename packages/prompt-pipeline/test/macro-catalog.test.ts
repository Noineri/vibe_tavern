import { describe, it, expect } from "bun:test";
import { getMacroCatalog, createFullMacroEngine } from "../src/macro-registry.ts";
import { MacroCategory } from "../src/macro-registry.ts";
import { buildPromptVariableContext } from "../src/prompt-variable-context.ts";

/**
 * Tests for the macro catalog — the displayable metadata layer over the registry
 * consumed by the editor autocomplete (and the Co-Author's allowed subset).
 *
 * The catalog is DERIVED from the registered resolvers (MacroEngine.catalog),
 * so these tests pin the invariant that keeps it from drifting: every surfaced
 * macro carries a description + category, aliases do not create duplicates, and
 * internal resolvers (banned) stay hidden.
 */

describe("macro catalog", () => {
  it("returns every cataloged resolver well-formed with valid category and aliases array", () => {
    const catalog = getMacroCatalog();
    const validCategories = new Set(Object.values(MacroCategory));
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(entry.name).toBeTruthy();
      expect(entry.description.length).toBeGreaterThan(0);
      expect(validCategories.has(entry.category)).toBe(true);
      expect(Array.isArray(entry.aliases)).toBe(true);
    }
  });

  it("de-duplicates by canonical name (aliases do not inflate the catalog)", () => {
    const catalog = getMacroCatalog();
    const names = catalog.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exposes the identity + pronoun macros the autocomplete and Co-Author rely on", () => {
    const byName = new Map(getMacroCatalog().map((e) => [e.name, e]));
    for (const name of ["user", "char", "persona", "sub", "obj", "poss", "poss_p", "ref"]) {
      expect(byName.has(name)).toBe(true);
    }
    expect(byName.get("user")!.category).toBe(MacroCategory.Identity);
    expect(byName.get("sub")!.category).toBe(MacroCategory.Pronouns);
    expect(byName.get("char")!.category).toBe(MacroCategory.Identity);
  });

  it("exposes aliases on canonical entries without promoting aliases to top-level catalog entries", () => {
    const catalog = getMacroCatalog();
    const names = new Set(catalog.map((e) => e.name));
    const withAliases = catalog.filter((e) => e.aliases.length > 0);
    expect(withAliases.length).toBeGreaterThanOrEqual(3);
    for (const entry of withAliases) {
      for (const alias of entry.aliases) {
        expect(names.has(alias)).toBe(false);
      }
    }
    const byName = new Map(catalog.map((e) => [e.name, e]));
    expect(byName.get("user")?.aliases).toEqual(["<USER>"]);
    expect(byName.get("char")?.aliases).toEqual(["<CHAR>", "<BOT>"]);
    expect(byName.get("idleDuration")?.aliases).toContain("idle_duration");

    const engine = createFullMacroEngine();
    const ctx = buildPromptVariableContext({ names: { userName: "Alice", charName: "Aria" } });
    expect(engine.resolve("<USER> <CHAR> <BOT> {{lastMessage}}", ctx)).toBe(
      engine.resolve("{{user}} {{char}} {{char}} {{lastChatMessage}}", ctx),
    );
  });

  it("hides internal resolvers (banned executes in the engine but stays out of the catalog)", () => {
    const engine = createFullMacroEngine();
    const ctx = buildPromptVariableContext({});
    // Unknown names stay literal; registered internal resolver `banned` executes and strips its tag.
    expect(engine.resolve("{{unknown_macro}}", ctx)).toBe("{{unknown_macro}}");
    expect(engine.resolve("keep {{banned::secret}}text", ctx)).toBe("keep text");

    const names = new Set(getMacroCatalog().map((e) => e.name));
    expect(names.has("banned")).toBe(false);
  });

  it("is stable across calls (cached) and matches a fresh engine's catalog", () => {
    const a = getMacroCatalog();
    const b = getMacroCatalog();
    expect(a).toBe(b); // same cached reference
    const fresh = createFullMacroEngine().catalog();
    expect(fresh).toEqual(a);
  });

  it("covers every category so the autocomplete grouping is never empty", () => {
    const cats = new Set(getMacroCatalog().map((e) => e.category));
    for (const c of Object.values(MacroCategory)) {
      expect(cats.has(c)).toBe(true);
    }
  });

  it("catalogs every added static-text macro and the idle_duration alias", () => {
    const byName = new Map(getMacroCatalog().map((entry) => [entry.name, entry]));
    for (const name of ["charPrompt", "charInstruction", "systemPrompt", "defaultSystemPrompt", "authorsNote", "defaultAuthorsNote", "charAuthorsNote", "groupNotMuted", "notChar", "reverse", "input", "datetimeformat", "idleDuration", "timeDiff", "time"]) {
      expect(byName.get(name)?.description).toBeTruthy();
    }
    expect(byName.get("idleDuration")?.aliases).toContain("idle_duration");
  });
});

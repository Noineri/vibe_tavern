import { describe, it, expect } from "bun:test";
import { getMacroCatalog, createFullMacroEngine } from "../src/macro-registry.ts";
import { MacroCategory } from "../src/macro-registry.ts";

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
  it("returns one entry per user-facing resolver, each well-formed", () => {
    const catalog = getMacroCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(entry.name).toBeTruthy();
      expect(entry.description.length).toBeGreaterThan(0);
      expect(typeof entry.category).toBe("string");
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

  it("keeps aliases reachable for search but inserts the canonical name", () => {
    const user = getMacroCatalog().find((e) => e.name === "user");
    expect(user?.aliases).toContain("<USER>");
    // The autocomplete inserts the canonical token, not the alias:
    expect(`{{${user!.name}}}`).toBe("{{user}}");
  });

  it("hides internal resolvers (banned is collected for logit bias, never authored)", () => {
    const names = new Set(getMacroCatalog().map((e) => e.name));
    expect(names.has("banned")).toBe(false);
  });

  it("is stable across calls (cached) and matches a fresh engine's catalog", () => {
    const a = getMacroCatalog();
    const b = getMacroCatalog();
    expect(a).toBe(b); // same cached reference
    const fresh = createFullMacroEngine().catalog();
    expect(fresh.map((e) => e.name)).toEqual(a.map((e) => e.name));
  });

  it("covers every category so the autocomplete grouping is never empty", () => {
    const cats = new Set(getMacroCatalog().map((e) => e.category));
    for (const c of Object.values(MacroCategory)) {
      expect(cats.has(c)).toBe(true);
    }
  });
});

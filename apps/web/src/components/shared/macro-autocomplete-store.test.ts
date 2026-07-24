import { describe, expect, it } from "vitest";
import type { MacroCatalogEntry } from "@vibe-tavern/prompt-pipeline";
import {
  filterMacros,
  orderMacrosForDisplay,
  readMacroQuery,
} from "./macro-autocomplete-store.js";

function entry(name: string, category: MacroCatalogEntry["category"], description = "", aliases: string[] = []): MacroCatalogEntry {
  return { name, category, description, aliases };
}

const CATALOG: MacroCatalogEntry[] = [
  entry("user", "identity", "The user's display name"),
  entry("char", "identity", "The character's name"),
  entry("persona", "identity", "The active persona's name"),
  entry("sub", "pronouns", "Subjective pronoun"),
  entry("obj", "pronouns", "Objective pronoun"),
  entry("time", "time", "Current time"),
  entry("random", "random", "Random pick"),
  entry("getvar", "variables", "Read a variable", ["get_var"]),
];

describe("orderMacrosForDisplay", () => {
  it("seeds identity before pronouns before alphabetical-by-name", () => {
    const ordered = orderMacrosForDisplay(CATALOG, []).map((e) => e.name);
    // identity (3) → pronouns (2) → remainder alphabetical: getvar, random, time
    expect(ordered).toEqual(["user", "char", "persona", "sub", "obj", "getvar", "random", "time"]);
  });

  it("hoists recently-picked names to the front in recency order", () => {
    const ordered = orderMacrosForDisplay(CATALOG, ["time", "user"]).map((e) => e.name);
    expect(ordered.slice(0, 2)).toEqual(["time", "user"]);
    // remainder still seed-ordered
    expect(ordered.slice(2)).toEqual(["char", "persona", "sub", "obj", "getvar", "random"]);
  });

  it("ignores recency names absent from the catalog", () => {
    const ordered = orderMacrosForDisplay(CATALOG, ["nope"]).map((e) => e.name);
    expect(ordered).toEqual(["user", "char", "persona", "sub", "obj", "getvar", "random", "time"]);
  });

  it("dedups recency", () => {
    const ordered = orderMacrosForDisplay(CATALOG, ["user", "user"]).map((e) => e.name);
    expect(ordered.filter((n) => n === "user")).toHaveLength(1);
    expect(ordered[0]).toBe("user");
  });
});

describe("filterMacros", () => {
  it("returns the whole catalog (up to limit) for an empty query", () => {
    expect(filterMacros(CATALOG, "")).toHaveLength(CATALOG.length);
  });

  it("matches by name substring (case-insensitive)", () => {
    const names = filterMacros(CATALOG, "GETV").map((e) => e.name);
    expect(names).toEqual(["getvar"]);
  });

  it("matches by description substring", () => {
    const names = filterMacros(CATALOG, "pronoun").map((e) => e.name);
    expect(names).toEqual(["sub", "obj"]);
  });

  it("matches by alias", () => {
    const names = filterMacros(CATALOG, "get_var").map((e) => e.name);
    expect(names).toEqual(["getvar"]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterMacros(CATALOG, "zzzzz")).toEqual([]);
  });

  it("caps results at the limit", () => {
    expect(filterMacros(CATALOG, "", 3)).toHaveLength(3);
  });
});

describe("readMacroQuery", () => {
  it("returns null when there is no {{", () => {
    expect(readMacroQuery("hello world", 11)).toBeNull();
  });

  it("returns empty string immediately after {{", () => {
    expect(readMacroQuery("hello {{", 8)).toBe("");
  });

  it("returns the query between {{ and the caret", () => {
    expect(readMacroQuery("hello {{us", 10)).toBe("us");
  });

  it("uses the last {{ when multiple are present", () => {
    expect(readMacroQuery("{{a{{b", 6)).toBe("b");
  });

  it("closes on a closing brace (the macro was completed)", () => {
    expect(readMacroQuery("{{user}}", 8)).toBeNull();
  });

  it("closes on a stray brace mid-query", () => {
    expect(readMacroQuery("{{us}r", 6)).toBeNull();
  });

  it("closes on a newline (multi-line token names are invalid)", () => {
    expect(readMacroQuery("{{\n", 3)).toBeNull();
  });

  it("closes on an absurdly long query", () => {
    const long = "{{" + "x".repeat(50);
    expect(readMacroQuery(long, long.length)).toBeNull();
  });
});

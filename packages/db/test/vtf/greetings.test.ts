import { describe, it, expect } from "bun:test";
import {
  greetingsFromCharacter,
  characterFromGreetings,
  compileGreetingsIndex,
  parseGreetingsIndex,
  writeGreetingsFolder,
  readGreetingsFolder,
  splitGreetingsInline,
  compileGreetingsInline,
  greetingIdFromIndex,
  indexFromGreetingId,
  isStableGreetingId,
  defaultGreetingName,
  type VtfGreeting,
} from "../../src/vtf/greetings.js";

// ─── Factories ─────────────────────────────────────────────────────────────

function makeGreetings(): VtfGreeting[] {
  return greetingsFromCharacter("Hello there!", ["Alt one body.", "Alt two body."]);
}

// ─── id helpers ────────────────────────────────────────────────────────────

describe("greetings: stable ids", () => {
  it("derives position-based ids (4-hex, zero-padded)", () => {
    expect(greetingIdFromIndex(0)).toBe("g_0000");
    expect(greetingIdFromIndex(1)).toBe("g_0001");
    expect(greetingIdFromIndex(15)).toBe("g_000f");
    expect(greetingIdFromIndex(256)).toBe("g_0100");
  });

  it("round-trips index ↔ id", () => {
    expect(indexFromGreetingId("g_0007")).toBe(7);
    expect(indexFromGreetingId("g_00ff")).toBe(255);
    expect(indexFromGreetingId("not-an-id")).toBeNull();
  });

  it("detects stable greeting ids", () => {
    expect(isStableGreetingId("g_0000")).toBe(true);
    expect(isStableGreetingId("g_00ab")).toBe(true);
    expect(isStableGreetingId("slug-from-title")).toBe(false);
    expect(isStableGreetingId("")).toBe(false);
  });

  it("derives default names from position", () => {
    expect(defaultGreetingName(0)).toBe("First Message");
    expect(defaultGreetingName(1)).toBe("Alt 1");
    expect(defaultGreetingName(3)).toBe("Alt 3");
  });
});

// ─── Character ↔ greetings ─────────────────────────────────────────────────

describe("greetings: character ↔ greetings round-trip", () => {
  it("builds greetings from firstMessage + alternateGreetings", () => {
    const greetings = greetingsFromCharacter("Hi!", ["Alt A", "Alt B"]);
    expect(greetings).toHaveLength(3);
    expect(greetings[0]).toMatchObject({ id: "g_0000", primary: true, content: "Hi!", file: "g_0000.md" });
    expect(greetings[1]).toMatchObject({ id: "g_0001", primary: false, content: "Alt A" });
    expect(greetings[2]).toMatchObject({ id: "g_0002", primary: false, content: "Alt B" });
  });

  it("reduces greetings back to character fields (primary becomes firstMessage)", () => {
    const greetings = makeGreetings();
    const back = characterFromGreetings(greetings);
    expect(back).toEqual({ firstMessage: "Hello there!", alternateGreetings: ["Alt one body.", "Alt two body."] });
  });

  it("Form → greetings → Form is lossless", () => {
    const original = { firstMessage: "Primary text.\nTwo lines.", alternateGreetings: ["A", "B", "C"] };
    const back = characterFromGreetings(greetingsFromCharacter(original.firstMessage, original.alternateGreetings));
    expect(back).toEqual(original);
  });

  it("handles a single greeting (no alternates)", () => {
    const greetings = greetingsFromCharacter("Only one.", []);
    expect(greetings).toHaveLength(1);
    expect(characterFromGreetings(greetings)).toEqual({ firstMessage: "Only one.", alternateGreetings: [] });
  });

  it("handles an empty character gracefully", () => {
    const greetings = greetingsFromCharacter("", []);
    expect(characterFromGreetings(greetings)).toEqual({ firstMessage: "", alternateGreetings: [] });
  });
});

// ─── _index.yaml codec ─────────────────────────────────────────────────────

describe("greetings: _index.yaml round-trip", () => {
  it("compile → parse preserves id/name/file/primary for every entry, in order", () => {
    const greetings = makeGreetings();
    const yaml = compileGreetingsIndex(greetings);
    const parsed = parseGreetingsIndex(yaml);
    expect(parsed).toEqual([
      { id: "g_0000", name: "First Message", file: "g_0000.md", primary: true },
      { id: "g_0001", name: "Alt 1", file: "g_0001.md", primary: false },
      { id: "g_0002", name: "Alt 2", file: "g_0002.md", primary: false },
    ]);
  });

  it("is idempotent", () => {
    const yaml = compileGreetingsIndex(makeGreetings());
    expect(compileGreetingsIndex(parseGreetingsIndex(yaml).map((e) => ({
      id: e.id, name: e.name, file: e.file, primary: e.primary, content: "",
    } as VtfGreeting)))).toBe(yaml);
  });

  it("ignores comment lines and blank lines", () => {
    const yaml = [
      "# header comment",
      "",
      "- id: g_0000",
      "  name: First Message",
      "  file: g_0000.md",
      "  primary: true",
    ].join("\n");
    const parsed = parseGreetingsIndex(yaml);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "g_0000", primary: true });
  });
});

// ─── Folder codec ──────────────────────────────────────────────────────────

describe("greetings: folder codec round-trip", () => {
  it("writes a manifest + one .md per greeting", () => {
    const entries = writeGreetingsFolder(makeGreetings());
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["greetings/_index.yaml", "greetings/g_0000.md", "greetings/g_0001.md", "greetings/g_0002.md"]);
  });

  it("write → read preserves every greeting (id, name, primary, content)", () => {
    const original = makeGreetings();
    const entries = writeGreetingsFolder(original);
    const back = readGreetingsFolder(entries);
    expect(back).toEqual(original);
  });

  it("renaming-free across content edits: filenames are stable when only the body changes", () => {
    // Simulate an edit: same ids/order, only content differs.
    const edited: VtfGreeting[] = [
      { id: "g_0000", name: "First Message", file: "g_0000.md", primary: true, content: "EDITED primary body." },
      { id: "g_0001", name: "Alt 1", file: "g_0001.md", primary: false, content: "EDITED alt 1 body." },
      { id: "g_0002", name: "Alt 2", file: "g_0002.md", primary: false, content: "Alt two body." },
    ];
    const entries = writeGreetingsFolder(edited);
    const paths = entries.map((e) => e.path).sort();
    // Filenames unchanged vs the original codec output.
    expect(paths).toEqual(["greetings/_index.yaml", "greetings/g_0000.md", "greetings/g_0001.md", "greetings/g_0002.md"]);
    // Content of g_0001 reflects the edit.
    const alt1 = entries.find((e) => e.path === "greetings/g_0001.md")!;
    expect(alt1.content.trim()).toBe("EDITED alt 1 body.");
  });

  it("reordering updates only the manifest order; filenames stay the same", () => {
    const original = makeGreetings();
    // Move the last alt to the front (behind the primary).
    const reordered = [original[0]!, original[2]!, original[1]!];
    const entries = writeGreetingsFolder(reordered);
    const manifest = parseGreetingsIndex(entries.find((e) => e.path === "greetings/_index.yaml")!.content);
    expect(manifest.map((m) => m.id)).toEqual(["g_0000", "g_0002", "g_0001"]);
    // All three files still exist with their original filenames.
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["greetings/_index.yaml", "greetings/g_0000.md", "greetings/g_0001.md", "greetings/g_0002.md"]);
  });

  it("tolerates a missing _index.yaml (returns empty, never throws)", () => {
    expect(readGreetingsFolder([{ path: "greetings/g_0000.md", content: "x" }])).toEqual([]);
  });
});

// ─── Inline marker codec ───────────────────────────────────────────────────

describe("greetings: inline marker codec", () => {
  it("compiles a primary + alternates into a single text blob", () => {
    const text = compileGreetingsInline(greetingsFromCharacter("Primary body.", ["First alt.", "Second alt."]));
    expect(text).toBe("Primary body.\n\n=== ALT 1 ===\n\nFirst alt.\n\n=== ALT 2 ===\n\nSecond alt.\n");
  });

  it("split → compile is stable (canonical)", () => {
    const greetings = greetingsFromCharacter("P", ["A1", "A2"]);
    const text = compileGreetingsInline(greetings);
    const recompiled = compileGreetingsInline(splitGreetingsInline(text));
    expect(recompiled).toBe(text);
  });

  it("compile → split preserves the primary and alternates as character fields", () => {
    const greetings = greetingsFromCharacter("Primary body.", ["First alt.", "Second alt."]);
    const text = compileGreetingsInline(greetings);
    const back = characterFromGreetings(splitGreetingsInline(text));
    expect(back).toEqual({ firstMessage: "Primary body.", alternateGreetings: ["First alt.", "Second alt."] });
  });

  it("tolerates case-insensitive and loosely-spaced markers on parse", () => {
    const text = [
      "Primary body.",
      "=== alt ===",
      "Alt one.",
      "=== ALT 2 ===",
      "Alt two.",
    ].join("\n");
    const back = characterFromGreetings(splitGreetingsInline(text));
    expect(back).toEqual({ firstMessage: "Primary body.", alternateGreetings: ["Alt one.", "Alt two."] });
  });

  it("handles a primary-only blob (no markers)", () => {
    const text = "Just one greeting body.\nWith two lines.\n";
    const back = characterFromGreetings(splitGreetingsInline(text));
    expect(back).toEqual({ firstMessage: "Just one greeting body.\nWith two lines.", alternateGreetings: [] });
  });

  it("compiles an empty greeting list to an empty string", () => {
    expect(compileGreetingsInline([])).toBe("");
  });
});

// ─── Cross-representation consistency ──────────────────────────────────────

describe("greetings: folder ↔ inline consistency", () => {
  it("folder and inline representations describe the same character fields", () => {
    const firstMessage = "A multi-paragraph\n\ngreeting body.";
    const alternates = ["Alt with: a colon.", "Alt with \"quotes\" inside."];
    const greetings = greetingsFromCharacter(firstMessage, alternates);
    const fromFolder = characterFromGreetings(readGreetingsFolder(writeGreetingsFolder(greetings)));
    const fromInline = characterFromGreetings(splitGreetingsInline(compileGreetingsInline(greetings)));
    expect(fromFolder).toEqual({ firstMessage, alternateGreetings: alternates });
    expect(fromInline).toEqual({ firstMessage, alternateGreetings: alternates });
  });
});

import { describe, expect, test } from "bun:test";
import { parseStPersonas } from "./st-persona-parser.js";

/**
 * Characterization tests for parseStPersonas. Covers both SillyTavern import
 * shapes the UI must accept:
 *   1. ST settings.json — personas nested under `power_user` (the live-ST-data
 *      shape, the original import source via folder pick).
 *   2. ST backup / VT-export shape — personas at the top level (the shape
 *      VT's own `exportPersona("st")` emits, and the shape ST backups store).
 * Both must round-trip so a user can import a file VT itself exported.
 */

// ─── ST settings.json shape (power_user.*) ────────────────────────────────
const settingsJsonShape = {
  power_user: {
    personas: {
      "alice.png": "Alice",
      "bob.png": "Bob",
    },
    persona_descriptions: {
      "alice.png": { description: "Alice's persona", position: 0, depth: 2, role: 0 },
      "bob.png": { description: "Bob's persona", position: 0, depth: 2, role: 0 },
    },
    default_persona: "alice.png",
  },
};

// ─── ST backup / VT-export shape (top-level) ──────────────────────────────
const backupShape = {
  personas: {
    "carol.png": "Carol",
  },
  persona_descriptions: {
    "carol.png": { description: "Carol's persona", position: 0, depth: 2, role: 0 },
  },
  default_persona: "carol.png",
};

describe("parseStPersonas — settings.json shape (power_user.*)", () => {
  test("parses personas nested under power_user with descriptions + default", () => {
    const entries = parseStPersonas(settingsJsonShape);
    expect(entries.map((e) => e.name).sort()).toEqual(["Alice", "Bob"]);
    const alice = entries.find((e) => e.name === "Alice")!;
    expect(alice.description).toBe("Alice's persona");
    expect(alice.isDefault).toBe(true);
    expect(alice.key).toBe("alice.png");
    expect(alice.avatarRelativePath).toBe("User Avatars/alice.png");
    const bob = entries.find((e) => e.name === "Bob")!;
    expect(bob.isDefault).toBe(false);
  });

  test("returns empty for settings.json without power_user.personas", () => {
    expect(parseStPersonas({ power_user: {} })).toEqual([]);
    expect(parseStPersonas({ power_user: { personas: {} } })).toEqual([]);
  });
});

describe("parseStPersonas — backup / VT-export shape (top-level)", () => {
  test("parses top-level personas (the shape exportPersona('st') emits)", () => {
    const entries = parseStPersonas(backupShape);
    expect(entries).toHaveLength(1);
    const carol = entries[0];
    expect(carol.name).toBe("Carol");
    expect(carol.description).toBe("Carol's persona");
    expect(carol.key).toBe("carol.png");
    expect(carol.isDefault).toBe(true);
  });

  test("top-level shape wins when both top-level and power_user present", () => {
    // Ambiguous input: prefer the top-level (backup) shape — it is the more
    // specific intent (a backup file), and power_user may be incidental.
    const entries = parseStPersonas({
      ...backupShape,
      power_user: { personas: { "decoy.png": "Decoy" } },
    });
    expect(entries.map((e) => e.name)).toEqual(["Carol"]);
  });
});

describe("parseStPersonas — defensive", () => {
  test("returns empty for non-object input", () => {
    expect(parseStPersonas(null)).toEqual([]);
    expect(parseStPersonas("string")).toEqual([]);
    expect(parseStPersonas(42)).toEqual([]);
    expect(parseStPersonas([1, 2, 3])).toEqual([]);
  });

  test("skips entries with empty/missing names", () => {
    const entries = parseStPersonas({
      personas: { "good.png": "Good", "blank.png": "   ", "noname.png": 123 },
      persona_descriptions: {},
    });
    expect(entries.map((e) => e.name)).toEqual(["Good"]);
  });
});

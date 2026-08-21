/**
 * Rules starter catalog characterization tests (IR-81A).
 *
 * Pins the six shipped starters' structural validity, immutability,
 * self-containment (no host globals / internal imports), duplication
 * independence, and — critically — that each source registers successfully
 * through the real IR-12 sandbox and passes the authoritative definition
 * schema. Full action-sequence simulation arrives with IR-81B.
 */
import { describe, expect, it } from "bun:test";
import {
  createDeterministicRandom,
  discoverExperienceDefinition,
  runActions,
  runCreate,
  runProject,
  runReduce,
  type ExperienceCapabilityContext,
} from "../../../../services/api/src/domain/interactive/experience-kernel.js";
import {
  RULES_STARTERS,
  RULES_STARTER_SOURCES,
  getRulesStarter,
  rulesStarterToDraftValues,
  duplicateRulesValues,
} from "./experience-rules-starters.js";

const EXPECTED_IDS = ["round", "board", "card", "model_conversation", "catch_arcade", "blank_state_machine"];

// ─── Structural validity ─────────────────────────────────────────────────────

describe("rules starter catalog — structure", () => {
  it("ships exactly six starters with the expected ids in canonical order", () => {
    expect(RULES_STARTERS).toHaveLength(6);
    expect(RULES_STARTERS.map((s) => s.id)).toEqual(EXPECTED_IDS);
  });

  it("starter ids are unique", () => {
    const ids = RULES_STARTERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getRulesStarter resolves by id and returns undefined for unknown", () => {
    expect(getRulesStarter("round")?.label).toBe("Round");
    expect(getRulesStarter("nonexistent")).toBeUndefined();
  });

  it("every starter has non-empty label, description, and source", () => {
    for (const s of RULES_STARTERS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.source.length).toBeGreaterThan(0);
    }
  });

  it("RULES_STARTER_SOURCES has one entry per starter", () => {
    expect(RULES_STARTER_SOURCES).toHaveLength(6);
    expect(RULES_STARTER_SOURCES.every((src) => src.length > 0)).toBe(true);
  });
});

// ─── Immutability ────────────────────────────────────────────────────────────

describe("rules starter catalog — immutability", () => {
  it("the catalog and exported source arrays are frozen", () => {
    expect(Object.isFrozen(RULES_STARTERS)).toBe(true);
    expect(Object.isFrozen(RULES_STARTER_SOURCES)).toBe(true);
  });

  it("starter objects are frozen", () => {
    for (const s of RULES_STARTERS) {
      expect(Object.isFrozen(s)).toBe(true);
    }
  });
});

// ─── Self-containment: no host globals or internal imports ───────────────────

const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ESM import", re: /\bimport\s+[\w{]/ },
  { name: "require()", re: /\brequire\s*\(/ },
  { name: "window global", re: /\bwindow\b/ },
  { name: "document global", re: /\bdocument\b/ },
  { name: "fetch", re: /\bfetch\s*\(/ },
  { name: "process global", re: /\bprocess\b/ },
  { name: "globalThis", re: /\bglobalThis\b/ },
  { name: "eval", re: /\beval\s*\(/ },
  { name: "setTimeout", re: /\bsetTimeout\b/ },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
];

describe("rules starter catalog — no host globals / internal imports", () => {
  for (const source of RULES_STARTER_SOURCES) {
    const preview = source.slice(0, 32).replace(/\s+/g, " ");
    it(`source is self-contained (${preview}…)`, () => {
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        expect(re.test(source), `forbidden "${name}" found in source`).toBe(false);
      }
    });
  }
});

// ─── Real IR-12 sandbox discovery ────────────────────────────────────────────

function starterCaps(id: string): ExperienceCapabilityContext {
  if (id === "round") {
    return {
      participants: [
        { id: "p1", label: "One", controller: "human" },
        { id: "p2", label: "Two", controller: "human" },
      ],
    };
  }
  if (id === "card") return { random: createDeterministicRandom(42) };
  return {};
}

describe("rules starter catalog — real kernel boundary", () => {
  for (const starter of RULES_STARTERS) {
    it(`${starter.label} (${starter.id}) discovers and completes one transition`, () => {
      const scriptName = `${starter.id}.js`;
      const discovered = discoverExperienceDefinition(starter.source, scriptName);
      expect(discovered.ok).toBe(true);
      if (!discovered.ok) throw new Error(discovered.message);
      expect(discovered.definition.manifest.id).toBe(starter.id);

      const caps = starterCaps(starter.id);
      const created = runCreate(starter.source, scriptName, {}, caps);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.message);

      const viewer = { kind: "observer" as const };
      const projection = runProject(starter.source, scriptName, created.value, viewer, caps);
      expect(projection.ok).toBe(true);
      if (!projection.ok) throw new Error(projection.message);

      const legal = runActions(starter.source, scriptName, created.value, viewer, caps);
      expect(legal.ok).toBe(true);
      if (!legal.ok) throw new Error(legal.message);
      expect(legal.value.length).toBeGreaterThan(0);

      const first = legal.value[0];
      if (!first) throw new Error("starter returned no legal action");
      const transition = runReduce(starter.source, scriptName, created.value, {
        type: first.type,
        requestId: `req_${starter.id}`,
        expectedRevision: 0,
        ...(starter.id === "model_conversation" ? { payload: "Hello" } : {}),
      }, caps);
      expect(transition.ok).toBe(true);
      if (!transition.ok) throw new Error(transition.message);
    });
  }
});

// ─── Duplication independence ────────────────────────────────────────────────

describe("rules starter duplication — values are independent copies", () => {
  it("rulesStarterToDraftValues produces a copy that does not reference the starter", () => {
    const starter = getRulesStarter("round")!;
    const values = rulesStarterToDraftValues(starter);
    expect(values).toEqual({
      name: starter.label,
      description: starter.description,
      code: starter.source,
      scriptKind: "interactive",
      enabled: false,
    });
    // Mutating the copy must not affect the frozen starter.
    values.name = "Changed";
    values.code = "changed";
    expect(starter.label).toBe("Round");
    expect(starter.source).not.toBe("changed");
  });

  it("duplicateRulesValues produces a deep copy independent of the source", () => {
    const original = { name: "Original", description: "Description", code: "original code" };
    const copy = duplicateRulesValues(original);
    expect(copy).toEqual({ ...original, scriptKind: "interactive", enabled: false });
    expect(copy).not.toBe(original);

    copy.name = "Copy";
    copy.code = "copy code";
    expect(original.name).toBe("Original");
    expect(original.code).toBe("original code");
  });

  it("duplicating from a starter produces values usable as createScript input", () => {
    const starter = getRulesStarter("board")!;
    const values = rulesStarterToDraftValues(starter);
    expect(values.scriptKind).toBe("interactive");
    expect(values.enabled).toBe(false);
    expect(values.code).toContain("context.experience.register");
  });
});

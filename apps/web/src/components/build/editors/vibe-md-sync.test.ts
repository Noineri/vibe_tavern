import { describe, expect, test } from "bun:test";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import {
  applyBodyToDraft,
  draftToBody,
  pinBodyFields,
  pinGreetingsFields,
  altIndexAt,
  bodyIsCanonical,
} from "./vibe-md-sync.js";

/**
 * VTF-12 — Vibe MD sync core.
 *
 * Pinning the round-trip invariants and the Threat 2 structural-pin guarantee:
 * the canonical heading set self-heals on save regardless of what broke it.
 * Pure-function tests — no DOM, no CodeMirror.
 */

/** A fully-populated draft exercising every prose field. */
function fullDraft(): BuildCharacterDraft {
  return {
    name: "Silvius",
    description: "Silver-haired butler with a secret.",
    firstMessage: "Dinner is served, my lord.",
    mesExample: "{{char}}: *bows* Welcome home.\n{{user}}: At ease.",
    mesExampleMode: "always",
    mesExampleDepth: 4,
    scenario: "Modern day; inherited estate.",
    personalitySummary: "",
    systemPrompt: "You are Silvius.",
    alternateGreetings: [],
    postHistoryInstructions: "Stay in character.",
    creatorNotes: "A butler OC.",
    depthPrompt: "Hint: werewolf instincts.",
    depthPromptDepth: 4,
    depthPromptRole: "system",
    tags: ["fantasy", "butler"],
  };
}

const allHeadings = (body: string): string[] =>
  body.split("\n").filter((l) => /^# /.test(l)).map((l) => l.slice(2));

// ───────────────────────────────────────────────────────────────────────────

describe("draftToBody: canonical emission", () => {
  test("emits PERSONALITY/SCENARIO/EXAMPLES/GREETINGS in fixed order when populated", () => {
    const body = draftToBody(fullDraft());
    expect(allHeadings(body)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES", "GREETINGS"]);
  });
  test("contains NO frontmatter (body only)", () => {
    const body = draftToBody(fullDraft());
    expect(body.startsWith("---")).toBe(false);
    expect(body).not.toMatch(/^name:/m);
    expect(body).not.toMatch(/^tags:/m);
  });
  test("always emits all FOUR headings even when prose fields are empty (stable skeleton)", () => {
    const draft = { ...fullDraft(), description: "", scenario: "", mesExample: "" };
    const body = draftToBody(draft);
    expect(body).toContain("# PERSONALITY");
    // PERSONALITY body is empty even though the heading is always present.
    expect(pinBodyFields(body).description).toBe("");
    // The editor skeleton ALWAYS shows all four headings (storage still omits
    // empty SCENARIO/EXAMPLES; the editor pads them for a stable view).
    expect(allHeadings(body)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES", "GREETINGS"]);
  });
  test("ALWAYS emits SCENARIO/EXAMPLES headings even when their fields are empty (skeleton)", () => {
    const draft = { ...fullDraft(), scenario: "", mesExample: "" };
    const body = draftToBody(draft);
    expect(body).toContain("# PERSONALITY");
    expect(body).toContain("# SCENARIO");
    expect(body).toContain("# EXAMPLES");
    expect(body).toContain("# GREETINGS");
    // But the fields parse back to empty (the headings are bare).
    expect(pinBodyFields(body).scenario).toBe("");
    expect(pinBodyFields(body).mesExample).toBe("");
  });
  test("does NOT emit functional/instruction sections (prose-only)", () => {
    const body = draftToBody(fullDraft());
    expect(body).not.toContain("# SYSTEM");
    expect(body).not.toContain("# POST-HISTORY");
    expect(body).not.toContain("# DEPTH PROMPT");
  });
  test("instructions/metadata are NOT carried in the body, but GREETINGS are", () => {
    const body = draftToBody(fullDraft());
    expect(body).not.toContain("Silvius"); // name lives in frontmatter, not body
    expect(body).not.toContain("You are Silvius"); // systemPrompt → instructions.json
    expect(body).not.toContain("Stay in character"); // postHistoryInstructions → instructions.json
    expect(body).not.toContain("werewolf instincts"); // depthPrompt → instructions.json
    expect(body).not.toContain("# SYSTEM");
    expect(body).not.toContain("# POST-HISTORY");
    expect(body).not.toContain("# DEPTH PROMPT");
    // GREETINGS ARE carried in the body now (the # GREETINGS section).
    expect(body).toContain("# GREETINGS");
    expect(body).toContain("Dinner is served"); // firstMessage → # GREETINGS primary
    // (mesExample appears via # EXAMPLES — that is correct.)
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("pinBodyFields / applyBodyToDraft: extraction", () => {
  test("extracts the three prose sections into fields", () => {
    const body = "# PERSONALITY\nP body.\n\n# SCENARIO\nS body.\n\n# EXAMPLES\nE body.";
    expect(pinBodyFields(body)).toEqual({
      description: "P body.",
      scenario: "S body.",
      mesExample: "E body.",
    });
  });
  test("missing optional sections yield empty strings (not null)", () => {
    const body = "# PERSONALITY\nOnly personality.";
    expect(pinBodyFields(body)).toEqual({
      description: "Only personality.",
      scenario: "",
      mesExample: "",
    });
  });
  test("applyBodyToDraft preserves non-body fields; body fields are overwritten", () => {
    // The body owns description/scenario/mesExample + firstMessage/alternateGreetings
    // (via # GREETINGS). A body with no GREETINGS clears firstMessage/alternates.
    const draft = fullDraft();
    const updated = applyBodyToDraft("# PERSONALITY\nNew desc.", draft);
    expect(updated.description).toBe("New desc.");
    expect(updated.scenario).toBe("");
    expect(updated.mesExample).toBe("");
    expect(updated.firstMessage).toBe(""); // no # GREETINGS in the body
    expect(updated.alternateGreetings).toEqual([]);
    // Untouched (accordion-owned) fields pass through verbatim.
    expect(updated.name).toBe(draft.name);
    expect(updated.systemPrompt).toBe(draft.systemPrompt);
    expect(updated.tags).toEqual(draft.tags);
    expect(updated.depthPromptDepth).toBe(draft.depthPromptDepth);
  });
  test("malformed MD never throws (graceful fallback)", () => {
    expect(() => pinBodyFields("")).not.toThrow();
    expect(() => pinBodyFields("garbage with no headings")).not.toThrow();
    expect(() => pinBodyFields("# PERSONALITY\n\n\n\n")).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("Round-trip identity: draft → body → draft", () => {
  test("prose fields survive the round-trip on a fully-populated draft", () => {
    const draft = fullDraft();
    const roundTrip = applyBodyToDraft(draftToBody(draft), draft);
    expect(roundTrip.description).toBe(draft.description);
    expect(roundTrip.scenario).toBe(draft.scenario);
    expect(roundTrip.mesExample).toBe(draft.mesExample);
  });
  test("round-trip is stable on a minimal draft (empty optionals)", () => {
    const draft = { ...fullDraft(), scenario: "", mesExample: "", description: "Solo." };
    const once = applyBodyToDraft(draftToBody(draft), draft);
    const twice = applyBodyToDraft(draftToBody(once), once);
    expect(twice).toEqual(once); // idempotent
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("Threat 2: structural pinning self-heals headings", () => {
  test("a DELETED # PERSONALITY is restored on re-emission", () => {
    // Body with PERSONALITY removed entirely (only SCENARIO + EXAMPLES remain).
    const broken = "# SCENARIO\nSome scenario.\n\n# EXAMPLES\nSome example.";
    const healed = applyBodyToDraft(broken, fullDraft());
    // The missing PERSONALITY → empty description; draftToBody re-emits the heading.
    expect(healed.description).toBe("");
    const reEmitted = draftToBody(healed);
    expect(reEmitted).toContain("# PERSONALITY");
    expect(allHeadings(reEmitted)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES", "GREETINGS"]);
  });
  test("a MALFORMED heading (## PERSONALITY, wrong level) does not populate the field", () => {
    // `##` is H2, not recognized as the PERSONALITY section → content ignored.
    const malformed = "## PERSONALITY\nThis should not become the description.";
    const pinned = pinBodyFields(malformed);
    expect(pinned.description).toBe("");
  });
  test("a RENAMED heading (# Personality, wrong label) does not populate the field", () => {
    const renamed = "# Personality\nWrong label content.";
    const pinned = pinBodyFields(renamed);
    expect(pinned.description).toBe("");
  });
  test("canonical order is enforced regardless of body order", () => {
    // Body with sections in wrong order → pinned fields → re-emitted in canonical order.
    const reordered = "# EXAMPLES\nE.\n\n# PERSONALITY\nP.\n\n# SCENARIO\nS.";
    const healed = draftToBody(applyBodyToDraft(reordered, fullDraft()));
    expect(allHeadings(healed)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES", "GREETINGS"]);
  });
  test("LLM-style wholesale replace carrying a broken heading self-heals through apply→emit", () => {
    // Simulate a Co-Author Apply that returned a document with a broken heading.
    const llmOutput = "# personality\nLLM rewrote it lowercase.\n\n# SCENARIO\nNew scenario.";
    const applied = applyBodyToDraft(llmOutput, fullDraft());
    // `# personality` (lowercase) is NOT the canonical PERSONALITY → description empty.
    expect(applied.description).toBe("");
    expect(applied.scenario).toBe("New scenario.");
    // On save, the canonical heading is restored; the skeleton always re-emits
    // all four headings (EXAMPLES bare since mesExample ended up empty).
    const saved = draftToBody(applied);
    expect(saved).toContain("# PERSONALITY");
    expect(allHeadings(saved)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES", "GREETINGS"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("# GREETINGS section round-trip (primary + alternates)", () => {
  test("draftToBody emits # GREETINGS with the primary greeting inline", () => {
    const body = draftToBody(fullDraft());
    expect(body).toContain("# GREETINGS");
    expect(body).toContain("Dinner is served, my lord.");
  });
  test("draftToBody emits === ALT N === markers for alternates", () => {
    const draft = { ...fullDraft(), alternateGreetings: ["Alt one.", "Alt two."] };
    const body = draftToBody(draft);
    expect(body).toContain("=== ALT 1 ===");
    expect(body).toContain("Alt one.");
    expect(body).toContain("=== ALT 2 ===");
    expect(body).toContain("Alt two.");
  });
  test("# GREETINGS is always emitted even when firstMessage is empty", () => {
    const draft = { ...fullDraft(), firstMessage: "", alternateGreetings: [] };
    const body = draftToBody(draft);
    expect(allHeadings(body)).toContain("GREETINGS");
  });
  test("pinGreetingsFields extracts primary + alternates back", () => {
    const body = draftToBody({ ...fullDraft(), alternateGreetings: ["Alt one."] });
    expect(pinGreetingsFields(body)).toEqual({
      firstMessage: "Dinner is served, my lord.",
      alternateGreetings: ["Alt one."],
    });
  });
  test("firstMessage + alternateGreetings survive the full round-trip", () => {
    const draft = { ...fullDraft(), alternateGreetings: ["Alt one.", "Alt two."] };
    const roundTrip = applyBodyToDraft(draftToBody(draft), draft);
    expect(roundTrip.firstMessage).toBe(draft.firstMessage);
    expect(roundTrip.alternateGreetings).toEqual(draft.alternateGreetings);
  });
  test("a body with no # GREETINGS yields empty greetings (tolerant)", () => {
    const body = "# PERSONALITY\nJust personality.";
    expect(pinGreetingsFields(body)).toEqual({ firstMessage: "", alternateGreetings: [] });
  });
  test("altIndexAt maps a marker line offset to its 0-based alternate slot", () => {
    const draft = { ...fullDraft(), alternateGreetings: ["Alt one.", "Alt two."] };
    const body = draftToBody(draft);
    // Find the two `=== ALT` marker line starts.
    const offsets: number[] = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "=" && /^[=\-]{3}\s*(?:alt|ALT)/.test(body.slice(i))) {
        // Line start = back up to start of line.
        let s = i;
        while (s > 0 && body[s - 1] !== "\n") s--;
        offsets.push(s);
      }
    }
    expect(offsets.length).toBe(2);
    expect(altIndexAt(body, offsets[0]!)).toBe(0); // ALT 1 → index 0
    expect(altIndexAt(body, offsets[1]!)).toBe(1); // ALT 2 → index 1
    // A non-marker offset returns -1.
    expect(altIndexAt(body, 0)).toBe(-1);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("bodyIsCanonical", () => {
  test("true when body equals the canonical emission of its own pinned fields", () => {
    const draft = fullDraft();
    const canonical = draftToBody(draft);
    expect(bodyIsCanonical(canonical, draft)).toBe(true);
  });
  test("false when body has non-canonical whitespace/heading drift", () => {
    const draft = fullDraft();
    const canonical = draftToBody(draft);
    const drifted = canonical.replace("# PERSONALITY", "#  PERSONALITY");
    expect(bodyIsCanonical(drifted, draft)).toBe(false);
  });
  test("true after a pin round-trip stabilizes a drifted body", () => {
    const draft = fullDraft();
    const drifted = draftToBody(draft).replace("# PERSONALITY", "#  PERSONALITY");
    const stabilized = draftToBody(applyBodyToDraft(drifted, draft));
    expect(bodyIsCanonical(stabilized, draft)).toBe(true);
  });
});

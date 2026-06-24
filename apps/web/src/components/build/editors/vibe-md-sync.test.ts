import { describe, expect, test } from "bun:test";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import {
  applyBodyToDraft,
  draftToBody,
  pinBodyFields,
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
  test("emits PERSONALITY/SCENARIO/EXAMPLES in fixed order when populated", () => {
    const body = draftToBody(fullDraft());
    expect(allHeadings(body)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES"]);
  });
  test("contains NO frontmatter (body only)", () => {
    const body = draftToBody(fullDraft());
    expect(body.startsWith("---")).toBe(false);
    expect(body).not.toMatch(/^name:/m);
    expect(body).not.toMatch(/^tags:/m);
  });
  test("always emits # PERSONALITY even when description is empty", () => {
    // Minimal draft: only PERSONALITY can appear, so a bare heading is observable.
    const draft = { ...fullDraft(), description: "", scenario: "", mesExample: "" };
    const body = draftToBody(draft);
    expect(body).toContain("# PERSONALITY");
    // Bare heading with no body (nothing follows but whitespace/EOF).
    const idx = body.indexOf("# PERSONALITY");
    expect(body.slice(idx + "# PERSONALITY".length).trim()).toBe("");
  });
  test("omits SCENARIO/EXAMPLES when their fields are empty", () => {
    const draft = { ...fullDraft(), scenario: "", mesExample: "" };
    const body = draftToBody(draft);
    expect(body).toContain("# PERSONALITY");
    expect(body).not.toContain("# SCENARIO");
    expect(body).not.toContain("# EXAMPLES");
  });
  test("does NOT emit functional/instruction sections (prose-only)", () => {
    const body = draftToBody(fullDraft());
    expect(body).not.toContain("# SYSTEM");
    expect(body).not.toContain("# POST-HISTORY");
    expect(body).not.toContain("# DEPTH PROMPT");
  });
  test("instructions/metadata/greetings are NOT carried in the body (prose fields only)", () => {
    const body = draftToBody(fullDraft());
    expect(body).not.toContain("Silvius"); // name lives in frontmatter, not body
    expect(body).not.toContain("Dinner is served"); // firstMessage → greetings, not body
    expect(body).not.toContain("You are Silvius"); // systemPrompt → instructions.json
    expect(body).not.toContain("Stay in character"); // postHistoryInstructions → instructions.json
    expect(body).not.toContain("werewolf instincts"); // depthPrompt → instructions.json
    expect(body).not.toContain("# SYSTEM");
    expect(body).not.toContain("# POST-HISTORY");
    expect(body).not.toContain("# DEPTH PROMPT");
    // (mesExample DOES appear in the body via # EXAMPLES — that is correct.)
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
  test("applyBodyToDraft preserves all non-prose draft fields", () => {
    const draft = fullDraft();
    const updated = applyBodyToDraft("# PERSONALITY\nNew desc.", draft);
    expect(updated.description).toBe("New desc.");
    expect(updated.scenario).toBe("");
    expect(updated.mesExample).toBe("");
    // Untouched fields pass through verbatim.
    expect(updated.name).toBe(draft.name);
    expect(updated.systemPrompt).toBe(draft.systemPrompt);
    expect(updated.firstMessage).toBe(draft.firstMessage);
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
    expect(allHeadings(reEmitted)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES"]);
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
    expect(allHeadings(healed)).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES"]);
  });
  test("LLM-style wholesale replace carrying a broken heading self-heals through apply→emit", () => {
    // Simulate a Co-Author Apply that returned a document with a broken heading.
    const llmOutput = "# personality\nLLM rewrote it lowercase.\n\n# SCENARIO\nNew scenario.";
    const applied = applyBodyToDraft(llmOutput, fullDraft());
    // `# personality` (lowercase) is NOT the canonical PERSONALITY → description empty.
    expect(applied.description).toBe("");
    expect(applied.scenario).toBe("New scenario.");
    // On save, the canonical heading is restored.
    const saved = draftToBody(applied);
    expect(saved).toContain("# PERSONALITY");
    expect(allHeadings(saved)).toEqual(["PERSONALITY", "SCENARIO"]);
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

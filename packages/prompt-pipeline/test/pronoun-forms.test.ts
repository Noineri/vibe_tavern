import { describe, expect, test } from "bun:test";
import type { PronounForms } from "@vibe-tavern/domain";
import { PRESET_PRONOUN_FORMS, resolvePronounForms } from "../src/pronoun-forms.js";
import { createFullMacroEngine } from "../src/macro-registry.js";
import type { PromptVariableContext } from "../src/prompt-variable-context.js";

/** Minimal variable context — only `persona` matters for the pronoun macros. */
function ctx(persona: PromptVariableContext["persona"]): PromptVariableContext {
  return {
    names: { userName: "User", charName: "Assistant" },
    persona,
    character: { name: "", description: "", personality: null, scenario: null },
    prompt: { system: "", jailbreak: "", summary: "", tools: "", prefill: null, authorsNote: null, authorsNoteDepth: null, customInjections: [], promptOrder: [], original: null, contextBudget: null, maxResponseTokens: null },
    chat: { messages: [], messageIds: [] },
    runtime: { contextBudget: null, maxPromptTokens: null },
  } as unknown as PromptVariableContext;
}

describe("PRESET_PRONOUN_FORMS", () => {
  test("all four presets present and keyed by the full slash strings", () => {
    expect(Object.keys(PRESET_PRONOUN_FORMS).sort()).toEqual(["he/him", "it/its", "she/her", "they/them"]);
  });

  test("he/him declension", () => {
    expect(PRESET_PRONOUN_FORMS["he/him"]).toEqual({
      subjective: "he", objective: "him", possessive: "his", possessivePronoun: "his", reflexive: "himself",
    });
  });

  test("she/her declension", () => {
    expect(PRESET_PRONOUN_FORMS["she/her"]).toEqual({
      subjective: "she", objective: "her", possessive: "her", possessivePronoun: "hers", reflexive: "herself",
    });
  });

  test("they/them declension", () => {
    expect(PRESET_PRONOUN_FORMS["they/them"]).toEqual({
      subjective: "they", objective: "them", possessive: "their", possessivePronoun: "theirs", reflexive: "themselves",
    });
  });

  test("it/its declension", () => {
    expect(PRESET_PRONOUN_FORMS["it/its"]).toEqual({
      subjective: "it", objective: "it", possessive: "its", possessivePronoun: "its", reflexive: "itself",
    });
  });
});

describe("resolvePronounForms", () => {
  test("custom pronounForms take precedence over the preset key", () => {
    const forms: PronounForms = { subjective: "ze", objective: "zir", possessive: "zir", possessivePronoun: "zirs", reflexive: "zirself" };
    expect(resolvePronounForms({ pronouns: "he/him", pronounForms: forms })).toEqual(forms);
  });

  test("preset key resolves when pronounForms is null", () => {
    expect(resolvePronounForms({ pronouns: "she/her", pronounForms: null })).toEqual(PRESET_PRONOUN_FORMS["she/her"]);
  });

  test.each(["he/him", "she/her", "they/them", "it/its"] as const)("preset %s resolves", (key) => {
    expect(resolvePronounForms({ pronouns: key, pronounForms: null })).toEqual(PRESET_PRONOUN_FORMS[key]);
  });

  test("unrecognized free-text pronouns (legacy custom) resolve to null", () => {
    expect(resolvePronounForms({ pronouns: "ze/zir", pronounForms: null })).toBeNull();
  });

  test("'custom' discriminator without structured forms resolves to null", () => {
    expect(resolvePronounForms({ pronouns: "custom", pronounForms: null })).toBeNull();
  });

  test("null pronouns and null forms resolve to null", () => {
    expect(resolvePronounForms({ pronouns: null, pronounForms: null })).toBeNull();
  });
});

describe("pronoun macros ({{sub}}/{{obj}}/{{poss}}/{{poss_p}}/{{ref}})", () => {
  const engine = createFullMacroEngine();

  test("preset they/them expands all five macros", () => {
    const c = ctx({ name: "A", description: "", pronouns: "they/them", pronounForms: null, avatarAssetId: null });
    const sentence = "{{sub}}|{{obj}}|{{poss}}|{{poss_p}}|{{ref}}";
    expect(engine.resolve(sentence, c)).toBe("they|them|their|theirs|themselves");
  });

  test("custom neopronouns expand from pronounForms", () => {
    const c = ctx({
      name: "A", description: "", pronouns: "custom",
      pronounForms: { subjective: "ze", objective: "zir", possessive: "zir", possessivePronoun: "zirs", reflexive: "zirself" },
      avatarAssetId: null,
    });
    expect(engine.resolve("{{sub}}|{{obj}}|{{poss}}|{{poss_p}}|{{ref}}", c)).toBe("ze|zir|zir|zirs|zirself");
  });

  test("no persona (null forms, null pronouns) → macros expand to empty", () => {
    const c = ctx({ name: "", description: "", pronouns: null, pronounForms: null, avatarAssetId: null });
    expect(engine.resolve("[{{sub}}][{{obj}}][{{poss}}][{{poss_p}}][{{ref}}]", c)).toBe("[][][][][]");
  });

  test("macros are case-insensitive (name normalized to lowercase)", () => {
    const c = ctx({ name: "A", description: "", pronouns: null, pronounForms: null, avatarAssetId: null });
    // {{SUB}} normalizes to "sub"; with no persona it resolves to empty.
    expect(engine.resolve("{{SUB}} stays unknown", c)).toBe(" stays unknown");
  });

  test("existing {{user}} macro is unaffected by pronoun registration", () => {
    const c = ctx({ name: "A", description: "", pronouns: "he/him", pronounForms: null, avatarAssetId: null });
    expect(engine.resolve("{{user}} uses {{poss}}", c)).toBe("User uses his");
  });
});

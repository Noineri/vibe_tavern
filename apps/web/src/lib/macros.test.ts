import { describe, expect, it } from "bun:test";
import { replaceUiMacros } from "./macros.js";

describe("replaceUiMacros", () => {
  const baseCtx = {
    characterName: "Aria",
    personaName: "Noineri",
    personaDescription: "a curious traveler",
  };

  // ── Characterization (existing behavior, pre-pronoun extension) ──
  it("resolves {{char}} and {{user}}", () => {
    expect(replaceUiMacros("{{char}} meets {{user}}.", baseCtx)).toBe("Aria meets Noineri.");
  });

  it("falls back to 'User' when personaName is empty/whitespace", () => {
    expect(replaceUiMacros("Hi {{user}}", { ...baseCtx, personaName: "   " })).toBe("Hi User");
  });

  it("resolves {{persona}} to the persona description", () => {
    expect(replaceUiMacros("[{{persona}}]", baseCtx)).toBe("[a curious traveler]");
  });

  it("resolves legacy <USER>/<BOT>/<CHAR> tokens", () => {
    expect(replaceUiMacros("<USER> → <BOT>", baseCtx)).toBe("Noineri → Aria");
    expect(replaceUiMacros("<CHAR>", baseCtx)).toBe("Aria");
  });

  it("is case-insensitive on macro names", () => {
    expect(replaceUiMacros("{{CHAR}} and {{User}}", baseCtx)).toBe("Aria and Noineri");
  });

  it("tolerates inner whitespace in macros", () => {
    expect(replaceUiMacros("{{ char }} / {{ user }}", baseCtx)).toBe("Aria / Noineri");
  });

  it("returns empty/falsy text unchanged", () => {
    expect(replaceUiMacros("", baseCtx)).toBe("");
  });

  it("leaves unknown macros intact", () => {
    expect(replaceUiMacros("{{unknown_macro}} stays", baseCtx)).toBe("{{unknown_macro}} stays");
  });

  // ── Pronoun resolution (new behavior) ──
  describe("pronouns — preset key", () => {
    it("resolves VT-native macros for she/her", () => {
      const ctx = { ...baseCtx, personaPronouns: "she/her", personaPronounForms: null };
      expect(replaceUiMacros("{{sub}} grabbed {{poss}} bag.", ctx)).toBe("she grabbed her bag.");
    });

    it("resolves obj / poss_p / ref", () => {
      const ctx = { ...baseCtx, personaPronouns: "he/him", personaPronounForms: null };
      expect(replaceUiMacros("saw {{obj}}. the bag is {{poss_p}}. {{sub}} did it {{ref}}.", ctx))
        .toBe("saw him. the bag is his. he did it himself.");
    });

    it("resolves they/them forms", () => {
      const ctx = { ...baseCtx, personaPronouns: "they/them", personaPronounForms: null };
      expect(replaceUiMacros("{{sub}} brought {{poss}} things.", ctx)).toBe("they brought their things.");
    });

    it("resolves ST-extension dotted aliases", () => {
      const ctx = { ...baseCtx, personaPronouns: "she/her", personaPronounForms: null };
      expect(replaceUiMacros("{{pronoun.subjective}}/{{pronoun.objective}}", ctx)).toBe("she/her");
      expect(replaceUiMacros("{{pronoun.pos_det}} / {{pronoun.pos_pro}}", ctx)).toBe("her / hers");
      expect(replaceUiMacros("{{pronoun.reflexive}}", ctx)).toBe("herself");
    });
  });

  describe("pronouns — custom forms take precedence over preset", () => {
    it("uses personaPronounForms when set, ignoring the preset key", () => {
      const ctx = {
        ...baseCtx,
        personaPronouns: "she/her", // would normally give "she"
        personaPronounForms: {
          subjective: "ze", objective: "zir", possessive: "zir", possessivePronoun: "zirs", reflexive: "zirself",
        },
      };
      expect(replaceUiMacros("{{sub}} lost {{poss}} map; it is {{poss_p}}.", ctx))
        .toBe("ze lost zir map; it is zirs.");
    });
  });

  describe("pronouns — no forms available", () => {
    it("expands to empty string when no persona pronouns set", () => {
      const ctx = { ...baseCtx, personaPronouns: null, personaPronounForms: null };
      expect(replaceUiMacros("[{{sub}}]", ctx)).toBe("[]");
    });

    it("expands to empty string for unrecognized preset key", () => {
      const ctx = { ...baseCtx, personaPronouns: "xe/xem", personaPronounForms: null };
      expect(replaceUiMacros("[{{sub}}]", ctx)).toBe("[]");
    });
  });

  // ── Combined ──
  it("resolves user + char + pronouns together", () => {
    const ctx = { ...baseCtx, personaPronouns: "she/her", personaPronounForms: null };
    expect(replaceUiMacros("{{char}} handed {{user}} {{poss}} coat.", ctx))
      .toBe("Aria handed Noineri her coat.");
  });

  it("{{poss}} does not bleed into {{poss_p}}", () => {
    const ctx = { ...baseCtx, personaPronouns: "she/her", personaPronounForms: null };
    // 'her' vs 'hers' — the {{poss}} regex must not partially match inside {{poss_p}}
    expect(replaceUiMacros("{{poss}}|{{poss_p}}", ctx)).toBe("her|hers");
  });
});

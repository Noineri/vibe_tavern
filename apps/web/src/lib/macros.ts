import type { PronounForms } from "@vibe-tavern/domain";
import { PRESET_PRONOUN_FORMS, resolvePronounForms } from "@vibe-tavern/prompt-pipeline";

export interface MacroContext {
  characterName: string;
  personaName?: string | null;
  personaDescription?: string | null;
  /** Slash-string preset key (e.g. "she/her") — resolves via PRESET_PRONOUN_FORMS. */
  personaPronouns?: string | null;
  /** Structured custom forms — takes precedence over the preset key when set. */
  personaPronounForms?: PronounForms | null;
}

/**
 * Apply macro resolution for DISPLAY ONLY. This is the thin frontend mirror of
 * the backend macro engine (`packages/prompt-pipeline`): it substitutes only
 * the user-facing macros (`{{user}}`/`{{char}}`/`{{persona}}` + pronoun forms)
 * so the chat view shows resolved text. The RAW string stays canonical in the
 * DB; the backend re-resolves at prompt-assembly time so the LLM always sees
 * forms for the persona active AT SEND TIME (not the one baked at chat-creation).
 *
 * Pronoun resolution uses the SAME `resolvePronounForms` + `PRESET_PRONOUN_FORMS`
 * as the backend engine, so the preset table and custom-vs-preset precedence
 * can never drift between display and generation paths.
 *
 * When no persona / no pronoun forms are set, pronoun macros expand to an empty
 * string (matching the backend `?? ""` behavior in macro-registry.ts).
 */
export function replaceUiMacros(
  text: string,
  context: MacroContext,
): string {
  if (!text) return text;
  const userName = context.personaName?.trim() || "User";

  // Resolve pronoun forms via the shared helper (custom forms win over preset).
  // Null when there is no persona, no preset, or an unrecognized pronouns string.
  const forms = resolvePronounForms({
    pronouns: context.personaPronouns ?? null,
    pronounForms: context.personaPronounForms ?? null,
  });
  const sub = forms?.subjective ?? "";
  const obj = forms?.objective ?? "";
  const poss = forms?.possessive ?? "";
  const possP = forms?.possessivePronoun ?? "";
  const ref = forms?.reflexive ?? "";

  return text
    .replace(/\{\{\s*char\s*\}\}/gi, context.characterName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*persona\s*\}\}/gi, context.personaDescription ?? "")
    // VT-native pronoun macros
    .replace(/\{\{\s*sub\s*\}\}/gi, sub)
    .replace(/\{\{\s*obj\s*\}\}/gi, obj)
    .replace(/\{\{\s*poss\s*\}\}/gi, poss)
    .replace(/\{\{\s*poss_p\s*\}\}/gi, possP)
    .replace(/\{\{\s*ref\s*\}\}/gi, ref)
    // ST-extension pronoun aliases (Wolfsblvt's SillyTavern-Pronouns compat)
    .replace(/\{\{\s*pronoun\.subjective\s*\}\}/gi, sub)
    .replace(/\{\{\s*pronoun\.objective\s*\}\}/gi, obj)
    .replace(/\{\{\s*pronoun\.pos_det\s*\}\}/gi, poss)
    .replace(/\{\{\s*pronoun\.pos_pro\s*\}\}/gi, possP)
    .replace(/\{\{\s*pronoun\.reflexive\s*\}\}/gi, ref)
    // Legacy angle-bracket tokens
    .replace(/<USER>/gi, userName)
    .replace(/<BOT>/gi, context.characterName)
    .replace(/<CHAR>/gi, context.characterName);
}

import type { PronounForms } from "@vibe-tavern/domain";

/**
 * Preset pronoun declension forms, keyed by the full slash strings stored in
 * `Persona.pronouns` (source: {@link PRONOUN_OPTIONS} in `PersonaModal.tsx`).
 *
 * These are VT-native values, not derived from any external source. SillyTavern
 * core does not ship `{{sub}}`/`{{obj}}`/`{{poss}}`/`{{poss_p}}`/`{{ref}}`
 * macros — the semantics are fixed in PERSONA_REWORK_PLAN.md.
 *
 * The custom case (neopronouns etc.) does NOT use this table: those forms are
 * persisted on the persona as structured `pronounForms` and pass through directly.
 */
export const PRESET_PRONOUN_FORMS: Record<string, PronounForms> = {
  "he/him": { subjective: "he", objective: "him", possessive: "his", possessivePronoun: "his", reflexive: "himself" },
  "she/her": { subjective: "she", objective: "her", possessive: "her", possessivePronoun: "hers", reflexive: "herself" },
  "they/them": { subjective: "they", objective: "them", possessive: "their", possessivePronoun: "theirs", reflexive: "themselves" },
  "it/its": { subjective: "it", objective: "it", possessive: "its", possessivePronoun: "its", reflexive: "itself" },
};

/**
 * Resolve the effective {@link PronounForms} for a persona-like value.
 *
 * - Custom: returns `pronounForms` when set (takes precedence — a persona with
 *   structured forms always wins over the preset key).
 * - Preset: derives from the `pronouns` slash-string key via {@link PRESET_PRONOUN_FORMS}.
 * - Otherwise null (no persona, no preset, incomplete custom, or unrecognized string).
 *
 * Null is the macro engine's signal to expand `{{sub}}` & co. to an empty string.
 */
export function resolvePronounForms(persona: {
  pronouns: string | null;
  pronounForms: PronounForms | null;
}): PronounForms | null {
  if (persona.pronounForms) return persona.pronounForms;
  if (persona.pronouns && persona.pronouns in PRESET_PRONOUN_FORMS) {
    return PRESET_PRONOUN_FORMS[persona.pronouns];
  }
  return null;
}

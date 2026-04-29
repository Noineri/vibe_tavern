import { createPhaseOneMacroEngine } from "./macro-registry.js";
import { buildPromptVariableContext } from "./prompt-variable-context.js";

export interface MacroContext {
  charName: string;
  userName: string;
  personaDescription?: string;
  originalText?: string;
}

const phaseOneMacroEngine = createPhaseOneMacroEngine();

/**
 * Replaces SillyTavern-style macros in text. Single-pass, no recursion.
 * Ported subset (Phase 1):
 *   {{char}}  / <CHAR> / <BOT>            -> charName
 *   {{user}}  / <USER>                    -> userName
 *   {{persona}}                           -> personaDescription (or empty)
 *   {{original}}                          -> original prompt text (one-shot, if provided)
 *   {{time}}                              -> HH:MM (24h, local)
 *   {{date}}                              -> YYYY-MM-DD (local)
 *   {{weekday}}                           -> Monday/Tuesday/... (English, local)
 *   {{isotime}}                           -> HH:mm
 *   {{isodate}}                           -> YYYY-MM-DD
 *   {{newline}}                           -> newline character
 *   {{noop}}                              -> (empty)
 *
 * Whitespace tolerance: `{{ char }}` works; case-insensitive on macro NAMES (e.g. {{CHAR}}).
 * Excluded for Phase 1: dice rolls, idle-duration, lastMessage, maxPrompt, postEnv vars,
 * variable scope, group-only macros — these need session/ST-specific state.
 */
export function replaceMacros(text: string, context: MacroContext): string {
  if (!text) return text;

  return phaseOneMacroEngine.resolve(text, buildPromptVariableContext({
    names: {
      charName: context.charName,
      userName: context.userName,
    },
    character: {
      name: context.charName,
    },
    persona: {
      name: context.userName,
      description: context.personaDescription ?? "",
    },
    prompt: {
      original: context.originalText ?? null,
    },
  }));
}

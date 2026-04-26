export interface MacroContext {
  charName: string;
  userName: string;
  personaDescription?: string;
  originalName?: string;
}

/**
 * Replaces SillyTavern-style macros in text. Single-pass, no recursion.
 * Ported subset (Phase 1):
 *   {{char}}  / <CHAR> / <BOT>            -> charName
 *   {{user}}  / <USER>                    -> userName
 *   {{persona}}                           -> personaDescription (or empty)
 *   {{original}}                          -> originalName (if provided)
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

  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const yyyy = now.getFullYear().toString();
  const mo = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const isodate = `${yyyy}-${mo}-${dd}`;
  const isotime = `${hh}:${mm}`;

  let result = text;

  // Curly-brace macros (whitespace-tolerant, case-insensitive)
  result = result.replace(/\{\{\s*char\s*\}\}/gi, context.charName);
  result = result.replace(/\{\{\s*user\s*\}\}/gi, context.userName);
  result = result.replace(/\{\{\s*persona\s*\}\}/gi, context.personaDescription ?? "");
  result = result.replace(/\{\{\s*original\s*\}\}/gi, context.originalName ?? "");
  result = result.replace(/\{\{\s*time\s*\}\}/gi, isotime);
  result = result.replace(/\{\{\s*date\s*\}\}/gi, isodate);
  result = result.replace(/\{\{\s*weekday\s*\}\}/gi, weekday);
  result = result.replace(/\{\{\s*isotime\s*\}\}/gi, isotime);
  result = result.replace(/\{\{\s*isodate\s*\}\}/gi, isodate);
  result = result.replace(/\{\{\s*newline\s*\}\}/gi, "\n");
  result = result.replace(/\{\{\s*noop\s*\}\}/gi, "");

  // Legacy non-curly macros (must come AFTER curly to avoid double-substituting names that contain "USER" etc.)
  result = result.replace(/<USER>/gi, context.userName);
  result = result.replace(/<BOT>/gi, context.charName);
  result = result.replace(/<CHAR>/gi, context.charName);

  return result;
}

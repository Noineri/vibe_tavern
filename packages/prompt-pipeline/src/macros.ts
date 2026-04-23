export interface MacroContext {
  charName: string;
  userName: string;
  originalName?: string;
}

/**
 * Replaces common SillyTavern-style macros in text.
 * Handles variations like {{char}}, {{Char}}, {{ user }}, etc.
 *
 * Supported macros:
 * - {{char}} / <BOT> - Replaced with character's name
 * - {{user}} / <USER> - Replaced with user's name
 * - {{original}} - Replaced with the character's original name (if applicable)
 */
export function replaceMacros(text: string, context: MacroContext): string {
  if (!text) {
    return text;
  }

  let result = text;

  // {{char}} and variations (e.g., {{ char }}, {{CHAR}})
  const charRegex = /{{\s*char\s*}}/gi;
  result = result.replace(charRegex, context.charName);

  // <BOT> macro (common in some older card formats)
  const botRegex = /<BOT>/gi;
  result = result.replace(botRegex, context.charName);

  // {{user}} and variations
  const userRegex = /{{\s*user\s*}}/gi;
  result = result.replace(userRegex, context.userName);

  // <USER> macro
  const userTagRegex = /<USER>/gi;
  result = result.replace(userTagRegex, context.userName);

  // {{original}} macro
  if (context.originalName) {
    const originalRegex = /{{\s*original\s*}}/gi;
    result = result.replace(originalRegex, context.originalName);
  }

  return result;
}

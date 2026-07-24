/**
 * Co-Author macro subset + unsafe-macro scanner (B5).
 *
 * The Co-Author is permitted to emit only identity + user-pronoun macros (the
 * base-prompt contract) so the cards it writes stay reusable across chats —
 * these resolve per-chat regardless of persona/character. When the model
 * disobeys and emits anything else, the apply path surfaces each occurrence as
 * a `CoauthorCorrection` for the user to review; prose is never stripped
 * silently. This module is the pure shared piece: the subset constant + a
 * scanner reused at the apply boundary.
 */

import { extractMacroNames } from "@vibe-tavern/prompt-pipeline";

/**
 * Macros the Co-Author may emit. Mirrors the `# Macros` section of the
 * Co-Author base prompt (`services/api/assets/coauthor/base.md`) — keep the two
 * in sync when editing either.
 */
export const COAUTHOR_SAFE_MACROS: ReadonlySet<string> = new Set([
  "user",
  "char",
  "sub",
  "obj",
  "poss",
  "poss_p",
  "ref",
]);

/**
 * Distinct macro names in `text` that fall outside the Co-Author safe subset.
 * Reuses the prompt-pipeline tokenizer, so the detection matches actual
 * resolution (nesting, `{{// comments}}`, `::`-args, legacy `<USER>` markers
 * are all handled by the engine's own tokenizer, not a divergent regex).
 */
export function findUnsafeMacros(text: string): string[] {
  const unsafe = new Set<string>();
  for (const name of extractMacroNames(text)) {
    if (!COAUTHOR_SAFE_MACROS.has(name)) unsafe.add(name);
  }
  return [...unsafe];
}

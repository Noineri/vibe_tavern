/**
 * Standalone ST regex-script JSON import/export (REGEX_EXTENSION_PLAN, RX-16).
 *
 * Some tools ship regex scripts as standalone `.json` files — either a SINGLE
 * `RegexScriptData` object (the common ST export shape) or an ARRAY of them;
 * `{ "scripts": [...] }` wrappers also occur. This module parses all three
 * shapes into the shared {@link RegexScriptImportDraft} drafts and serializes
 * drafts back to an ST-importable JSON array.
 *
 * SECURITY GATE (plan non-negotiable): every parsed draft lands
 * `disabled: true` via the shared {@link normalizeStRegexScript} — review
 * before trust, identical to card/preset embedded scripts. Serialized output
 * preserves each draft's own `disabled` flag verbatim (round-trip fidelity).
 *
 * NEVER throws: malformed input yields [].
 */

import { normalizeStRegexScript, type RegexScriptImportDraft } from "../cards/regex-scripts.js";

/** A draft with its lossless source channel stripped — what serialization accepts. */
export type StandaloneRegexScriptOut = Omit<RegexScriptImportDraft, "sourceScript">;

/**
 * Parse a standalone regex-script JSON payload into importable drafts.
 *
 * Accepts: single script object, array of objects, or `{ scripts: [...] }`
 * wrapper. Entries are validated by {@link normalizeStRegexScript};
 * meaningless ones (missing findRegex) are skipped; `sortOrder` follows the
 * accepted order. Returns [] for garbage/empty input — never throws.
 */
export function parseStandaloneRegexJson(jsonText: string): RegexScriptImportDraft[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const list = extractRawList(raw);
  const drafts: RegexScriptImportDraft[] = [];
  for (const entry of list) {
    const draft = normalizeStRegexScript(entry, drafts.length);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

function extractRawList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as { scripts?: unknown }).scripts)) {
    return (raw as { scripts: unknown[] }).scripts;
  }
  // Single-object shape (the common ST export) — wrap for uniform handling.
  if (typeof raw === "object" && raw !== null) return [raw];
  return [];
}

/**
 * Serialize drafts to an ST-importable JSON array of plain
 * `RegexScriptData`-shaped objects (strips the draft-only `sourceScript`).
 *
 * Round-trip guarantee: `parseStandaloneRegexJson(serializeStandaloneRegexJson(drafts))`
 * yields drafts equal to the inputs minus `sourceScript`.
 */
export function serializeStandaloneRegexJson(
  drafts: Array<StandaloneRegexScriptOut | RegexScriptImportDraft>,
): string {
  const out = drafts.map((draft) => ({
    scriptName: draft.name,
    findRegex: draft.findRegex,
    replaceString: draft.replaceString,
    trimStrings: [...draft.trimStrings],
    placement: [...draft.placement],
    disabled: draft.disabled,
    markdownOnly: draft.markdownOnly,
    promptOnly: draft.promptOnly,
    runOnEdit: draft.runOnEdit,
    substituteRegex: draft.substituteRegex,
    minDepth: draft.minDepth,
    maxDepth: draft.maxDepth,
  }));
  return JSON.stringify(out, null, 2);
}

/**
 * Standalone ST regex-script JSON import/export (REGEX_EXTENSION_PLAN, RX-16).
 *
 * Some tools ship regex scripts as standalone `.json` files — either a SINGLE
 * `RegexScriptData` object (the common ST export shape) or an ARRAY of them;
 * `{ "scripts": [...] }` wrappers also occur. This module parses all three
 * shapes into the shared {@link RegexScriptImportDraft} drafts and serializes
 * Rules back to an ST-importable JSON array.
 *
 * Source fidelity (RXU-11): parsed drafts carry each script's own `disabled`
 * value via the shared {@link normalizeStRegexScript}; serialized output
 * preserves the flag verbatim, so round trips are state-lossless.
 *
 * NEVER throws: malformed input yields [].
 */

import {
  normalizeStRegexScript,
  type RegexRuleExport,
  type RegexScriptImportDraft,
} from "../cards/regex-scripts.js";

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
 * Serialize Rules to an ST-importable JSON array of plain
 * `RegexScriptData`-shaped objects. Accepts the neutral {@link RegexRuleExport}
 * shape; import drafts (Rule + lossless `sourceScript`) are accepted too —
 * the channel is simply not emitted.
 *
 * Round-trip guarantee: `parseStandaloneRegexJson(serializeStandaloneRegexJson(rules))`
 * yields drafts equal to the inputs minus `sourceScript`, with every
 * enabled/disabled flag preserved.
 */
export function serializeStandaloneRegexJson(drafts: RegexRuleExport[]): string {
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

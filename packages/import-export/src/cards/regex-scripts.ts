/**
 * ST card regex-script extraction (REGEX_EXTENSION_PLAN, RX-15).
 *
 * SillyTavern character cards may embed named find/replace scripts under
 * `data.extensions.regex_scripts` (ST `RegexScriptData`). This module parses
 * them into importable {@link RegexScriptImportDraft} drafts for the
 * offer-to-save flow.
 *
 * SECURITY GATE (plan non-negotiable): every draft lands `disabled: true` —
 * the same review-before-trust gate ST applies to shared cards — regardless of
 * what the embedded script claims. The caller stamps createdAt/updatedAt and
 * a fresh id when persisting an accepted draft as a RegexPreset.
 *
 * Extraction is ADDITIVE, never destructive: extensions keep carrying the raw
 * `regex_scripts` array so a round-trip re-export of the card is lossless.
 *
 * NEVER throws: malformed input yields a partial list or [].
 */

import {
  REGEX_PLACEMENT,
  REGEX_SUBSTITUTE,
  type RegexPlacement,
  type RegexPreset,
  type RegexSubstituteMode,
} from "@vibe-tavern/domain";

import { isRecord } from "../shared.js";

/** A RegexPreset-shaped draft with timestamps left to the caller. */
export type RegexScriptImportDraft = Omit<RegexPreset, "id" | "createdAt" | "updatedAt"> & {
  /** The ORIGINAL embedded ST script object — lossless channel so the
   *  offer-to-save UI can show raw details without re-parsing extensions. */
  sourceScript: Record<string, unknown>;
};

const VALID_PLACEMENTS = new Set<number>(Object.values(REGEX_PLACEMENT));
const SUBSTITUTE_VALUES = Object.values(REGEX_SUBSTITUTE);

const DEFAULT_NAME = "Imported regex script";

function asBool(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

/** Nullable depth bound: finite numbers pass; anything else → null. */
function asDepth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePlacement(value: unknown): RegexPlacement[] {
  if (!Array.isArray(value)) return [REGEX_PLACEMENT.AiOutput];
  const codes = value.filter(
    (code): code is RegexPlacement => typeof code === "number" && VALID_PLACEMENTS.has(code),
  );
  return codes.length > 0 ? [...new Set(codes)] : [REGEX_PLACEMENT.AiOutput];
}

function parseSubstituteRegex(value: unknown): RegexSubstituteMode {
  // find() both validates membership AND narrows to the branded union type.
  return SUBSTITUTE_VALUES.find((mode) => mode === value) ?? REGEX_SUBSTITUTE.None;
}

function parseTrimStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}

function parseScriptName(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_NAME;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_NAME;
}

/**
 * Extract importable regex-script drafts from a card's `extensions` record.
 *
 * Per-element validation drops only meaningless entries (missing/blank
 * findRegex); malformed individual fields fall back to their defaults instead
 * of rejecting the whole script. Unknown extra fields are preserved via
 * {@link RegexScriptImportDraft.sourceScript}.
 */
export function extractCardRegexScripts(
  rawExtensions: Record<string, unknown> | undefined,
): RegexScriptImportDraft[] {
  const rawScripts = rawExtensions?.regex_scripts;
  if (!Array.isArray(rawScripts)) return [];

  const drafts: RegexScriptImportDraft[] = [];
  for (const entry of rawScripts) {
    if (!isRecord(entry)) continue;

    // A regex script without a find pattern is meaningless — drop it rather
    // than import something that can never match.
    const findRegex = typeof entry.findRegex === "string" ? entry.findRegex.trim() : "";
    if (!findRegex) continue;

    drafts.push({
      name: parseScriptName(entry.scriptName),
      findRegex,
      replaceString: typeof entry.replaceString === "string" ? entry.replaceString : "",
      trimStrings: parseTrimStrings(entry.trimStrings),
      substituteRegex: parseSubstituteRegex(entry.substituteRegex),
      // Security gate: embedded scripts are untrusted until reviewed.
      disabled: true,
      markdownOnly: asBool(entry.markdownOnly),
      promptOnly: asBool(entry.promptOnly),
      runOnEdit: entry.runOnEdit === undefined ? true : asBool(entry.runOnEdit),
      minDepth: asDepth(entry.minDepth),
      maxDepth: asDepth(entry.maxDepth),
      placement: parsePlacement(entry.placement),
      // Card scripts bind to their character — never global.
      isGlobal: false,
      sortOrder: drafts.length,
      sourceScript: entry,
    });
  }
  return drafts;
}

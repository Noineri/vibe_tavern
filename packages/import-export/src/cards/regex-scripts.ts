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
 * Normalize ONE raw ST `RegexScriptData` object into an importable draft.
 *
 * Shared per-script parser for all import entry points (card extensions,
 * preset files, standalone JSON) — one validation logic, three callers.
 *
 * Per-element validation drops only meaningless entries (missing/blank
 * findRegex → null); malformed individual fields fall back to their defaults
 * instead of rejecting the whole script. Unknown extra fields are preserved
 * via {@link RegexScriptImportDraft.sourceScript}.
 *
 * SECURITY GATE (plan non-negotiable): every draft lands `disabled: true`
 * regardless of what the embedded script claims; `isGlobal` is always false.
 *
 * @param index assigned to the returned draft's `sortOrder` (callers decide
 *              the semantics: raw array position or accepted-so-far count).
 */
export function normalizeStRegexScript(raw: unknown, index: number): RegexScriptImportDraft | null {
  if (!isRecord(raw)) return null;

  // A regex script without a find pattern is meaningless — drop it rather
  // than import something that can never match.
  const findRegex = typeof raw.findRegex === "string" ? raw.findRegex.trim() : "";
  if (!findRegex) return null;

  return {
    name: parseScriptName(raw.scriptName),
    findRegex,
    replaceString: typeof raw.replaceString === "string" ? raw.replaceString : "",
    trimStrings: parseTrimStrings(raw.trimStrings),
    substituteRegex: parseSubstituteRegex(raw.substituteRegex),
    // Security gate: embedded scripts are untrusted until reviewed.
    disabled: true,
    markdownOnly: asBool(raw.markdownOnly),
    promptOnly: asBool(raw.promptOnly),
    runOnEdit: raw.runOnEdit === undefined ? true : asBool(raw.runOnEdit),
    minDepth: asDepth(raw.minDepth),
    maxDepth: asDepth(raw.maxDepth),
    placement: parsePlacement(raw.placement),
    isGlobal: false,
    sortOrder: index,
    sourceScript: raw,
  };
}

/**
 * Extract importable regex-script drafts from a card's `extensions` record.
 */
export function extractCardRegexScripts(
  rawExtensions: Record<string, unknown> | undefined,
): RegexScriptImportDraft[] {
  const rawScripts = rawExtensions?.regex_scripts;
  if (!Array.isArray(rawScripts)) return [];

  const drafts: RegexScriptImportDraft[] = [];
  for (const entry of rawScripts) {
    const draft = normalizeStRegexScript(entry, drafts.length);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

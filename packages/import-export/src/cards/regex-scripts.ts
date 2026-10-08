/**
 * ST card regex-script extraction (REGEX_EXTENSION_PLAN, RX-15).
 *
 * SillyTavern character cards may embed named find/replace scripts under
 * `data.extensions.regex_scripts` (ST `RegexScriptData`). This module parses
 * them into importable {@link RegexScriptImportDraft} drafts for the
 * offer-to-save flow.
 *
 * Source fidelity (REGEX_RULE_PROFILE_UX_PORTABILITY_PLAN, RXU-11): parsing
 * is faithful to the source — each draft carries the source script's own
 * `disabled` value exactly. No activation policy lives in the parser;
 * import flows own what a draft lands as when persisted. The caller stamps
 * createdAt/updatedAt and a fresh id when persisting an accepted draft as a
 * RegexPreset.
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

/**
 * A Rule in its neutral, serialization-facing shape: a `RegexPreset` minus
 * persistence fields (id, createdAt, updatedAt) and the import-only
 * `sourceScript` channel. Carries NO import policy — enabled/disabled is the
 * Rule's own state. Import drafts are structurally assignable to this type,
 * so parsers and serializers share one Rule shape (RXU-11).
 */
export type RegexRuleExport = Omit<RegexPreset, "id" | "createdAt" | "updatedAt">;

/** A Rule-shaped import draft: the neutral export shape plus the lossless
 *  source channel. Timestamps are left to the caller; `disabled` mirrors the
 *  source script's own value. */
export type RegexScriptImportDraft = RegexRuleExport & {
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
 * Source fidelity (RXU-11): the draft's `disabled` mirrors the source
 * script's own value (absent → false, ST's enabled default); `isGlobal` is
 * always false — profile scope is a VT-native concept, never trusted from
 * card data.
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
    // Source fidelity: the source script's own flag, absent → false (enabled).
    disabled: asBool(raw.disabled),
    markdownOnly: asBool(raw.markdownOnly),
    promptOnly: asBool(raw.promptOnly),
    runOnEdit: raw.runOnEdit === undefined ? true : asBool(raw.runOnEdit),
    minDepth: asDepth(raw.minDepth),
    maxDepth: asDepth(raw.maxDepth),
    placement: parsePlacement(raw.placement),
    isGlobal: false,
    sortOrder: index,
    // Cards stay flat: an imported script always lands standalone (R-13
    // profiles are a VT-native concept; profile bundling is a manager-side
    // action, never encoded in card data).
    profileId: null,
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

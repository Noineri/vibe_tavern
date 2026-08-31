import type {
  LoreEntry,
  LoreEntryId,
  LoreLogic,
  LoreEntryRole,
  LoreScopeType,
  Lorebook,
  LorebookId,
  LoreMatchSource,
  LoreEntryPosition,
} from "@vibe-tavern/domain";
import { brandId, ENTITY_ID_NAMESPACE } from "@vibe-tavern/domain";

import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  isRecord,
  makeDeterministicId,
  normalizeTimestamp,
  parseJsonInput,
  stableJson,
} from "../shared.js";

interface StLorebookEntryRecord extends Record<string, unknown> {
  uid?: unknown;
  key?: unknown;
  keysecondary?: unknown;
  comment?: unknown;
  content?: unknown;
  selective?: unknown;
  selectiveLogic?: unknown;
  order?: unknown;
  position?: unknown;
  depth?: unknown;
  disable?: unknown;
  sticky?: unknown;
  cooldown?: unknown;
  delay?: unknown;
  constant?: unknown;
  probability?: unknown;
  useProbability?: unknown;
  role?: unknown;
  group?: unknown;
  addMemo?: unknown;
  excludeRecursion?: unknown;
  preventRecursion?: unknown;
  delayUntilRecursion?: unknown;
  scanDepth?: unknown;
  automationId?: unknown;
  outletName?: unknown;
}

export interface StLorebookNormalized {
  name: string;
  description: string;
  scanDepth: number;
  tokenBudget: number;
  tokenBudgetPercent: number | null;
  recursiveScanning: boolean;
  maxRecursionSteps?: number;
  includeNames?: boolean;
  extensions: Record<string, unknown>;
}

export interface ImportedLorebookBundle {
  format: "st_lorebook_json";
  normalized: StLorebookNormalized;
  lorebook: Lorebook;
  entries: LoreEntry[];
  warnings: string[];
}

export interface ImportLorebookOptions {
  now?: string;
  scopeType?: LoreScopeType;
  defaultDepth?: number;
  fallbackName?: string;
  /**
   * ST's group-scoring switch (world_info_use_group_scoring) is GLOBAL client
   * state, not part of any lorebook file — so it cannot ride the book payload.
   * When the caller knows it (the ST directory import reads settings.json),
   * it maps onto the imported book's useGroupScoring (owner decision,
   * 2026-08-31). Absent → false. See LOREBOOK_GROUP_SCORING_PARITY_REPORT (D9).
   */
  globalUseGroupScoring?: boolean;
}

function mapSelectiveLogic(value: unknown): LoreLogic {
  switch (value) {
    case 1:
      return "not_all";
    case 2:
      return "not_any";
    case 3:
      return "and_all";
    case 0:
    default:
      return "and_any";
  }
}

/** VT logic → ST `selectiveLogic` number (export direction; inverse of {@link mapSelectiveLogic}). */
function logicToSt(logic: string): number {
  switch (logic) {
    case "not_all": return 1;
    case "not_any": return 2;
    case "and_all": return 3;
    case "and_any":
    default: return 0;
  }
}

/**
 * Single bidirectional mapping between VT `LoreEntryPosition` (string) and the
 * SillyTavern World Info numeric position enum. Consumed by both directions:
 * import (`mapLoreEntryPosition`: ST number → VT string) and export
 * (`vtPositionToSt`: VT string → ST number). Previously the two directions were
 * hand-maintained in two packages (st-lorebook.ts + lorebook-store.ts) with no
 * compile link — adding a 9th position would silently drift. All 8 ST positions
 * are preserved 1:1 so the user's before/after split survives import (see
 * lorebook-st-parity-audit.md §2.1: previously this collapsed every prompt-area
 * position to `in_prompt`, making the `worldInfoBefore` prompt-order marker
 * structurally unreachable). `assemble.ts` switches on these literals to route
 * each entry to the right marker and fine-grained subPosition.
 */
const LORE_ENTRY_POSITION_TABLE: ReadonlyArray<{ readonly vt: LoreEntryPosition; readonly st: number }> = [
  { vt: "before_char", st: 0 },
  { vt: "after_char", st: 1 },
  { vt: "top_an", st: 2 },
  { vt: "bottom_an", st: 3 },
  { vt: "at_depth", st: 4 },
  { vt: "before_examples", st: 5 },
  { vt: "after_examples", st: 6 },
  { vt: "outlet", st: 7 },
];

/** ST numeric position → VT position (import direction). ST default is `before_char`. */
function mapLoreEntryPosition(value: unknown): LoreEntryPosition {
  return LORE_ENTRY_POSITION_TABLE.find((r) => r.st === value)?.vt ?? "before_char";
}

/** VT position → ST numeric position (export direction). Unknown VT → ST default `after_char` (1). */
function vtPositionToSt(vt: string): number {
  return LORE_ENTRY_POSITION_TABLE.find((r) => r.vt === vt)?.st ?? 1;
}

function getEntryRecords(root: Record<string, unknown>): StLorebookEntryRecord[] {
  const entries = root.entries;

  if (Array.isArray(entries)) {
    return entries.filter(isRecord);
  }

  if (isRecord(entries)) {
    return Object.values(entries).filter(isRecord);
  }

  return [];
}

export function importStLorebookJson(
  input: string | Record<string, unknown>,
  options: ImportLorebookOptions = {},
): ImportedLorebookBundle {
  const root = parseJsonInput(input);
  const fallbackNow = options.now ?? new Date().toISOString();
  const importedAt = normalizeTimestamp(root.create_date, fallbackNow);
  const name = asString(root.name).trim() || options.fallbackName || "Imported Lorebook";

  const normalized: StLorebookNormalized = {
    name,
    description: asString(root.description),
    scanDepth: asNumber(root.scan_depth, 50),
    tokenBudget: asNumber(root.token_budget, 1000),
    // ST stores budget as either a percentage (extensions.token_budget_pct)
    // or a fixed cap (token_budget). Preserve the percentage when present.
    tokenBudgetPercent: (() => {
      const pct = (root.extensions as Record<string, unknown>)?.token_budget_pct;
      return typeof pct === 'number' && pct >= 0 && pct <= 100 ? pct : null;
    })(),
    recursiveScanning: asBoolean(root.recursive_scanning, false),
    maxRecursionSteps: asNumber((root.extensions as Record<string, unknown>)?.max_recursion_steps, 5),
    extensions: isRecord(root.extensions) ? root.extensions : {},
  };

  const lorebookId: LorebookId = brandId<LorebookId>(makeDeterministicId(
    ENTITY_ID_NAMESPACE.lorebook,
    `${normalized.name}:${stableJson(root)}`,
  ));

  const lorebook: Lorebook = {
    id: lorebookId,
    name: normalized.name,
    description: normalized.description,
    scopeType: options.scopeType ?? "character",
    scanDepth: normalized.scanDepth,
    tokenBudget: normalized.tokenBudget,
    tokenBudgetPercent: normalized.tokenBudgetPercent,
    recursiveScanning: normalized.recursiveScanning,
    // Maps the ST global switch when the caller knows it; default false.
    useGroupScoring: options.globalUseGroupScoring ?? false,
    maxRecursionSteps: normalized.maxRecursionSteps ?? 5,
    includeNames: false,
    minActivations: 0,
    minActivationsDepthMax: 0,
    overflowAlert: false,
    characterStrategy: 0,
    sortOrder: 0,
    enabled: true,
    characterId: null,
    personaId: null,
    chatId: null,
    extensions: normalized.extensions,
    createdAt: importedAt,
    updatedAt: importedAt,
  };

  const warnings: string[] = [];
  const entryRecords = getEntryRecords(root);
  const entries: LoreEntry[] = entryRecords.map((entry, index) => {
    const keys = asStringArray(entry.key);
    const secondaryKeys = asStringArray(entry.keysecondary);
    const hasSecondaryLogic = asBoolean(entry.selective, false) && secondaryKeys.length > 0;
    const logic = hasSecondaryLogic ? mapSelectiveLogic(entry.selectiveLogic) : "and_any";
    const externalId = String(entry.uid ?? index);
    const title = asString(entry.comment).trim() || `Entry ${externalId}`;
    const content = asString(entry.content);

    if (!content) {
      warnings.push(`Lore entry ${externalId} has empty content.`);
    }

    if (keys.length === 0 && !asBoolean(entry.constant, false)) {
      warnings.push(`Lore entry ${externalId} has no primary keys and is not constant.`);
    }

    return {
      id: brandId<LoreEntryId>(makeDeterministicId(ENTITY_ID_NAMESPACE.loreEntryDeterministic, `${lorebookId}:${externalId}:${content}`)),
      lorebookId: lorebookId as LorebookId,
      title,
      content,
      keys,
      secondaryKeys,
      logic,
      position: mapLoreEntryPosition(entry.position),
      depth: asNumber(entry.depth, options.defaultDepth ?? 4),
      priority: asNumber(entry.order, 100),
      stickyWindow: asNumber(entry.sticky, 0),
      cooldownWindow: asNumber(entry.cooldown, 0),
      delayWindow: asNumber(entry.delay, 0),
      constant: asBoolean(entry.constant, false),
      probability: asNumber(entry.probability, 100),
      ignoreBudget: asBoolean(entry.ignoreBudget, false),
      role: (asString(entry.role) || "system") as LoreEntryRole,
      groupName: asString(entry.group),
      groupWeight: 0,
      prioritizeInclusion: false,
      // Tri-state preserve (ST parity): ST stores null (inherit the global
      // switch) / true / false — collapsing null to false would permanently
      // pin imported entries against the book default. See
      // LOREBOOK_GROUP_SCORING_PARITY_REPORT (LG-4).
      useGroupScoring: entry.useGroupScoring === true ? true : entry.useGroupScoring === false ? false : null,
      excludeRecursion: asBoolean(entry.excludeRecursion, false),
      preventRecursion: asBoolean(entry.preventRecursion, false),
      delayUntilRecursion: asBoolean(entry.delayUntilRecursion, false),
      recursionLevel: 0,
      scanDepthOverride: entry.scanDepth != null ? asNumber(entry.scanDepth, 0) : null,
      caseSensitive: false,
      matchWholeWords: false,
      characterFilter: asStringArray(entry.character_filter).map((name) => ({ id: null, name })),
      characterFilterExclude: asBoolean(entry.character_filter_exclude, false),
      matchSources: [] as LoreMatchSource[],
      enabled: !asBoolean(entry.disable, false),
      // sortOrder is the DISPLAY/LIST position, not the ST activation priority.
      // ST `order` is a priority (higher = earlier in prompt); using it here
      // would reverse descending-order files on import (listEntries sorts
      // `ORDER BY sortOrder ASC`). Use the positional index so the file order
      // is preserved; `priority` above keeps the ST `order` semantics.
      // Mirrors the Janitor parser's `sortOrder: insertionOrder` convention.
      sortOrder: index,
      automationId: asString(entry.automationId),
      metadata: {
        stUid: entry.uid ?? index,
        stComment: entry.comment ?? "",
        stSelective: asBoolean(entry.selective, false),
        stPosition: entry.position ?? 0,
        stConstant: asBoolean(entry.constant, false),
        stProbability: asNumber(entry.probability, 100),
        stIgnoreBudget: asBoolean(entry.ignoreBudget, false),
        stUseProbability: asBoolean(entry.useProbability, false),
        stRole: entry.role ?? null,
        stGroup: asString(entry.group),
        stAddMemo: asBoolean(entry.addMemo, false),
        stExcludeRecursion: asBoolean(entry.excludeRecursion, false),
        stPreventRecursion: asBoolean(entry.preventRecursion, false),
        stDelayUntilRecursion: asBoolean(entry.delayUntilRecursion, false),
        stScanDepth: entry.scanDepth ?? null,
        stAutomationId: asString(entry.automationId),
        stOutletName: asString(entry.outletName),
      },
    };
  });

  return {
    format: "st_lorebook_json",
    normalized,
    lorebook,
    entries,
    warnings,
  };
}

// ─── Export (inverse of importStLorebookJson) ─────────────────────────────────

/**
 * Read-only contract for {@link exportLorebookToSt} — the lorebook-level fields
 * the serializer reads. Types are deliberately wider than `Lorebook` (it ignores
 * ids/scope/timestamps) so BOTH domain entities and store entities satisfy it
 * with no caller-side casting or field-by-field mapping.
 */
interface StExportLorebook {
  readonly name: string;
  readonly description: string;
  readonly scanDepth: number;
  readonly tokenBudget: number;
  readonly tokenBudgetPercent: number | null;
  readonly recursiveScanning: boolean;
  readonly maxRecursionSteps: number;
  readonly extensions: Record<string, unknown>;
}

/**
 * Read-only contract for {@link exportLorebookToSt} — the entry fields the
 * serializer reads. Enum-typed fields (logic/position/role) are typed as plain
 * `string` because the serializer treats them as opaque (it maps them to ST
 * keys without validating), which also lets both domain entities (narrow
 * unions) and store entities (loose strings) satisfy the contract with no
 * caller-side casting.
 */
interface StExportLoreEntry {
  readonly keys: string[];
  readonly secondaryKeys: string[];
  readonly title: string;
  readonly content: string;
  readonly constant: boolean;
  readonly logic: string;
  readonly priority: number;
  readonly position: string;
  readonly depth: number;
  readonly enabled: boolean;
  readonly stickyWindow: number;
  readonly cooldownWindow: number;
  readonly delayWindow: number;
  readonly probability: number;
  readonly role: string;
  readonly groupName: string;
  readonly groupWeight: number;
  readonly scanDepthOverride: number | null;
  readonly caseSensitive: boolean;
  readonly matchWholeWords: boolean;
  readonly characterFilter: ReadonlyArray<{ name: string }>;
  readonly characterFilterExclude: boolean;
  readonly automationId: string;
  readonly excludeRecursion: boolean;
  readonly preventRecursion: boolean;
  readonly delayUntilRecursion: boolean;
  readonly metadata: Record<string, unknown>;
}

/**
 * Serialize a lorebook + its entries to SillyTavern-compatible JSON. Pure: no DB
 * access. The inverse of {@link importStLorebookJson} — together they share
 * {@link LORE_ENTRY_POSITION_TABLE} and the selective-logic pair
 * (mapSelectiveLogic / logicToSt) so a position/logic added in one direction
 * cannot drift from the other. Colocated with its inverse (previously the
 * export lived in the db store, split from its inverse across two packages).
 */
export function exportLorebookToSt(
  lorebook: StExportLorebook,
  entries: readonly StExportLoreEntry[],
): Record<string, unknown> {
  const stEntries: Record<string, unknown> = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    stEntries[String(i)] = {
      uid: i,
      key: e.keys,
      keysecondary: e.secondaryKeys,
      comment: e.title,
      content: e.content,
      constant: e.constant,
      selective: e.secondaryKeys.length > 0,
      selectiveLogic: logicToSt(e.logic),
      order: e.priority,
      position: vtPositionToSt(e.position),
      depth: e.depth,
      disable: !e.enabled,
      sticky: e.stickyWindow,
      cooldown: e.cooldownWindow,
      delay: e.delayWindow,
      probability: e.probability,
      useProbability: true,
      role: e.role,
      group: e.groupName,
      groupWeight: e.groupWeight,
      scanDepth: e.scanDepthOverride,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      // characterFilter: strip the bound id (ST has no notion of it) and emit
      // the name list. Ghosts (id=null) round-trip as plain names. The exclude
      // flag is a VT extension; emitted so VT-origin cards lossless round-trip.
      character_filter: e.characterFilter.map((c) => c.name),
      character_filter_exclude: e.characterFilterExclude,
      automationId: e.automationId,
      excludeRecursion: e.excludeRecursion,
      preventRecursion: e.preventRecursion,
      delayUntilRecursion: e.delayUntilRecursion,
      metadata: e.metadata,
    };
  }

  return {
    entries: stEntries,
    name: lorebook.name,
    description: lorebook.description,
    scan_depth: lorebook.scanDepth,
    token_budget: lorebook.tokenBudget,
    token_budget_percent: lorebook.tokenBudgetPercent,
    recursive_scanning: lorebook.recursiveScanning,
    extensions: {
      ...((lorebook.extensions as Record<string, unknown>) ?? {}),
      max_recursion_steps: lorebook.maxRecursionSteps,
    },
  };
}

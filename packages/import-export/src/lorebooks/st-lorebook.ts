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
import { brandId, compileRussianCaseFormsKey, ENTITY_ID_NAMESPACE, LORE_MATCH_SOURCE, unwrapRussianCaseFormsKey } from "@vibe-tavern/domain";

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
  groupWeight?: unknown;
  groupOverride?: unknown;
  addMemo?: unknown;
  excludeRecursion?: unknown;
  preventRecursion?: unknown;
  delayUntilRecursion?: unknown;
  scanDepth?: unknown;
  automationId?: unknown;
  outletName?: unknown;
  matchPersonaDescription?: unknown;
  matchCharacterDescription?: unknown;
  matchCharacterPersonality?: unknown;
  matchCharacterDepthPrompt?: unknown;
  matchScenario?: unknown;
  matchCreatorNotes?: unknown;
  characterFilter?: unknown;
  character_filter?: unknown;
  character_filter_exclude?: unknown;
}

export interface StLorebookNormalized {
  name: string;
  description: string;
  scanDepth: number;
  tokenBudget: number;
  tokenBudgetPercent: number;
  tokenBudgetCap: number;
  recursiveScanning: boolean;
  useGroupScoring: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  maxRecursionSteps: number;
  includeNames: boolean;
  minActivations: number;
  minActivationsDepthMax: number;
  overflowAlert: boolean;
  characterStrategy: number;
  extensions: Record<string, unknown>;
}

/** ST's settings.json world-info globals, cached per imported VT book. */
export interface StWorldInfoGlobalOptions {
  globalScanDepth?: number;
  globalTokenBudgetPercent?: number;
  globalTokenBudgetCap?: number;
  globalRecursiveScanning?: boolean;
  globalUseGroupScoring?: boolean;
  globalCaseSensitive?: boolean;
  globalMatchWholeWords?: boolean;
  globalMaxRecursionSteps?: number;
  globalIncludeNames?: boolean;
  globalMinActivations?: number;
  globalMinActivationsDepthMax?: number;
  globalOverflowAlert?: boolean;
  globalCharacterStrategy?: number;
}

// ST's world-info globals are absent from standalone world files.
// These exact defaults are declared at world-info.js:69-82.
const ST_WORLD_INFO_DEFAULTS = {
  scanDepth: 2,
  tokenBudgetPercent: 25,
  tokenBudgetCap: 0,
  recursiveScanning: false,
  useGroupScoring: false,
  caseSensitive: false,
  matchWholeWords: false,
  maxRecursionSteps: 0,
  includeNames: true,
  minActivations: 0,
  minActivationsDepthMax: 0,
  overflowAlert: false,
  characterStrategy: 1,
} as const;

export interface ImportedLorebookBundle {
  format: "st_lorebook_json";
  normalized: StLorebookNormalized;
  lorebook: Lorebook;
  entries: LoreEntry[];
  warnings: string[];
}

export interface ImportLorebookOptions extends StWorldInfoGlobalOptions {
  now?: string;
  /** Resolves an ST character-filter avatar filename to a local character. */
  characterFilterAvatarResolver?: (avatarFilename: string) => { id: string; name: string } | null;

  scopeType?: LoreScopeType;
  defaultDepth?: number;
  fallbackName?: string;
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
  if (vt === "before_persona") return 0;
  if (vt === "after_persona") return 1;
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

function mapStRole(value: unknown): LoreEntryRole {
  if (value === 1 || value === "user") return "user";
  if (value === 2 || value === "assistant") return "assistant";
  return "system";
}

function mapDelayUntilRecursion(value: unknown): { delayUntilRecursion: boolean; recursionLevel: number } {
  if (value === true) return { delayUntilRecursion: true, recursionLevel: 1 };
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
    return { delayUntilRecursion: true, recursionLevel: value };
  }
  return { delayUntilRecursion: false, recursionLevel: 0 };
}

const ST_MATCH_SOURCE_MAP = [
  { field: "matchPersonaDescription", source: LORE_MATCH_SOURCE.personaDesc },
  { field: "matchCharacterDescription", source: LORE_MATCH_SOURCE.characterDesc },
  { field: "matchCharacterPersonality", source: LORE_MATCH_SOURCE.characterPersonality },
  { field: "matchCharacterDepthPrompt", source: LORE_MATCH_SOURCE.characterNote },
  { field: "matchScenario", source: LORE_MATCH_SOURCE.scenario },
  { field: "matchCreatorNotes", source: LORE_MATCH_SOURCE.creatorNotes },
] as const;

function mapMatchSources(entry: StLorebookEntryRecord): LoreMatchSource[] {
  return [
    LORE_MATCH_SOURCE.chatMessages,
    ...ST_MATCH_SOURCE_MAP
      .filter(({ field }) => entry[field] === true)
      .map(({ source }) => source),
  ];
}

function unwrapCaseFormsKeys(keys: string[]): { keys: string[]; caseFormsKeys: string[] } {
  const caseFormsKeys: string[] = [];
  const unwrapped = keys.map((key) => {
    const original = unwrapRussianCaseFormsKey(key);
    if (original !== null) caseFormsKeys.push(original);
    return original ?? key;
  });
  return { keys: unwrapped, caseFormsKeys: [...new Set(caseFormsKeys)] };
}

function mapCharacterFilter(
  entry: StLorebookEntryRecord,
  resolver: ImportLorebookOptions["characterFilterAvatarResolver"],
): { characterFilter: Array<{ id: string | null; name: string }>; characterFilterExclude: boolean; names: string[]; tags: string[] } {
  const nativeFilter = isRecord(entry.characterFilter) ? entry.characterFilter : null;
  const names = nativeFilter ? asStringArray(nativeFilter.names) : asStringArray(entry.character_filter);
  return {
    characterFilter: names.map((name) => resolver?.(name) ?? { id: null, name }),
    characterFilterExclude: nativeFilter
      ? asBoolean(nativeFilter.isExclude, false)
      : asBoolean(entry.character_filter_exclude, false),
    names,
    tags: nativeFilter ? asStringArray(nativeFilter.tags) : [],
  };
}

/**
 * Convert the Character Card V3 `character_book` shape into the World Info
 * shape consumed by {@link importStLorebookJson}. This mirrors SillyTavern's
 * `convertCharacterBook` (world-info.js:5498-5547) before reusing the shared
 * ST world-file field mapper below.
 */
export function convertCharacterBook(input: Record<string, unknown>): Record<string, unknown> {
  const entries = Array.isArray(input.entries) ? input.entries.filter(isRecord) : [];
  return {
    name: input.name,
    description: input.description,
    scan_depth: input.scan_depth,
    token_budget: input.token_budget,
    recursive_scanning: input.recursive_scanning,
    entries: entries.map((entry, index) => {
      const extensions = isRecord(entry.extensions) ? entry.extensions : {};
      return {
        uid: entry.id === undefined ? index : entry.id,
        key: entry.keys,
        keysecondary: entry.secondary_keys ?? [],
        comment: entry.comment ?? "",
        content: entry.content,
        constant: entry.constant || false,
        selective: entry.selective || false,
        order: entry.insertion_order,
        position: extensions.position ?? (entry.position === "before_char" ? 0 : 1),
        excludeRecursion: extensions.exclude_recursion ?? false,
        preventRecursion: extensions.prevent_recursion ?? false,
        delayUntilRecursion: extensions.delay_until_recursion ?? false,
        disable: !entry.enabled,
        addMemo: Boolean(entry.comment),
        displayIndex: extensions.display_index ?? index,
        probability: extensions.probability ?? 100,
        useProbability: extensions.useProbability ?? true,
        depth: extensions.depth ?? 4,
        selectiveLogic: extensions.selectiveLogic ?? 0,
        outletName: extensions.outlet_name ?? "",
        group: extensions.group ?? "",
        groupOverride: extensions.group_override ?? false,
        groupWeight: extensions.group_weight ?? 100,
        scanDepth: extensions.scan_depth ?? null,
        caseSensitive: extensions.case_sensitive ?? null,
        matchWholeWords: extensions.match_whole_words ?? null,
        useGroupScoring: extensions.use_group_scoring ?? null,
        automationId: extensions.automation_id ?? "",
        role: extensions.role ?? 0,
        vectorized: extensions.vectorized ?? false,
        sticky: extensions.sticky ?? null,
        cooldown: extensions.cooldown ?? null,
        delay: extensions.delay ?? null,
        matchPersonaDescription: extensions.match_persona_description ?? false,
        matchCharacterDescription: extensions.match_character_description ?? false,
        matchCharacterPersonality: extensions.match_character_personality ?? false,
        matchCharacterDepthPrompt: extensions.match_character_depth_prompt ?? false,
        matchScenario: extensions.match_scenario ?? false,
        matchCreatorNotes: extensions.match_creator_notes ?? false,
        extensions,
        triggers: extensions.triggers ?? [],
        ignoreBudget: extensions.ignore_budget ?? false,
      };
    }),
  };
}

/** Import an embedded Character Card V3 lorebook using ST's card converter. */
export function importCharacterBookJson(
  input: unknown,
  options: ImportLorebookOptions = {},
): ImportedLorebookBundle {
  return importStLorebookJson(convertCharacterBook(isRecord(input) ? input : {}), options);
}

export function importStLorebookJson(
  input: string | Record<string, unknown>,
  options: ImportLorebookOptions = {},
): ImportedLorebookBundle {
  const root = parseJsonInput(input);
  const fallbackNow = options.now ?? new Date().toISOString();
  const importedAt = normalizeTimestamp(root.create_date, fallbackNow);
  const name = asString(root.name).trim() || options.fallbackName || "Imported Lorebook";

  const extensions = isRecord(root.extensions) ? root.extensions : {};
  const extensionPercent = extensions.token_budget_pct;
  const extensionCap = extensions.token_budget_cap;

  const normalized: StLorebookNormalized = {
    name,
    description: asString(root.description),
    // settings.json is authoritative for a directory import; file values keep
    // supporting legacy/VT round trips when a global setting is unavailable.
    scanDepth: options.globalScanDepth ?? asNumber(root.scan_depth, ST_WORLD_INFO_DEFAULTS.scanDepth),
    tokenBudget: asNumber(root.token_budget, 1000),
    tokenBudgetPercent: options.globalTokenBudgetPercent
      ?? (typeof extensionPercent === "number" && extensionPercent >= 0 && extensionPercent <= 100
        ? extensionPercent
        : ST_WORLD_INFO_DEFAULTS.tokenBudgetPercent),
    tokenBudgetCap: options.globalTokenBudgetCap
      ?? (typeof extensionCap === "number" && extensionCap >= 0 ? Math.floor(extensionCap) : ST_WORLD_INFO_DEFAULTS.tokenBudgetCap),
    recursiveScanning: options.globalRecursiveScanning
      ?? asBoolean(root.recursive_scanning, ST_WORLD_INFO_DEFAULTS.recursiveScanning),
    useGroupScoring: options.globalUseGroupScoring ?? ST_WORLD_INFO_DEFAULTS.useGroupScoring,
    caseSensitive: options.globalCaseSensitive ?? ST_WORLD_INFO_DEFAULTS.caseSensitive,
    matchWholeWords: options.globalMatchWholeWords ?? ST_WORLD_INFO_DEFAULTS.matchWholeWords,
    maxRecursionSteps: options.globalMaxRecursionSteps
      ?? asNumber(extensions.max_recursion_steps, ST_WORLD_INFO_DEFAULTS.maxRecursionSteps),
    includeNames: options.globalIncludeNames ?? ST_WORLD_INFO_DEFAULTS.includeNames,
    minActivations: options.globalMinActivations ?? ST_WORLD_INFO_DEFAULTS.minActivations,
    minActivationsDepthMax: options.globalMinActivationsDepthMax ?? ST_WORLD_INFO_DEFAULTS.minActivationsDepthMax,
    overflowAlert: options.globalOverflowAlert ?? ST_WORLD_INFO_DEFAULTS.overflowAlert,
    characterStrategy: options.globalCharacterStrategy ?? ST_WORLD_INFO_DEFAULTS.characterStrategy,
    extensions,
  };

  const lorebookId: LorebookId = brandId<LorebookId>(makeDeterministicId(
    ENTITY_ID_NAMESPACE.lorebook,
    `${normalized.name}:${stableJson(root)}`,
  ));

  const lorebook: Lorebook = {
    id: lorebookId,
    name: normalized.name,
    description: normalized.description,
    scopeType: options.scopeType ?? "entity",
    scanDepth: normalized.scanDepth,
    tokenBudget: normalized.tokenBudget,
    tokenBudgetPercent: normalized.tokenBudgetPercent,
    tokenBudgetCap: normalized.tokenBudgetCap,
    recursiveScanning: normalized.recursiveScanning,
    useGroupScoring: normalized.useGroupScoring,
    caseSensitive: normalized.caseSensitive,
    matchWholeWords: normalized.matchWholeWords,
    maxRecursionSteps: normalized.maxRecursionSteps,
    includeNames: normalized.includeNames,
    minActivations: normalized.minActivations,
    minActivationsDepthMax: normalized.minActivationsDepthMax,
    overflowAlert: normalized.overflowAlert,
    characterStrategy: normalized.characterStrategy,
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
    const primaryKeyResult = unwrapCaseFormsKeys(asStringArray(entry.key));
    // ST's new-entry template defaults selective to true. Secondary keys are
    // ignored only when the source explicitly disables selective matching.
    const selective = entry.selective !== false;
    const secondaryKeyResult = selective
      ? unwrapCaseFormsKeys(asStringArray(entry.keysecondary))
      : { keys: [], caseFormsKeys: [] };
    const keys = primaryKeyResult.keys;
    const secondaryKeys = secondaryKeyResult.keys;
    const caseFormsKeys = [...new Set([...primaryKeyResult.caseFormsKeys, ...secondaryKeyResult.caseFormsKeys])];
    const hasSecondaryLogic = selective && secondaryKeys.length > 0;
    const logic = hasSecondaryLogic ? mapSelectiveLogic(entry.selectiveLogic) : "and_any";
    const recursionDelay = mapDelayUntilRecursion(entry.delayUntilRecursion);
    const characterFilter = mapCharacterFilter(entry, options.characterFilterAvatarResolver);
    const externalId = String(entry.uid ?? index);
    const title = asString(entry.comment).trim() || `Entry ${externalId}`;
    const content = asString(entry.content);

    if (!content) {
      warnings.push(`Lore entry ${externalId} has empty content.`);
    }

    if (keys.length === 0 && !asBoolean(entry.constant, false)) {
      warnings.push(`Lore entry ${externalId} has no primary keys and is not constant.`);
    }

    // ST skips outlet-position entries without a name because no
    // {{outlet::name}} macro can reference them (world-info.js:5121-5124).
    // Keep this narrow warning here until step 21 reshapes the field map.
    if (asNumber(entry.position, 0) === 7 && !asString(entry.outletName).trim()) {
      warnings.push(`Lore entry ${externalId} has position 'outlet' but no outlet name.`);
    }

    if (characterFilter.tags.length > 0) {
      warnings.push(`Lore entry ${externalId} has character-filter tags that Vibe Tavern cannot import.`);
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
      // ST `delay` is an absolute chat-length gate — imported 1:1 into VT's
      // `minChatMessages` (the old VT-only `delayWindow` mechanic is gone;
      // resweep step 1, LOREBOOK_ST_PARITY_RESWEEP_2026-09).
      minChatMessages: asNumber(entry.delay, 0),
      constant: asBoolean(entry.constant, false),
      // ST skips its probability roll entirely when useProbability is false.
      probability: entry.useProbability === false ? 100 : asNumber(entry.probability, 100),
      ignoreBudget: asBoolean(entry.ignoreBudget, false),
      role: mapStRole(entry.role),
      groupName: asString(entry.group),
      groupWeight: asNumber(entry.groupWeight, 100),
      prioritizeInclusion: asBoolean(entry.groupOverride, false),
      // Tri-state preserve (ST parity): ST stores null (inherit the global
      // switch) / true / false — collapsing null to false would permanently
      // pin imported entries against the book default. See
      // LOREBOOK_GROUP_SCORING_PARITY_REPORT (LG-4).
      useGroupScoring: entry.useGroupScoring === true ? true : entry.useGroupScoring === false ? false : null,
      // Tri-state preserve (ST parity, D2): ST stores null (inherit the
      // global switch) / true / false for caseSensitive and matchWholeWords —
      // collapsing null to false would permanently pin imported entries
      // against the book default (world-info.js:269/347 resolves null against
      // the global setting).
      caseSensitive: entry.caseSensitive === true ? true : entry.caseSensitive === false ? false : null,
      matchWholeWords: entry.matchWholeWords === true ? true : entry.matchWholeWords === false ? false : null,
      caseFormsKeys,
      excludeRecursion: asBoolean(entry.excludeRecursion, false),
      preventRecursion: asBoolean(entry.preventRecursion, false),
      delayUntilRecursion: recursionDelay.delayUntilRecursion,
      recursionLevel: recursionDelay.recursionLevel,
      scanDepthOverride: entry.scanDepth != null ? asNumber(entry.scanDepth, 0) : null,
      characterFilter: characterFilter.characterFilter,
      characterFilterExclude: characterFilter.characterFilterExclude,
      matchSources: mapMatchSources(entry),
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
        stSelective: selective,
        stPosition: entry.position ?? 0,
        stConstant: asBoolean(entry.constant, false),
        stProbability: asNumber(entry.probability, 100),
        stIgnoreBudget: asBoolean(entry.ignoreBudget, false),
        stUseProbability: entry.useProbability !== false,
        stRole: entry.role ?? null,
        stGroup: asString(entry.group),
        stAddMemo: asBoolean(entry.addMemo, false),
        stExcludeRecursion: asBoolean(entry.excludeRecursion, false),
        stPreventRecursion: asBoolean(entry.preventRecursion, false),
        stDelayUntilRecursion: entry.delayUntilRecursion ?? false,
        stScanDepth: entry.scanDepth ?? null,
        stAutomationId: asString(entry.automationId),
        stOutletName: asString(entry.outletName),
        // VT binds known ST avatar filenames to local character names. Keep the
        // source names and unsupported tags in metadata so export can restore
        // ST's characterFilter object without a schema-only storage field.
        stCharacterFilterNames: characterFilter.names,
        stCharacterFilterTags: characterFilter.tags,
        ...(caseFormsKeys.length > 0 ? { caseFormsKeys } : {}),
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
  readonly tokenBudgetCap: number;
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
  readonly minChatMessages: number;
  readonly probability: number;
  readonly ignoreBudget: boolean;
  readonly role: string;
  readonly groupName: string;
  readonly groupWeight: number;
  readonly prioritizeInclusion: boolean;
  readonly useGroupScoring: boolean | null;
  readonly scanDepthOverride: number | null;
  readonly caseSensitive: boolean | null;
  readonly matchWholeWords: boolean | null;
  /** Plain keys compiled to ST regexes on export; metadata is the legacy physical store. */
  readonly caseFormsKeys?: readonly string[];
  readonly characterFilter: ReadonlyArray<{ name: string }>;
  readonly characterFilterExclude: boolean;
  readonly matchSources: readonly string[];
  readonly automationId: string;
  readonly excludeRecursion: boolean;
  readonly preventRecursion: boolean;
  readonly delayUntilRecursion: boolean;
  readonly recursionLevel: number;
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
function vtRoleToSt(role: string): number {
  if (role === "user") return 1;
  if (role === "assistant") return 2;
  return 0;
}

function stUidFromMetadata(metadata: Record<string, unknown>, fallback: number): number {
  const uid = metadata.stUid;
  return typeof uid === "number" && Number.isFinite(uid) ? uid : fallback;
}

function stCharacterFilterNames(entry: StExportLoreEntry): string[] {
  const preservedNames = asStringArray(entry.metadata.stCharacterFilterNames);
  // Imported resolved entries retain only the VT character name. Reuse the
  // source avatar filename when its one-to-one list still matches the filter;
  // native VT entries and changed filters fall back to their visible names.
  return preservedNames.length === entry.characterFilter.length
    ? preservedNames
    : entry.characterFilter.map((character) => character.name);
}

function stDelayUntilRecursion(entry: StExportLoreEntry): boolean | number {
  if (!entry.delayUntilRecursion) return false;
  return entry.recursionLevel > 1 ? entry.recursionLevel : true;
}

export type StLorebookExportWarning = {
  kind: "chat_off_entry";
  entryTitle: string;
};

export interface StLorebookExportResult {
  data: Record<string, unknown>;
  warnings: StLorebookExportWarning[];
}

export function exportLorebookToSt(
  lorebook: StExportLorebook,
  entries: readonly StExportLoreEntry[],
): Record<string, unknown> {
  const stEntries: Record<string, unknown> = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    stEntries[String(i)] = {
      uid: stUidFromMetadata(e.metadata, i),
      key: e.keys.map((key) => (e.caseFormsKeys ?? asStringArray(e.metadata.caseFormsKeys)).includes(key)
        ? compileRussianCaseFormsKey(key)
        : key),
      keysecondary: e.secondaryKeys.map((key) => (e.caseFormsKeys ?? asStringArray(e.metadata.caseFormsKeys)).includes(key)
        ? compileRussianCaseFormsKey(key)
        : key),
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
      // Step 1 parity: VT's minChatMessages is ST's absolute chat-length
      // delay gate, not the removed VT-only delay-window mechanic.
      delay: e.minChatMessages,
      probability: e.probability,
      // VT represents a disabled ST roll as probability 100. Metadata retains
      // the otherwise-lossy source switch so an imported entry exports exactly.
      useProbability: e.metadata.stUseProbability !== false,
      role: vtRoleToSt(e.role),
      group: e.groupName,
      groupWeight: e.groupWeight,
      groupOverride: e.prioritizeInclusion,
      useGroupScoring: e.useGroupScoring,
      ignoreBudget: e.ignoreBudget,
      scanDepth: e.scanDepthOverride,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      characterFilter: {
        isExclude: e.characterFilterExclude,
        names: stCharacterFilterNames(e),
        tags: asStringArray(e.metadata.stCharacterFilterTags),
      },
      addMemo: e.metadata.stAddMemo === true,
      outletName: asString(e.metadata.stOutletName),
      automationId: e.automationId,
      excludeRecursion: e.excludeRecursion,
      preventRecursion: e.preventRecursion,
      delayUntilRecursion: stDelayUntilRecursion(e),
      ...Object.fromEntries(ST_MATCH_SOURCE_MAP.map(({ field, source }) => [field, e.matchSources.includes(source)])),
    };
  }

  return {
    entries: stEntries,
    name: lorebook.name,
    description: lorebook.description,
    scan_depth: lorebook.scanDepth,
    token_budget: lorebook.tokenBudget,
    token_budget_percent: lorebook.tokenBudgetPercent,
    token_budget_cap: lorebook.tokenBudgetCap,
    recursive_scanning: lorebook.recursiveScanning,
    extensions: {
      ...((lorebook.extensions as Record<string, unknown>) ?? {}),
      max_recursion_steps: lorebook.maxRecursionSteps,
    },
  };
}

/**
 * Wrap the ST JSON in export diagnostics without adding VT-only metadata to
 * the downloaded ST file. ST always scans chat messages, so a VT entry that
 * turns chat off cannot round-trip that choice.
 */
export function exportLorebookToStWithWarnings(
  lorebook: StExportLorebook,
  entries: readonly StExportLoreEntry[],
): StLorebookExportResult {
  return {
    data: exportLorebookToSt(lorebook, entries),
    warnings: entries.flatMap((entry, index) => {
      if (entry.matchSources.includes(LORE_MATCH_SOURCE.chatMessages)) return [];
      const entryTitle = entry.title.trim() || entry.keys[0]?.trim() || `Entry ${index + 1}`;
      return [{ kind: "chat_off_entry", entryTitle }];
    }),
  };
}

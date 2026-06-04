import type {
  LoreEntry,
  LoreEntryId,
  LoreLogic,
  LoreEntryRole,
  LoreScopeType,
  Lorebook,
  LorebookId,
  LoreTriggerType,
  LoreMatchSource,
  PromptLayerPosition,
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

function mapPromptLayerPosition(value: unknown): PromptLayerPosition {
  // SillyTavern World Info positions are more fine-grained than Vibe Tavern's
  // canonical prompt layer positions. Preserve execution semantics by mapping
  // normal prompt-area positions to in_prompt, depth injections to in_chat, and
  // outlet entries to hidden_system.
  switch (value) {
    case 4:
      return "in_chat";
    case 7:
      return "hidden_system";
    case 0:
    case 1:
    case 2:
    case 3:
    case 5:
    case 6:
    default:
      return "in_prompt";
  }
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
    recursiveScanning: normalized.recursiveScanning,
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
      position: mapPromptLayerPosition(entry.position),
      depth: asNumber(entry.depth, options.defaultDepth ?? 4),
      priority: asNumber(entry.order, 100),
      stickyWindow: asNumber(entry.sticky, 0),
      cooldownWindow: asNumber(entry.cooldown, 0),
      delayWindow: asNumber(entry.delay, 0),
      constant: asBoolean(entry.constant, false),
      probability: asNumber(entry.probability, 100),
      ignoreBudget: asBoolean(entry.ignoreBudget, false),
      role: (asString(entry.role) || "system") as LoreEntryRole,
      group: asString(entry.group),
      groupWeight: 0,
      prioritizeInclusion: false,
      useGroupScoring: asBoolean(entry.useGroupScoring, false),
      excludeRecursion: asBoolean(entry.excludeRecursion, false),
      preventRecursion: asBoolean(entry.preventRecursion, false),
      delayUntilRecursion: asBoolean(entry.delayUntilRecursion, false),
      recursionLevel: 0,
      scanDepthOverride: entry.scanDepth != null ? asNumber(entry.scanDepth, 0) : null,
      caseSensitive: false,
      matchWholeWords: false,
      characterFilter: [],
      characterFilterExclude: false,
      triggers: [] as LoreTriggerType[],
      matchSources: [] as LoreMatchSource[],
      enabled: !asBoolean(entry.disable, false),
      sortOrder: asNumber(entry.order, 100),
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

import type {
  LoreEntry,
  LoreEntryId,
  LoreLogic,
  Lorebook,
  LorebookId,
  LoreScopeType,
} from "@vibe-tavern/domain";
import { brandId, ENTITY_ID_NAMESPACE } from "@vibe-tavern/domain";

import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  isRecord,
  makeDeterministicId,
  stableJson,
} from "../shared.js";

/**
 * Janitor AI lorebook entry record.
 *
 * Janitor ships a lorebook as a bare JSON ARRAY of entry objects (no
 * enclosing lorebook metadata object, unlike SillyTavern's `{ entries: {} }`
 * shape). The field names overlap with ST's (key/keysecondary/content/depth)
 * but use camelCase and carry Janitor-specific extras (inclusionGroupRaw,
 * insertion_order, activationMode, category, tags, minMessages).
 */
interface JanitorLorebookEntryRecord extends Record<string, unknown> {
  id?: unknown; // Janitor's own UUID (string), NOT our branded ID
  name?: unknown;
  comment?: unknown;
  content?: unknown;
  key?: unknown;
  keysecondary?: unknown;
  keysRaw?: unknown;
  keysecondaryRaw?: unknown;
  keywordsRaw?: unknown;
  selectiveLogic?: unknown;
  constant?: unknown;
  case_sensitive?: unknown;
  matchWholeWords?: unknown;
  probability?: unknown;
  groupWeight?: unknown;
  prioritizeInclusion?: unknown;
  inclusionGroupRaw?: unknown;
  insertion_order?: unknown;
  priority?: unknown;
  depth?: unknown;
  enabled?: unknown;
  minMessages?: unknown;
  category?: unknown;
  tags?: unknown;
  activationMode?: unknown;
  activationScript?: unknown;
  keyMatchPriority?: unknown;
  extensions?: unknown;
}

export interface JanitorImportedLorebookBundle {
  format: "janitor_lorebook_json";
  lorebook: Lorebook;
  entries: LoreEntry[];
  warnings: string[];
}

export interface ImportJanitorLorebookOptions {
  scopeType?: LoreScopeType;
  /** Lorebook name — Janitor files carry no lorebook-level name, so the caller
   * typically passes the uploaded filename (minus extension). */
  fallbackName?: string;
  /** Stable seed for deterministic lorebook ID; defaults to fallbackName. */
  nameSeed?: string;
}

/**
 * Map Janitor's `selectiveLogic` numeric enum to our canonical LoreLogic.
 * The enum values are ST-compatible (Janitor inherited them): 0=AND ANY,
 * 1=NOT ALL, 2=NOT ANY, 3=AND ALL.
 */
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

/**
 * Parse a Janitor AI lorebook — a bare JSON array of entry objects.
 *
 * Accepts either an already-parsed array or a JSON string. Throws if the
 * top-level value is not an array (use the ST parser for `{ entries: {} }`
 * shapes — format detection happens upstream in the import service).
 */
export function importJanitorLorebookJson(
  input: string | unknown[],
  options: ImportJanitorLorebookOptions = {},
): JanitorImportedLorebookBundle {
  const root = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!Array.isArray(root)) {
    throw new Error(
      "Janitor lorebook must be a top-level JSON array of entries. For SillyTavern `{ entries: ... }` shape, use the ST importer.",
    );
  }

  const entryRecords = root.filter(isRecord) as JanitorLorebookEntryRecord[];
  const warnings: string[] = [];

  // Lorebook-level metadata: Janitor ships none. Derive the name from the
  // caller-provided fallback (typically the filename) and apply sane engine
  // defaults. The first entry's name is a poor name proxy — prefer the file
  // name, then fall back to a generic label.
  const name = (options.fallbackName ?? "").trim() || "Imported Lorebook";
  const nameSeed = options.nameSeed ?? name;
  const now = new Date().toISOString();

  const lorebookId: LorebookId = brandId<LorebookId>(
    makeDeterministicId(ENTITY_ID_NAMESPACE.lorebook, `janitor:${nameSeed}:${stableJson(root)}`),
  );

  const lorebook: Lorebook = {
    id: lorebookId,
    name,
    description: "",
    scopeType: options.scopeType ?? "character",
    scanDepth: 10,
    tokenBudget: 1000,
    tokenBudgetPercent: null,
    recursiveScanning: false,
    maxRecursionSteps: 5,
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
    extensions: {},
    createdAt: now,
    updatedAt: now,
  };

  const entries: LoreEntry[] = entryRecords.map((entry, index) => {
    const externalId = asString(entry.id) || String(index);
    const title = asString(entry.name).trim() || asString(entry.comment).trim() || `Entry ${externalId}`;
    const content = asString(entry.content);
    const keys = asStringArray(entry.key);
    const secondaryKeys = asStringArray(entry.keysecondary);
    // selectiveLogic only applies when there are secondary keys to combine.
    const logic = secondaryKeys.length > 0 ? mapSelectiveLogic(entry.selectiveLogic) : "and_any";
    const groupName = asString(entry.inclusionGroupRaw);
    // Janitor's `insertion_order` is the canonical prompt-position signal
    // (higher = inserted first = survives token-budget overflow), exactly
    // matching ST's `order` and VT's `priority`. Janitor's own `priority`
    // (1-5 in Advanced scripts) is a coarser APPLY_LIMIT bucket used only
    // inside Janitor's runtime — preserve it in metadata, do NOT promote it
    // to VT `priority`, or it would invert overflow resolution.
    // See vibe_tavern_plan/reports/lorebook-st-parity-audit.md §4.2.
    const insertionOrder = asNumber(entry.insertion_order, index * 10);
    const janitorPriorityRaw = asNumber(entry.priority, insertionOrder);
    const priority = insertionOrder;

    if (!content) {
      warnings.push(`Lore entry ${externalId} (${title}) has empty content.`);
    }
    if (keys.length === 0 && !asBoolean(entry.constant, false)) {
      warnings.push(
        `Lore entry ${externalId} (${title}) has no primary keys and is not constant — it will never activate.`,
      );
    }

    return {
      id: brandId<LoreEntryId>(
        makeDeterministicId(
          ENTITY_ID_NAMESPACE.loreEntryDeterministic,
          `${lorebookId}:${externalId}:${content}`,
        ),
      ),
      lorebookId: lorebookId as LorebookId,
      title,
      content,
      keys,
      secondaryKeys,
      logic,
      // Basic Janitor format (single `content` slot, no `personality`/
      // `scenario` split) carries no per-entry prompt-layer position — the
      // "position" is implicit (content lands in the character-context
      // block). VT's `in_prompt` approximates that. Janitor Advanced scripts
      // (which DO have explicit personality/scenario targets) are out of
      // scope here — they run as VT scripts via context.character.* , not
      // as lorebook entries. See lorebook-st-parity-audit.md §4.1.
      position: "in_prompt",
      depth: asNumber(entry.depth, 4),
      priority,
      // Janitor does not expose sticky/cooldown/delay windows.
      stickyWindow: 0,
      cooldownWindow: 0,
      delayWindow: 0,
      constant: asBoolean(entry.constant, false),
      probability: asNumber(entry.probability, 100),
      ignoreBudget: false,
      role: "system",
      groupName,
      groupWeight: asNumber(entry.groupWeight, 100),
      prioritizeInclusion: asBoolean(entry.prioritizeInclusion, false),
      useGroupScoring: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      recursionLevel: 0,
      scanDepthOverride: null,
      caseSensitive: asBoolean(entry.case_sensitive, false),
      matchWholeWords: asBoolean(entry.matchWholeWords, false),
      characterFilter: [],
      characterFilterExclude: false,
      matchSources: [],
      enabled: asBoolean(entry.enabled, true),
      sortOrder: insertionOrder,
      automationId: "",
      metadata: {
        source: "janitor",
        janitorId: externalId,
        janitorName: asString(entry.name),
        janitorCategory: asString(entry.category),
        janitorTags: asStringArray(entry.tags),
        janitorActivationMode: asString(entry.activationMode),
        janitorMinMessages: asNumber(entry.minMessages, 0),
        janitorKeyMatchPriority: asBoolean(entry.keyMatchPriority, false),
        janitorInsertionOrder: insertionOrder,
        janitorPriority: janitorPriorityRaw,
        janitorInclusionGroupRaw: groupName,
      },
    };
  });

  return {
    format: "janitor_lorebook_json",
    lorebook,
    entries,
    warnings,
  };
}

/**
 * Format detector: returns true if the parsed JSON looks like a Janitor
 * lorebook (bare top-level array of records with typical Janitor keys).
 * Used by the import service to auto-route even when `format` was not
 * explicitly set or defaulted to "st".
 */
export function isJanitorLorebookArray(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  // Require at least one entry that looks like a Janitor record: it must have
  // a `content` string and at least one Janitor-specific key. This avoids a
  // false positive on a bare array of strings or numbers.
  const sample = data.find(isRecord);
  if (!sample) return false;
  return (
    typeof sample.content === "string" &&
    ("inclusionGroupRaw" in sample ||
      "insertion_order" in sample ||
      "activationMode" in sample ||
      "keysRaw" in sample ||
      "keysecondaryRaw" in sample)
  );
}

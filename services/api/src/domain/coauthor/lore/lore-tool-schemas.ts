/**
 * COAUTHOR_LORE_FULL_SETTINGS step 2 — the ONE schema source for the lore
 * tools' settings fields.
 *
 * Every settings field the lorebook API contracts define
 * (`updateLorebookMetaSchema` / `updateLoreEntrySchema` in api-contracts) is
 * exposed to the Co-Author here, built FROM those contract schemas via
 * `.omit` — no hand-written duplicate zod objects. The only hand-written part
 * is the per-field model-facing DESCRIPTION map: a field added to the
 * contracts later reaches the Co-Author by adding its description to the map
 * (the mapped types below are a compile error until then, and
 * `lore-tool-schemas.test.ts` pins the coverage at runtime).
 *
 * Deliberate narrowings (still one source — the enum values come from the
 * domain as-const objects; the wire stays the loose contract string):
 *  - `scopeType`, `logic`, `position`, `role`, `matchSources` are plain
 *    `z.string()` in the contracts; the tools narrow them to enums so the
 *    model cannot propose values the engine would silently mis-handle.
 *  - The entry `order` contract field is NOT exposed: it is an ST wire alias
 *    of `priority` (ST import maps ST `order` → VT `priority`; export maps
 *    VT `priority` → ST `order`), the store has no `order` column and the
 *    API PATCH path silently drops it — exposing it would let the Co-Author
 *    set a value that never lands. `priority` is the live knob.
 */
import {
  createLorebookSchema,
  updateLoreEntrySchema,
  updateLorebookMetaSchema,
} from "@vibe-tavern/api-contracts";
import {
  LORE_ENTRY_POSITION,
  LORE_ENTRY_ROLE,
  LORE_LOGIC,
  LORE_MATCH_SOURCE,
  LORE_SCOPE_TYPE,
} from "@vibe-tavern/domain";
import { z } from "zod";

/**
 * Entry fields of `updateLoreEntrySchema` deliberately NOT exposed as
 * settings: the content-path trio (content / keys / secondaryKeys —
 * delegate-only via `ai_write_lore_entry` / `ai_generate_lore_keys`) and
 * `order` (see the module header). Keyed object so the exclusion list is
 * itself drift-checked by `lore-tool-schemas.test.ts`.
 */
export const LORE_TOOL_EXCLUDED_ENTRY_FIELDS = {
  content: "content-path — delegate-only via ai_write_lore_entry",
  keys: "content-path — delegate-only via ai_generate_lore_keys",
  secondaryKeys: "content-path — delegate-only via ai_generate_lore_keys",
  order: "ST wire alias of priority (no store column; the API PATCH path drops it)",
} as const;

/** The `summary` param every lore tool carries (review-surface label). */
const summaryField = z
  .string()
  .max(200)
  .describe("One-line description of this change, shown above the Apply button.");

/**
 * Model-facing description for EVERY book-level settings field of
 * `updateLorebookMetaSchema`. The mapped type makes an added contract field a
 * compile error here until it gets a description — single source, no drift.
 */
export const LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS: {
  readonly [K in keyof typeof updateLorebookMetaSchema["shape"]]: string;
} = {
  name: "The lorebook's display name, e.g. 'World Lore' or 'Castle Anvil'.",
  description: "A short description of what this lorebook covers.",
  scanDepth:
    "How many recent chat messages the engine scans for key matches. Default 10. Raise (15-20) for slow-burn triggers that appear across a longer window; lower (5) for tight, fast-triggering books.",
  tokenBudget:
    "Max tokens this lorebook may inject per turn in FIXED-budget mode (used when tokenBudgetPercent is null). Default 1000.",
  tokenBudgetPercent:
    "Budget as a PERCENT of the model's context window instead of a fixed token count: null = fixed mode (use tokenBudget), 0-100 = percent mode (scales with the model's context). Prefer percent for reference books that should grow with the model.",
  tokenBudgetCap:
    "Absolute token ceiling for percent mode; 0 = no cap. Ignored in fixed mode (tokenBudget is already absolute).",
  recursiveScanning:
    "true lets a matched entry's keys trigger further entries (chains, layered worlds). Default false. Recursion can inflate token spend — pair it with a tighter budget.",
  useGroupScoring:
    "Book-level default for group scoring: when entries share a groupName, their key scores combine across the group instead of competing per entry. Entries can override per-entry (their null = inherit this default).",
  caseSensitive:
    "Book-level default: key matching distinguishes upper/lower case. Default false. Entries can override per-entry (their null = inherit).",
  matchWholeWords:
    "Book-level default: keys match only as whole words, not as substrings. Default false. Entries can override per-entry (their null = inherit).",
  maxRecursionSteps:
    "How many recursion hops a single activation may follow when recursiveScanning is on. 0 = unlimited.",
  includeNames:
    "Also scan character/persona NAMES as match text (ST's global include-names switch, scoped to this book). Default true.",
  minActivations:
    "Minimum number of entries that must activate from this book before ANY of them inject; below the threshold the engine widens its scan window trying to reach it. 0 = off.",
  minActivationsDepthMax:
    "Cap on how far the minActivations window may widen (in messages back from the newest). 0 = no cap (chat length is the only bound).",
  overflowAlert:
    "Show the user an alert when this lorebook's token budget overflows and entries get dropped. Default false.",
  characterStrategy:
    "How character-scoped and global lore entries are ordered relative to each other: 0 = evenly interleave, 1 = character books first (default), 2 = global books first.",
  scopeType:
    "Where this lorebook is scoped. 'entity' (default) attaches it to the current character; 'global' applies to every character; 'chat' only to this chat (rare).",
  enabled: "Whether the lorebook is active at all. Defaults to true.",
};

/**
 * Model-facing description for EVERY entry-level settings field of
 * `updateLoreEntrySchema` minus {@link LORE_TOOL_EXCLUDED_ENTRY_FIELDS}.
 * Same drift contract as the book map above.
 */
export const LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS: {
  readonly [K in keyof Omit<
    typeof updateLoreEntrySchema["shape"],
    keyof typeof LORE_TOOL_EXCLUDED_ENTRY_FIELDS
  >]: string;
} = {
  title: "A short organizational title for the entry (shown to the author; NOT an activation trigger).",
  logic:
    "How the entry's secondary keys combine with a primary key match: 'and_any' (default) = at least one secondary must also match; 'and_all' = all must match; 'not_any' = none may match (suppression); 'not_all' = not all match.",
  position:
    "Where the entry injects in the assembled prompt. Common: 'before_char' / 'after_char' (world info around the character card). Depth-aware: 'at_depth' (uses depth), 'in_chat'. Around example dialogue: 'before_examples' / 'after_examples'. Author's Note: 'top_an' / 'bottom_an'. Persona slots: 'before_persona' / 'after_persona'. VT-native: 'outlet' (end of prompt), 'before_prompt', 'in_prompt', 'hidden_system'.",
  depth: "Injection depth for depth-aware positions ('at_depth', 'in_chat'): how many messages deep the entry lands. Default 4.",
  priority:
    "Insertion priority when several entries compete for the same slot: higher wins (this is ST's 'order'). Default 100.",
  constant:
    "If true the entry activates every turn regardless of key match (world rules, core conditions). Default false. Sparing use — constant entries always cost budget; the keyword path is the default for a reason.",
  probability:
    "Chance the entry actually injects when it activates, 0-100 percent. Default 100. Use for flavor entries that should not fire every time.",
  ignoreBudget: "true = the entry bypasses the lorebook's token budget entirely. Default false. Use sparingly for must-have entries.",
  role:
    "Chat role the injected text plays for depth-aware chat positions: 'system' (default), 'user', or 'assistant'. Only meaningful with position 'at_depth'/'in_chat'.",
  groupName:
    "Inclusion group: entries sharing a groupName form a group of which only some inject per turn (picked by weight). Empty = no group.",
  groupWeight:
    "Relative chance this entry is the one picked from its inclusion group (higher = more likely). Default 100.",
  prioritizeInclusion:
    "true = this entry is always included when its inclusion group is picked, before weighted selection. Default false.",
  useGroupScoring:
    "Per-entry override of the book's group-scoring default for this entry's group: true/false = explicit, null (default) = inherit the book's setting.",
  excludeRecursion:
    "true = this entry can never be activated BY a recursive scan (only by the normal chat scan). Default false.",
  preventRecursion:
    "true = this entry's own keys do not trigger further entries during recursion. Default false.",
  delayUntilRecursion:
    "true = the entry only becomes eligible at recursion level `recursionLevel` — it waits until other entries have already matched and been injected. Default false.",
  recursionLevel:
    "The recursion level this entry waits for when delayUntilRecursion is true. Default 0.",
  scanDepthOverride:
    "Per-entry override of the lorebook's scanDepth for this entry only: number = override, null (default) = use the book's scanDepth.",
  caseSensitive:
    "Per-entry override of the book's caseSensitive default: true/false = explicit, null (default) = inherit the book's setting.",
  matchWholeWords:
    "Per-entry override of the book's matchWholeWords default: true/false = explicit, null (default) = inherit the book's setting.",
  caseFormsKeys:
    "The subset of this entry's keys for which the Russian case-forms compiler auto-generates grammatical case variants (a Russian name key then matches in genitive/dative/etc. too). Only meaningful for Russian keys; list keys that exist on the entry (keys themselves come from ai_generate_lore_keys).",
  characterFilter:
    "Restrict activation to specific characters: a list of { id, name }. Use id null + the character's name for a name-matched filter (works even for characters not in this database); use a real character id (from search_context results) for a rename-proof filter. Empty = no filter.",
  characterFilterExclude:
    "false (default) = the characterFilter is an ALLOW-list (only listed characters trigger the entry); true = a BLOCK-list (everyone except the listed characters).",
  matchSources:
    "Which text sources the engine scans for this entry's keys: 'chat_messages' (the default, chat only) plus character fields ('character_desc', 'character_personality', 'character_note', 'character_alt_greetings'), persona ('persona_desc'), chat framing ('scenario', 'authors_note', 'chat_dynamic_prompt', 'chat_summary'), background ('creator_notes', 'summaries').",
  enabled: "Whether the entry is active at all. Default true.",
  stickyWindow:
    "After this entry activates, it keeps injecting for the next N turns even without a key match (stickiness). 0 = off. Use for facts that should persist once surfaced (an injury, a revealed secret).",
  cooldownWindow:
    "After this entry activates, it is suppressed for the next N turns even on a key match. 0 = off. Use to stop a trigger from re-firing every turn.",
  minChatMessages:
    "Absolute chat-length gate: while the chat has fewer messages than this, the entry is fully suppressed (constants and windows included). 0 = off. Use for late-game reveals.",
};

// ─── Derivation helpers ──────────────────────────────────────────────────────

/**
 * Apply each field's model-facing description to a contract-derived shape.
 * Generic over the shape so a contract field with no description entry is a
 * compile error at the call site (mapped-type exhaustiveness).
 */
function withFieldDescriptions<T extends Record<string, z.ZodType>>(
  shape: T,
  descriptions: { readonly [K in keyof T]: string },
): { [K in keyof T]: T[K] } {
  const out: Record<string, z.ZodType> = {};
  for (const key of Object.keys(shape)) {
    out[key] = shape[key as keyof T].describe(descriptions[key as keyof T]);
  }
  // The loop rebuilt the same shape with descriptions attached; one edge cast
  // (ZodRawShape values carry no public members, so TS cannot see the loop
  // preserves each field's exact type) restores the precise generic.
  return out as unknown as { [K in keyof T]: T[K] };
}

/** Values of a domain as-const string-enum object as a zod enum (one source). */
function domainEnumValues<const T extends Record<string, string>>(values: T) {
  return z.enum(Object.values(values) as [T[keyof T], ...T[keyof T][]]);
}

// ─── Book-level settings fields (create_lorebook / edit_lorebook) ───────────

const lorebookScopeTypeEnum = domainEnumValues(LORE_SCOPE_TYPE)
  .optional()
  .describe(LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS.scopeType);

/**
 * Book settings EXCLUDING `name` (create takes the required `name` from
 * `createLorebookSchema`; edit takes the optional one from the update
 * contract — spreading an optional `name` after a required literal key would
 * silently override it, so `name` is threaded separately by each tool).
 * `scopeType` is narrowed to the draft enum in place (contract key order is
 * preserved).
 */
const lorebookSettingsFieldsExceptName = {
  ...withFieldDescriptions(
    updateLorebookMetaSchema.omit({ name: true, scopeType: true }).shape,
    LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS,
  ),
  scopeType: lorebookScopeTypeEnum,
};

/** create_lorebook input: required `name` + every book setting + summary. */
export const createLorebookToolInputSchema = z.object({
  name: createLorebookSchema.shape.name.describe(LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS.name),
  ...lorebookSettingsFieldsExceptName,
  summary: summaryField,
});

/** edit_lorebook input: target id + every book setting + summary. */
export const editLorebookToolInputSchema = z.object({
  lorebookId: z
    .string()
    .describe("The id of the lorebook to edit — a create_lorebook id from this turn, or a persisted lorebook id."),
  name: updateLorebookMetaSchema.shape.name.describe(LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS.name),
  ...lorebookSettingsFieldsExceptName,
  summary: summaryField,
});

// ─── Entry-level settings fields ─────────────────────────────────────────────

const loreLogicEnum = domainEnumValues(LORE_LOGIC);
const lorePositionEnum = domainEnumValues(LORE_ENTRY_POSITION);
const loreRoleEnum = domainEnumValues(LORE_ENTRY_ROLE);
const loreMatchSourceEnum = domainEnumValues(LORE_MATCH_SOURCE);

/**
 * Every `updateLoreEntrySchema` settings field (minus the documented
 * exclusions) with its model-facing description; `logic` / `position` /
 * `role` / `matchSources` are narrowed from the contract's plain strings to
 * the domain enums (same single source; the model cannot propose garbage).
 */
const loreEntrySettingsFields = {
  ...withFieldDescriptions(
    updateLoreEntrySchema.omit({
      content: true,
      keys: true,
      secondaryKeys: true,
      order: true,
    }).shape,
    LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS,
  ),
  logic: loreLogicEnum.optional().describe(LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS.logic),
  position: lorePositionEnum.optional().describe(LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS.position),
  role: loreRoleEnum.optional().describe(LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS.role),
  matchSources: z
    .array(loreMatchSourceEnum)
    .optional()
    .describe(LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS.matchSources),
};

/** create_lore_entry input: parent id + settings skeleton + summary. */
export const createLoreEntryToolInputSchema = z.object({
  lorebookId: z
    .string()
    .describe("The id of the parent lorebook (from a create_lorebook result this turn)."),
  ...loreEntrySettingsFields,
  summary: summaryField,
});

/** add_lore_entry input: EXISTING parent id + settings skeleton + summary. */
export const addLoreEntryToolInputSchema = z.object({
  lorebookId: z
    .string()
    .describe("The id of an EXISTING lorebook (drafted this turn or persisted) to add the entry to."),
  ...loreEntrySettingsFields,
  summary: summaryField,
});

/** edit_lore_entry input: target id + every entry setting + summary. */
export const editLoreEntryToolInputSchema = z.object({
  entryId: z
    .string()
    .describe("The id of the entry to edit — a create_lore_entry id from this turn, or a persisted entry id."),
  ...loreEntrySettingsFields,
  summary: summaryField,
});

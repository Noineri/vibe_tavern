/**
 * Lore entry field-map spec — the single source of truth mapping the ~33
 * lore-entry domain fields to their DB columns (extracted from
 * `lorebook-store.ts` so both the store CRUD and the co-author Apply
 * (`coauthor-lore-apply.ts`) derive from ONE table with no module cycle).
 *
 * The fields are mapped at three transform-bearing boundaries (createEntry
 * insert, updateEntry patch, mapEntryRow read) plus one identity projection
 * (duplicateLorebook). Previously each site hand-maintained the field list
 * with bool→int coercion, JSON serialization, and `?? default` — the same
 * structural drift class that shipped the avatar `avatarFullExt` bug (one map
 * silently dropped a field). `ENTRY_FIELD_SPEC` is the one table the
 * transform-bearing sites derive from; keyed by `keyof CreateLoreEntryData`
 * so adding a field to the input type without adding it here is a compile
 * error (exhaustiveness via the mapped type).
 */
import type { loreEntries } from '../db-schema.js';
import type { CreateLoreEntryData, LoreEntry, UpdateLoreEntryData } from './lorebook-store.js';

// ─── Entry field-map spec (single source of truth) ───────────────────────────
//
// The ~33 lore-entry fields are mapped at three transform-bearing boundaries
// (createEntry insert, updateEntry patch, mapEntryRow read) plus one identity
// projection (duplicateLorebook). Previously each site hand-maintained the
// field list with bool→int coercion, JSON serialization, and `?? default` —
// the same structural drift class that shipped the avatar `avatarFullExt` bug
// (one map silently dropped a field). In fact duplicateLorebook's projection
// had ALREADY dropped useGroupScoring/automationId/sortOrder — caught by the
// characterization test. `ENTRY_FIELD_SPEC` is the one table the three
// transform-bearing sites derive from; keyed by `keyof CreateLoreEntryData` so
// adding a field to the input type without adding it here is a compile error
// (exhaustiveness via the mapped type). The duplicate projection needs no
// transforms (it is LoreEntry→CreateLoreEntryData, same domain types) so it is
// a structural destructure, not a spec loop — type-safe and auto-exhaustive.

export type EntryCoerce = 'bool' | 'bool3' | 'json' | 'raw';
export type StoredEntryField = Exclude<keyof CreateLoreEntryData, 'caseFormsKeys'>;

export interface EntryFieldSpec {
  /** Drizzle column on `loreEntries`. */
  readonly column: keyof typeof loreEntries.$inferInsert;
  /** Transform at the DB boundary: bool→0/1 int, json→stringify, raw→passthrough. */
  readonly coerce: EntryCoerce;
  /** Value used on create when the input omits the field. */
  readonly insertDefault: unknown;
}

export const ENTRY_FIELD_SPEC: { readonly [K in StoredEntryField]: EntryFieldSpec } = {
  title:                  { column: 'title',                  coerce: 'raw',  insertDefault: '' },
  content:                { column: 'content',                coerce: 'raw',  insertDefault: '' },
  keys:                   { column: 'keysJson',               coerce: 'json', insertDefault: [] },
  secondaryKeys:          { column: 'secondaryKeysJson',      coerce: 'json', insertDefault: [] },
  logic:                  { column: 'logic',                  coerce: 'raw',  insertDefault: 'and_any' },
  position:               { column: 'position',               coerce: 'raw',  insertDefault: 'in_prompt' },
  depth:                  { column: 'depth',                  coerce: 'raw',  insertDefault: 4 },
  priority:               { column: 'priority',               coerce: 'raw',  insertDefault: 100 },
  stickyWindow:           { column: 'stickyWindow',           coerce: 'raw',  insertDefault: 0 },
  cooldownWindow:         { column: 'cooldownWindow',         coerce: 'raw',  insertDefault: 0 },
  minChatMessages:        { column: 'minChatMessages',        coerce: 'raw',  insertDefault: 0 },
  constant:               { column: 'constant',               coerce: 'bool', insertDefault: false },
  probability:            { column: 'probability',            coerce: 'raw',  insertDefault: 100 },
  ignoreBudget:           { column: 'ignoreBudget',           coerce: 'bool', insertDefault: false },
  role:                   { column: 'role',                   coerce: 'raw',  insertDefault: 'system' },
  groupName:              { column: 'groupName',              coerce: 'raw',  insertDefault: '' },
  groupWeight:            { column: 'groupWeight',            coerce: 'raw',  insertDefault: 100 },
  prioritizeInclusion:    { column: 'prioritizeInclusion',    coerce: 'bool', insertDefault: false },
  useGroupScoring:        { column: 'useGroupScoring',        coerce: 'bool3', insertDefault: null },
  excludeRecursion:       { column: 'excludeRecursion',       coerce: 'bool', insertDefault: false },
  preventRecursion:       { column: 'preventRecursion',       coerce: 'bool', insertDefault: false },
  delayUntilRecursion:    { column: 'delayUntilRecursion',    coerce: 'bool', insertDefault: false },
  recursionLevel:         { column: 'recursionLevel',         coerce: 'raw',  insertDefault: 0 },
  scanDepthOverride:      { column: 'scanDepthOverride',      coerce: 'raw',  insertDefault: null },
  caseSensitive:          { column: 'caseSensitive',          coerce: 'bool3', insertDefault: null },
  matchWholeWords:        { column: 'matchWholeWords',        coerce: 'bool3', insertDefault: null },
  characterFilter:        { column: 'characterFilterJson',    coerce: 'json', insertDefault: [] },
  characterFilterExclude: { column: 'characterFilterExclude', coerce: 'bool', insertDefault: false },
  matchSources:           { column: 'matchSourcesJson',       coerce: 'json', insertDefault: ['chat_messages'] },
  enabled:                { column: 'enabled',                coerce: 'bool', insertDefault: true },
  sortOrder:              { column: 'sortOrder',              coerce: 'raw',  insertDefault: 0 },
  automationId:           { column: 'automationId',           coerce: 'raw',  insertDefault: '' },
  metadata:               { column: 'metadataJson',           coerce: 'json', insertDefault: {} },
};

/** Encode a domain value into its DB representation (write boundary). */
function encodeEntryField(coerce: EntryCoerce, value: unknown): number | string | null {
  switch (coerce) {
    case 'bool': return value ? 1 : 0;
    case 'bool3': return value === null || value === undefined ? null : value ? 1 : 0;
    case 'json': return JSON.stringify(value);
    case 'raw':  return value as number | string | null;
  }
}

/** Decode a DB cell into its domain value (read boundary). */
export function decodeEntryField(coerce: EntryCoerce, value: unknown): unknown {
  switch (coerce) {
    case 'bool': return value === 1;
    case 'bool3': return value === null || value === undefined ? null : value === 1;
    case 'json': return JSON.parse(value as string);
    case 'raw':  return value;
  }
}

/** Build the data-field payload for `createEntry`'s `.values()` (create path). */
export function mergeCaseFormsKeys(metadata: Record<string, unknown> | undefined, caseFormsKeys: string[] | undefined): Record<string, unknown> {
  // undefined = no opinion: leave metadata untouched (a bare unrelated-field
  // update must not fabricate or prune the key). A DEFINED list writes or
  // prunes: non-empty writes the flag list, empty deletes a stale key — so an
  // absent flag round-trips byte-identically while a toggled-off chip prunes.
  if (caseFormsKeys === undefined) return metadata ?? {};
  const next = { ...(metadata ?? {}) };
  if (caseFormsKeys.length > 0) next.caseFormsKeys = caseFormsKeys;
  else delete next.caseFormsKeys;
  return next;
}

export function buildEntryInsert(data: CreateLoreEntryData): Partial<typeof loreEntries.$inferInsert> {
  const out: Record<string, number | string | null> = {};
  const metadata = mergeCaseFormsKeys(data.metadata, data.caseFormsKeys);
  for (const [domain, spec] of Object.entries(ENTRY_FIELD_SPEC) as Array<[StoredEntryField, EntryFieldSpec]>) {
    const value = domain === 'metadata' ? metadata : data[domain];
    out[spec.column] = encodeEntryField(spec.coerce, value ?? spec.insertDefault);
  }
  // Single concrete assertion at the DB boundary (the spec loop cannot assign
  // to specific keys of the Drizzle insert type per-iteration without it).
  // Exhaustiveness is guaranteed by ENTRY_FIELD_SPEC's mapped-type keying;
  // coerce correctness is pinned by the entry field round-trip tests.
  return out as Partial<typeof loreEntries.$inferInsert>;
}

/** Build the partial patch for `updateEntry` (only fields the caller provided). */
export function buildEntryPatch(data: UpdateLoreEntryData): Partial<typeof loreEntries.$inferInsert> {
  const out: Record<string, number | string | null> = {};
  for (const [domain, spec] of Object.entries(ENTRY_FIELD_SPEC) as Array<[StoredEntryField, EntryFieldSpec]>) {
    const value = data[domain];
    if (value !== undefined) {
      out[spec.column] = encodeEntryField(spec.coerce, value);
    }
  }
  return out as Partial<typeof loreEntries.$inferInsert>;
}

/**
 * Project a stored `LoreEntry` back into `CreateLoreEntryData` (for
 * `duplicateLorebook` and any replay-into-create path). This is an identity
 * projection — LoreEntry and CreateLoreEntryData share the same domain field
 * types — so a structural destructure is type-safe, auto-exhaustive, and cannot
 * silently drop a field. (Previously a hand-written 31-field literal here
 * dropped useGroupScoring/automationId/sortOrder.)
 */
export function entryToCreateData(entry: LoreEntry): CreateLoreEntryData {
  const { id: _id, lorebookId: _lorebookId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = entry;
  return rest;
}

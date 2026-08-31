import { eq, and, or, asc, sql, inArray } from 'drizzle-orm';
import { lorebooks, loreEntries, lorebookLinks } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';
import type { CharacterFilterEntry } from '@vibe-tavern/domain';
import { LOREBOOK_DEFAULTS } from '@vibe-tavern/domain';

/**
 * Parse a raw `characterFilterJson` value into the canonical `CharacterFilterEntry[]`
 * shape, lazily migrating legacy data at the read boundary:
 *   - legacy `string[]` (raw character names) → `[{ id: null, name }]` ghosts;
 *   - already-migrated `{id,name}[]` → normalized (id coerced to string|null);
 *   - anything else → `[]`.
 *
 * Pure shape coercion only — NO name→id resolution (this store has no character
 * table access). Ghosts stay ghosts until bound in the UI; the activation engine
 * matches ghosts by name (see `lore-activation-engine.ts`).
 */
function parseCharacterFilter(raw: unknown): CharacterFilterEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CharacterFilterEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push({ id: null, name: item });
      continue;
    }
    if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      const obj = item as { id?: unknown; name: string };
      out.push({ id: typeof obj.id === 'string' ? obj.id : null, name: obj.name });
    }
  }
  return out;
}

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateLorebookData {
  name: string;
  description?: string;
  scopeType: string;
  scanDepth?: number;
  tokenBudget?: number;
  tokenBudgetPercent?: number | null;
  recursiveScanning?: boolean;
  useGroupScoring?: boolean;
  maxRecursionSteps?: number;
  includeNames?: boolean;
  minActivations?: number;
  minActivationsDepthMax?: number;
  overflowAlert?: boolean;
  characterStrategy?: number;
  sortOrder?: number;
  enabled?: boolean;
  characterId?: string | null;
  personaId?: string | null;
  chatId?: string | null;
  extensions?: Record<string, unknown>;
}

export type UpdateLorebookData = Partial<CreateLorebookData>;

export interface CreateLoreEntryData {
  title?: string;
  content?: string;
  keys?: string[];
  secondaryKeys?: string[];
  logic?: string;
  position?: string;
  depth?: number;
  priority?: number;
  stickyWindow?: number;
  cooldownWindow?: number;
  delayWindow?: number;
  constant?: boolean;
  probability?: number;
  ignoreBudget?: boolean;
  role?: string;
  groupName?: string;
  groupWeight?: number;
  prioritizeInclusion?: boolean;
  /** Tri-state (ST parity): null = inherit the book default, true/false = explicit. */
  useGroupScoring?: boolean | null;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  delayUntilRecursion?: boolean;
  recursionLevel?: number;
  scanDepthOverride?: number | null;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  characterFilter?: CharacterFilterEntry[];
  characterFilterExclude?: boolean;
  matchSources?: string[];
  enabled?: boolean;
  sortOrder?: number;
  automationId?: string;
  metadata?: Record<string, unknown>;
}

export type UpdateLoreEntryData = Partial<CreateLoreEntryData>;

// ─── Co-Author lore draft Apply (CTX-L2, Wave 4) ──────────────────────────────

/**
 * The co-author lore draft bundle persisted by Apply. Structurally identical
 * to the api-contracts `CoauthorLoreBundle` — the store (packages/db) cannot
 * import api-contracts (dependency graph: db ← domain only), so the shape is
 * re-declared here and the caller passes the contract bundle verbatim (TS
 * structural typing accepts it without a forbidden import).
 *
 * `id`s are PREALLOCATED in the request-local draft engine and become the DB
 * primary keys; Apply is idempotent (re-Apply upserts the same rows). The
 * scopeType→owner mapping mirrors `createLorebook`: a 'character'-scoped draft
 * book is written with `characterId` set so the activation engine (FK ∪
 * junction) finds it.
 */
export interface CoauthorLoreDraftBundle {
  lorebooks: Array<{
    id: string;
    name: string;
    description: string;
    scopeType: 'global' | 'character' | 'persona' | 'chat';
    enabled: boolean;
    /** CE-A1: activation overrides authored by the co-author. Apply falls back to `LOREBOOK_DEFAULTS` when absent. */
    scanDepth?: number;
    tokenBudget?: number;
    recursiveScanning?: boolean;
    useGroupScoring?: boolean;
    /** CE-B1 review metadata; Apply already routes create/edit via PK upsert. */
    mode?: 'create' | 'edit';
  }>;
  entries: Array<{
    id: string;
    lorebookId: string;
    title: string;
    content: string;
    keys: string[];
    secondaryKeys: string[];
    constant: boolean;
    position: string;
    depth: number;
    /** CE-A2: activation logic / match mode (LORE_LOGIC); falls back to 'and_any' when absent. */
    logic?: string;
    enabled: boolean;
    /** CE-B1 review metadata; Apply already routes create/edit via PK upsert. */
    mode?: 'create' | 'edit';
    /** CE-B2: verified persisted parent absent from this proposal bundle. */
    parentMode?: 'persisted';
  }>;
}

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Store-level Lorebook — domain Lorebook projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 */
export interface Lorebook {
  id: string;
  name: string;
  description: string;
  scopeType: string;
  scanDepth: number;
  tokenBudget: number;
  tokenBudgetPercent: number | null;
  recursiveScanning: boolean;
  useGroupScoring: boolean;
  maxRecursionSteps: number;
  includeNames: boolean;
  minActivations: number;
  minActivationsDepthMax: number;
  overflowAlert: boolean;
  characterStrategy: number;
  sortOrder: number;
  enabled: boolean;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Store-level LoreEntry — domain LoreEntry projected from a DB row.
 */
export interface LoreEntry {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: string;
  position: string;
  depth: number;
  priority: number;
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  constant: boolean;
  probability: number;
  ignoreBudget: boolean;
  role: string;
  groupName: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  /** Tri-state (ST parity): null = inherit the book default, true/false = explicit. */
  useGroupScoring: boolean | null;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: CharacterFilterEntry[];
  characterFilterExclude: boolean;
  matchSources: string[];
  enabled: boolean;
  sortOrder: number;
  automationId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─── Link types ────────────────────────────────────────────────────────────────

export interface LorebookLink {
  lorebookId: string;
  targetType: 'character' | 'persona';
  targetId: string;
}

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

type EntryCoerce = 'bool' | 'bool3' | 'json' | 'raw';

interface EntryFieldSpec {
  /** Drizzle column on `loreEntries`. */
  readonly column: keyof typeof loreEntries.$inferInsert;
  /** Transform at the DB boundary: bool→0/1 int, json→stringify, raw→passthrough. */
  readonly coerce: EntryCoerce;
  /** Value used on create when the input omits the field. */
  readonly insertDefault: unknown;
}

const ENTRY_FIELD_SPEC: { readonly [K in keyof CreateLoreEntryData]: EntryFieldSpec } = {
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
  delayWindow:            { column: 'delayWindow',            coerce: 'raw',  insertDefault: 0 },
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
  caseSensitive:          { column: 'caseSensitive',          coerce: 'bool', insertDefault: false },
  matchWholeWords:        { column: 'matchWholeWords',        coerce: 'bool', insertDefault: false },
  characterFilter:        { column: 'characterFilterJson',    coerce: 'json', insertDefault: [] },
  characterFilterExclude: { column: 'characterFilterExclude', coerce: 'bool', insertDefault: false },
  matchSources:           { column: 'matchSourcesJson',       coerce: 'json', insertDefault: [] },
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
function decodeEntryField(coerce: EntryCoerce, value: unknown): unknown {
  switch (coerce) {
    case 'bool': return value === 1;
    case 'bool3': return value === null || value === undefined ? null : value === 1;
    case 'json': return JSON.parse(value as string);
    case 'raw':  return value;
  }
}

/** Build the data-field payload for `createEntry`'s `.values()` (create path). */
function buildEntryInsert(data: CreateLoreEntryData): Partial<typeof loreEntries.$inferInsert> {
  const out: Record<string, number | string | null> = {};
  for (const [domain, spec] of Object.entries(ENTRY_FIELD_SPEC) as Array<[keyof CreateLoreEntryData, EntryFieldSpec]>) {
    const value = data[domain] ?? spec.insertDefault;
    out[spec.column] = encodeEntryField(spec.coerce, value);
  }
  // Single concrete assertion at the DB boundary (the spec loop cannot assign
  // to specific keys of the Drizzle insert type per-iteration without it).
  // Exhaustiveness is guaranteed by ENTRY_FIELD_SPEC's mapped-type keying;
  // coerce correctness is pinned by the entry field round-trip tests.
  return out as Partial<typeof loreEntries.$inferInsert>;
}

/** Build the partial patch for `updateEntry` (only fields the caller provided). */
function buildEntryPatch(data: UpdateLoreEntryData): Partial<typeof loreEntries.$inferInsert> {
  const out: Record<string, number | string | null> = {};
  for (const [domain, spec] of Object.entries(ENTRY_FIELD_SPEC) as Array<[keyof CreateLoreEntryData, EntryFieldSpec]>) {
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
function entryToCreateData(entry: LoreEntry): CreateLoreEntryData {
  const { id: _id, lorebookId: _lorebookId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = entry;
  return rest;
}

/**
 * Recover the original ST WI position from import metadata, or canonicalize a
 * prompt-layer position that leaked into lorebook-UI semantics. Pure helper —
 * no `this` — so it lives at module scope for `decodeEntryFields` to call.
 */
function normalizeImportedEntryPosition(
  position: string,
  metadata: Record<string, unknown>,
): string {
  // Older ST imports collapsed most ST WI positions into canonical "in_prompt".
  // Recover the original ST-like UI position from import metadata when present.
  const stPosition = metadata.stPosition;
  if ((position === 'in_prompt' || position === 'before_prompt' || position === 'in_chat' || position === 'hidden_system') && typeof stPosition === 'number') {
    switch (stPosition) {
      case 0: return 'before_char';
      case 1: return 'after_char';
      case 2: return 'top_an';
      case 3: return 'bottom_an';
      case 4: return 'at_depth';
      case 5: return 'before_examples';
      case 6: return 'after_examples';
      case 7: return 'outlet';
    }
  }

  // Canonical prompt-layer positions should not leak into lorebook UI semantics.
  switch (position) {
    case 'before_prompt': return 'before_char';
    case 'in_prompt': return 'after_char';
    case 'in_chat': return 'at_depth';
    case 'hidden_system': return 'outlet';
    default: return position;
  }
}

/**
 * Decode every spec field from a DB row into its domain value, applying the
 * two read-side post-processes the flat coerce kinds cannot express: position
 * recovery (ST-import `stPosition` metadata / prompt-layer leak canonicalization)
 * and the legacy `characterFilter` migration (raw string[] → ghost entries).
 * `id`/`lorebookId`/timestamps are added by the caller (`mapEntryRow`).
 */
function decodeEntryFields(row: typeof loreEntries.$inferSelect): Omit<LoreEntry, 'id' | 'lorebookId' | 'createdAt' | 'updatedAt'> {
  const out: Record<string, unknown> = {};
  for (const [domain, spec] of Object.entries(ENTRY_FIELD_SPEC) as Array<[keyof CreateLoreEntryData, EntryFieldSpec]>) {
    out[domain] = decodeEntryField(spec.coerce, row[spec.column]);
  }
  const metadata = (out.metadata as Record<string, unknown>) ?? {};
  out.position = normalizeImportedEntryPosition(out.position as string, metadata);
  out.characterFilter = parseCharacterFilter(out.characterFilter);
  return out as Omit<LoreEntry, 'id' | 'lorebookId' | 'createdAt' | 'updatedAt'>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class LorebookStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;
  private readonly content: ContentStore | null;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator; content?: ContentStore | null }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.content = options?.content ?? null;
  }

  // ─── Lorebook CRUD ─────────────────────────────────────────────────────────

  async getLorebook(id: string): Promise<Lorebook | null> {
    const row = await this.db.select().from(lorebooks).where(eq(lorebooks.id, id)).get();
    if (!row) return null;

    // Lazy migration: generate file if it doesn't exist on disk
    if (this.content && !row.hasFileOnDisk) {
      await this.syncFile(id);
    }

    return this.mapLorebookRow(row);
  }

  async listAllLorebooks(): Promise<Lorebook[]> {
    const rows = await this.db
      .select()
      .from(lorebooks)
      .orderBy(asc(lorebooks.scopeType), asc(lorebooks.sortOrder), asc(lorebooks.name))
      .all();
    return rows.map((r) => this.mapLorebookRow(r));
  }

  async listLorebooksByScope(scopeType: string, ownerId?: string): Promise<Lorebook[]> {
    if (scopeType === 'global') {
      const rows = await this.db
        .select()
        .from(lorebooks)
        .where(eq(lorebooks.scopeType, 'global'))
        .orderBy(asc(lorebooks.sortOrder), asc(lorebooks.name))
        .all();
      return rows.map((r) => this.mapLorebookRow(r));
    }

    if (!ownerId) return [];

    const fkCol = scopeType === 'character' ? lorebooks.characterId
      : scopeType === 'persona' ? lorebooks.personaId
      : lorebooks.chatId;

    const directCondition = and(eq(lorebooks.scopeType, scopeType), eq(fkCol, ownerId));

    // Character/persona tabs show both directly scoped lorebooks and lorebooks
    // linked via the junction table. Chat scope remains direct-only because
    // lorebook_links currently supports character/persona targets only.
    if (scopeType === 'character' || scopeType === 'persona') {
      const linkedRows = await this.db
        .select({ lorebookId: lorebookLinks.lorebookId })
        .from(lorebookLinks)
        .where(and(eq(lorebookLinks.targetType, scopeType), eq(lorebookLinks.targetId, ownerId)))
        .all();

      const linkedIds = [...new Set(linkedRows.map((row) => row.lorebookId))];
      const whereCondition = linkedIds.length > 0
        ? or(directCondition, inArray(lorebooks.id, linkedIds))
        : directCondition;

      const rows = await this.db
        .select()
        .from(lorebooks)
        .where(whereCondition)
        .orderBy(asc(lorebooks.scopeType), asc(lorebooks.sortOrder), asc(lorebooks.name))
        .all();
      return rows.map((r) => this.mapLorebookRow(r));
    }

    const rows = await this.db
      .select()
      .from(lorebooks)
      .where(directCondition)
      .orderBy(asc(lorebooks.sortOrder), asc(lorebooks.name))
      .all();
    return rows.map((r) => this.mapLorebookRow(r));
  }

  async createLorebook(data: CreateLorebookData): Promise<Lorebook> {
    const id = this.idGen.next('lorebook');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(lorebooks)
      .values({
        id,
        name: data.name,
        description: data.description ?? '',
        scopeType: data.scopeType,
        scanDepth: data.scanDepth ?? 10,
        tokenBudget: data.tokenBudget ?? 1000,
        tokenBudgetPercent: data.tokenBudgetPercent ?? null,
        recursiveScanning: (data.recursiveScanning ?? false) ? 1 : 0,
        useGroupScoring: (data.useGroupScoring ?? false) ? 1 : 0,
        maxRecursionSteps: data.maxRecursionSteps ?? 5,
        includeNames: data.includeNames ? 1 : 0,
        minActivations: data.minActivations ?? 0,
        minActivationsDepthMax: data.minActivationsDepthMax ?? 0,
        overflowAlert: data.overflowAlert ? 1 : 0,
        characterStrategy: data.characterStrategy ?? 0,
        sortOrder: data.sortOrder ?? 0,
        enabled: (data.enabled ?? true) ? 1 : 0,
        characterId: data.characterId ?? null,
        personaId: data.personaId ?? null,
        chatId: data.chatId ?? null,
        extensionsJson: JSON.stringify(data.extensions ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Dual-write: write canonical JSON file (entries will be empty at this point)
    if (this.content) {
      await this.syncFile(id);
    }

    return this.mapLorebookRow(row!);
  }

  async updateLorebook(id: string, data: UpdateLorebookData): Promise<Lorebook> {
    const now = this.clock.now();
    const values: Partial<typeof lorebooks.$inferInsert> = { updatedAt: now };
    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.scopeType !== undefined) values.scopeType = data.scopeType;
    if (data.scanDepth !== undefined) values.scanDepth = data.scanDepth;
    if (data.tokenBudget !== undefined) values.tokenBudget = data.tokenBudget;
    if (data.tokenBudgetPercent !== undefined) values.tokenBudgetPercent = data.tokenBudgetPercent;
    if (data.recursiveScanning !== undefined) values.recursiveScanning = data.recursiveScanning ? 1 : 0;
    if (data.useGroupScoring !== undefined) values.useGroupScoring = data.useGroupScoring ? 1 : 0;
    if (data.maxRecursionSteps !== undefined) values.maxRecursionSteps = data.maxRecursionSteps;
    if (data.includeNames !== undefined) values.includeNames = data.includeNames ? 1 : 0;
    if (data.minActivations !== undefined) values.minActivations = data.minActivations;
    if (data.minActivationsDepthMax !== undefined) values.minActivationsDepthMax = data.minActivationsDepthMax;
    if (data.overflowAlert !== undefined) values.overflowAlert = data.overflowAlert ? 1 : 0;
    if (data.characterStrategy !== undefined) values.characterStrategy = data.characterStrategy;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
    if (data.enabled !== undefined) values.enabled = data.enabled ? 1 : 0;
    if (data.characterId !== undefined) values.characterId = data.characterId;
    if (data.personaId !== undefined) values.personaId = data.personaId;
    if (data.chatId !== undefined) values.chatId = data.chatId;
    if (data.extensions !== undefined) values.extensionsJson = JSON.stringify(data.extensions);

    const [row] = await this.db
      .update(lorebooks)
      .set(values)
      .where(eq(lorebooks.id, id))
      .returning();
    if (!row) throw new Error(`Lorebook '${id}' not found after update`);

    // Dual-write: update canonical JSON file
    if (this.content) {
      await this.syncFile(id);
    }

    return this.mapLorebookRow(row);
  }

  async deleteLorebook(id: string): Promise<void> {
    // Delete file from disk
    if (this.content) {
      await this.content.deleteEntity(STORAGE_FOLDERS.lorebooks, id);
    }
    await this.db.delete(lorebooks).where(eq(lorebooks.id, id)).run();
  }

  async deleteAllEntries(lorebookId: string): Promise<void> {
    await this.db.delete(loreEntries).where(eq(loreEntries.lorebookId, lorebookId)).run();

    // Sync file: all entries removed
    if (this.content) {
      await this.syncFile(lorebookId);
    }
  }

  async bulkCreateEntries(lorebookId: string, entries: CreateLoreEntryData[]): Promise<number> {
    let count = 0;
    for (const data of entries) {
      await this.createEntry(lorebookId, data);
      count++;
    }
    return count;
  }

  // ─── Lore Entry CRUD ───────────────────────────────────────────────────────

  async getEntry(id: string): Promise<LoreEntry | null> {
    const row = await this.db.select().from(loreEntries).where(eq(loreEntries.id, id)).get();
    return row ? this.mapEntryRow(row) : null;
  }

  async listEntries(lorebookId: string): Promise<LoreEntry[]> {
    const rows = await this.db
      .select()
      .from(loreEntries)
      .where(eq(loreEntries.lorebookId, lorebookId))
      .orderBy(asc(loreEntries.sortOrder), asc(loreEntries.createdAt))
      .all();
    return rows.map((r) => this.mapEntryRow(r));
  }

  /**
   * Batch-reorder entries within a lorebook.
   * Accepts an array of {id, sortOrder, position?} updates applied in a single transaction.
   * Returns the updated entries list.
   */
  async reorderEntries(lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>): Promise<LoreEntry[]> {
    const now = this.clock.now();
    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 3): drizzle-orm 0.38.4
    // + bun:sqlite commits at the end of the callback's synchronous prefix, so
    // an async callback's post-await throw is never rolled back. Keeping this
    // synchronous means a failure partway through the reorder rolls the earlier
    // updates back — the prior complete order survives.
    this.db.transaction((tx) => {
      for (const u of updates) {
        const values: Partial<typeof loreEntries.$inferInsert> = { sortOrder: u.sortOrder, updatedAt: now };
        if (u.position !== undefined) values.position = u.position;
        tx
          .update(loreEntries)
          .set(values)
          .where(and(eq(loreEntries.id, u.id), eq(loreEntries.lorebookId, lorebookId)))
          .run();
      }
    });
    return this.listEntries(lorebookId);
  }

  async createEntry(lorebookId: string, data: CreateLoreEntryData): Promise<LoreEntry> {
    const id = this.idGen.next('lore_entry');
    const now = this.clock.now();

    // Auto-assign sortOrder: max existing + 1 within this lorebook
    let nextSortOrder = data.sortOrder ?? 0;
    if (data.sortOrder === undefined) {
      const maxRow = await this.db
        .select({ maxSort: sql<number>`COALESCE(MAX(${loreEntries.sortOrder}), -1)` })
        .from(loreEntries)
        .where(eq(loreEntries.lorebookId, lorebookId))
        .get();
      nextSortOrder = (maxRow?.maxSort ?? -1) + 1;
    }
    const [row] = await this.db
      .insert(loreEntries)
      .values({
        id,
        lorebookId,
        createdAt: now,
        updatedAt: now,
        ...buildEntryInsert({ ...data, sortOrder: nextSortOrder }),
      })
      .returning();

    // Sync file: entry added
    if (this.content) {
      await this.syncFile(lorebookId);
    }

    return this.mapEntryRow(row!);
  }

  async updateEntry(id: string, data: UpdateLoreEntryData): Promise<LoreEntry> {
    const now = this.clock.now();
    const values: Partial<typeof loreEntries.$inferInsert> = { updatedAt: now, ...buildEntryPatch(data) };

    const [row] = await this.db
      .update(loreEntries)
      .set(values)
      .where(eq(loreEntries.id, id))
      .returning();
    if (!row) throw new Error(`LoreEntry '${id}' not found after update`);

    // Sync file: entry updated
    if (this.content) {
      await this.syncFile(row.lorebookId);
    }

    return this.mapEntryRow(row);
  }

  async deleteEntry(id: string): Promise<void> {
    // Fetch entry first to get lorebookId for file sync
    const entry = await this.db.select({ lorebookId: loreEntries.lorebookId })
      .from(loreEntries)
      .where(eq(loreEntries.id, id))
      .get();
    const lorebookId = entry?.lorebookId;

    await this.db.delete(loreEntries).where(eq(loreEntries.id, id)).run();

    // Sync file: entry removed
    if (this.content && lorebookId) {
      await this.syncFile(lorebookId);
    }
  }

  /**
   * CTX-L2: persist a co-author lore draft bundle as character-scoped lorebooks
   * + entries using the PREALLOCATED draft ids, IDEMPOTENTLY. This is the sole
   * persistence boundary for lore proposals — tool execution only mutates the
   * request-local draft state; nothing reaches SQLite until Apply. Re-Apply
   * (same ids) upserts the same rows rather than creating duplicates; a first
   * Apply inserts. Runs in ONE transaction so a partial failure rolls back the
   * whole graph. Dependency validation: every entry's parent lorebook must be
   * present in the bundle (the draft engine enforces this, but Apply re-checks
   * defensively). The scopeType→owner mapping mirrors `createLorebook` (a
   * 'character'-scoped book sets `characterId`), so the activation engine (FK ∪
   * junction) discovers the new book.
   */
  async applyCoauthorLoreDraft(
    characterId: string,
    bundle: CoauthorLoreDraftBundle,
  ): Promise<{ lorebookIds: string[]; entryIds: string[] }> {
    const bookIds = new Set(bundle.lorebooks.map((lb) => lb.id));
    // CE-B2: an entry may reference a persisted parent lorebook NOT in the
    // bundle (edit_lore_entry on a persisted entry, or add_lore_entry to an
    // existing book). Accept a parent that exists in the DB in addition to one
    // drafted in this bundle; only reject a parent that is neither.
    const externalParentIds = [...new Set(
      bundle.entries.map((e) => e.lorebookId).filter((id) => !bookIds.has(id)),
    )];
    const externalParentSet = externalParentIds.length
      ? new Set((await this.db.select({ id: lorebooks.id }).from(lorebooks).where(inArray(lorebooks.id, externalParentIds))).map((r) => r.id))
      : new Set<string>();
    for (const entry of bundle.entries) {
      if (!bookIds.has(entry.lorebookId) && !externalParentSet.has(entry.lorebookId)) {
        throw new Error(
          `applyCoauthorLoreDraft: entry '${entry.id}' references unknown parent lorebook '${entry.lorebookId}'`,
        );
      }
    }

    const now = this.clock.now();
    const lorebookIds: string[] = [];
    const entryIds: string[] = [];

    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 3): see reorderEntries.
    // syncFile runs AFTER this transaction commits (below), so it stays outside
    // the DB callback — only synchronous bun:sqlite work happens here.
    this.db.transaction((tx) => {
      for (const lb of bundle.lorebooks) {
        const charScoped = lb.scopeType === 'character';
        tx
          .insert(lorebooks)
          .values({
            id: lb.id,
            name: lb.name,
            description: lb.description,
            scopeType: lb.scopeType,
            scanDepth: lb.scanDepth ?? LOREBOOK_DEFAULTS.scanDepth,
            tokenBudget: lb.tokenBudget ?? LOREBOOK_DEFAULTS.tokenBudget,
            tokenBudgetPercent: null,
            recursiveScanning: (lb.recursiveScanning ?? LOREBOOK_DEFAULTS.recursiveScanning) ? 1 : 0,
            useGroupScoring: (lb.useGroupScoring ?? false) ? 1 : 0,
            maxRecursionSteps: 5,
            includeNames: 0,
            minActivations: 0,
            minActivationsDepthMax: 0,
            overflowAlert: 0,
            characterStrategy: 0,
            sortOrder: 0,
            enabled: lb.enabled ? 1 : 0,
            characterId: charScoped ? characterId : null,
            personaId: null,
            chatId: null,
            extensionsJson: '{}',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: lorebooks.id,
            // Re-Apply updates mutable fields (incl. CE-A1 activation params) but preserves createdAt + id.
            set: {
              name: lb.name,
              description: lb.description,
              scopeType: lb.scopeType,
              scanDepth: lb.scanDepth ?? LOREBOOK_DEFAULTS.scanDepth,
              tokenBudget: lb.tokenBudget ?? LOREBOOK_DEFAULTS.tokenBudget,
              recursiveScanning: (lb.recursiveScanning ?? LOREBOOK_DEFAULTS.recursiveScanning) ? 1 : 0,
              useGroupScoring: (lb.useGroupScoring ?? false) ? 1 : 0,
              enabled: lb.enabled ? 1 : 0,
              characterId: charScoped ? characterId : null,
              updatedAt: now,
            },
          })
          .run();
        // CE-A1: a character-scoped lorebook is bound to its character via
        // lorebook_links (idempotent), so the co-author's book is discoverable
        // by the activation engine (FK ∪ junction) without the user binding it
        // manually. Non-character scopes do not create a character link.
        if (charScoped) {
          tx
            .insert(lorebookLinks)
            .values({ lorebookId: lb.id, targetType: 'character', targetId: characterId })
            .onConflictDoNothing()
            .run();
        }
        lorebookIds.push(lb.id);
      }
      for (const e of bundle.entries) {
        const fields = buildEntryInsert({
          title: e.title,
          content: e.content,
          keys: e.keys,
          secondaryKeys: e.secondaryKeys,
          constant: e.constant,
          position: e.position,
          depth: e.depth,
          logic: e.logic,
          enabled: e.enabled,
        });
        tx
          .insert(loreEntries)
          .values({ id: e.id, lorebookId: e.lorebookId, createdAt: now, updatedAt: now, ...fields })
          .onConflictDoUpdate({
            target: loreEntries.id,
            set: { lorebookId: e.lorebookId, updatedAt: now, ...buildEntryPatch({
              title: e.title, content: e.content, keys: e.keys, secondaryKeys: e.secondaryKeys,
              constant: e.constant, position: e.position, depth: e.depth, logic: e.logic, enabled: e.enabled,
            }) },
          })
          .run();
        entryIds.push(e.id);
      }
    });

    // Dual-write canonical JSON files after the transaction commits (mirrors
    // createLorebook/createEntry's syncFile calls).
    for (const id of lorebookIds) {
      await this.syncFile(id);
    }

    return { lorebookIds, entryIds };
  }

  // ─── Scope-aware listing (pipeline entry point) ────────────────────────────

  /**
   * Returns all lorebooks visible to a chat session across all scopes,
   * plus their enabled entries.
   *
   * Resolution: global lorebooks + lorebooks linked to the character (via lorebook_links)
   * + lorebooks linked to the persona (via lorebook_links) + chat-scoped lorebooks (direct FK).
   * Only enabled entries are included.
   */
  async listAllActiveForChat(
    characterId: string,
    personaId: string | null,
    chatId: string,
  ): Promise<Array<{ lorebook: Lorebook; entries: LoreEntry[] }>> {
    // Build lorebook ID set from multiple sources
    const lorebookIds = new Set<string>();

    // 1. Global lorebooks
    const globalRows = await this.db
      .select({ id: lorebooks.id })
      .from(lorebooks)
      .where(and(eq(lorebooks.scopeType, 'global'), eq(lorebooks.enabled, 1)))
      .all();
    for (const r of globalRows) lorebookIds.add(r.id);

    // 2. Character-scoped lorebooks: FK-owned (home scope) AND junction-linked.
    //    The resolver consults BOTH — the previous junction-only query silently
    //    dropped FK-owned lorebooks because `createLorebook` does NOT mirror the
    //    FK into `lorebook_links`, so a persona/character-FK lorebook created
    //    the normal way was visible in editor tabs but never activated in chat.
    //    Mirrors `ScriptStore.listAllEnabledForChat` (FK ∪ junction, Set dedup).
    const charFkRows = await this.db
      .select({ id: lorebooks.id })
      .from(lorebooks)
      .where(and(eq(lorebooks.scopeType, 'character'), eq(lorebooks.characterId, characterId), eq(lorebooks.enabled, 1)))
      .all();
    for (const r of charFkRows) lorebookIds.add(r.id);
    const charLinks = await this.db
      .select({ lorebookId: lorebookLinks.lorebookId })
      .from(lorebookLinks)
      .innerJoin(lorebooks, and(
        eq(lorebookLinks.lorebookId, lorebooks.id),
        eq(lorebooks.enabled, 1),
      ))
      .where(and(eq(lorebookLinks.targetType, 'character'), eq(lorebookLinks.targetId, characterId)))
      .all();
    for (const r of charLinks) lorebookIds.add(r.lorebookId);

    // 3. Persona-scoped lorebooks: FK-owned AND junction-linked (same reason).
    if (personaId) {
      const personaFkRows = await this.db
        .select({ id: lorebooks.id })
        .from(lorebooks)
        .where(and(eq(lorebooks.scopeType, 'persona'), eq(lorebooks.personaId, personaId), eq(lorebooks.enabled, 1)))
        .all();
      for (const r of personaFkRows) lorebookIds.add(r.id);
      const personaLinks = await this.db
        .select({ lorebookId: lorebookLinks.lorebookId })
        .from(lorebookLinks)
        .innerJoin(lorebooks, and(
          eq(lorebookLinks.lorebookId, lorebooks.id),
          eq(lorebooks.enabled, 1),
        ))
        .where(and(eq(lorebookLinks.targetType, 'persona'), eq(lorebookLinks.targetId, personaId)))
        .all();
      for (const r of personaLinks) lorebookIds.add(r.lorebookId);
    }

    // 4. Chat-scoped lorebooks (direct FK — not via links)
    const chatRows = await this.db
      .select({ id: lorebooks.id })
      .from(lorebooks)
      .where(and(eq(lorebooks.scopeType, 'chat'), eq(lorebooks.chatId, chatId), eq(lorebooks.enabled, 1)))
      .all();
    for (const r of chatRows) lorebookIds.add(r.id);

    if (lorebookIds.size === 0) return [];

    // Batch-load lorebooks
    const idArray = [...lorebookIds];
    const bookRows = await this.db
      .select()
      .from(lorebooks)
      .where(inArray(lorebooks.id, idArray))
      .all();

    const result: Array<{ lorebook: Lorebook; entries: LoreEntry[] }> = [];

    for (const bookRow of bookRows) {
      const entryRows = await this.db
        .select()
        .from(loreEntries)
        .where(
          and(
            eq(loreEntries.lorebookId, bookRow.id),
            eq(loreEntries.enabled, 1),
          ),
        )
        .all();

      result.push({
        lorebook: this.mapLorebookRow(bookRow),
        entries: entryRows.map((r) => this.mapEntryRow(r)),
      });
    }

    return result;
  }

  // ─── Link management ───────────────────────────────────────────────────────

  /**
   * Get all links for a lorebook.
   */
  async getLinks(lorebookId: string): Promise<LorebookLink[]> {
    const rows = await this.db
      .select()
      .from(lorebookLinks)
      .where(eq(lorebookLinks.lorebookId, lorebookId))
      .all();
    return rows.map((r) => ({
      lorebookId: r.lorebookId,
      targetType: r.targetType as 'character' | 'persona',
      targetId: r.targetId,
    }));
  }

  /**
   * Replace all links for a lorebook. Deletes existing and inserts new ones in a transaction.
   */
  async setLinks(lorebookId: string, links: Array<{ targetType: string; targetId: string }>): Promise<LorebookLink[]> {
    // Dedup by (targetType, targetId) BEFORE the delete: the junction table
    // has a composite PK on those columns, so a duplicate tuple in the input
    // would violate the PK on the second insert — AFTER the old set is already
    // deleted, leaving the graph empty. Normalizing first keeps the replace whole.
    const seen = new Set<string>();
    const unique: Array<{ targetType: string; targetId: string }> = [];
    for (const link of links) {
      const key = JSON.stringify([link.targetType, link.targetId]);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(link);
    }

    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 3): see reorderEntries.
    // A failure on a later link insert rolls the delete back too — the prior
    // complete graph survives instead of being wiped to empty.
    this.db.transaction((tx) => {
      tx.delete(lorebookLinks).where(eq(lorebookLinks.lorebookId, lorebookId)).run();
      for (const link of unique) {
        tx.insert(lorebookLinks).values({
          lorebookId,
          targetType: link.targetType,
          targetId: link.targetId,
        }).run();
      }
    });
    return this.getLinks(lorebookId);
  }

  /**
   * Add a single link (idempotent — ignores duplicates).
   */
  async addLink(lorebookId: string, targetType: string, targetId: string): Promise<void> {
    await this.db.insert(lorebookLinks).values({
      lorebookId,
      targetType,
      targetId,
    }).onConflictDoNothing().run();
  }

  /**
   * Remove a single link.
   */
  async removeLink(lorebookId: string, targetType: string, targetId: string): Promise<void> {
    await this.db.delete(lorebookLinks).where(
      and(
        eq(lorebookLinks.lorebookId, lorebookId),
        eq(lorebookLinks.targetType, targetType),
        eq(lorebookLinks.targetId, targetId),
      ),
    ).run();
  }

  /**
   * Reverse query — list lorebooks M:N-linked to a given target (character or
   * persona), regardless of the lorebook's own home scope. This is the
   * persona/character-editor view of "which lorebooks activate for me". Returns
   * links-only (FK-owned lorebooks are NOT included here; those surface via
   * `listLorebooksByScope` which unions FK + links).
   */
  async listLorebooksLinkedToTarget(targetType: 'character' | 'persona', targetId: string): Promise<Lorebook[]> {
    const linkedRows = await this.db
      .select({ lorebookId: lorebookLinks.lorebookId })
      .from(lorebookLinks)
      .where(and(eq(lorebookLinks.targetType, targetType), eq(lorebookLinks.targetId, targetId)))
      .all();
    const linkedIds = [...new Set(linkedRows.map((row) => row.lorebookId))];
    if (linkedIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(lorebooks)
      .where(inArray(lorebooks.id, linkedIds))
      .orderBy(asc(lorebooks.sortOrder), asc(lorebooks.name))
      .all();
    return rows.map((r) => this.mapLorebookRow(r));
  }

  // ─── Duplicate & export ────────────────────────────────────────────────────

  /**
   * Deep-copy a lorebook with all its entries.
   * Copies links from the original. Overrides optional fields if provided.
   */
  async duplicateLorebook(
    lorebookId: string,
    overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null },
  ): Promise<{ lorebook: Lorebook; links: LorebookLink[] }> {
    const source = await this.getLorebook(lorebookId);
    if (!source) throw new Error(`Lorebook '${lorebookId}' not found`);

    const sourceEntries = await this.listEntries(lorebookId);
    const sourceLinks = await this.getLinks(lorebookId);

    const created = await this.createLorebook({
      name: overrides?.name ?? `${source.name} (copy)`,
      description: source.description,
      scopeType: overrides?.scopeType ?? source.scopeType,
      characterId: overrides?.characterId ?? source.characterId,
      personaId: overrides?.personaId ?? source.personaId,
      scanDepth: source.scanDepth,
      tokenBudget: source.tokenBudget,
      tokenBudgetPercent: source.tokenBudgetPercent ?? null,
      recursiveScanning: source.recursiveScanning,
      useGroupScoring: source.useGroupScoring ?? false,
      maxRecursionSteps: source.maxRecursionSteps,
      includeNames: source.includeNames,
      minActivations: source.minActivations,
      minActivationsDepthMax: source.minActivationsDepthMax,
      overflowAlert: source.overflowAlert,
      characterStrategy: source.characterStrategy,
      enabled: source.enabled,
      extensions: source.extensions,
    });

    // Copy all entries
    await this.bulkCreateEntries(created.id, sourceEntries.map(entryToCreateData));

    // Copy links
    if (sourceLinks.length > 0) {
      await this.setLinks(created.id, sourceLinks.map((l) => ({
        targetType: l.targetType,
        targetId: l.targetId,
      })));
    }

    const links = await this.getLinks(created.id);
    return { lorebook: created, links };
  }

  // ─── Dual-write helpers ────────────────────────────────────────────────────

  /**
   * Regenerate the canonical lorebook JSON file (lorebook metadata + all entries).
   * Reads latest state from SQLite, builds payload, writes to ContentStore,
   * and updates contentHash + hasFileOnDisk on the lorebook row.
   */
  private async syncFile(lorebookId: string): Promise<void> {
    if (!this.content) return;

    const row = await this.db.select().from(lorebooks).where(eq(lorebooks.id, lorebookId)).get();
    if (!row) return;

    const entryRows = await this.db.select().from(loreEntries).where(eq(loreEntries.lorebookId, lorebookId)).all();
    const fileData = this.toFilePayload(row, entryRows);
    const hash = await this.content.writeEntity(STORAGE_FOLDERS.lorebooks, lorebookId, fileData);

    await this.db.update(lorebooks)
      .set({ contentHash: hash, hasFileOnDisk: 1 })
      .where(eq(lorebooks.id, lorebookId))
      .run();
  }

  private toFilePayload(
    row: typeof lorebooks.$inferSelect,
    entryRows: Array<typeof loreEntries.$inferSelect>,
  ): Record<string, unknown> {
    return {
      name: row.name,
      description: row.description,
      scopeType: row.scopeType,
      scanDepth: row.scanDepth,
      tokenBudget: row.tokenBudget,
      tokenBudgetPercent: row.tokenBudgetPercent,
      recursiveScanning: row.recursiveScanning === 1,
      useGroupScoring: row.useGroupScoring === 1,
      maxRecursionSteps: row.maxRecursionSteps,
      includeNames: row.includeNames === 1,
      minActivations: row.minActivations,
      minActivationsDepthMax: row.minActivationsDepthMax,
      overflowAlert: row.overflowAlert === 1,
      characterStrategy: row.characterStrategy,
      sortOrder: row.sortOrder,
      enabled: row.enabled === 1,
      characterId: row.characterId,
      personaId: row.personaId,
      chatId: row.chatId,
      extensions: JSON.parse(row.extensionsJson),
      entries: entryRows.map((e) => ({
        id: e.id,
        title: e.title,
        content: e.content,
        keys: JSON.parse(e.keysJson),
        secondaryKeys: JSON.parse(e.secondaryKeysJson),
        logic: e.logic,
        position: e.position,
        depth: e.depth,
        priority: e.priority,
        stickyWindow: e.stickyWindow,
        cooldownWindow: e.cooldownWindow,
        delayWindow: e.delayWindow,
        constant: e.constant === 1,
        probability: e.probability,
        ignoreBudget: e.ignoreBudget ?? false,
        role: e.role,
        group: e.groupName,
        groupWeight: e.groupWeight,
        prioritizeInclusion: e.prioritizeInclusion === 1,
        excludeRecursion: e.excludeRecursion === 1,
        preventRecursion: e.preventRecursion === 1,
        delayUntilRecursion: e.delayUntilRecursion === 1,
        recursionLevel: e.recursionLevel,
        scanDepthOverride: e.scanDepthOverride,
        caseSensitive: e.caseSensitive === 1,
        matchWholeWords: e.matchWholeWords === 1,
        characterFilter: parseCharacterFilter(JSON.parse(e.characterFilterJson)),
        characterFilterExclude: e.characterFilterExclude === 1,
        matchSources: JSON.parse(e.matchSourcesJson),
        enabled: e.enabled === 1,
        sortOrder: e.sortOrder,
        metadata: JSON.parse(e.metadataJson),
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
  }

  // ─── Row mappers ───────────────────────────────────────────────────────────

  private mapLorebookRow(row: typeof lorebooks.$inferSelect): Lorebook {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scopeType: row.scopeType,
      scanDepth: row.scanDepth,
      tokenBudget: row.tokenBudget,
      tokenBudgetPercent: row.tokenBudgetPercent,
      recursiveScanning: row.recursiveScanning === 1,
      useGroupScoring: row.useGroupScoring === 1,
      maxRecursionSteps: row.maxRecursionSteps,
      includeNames: row.includeNames === 1,
      minActivations: row.minActivations,
      minActivationsDepthMax: row.minActivationsDepthMax,
      overflowAlert: row.overflowAlert === 1,
      characterStrategy: row.characterStrategy,
      sortOrder: row.sortOrder,
      enabled: row.enabled === 1,
      characterId: row.characterId,
      personaId: row.personaId,
      chatId: row.chatId,
      extensions: JSON.parse(row.extensionsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapEntryRow(row: typeof loreEntries.$inferSelect): LoreEntry {
    const fields = decodeEntryFields(row);
    return {
      id: row.id,
      lorebookId: row.lorebookId,
      ...fields,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

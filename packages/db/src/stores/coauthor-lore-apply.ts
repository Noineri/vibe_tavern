/**
 * Co-Author lore draft Apply (CTX-L2, Wave 4; extracted from
 * `lorebook-store.ts` so that file stays under its arch-gate line budget —
 * COAUTHOR_LORE_FULL_SETTINGS step 3 needed it to grow, so the whole Apply
 * moved out instead). Persists a co-author lore draft bundle as entity-scoped
 * lorebooks + entries using the PREALLOCATED draft ids, IDEMPOTENTLY: this is
 * the sole persistence boundary for lore proposals — tool execution only
 * mutates the request-local draft state; nothing reaches SQLite until Apply.
 * Re-Apply (same ids) upserts the same rows rather than creating duplicates;
 * a first Apply inserts. Runs in ONE transaction so a partial failure rolls
 * back the whole graph.
 *
 * Step 3: the bundle carries EVERY settings field the lorebook API contracts
 * define; absent fields fall back to the SAME defaults the store's
 * `createLorebook` / entry insert defaults use, so a co-authored book lands
 * exactly like an API-created one.
 */
import { eq, inArray } from 'drizzle-orm';
import type { AppDb } from '../db-connection.js';
import { lorebooks, loreEntries, lorebookLinks } from '../db-schema.js';
import { LOREBOOK_DEFAULTS, type CharacterFilterEntry } from '@vibe-tavern/domain';
import { buildEntryInsert, buildEntryPatch, mergeCaseFormsKeys } from './lore-entry-fields.js';

/**
 * The co-author lore draft bundle persisted by Apply. Structurally identical
 * to the api-contracts `CoauthorLoreBundle` — the store (packages/db) cannot
 * import api-contracts (dependency graph: db ← domain only), so the shape is
 * re-declared here and the caller passes the contract bundle verbatim (TS
 * structural typing accepts it without a forbidden import).
 *
 * `id`s are PREALLOCATED in the request-local draft engine and become the DB
 * primary keys. Since migration 0107 owners are links only: an 'entity'-scoped
 * draft book is bound to the authored character via a `lorebook_links` row
 * (CE-A1, inserted idempotently below) so the activation engine finds it.
 */
export interface CoauthorLoreDraftBundle {
  lorebooks: Array<{
    id: string;
    name: string;
    description: string;
    scopeType: 'global' | 'entity' | 'chat';
    enabled: boolean;
    /** CE-A1: activation overrides authored by the co-author. Apply falls back to `LOREBOOK_DEFAULTS` when absent. */
    scanDepth?: number;
    tokenBudget?: number;
    tokenBudgetPercent?: number | null;
    tokenBudgetCap?: number;
    recursiveScanning?: boolean;
    useGroupScoring?: boolean;
    caseSensitive?: boolean;
    matchWholeWords?: boolean;
    maxRecursionSteps?: number;
    includeNames?: boolean;
    minActivations?: number;
    minActivationsDepthMax?: number;
    overflowAlert?: boolean;
    characterStrategy?: number;
    /** CE-B1 review metadata; Apply already routes create/edit via PK upsert. */
    mode?: 'create' | 'edit';
    /** Step 4 review metadata; never persisted. */
    settingChanges?: Record<string, { oldValue: unknown; newValue: unknown }>;
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
    priority?: number;
    probability?: number;
    ignoreBudget?: boolean;
    role?: string;
    groupName?: string;
    groupWeight?: number;
    prioritizeInclusion?: boolean;
    useGroupScoring?: boolean | null;
    excludeRecursion?: boolean;
    preventRecursion?: boolean;
    delayUntilRecursion?: boolean;
    recursionLevel?: number;
    scanDepthOverride?: number | null;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | null;
    caseFormsKeys?: string[];
    characterFilter?: CharacterFilterEntry[];
    characterFilterExclude?: boolean;
    matchSources?: string[];
    stickyWindow?: number;
    cooldownWindow?: number;
    minChatMessages?: number;
    /** CE-B1 review metadata; Apply already routes create/edit via PK upsert. */
    mode?: 'create' | 'edit';
    /** CE-B2: verified persisted parent absent from this proposal bundle. */
    parentMode?: 'persisted';
    /** Step 4 review metadata; never persisted. */
    settingChanges?: Record<string, { oldValue: unknown; newValue: unknown }>;
  }>;
}

/** Strip the draft node's bookkeeping fields; the rest IS CreateLoreEntryData. */
function entryNodeToCreateData(
  e: CoauthorLoreDraftBundle['entries'][number],
): Parameters<typeof buildEntryInsert>[0] {
  const { id: _id, lorebookId: _lorebookId, mode: _mode, parentMode: _parentMode, settingChanges: _settingChanges, ...data } = e;
  return data;
}

/** Insert values for one draft lorebook (defaults mirror `createLorebook`). */
function lorebookInsertValues(
  lb: CoauthorLoreDraftBundle['lorebooks'][number],
  now: string,
): typeof lorebooks.$inferInsert {
  return {
    id: lb.id,
    name: lb.name,
    description: lb.description,
    scopeType: lb.scopeType,
    scanDepth: lb.scanDepth ?? LOREBOOK_DEFAULTS.scanDepth,
    tokenBudget: lb.tokenBudget ?? LOREBOOK_DEFAULTS.tokenBudget,
    tokenBudgetPercent: lb.tokenBudgetPercent ?? null,
    tokenBudgetCap: lb.tokenBudgetCap ?? LOREBOOK_DEFAULTS.tokenBudgetCap,
    recursiveScanning: (lb.recursiveScanning ?? LOREBOOK_DEFAULTS.recursiveScanning) ? 1 : 0,
    useGroupScoring: (lb.useGroupScoring ?? false) ? 1 : 0,
    caseSensitive: (lb.caseSensitive ?? false) ? 1 : 0,
    matchWholeWords: (lb.matchWholeWords ?? false) ? 1 : 0,
    maxRecursionSteps: lb.maxRecursionSteps ?? 0,
    // ST's global default is on; native VT books inherit that default
    // (mirrors createLorebook — the pre-step-3 Apply hardcoded 0 here).
    includeNames: lb.includeNames === false ? 0 : 1,
    minActivations: lb.minActivations ?? 0,
    minActivationsDepthMax: lb.minActivationsDepthMax ?? 0,
    overflowAlert: lb.overflowAlert ? 1 : 0,
    characterStrategy: lb.characterStrategy ?? 1,
    sortOrder: 0,
    enabled: lb.enabled ? 1 : 0,
    chatId: null,
    extensionsJson: '{}',
    createdAt: now,
    updatedAt: now,
  };
}

/** Upsert-update set for one draft lorebook (mutable fields; preserves createdAt + id). */
function lorebookUpsertSet(
  lb: CoauthorLoreDraftBundle['lorebooks'][number],
  now: string,
): Partial<typeof lorebooks.$inferInsert> {
  const { id: _id, createdAt: _createdAt, sortOrder: _sortOrder, extensionsJson: _ext, chatId: _c, ...values } = lorebookInsertValues(lb, now);
  return { ...values, updatedAt: now };
}

/**
 * Validate parents, then persist the whole graph in ONE transaction.
 * CE-B2: an entry may reference a persisted parent lorebook NOT in the bundle
 * (edit_lore_entry on a persisted entry, or add_lore_entry to an existing
 * book). Accept a parent that exists in the DB in addition to one drafted in
 * this bundle; only reject a parent that is neither. Dependency validation
 * happens BEFORE the transaction so a bad bundle writes nothing.
 */
export async function applyCoauthorLoreDraftTx(
  db: AppDb,
  characterId: string,
  bundle: CoauthorLoreDraftBundle,
  now: string,
): Promise<{ lorebookIds: string[]; entryIds: string[] }> {
  const bookIds = new Set(bundle.lorebooks.map((lb) => lb.id));
  const externalParentIds = [...new Set(
    bundle.entries.map((e) => e.lorebookId).filter((id) => !bookIds.has(id)),
  )];
  const externalParentSet = externalParentIds.length
    ? new Set((await db.select({ id: lorebooks.id }).from(lorebooks).where(inArray(lorebooks.id, externalParentIds))).map((r) => r.id))
    : new Set<string>();
  for (const entry of bundle.entries) {
    if (!bookIds.has(entry.lorebookId) && !externalParentSet.has(entry.lorebookId)) {
      throw new Error(
        `applyCoauthorLoreDraft: entry '${entry.id}' references unknown parent lorebook '${entry.lorebookId}'`,
      );
    }
  }

  const lorebookIds: string[] = [];
  const entryIds: string[] = [];

  // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 3): see reorderEntries
  // in lorebook-store.ts — only synchronous bun:sqlite work happens here; file
  // sync runs AFTER the transaction commits (the store method's syncFile loop).
  db.transaction((tx) => {
    for (const lb of bundle.lorebooks) {
      const entityScoped = lb.scopeType === 'entity';
      tx
        .insert(lorebooks)
        .values(lorebookInsertValues(lb, now))
        .onConflictDoUpdate({
          target: lorebooks.id,
          // Re-Apply updates mutable fields (incl. CE-A1 activation params) but preserves createdAt + id.
          set: lorebookUpsertSet(lb, now),
        })
        .run();
      // CE-A1: an entity-scoped lorebook is bound to its character via
      // lorebook_links (idempotent), so the co-author's book is discoverable
      // by the activation engine without the user binding it manually. Since
      // migration 0107 this link IS the owner binding (the home-FK columns are
      // gone). Non-entity scopes do not create a character link.
      if (entityScoped) {
        tx
          .insert(lorebookLinks)
          .values({ lorebookId: lb.id, targetType: 'character', targetId: characterId })
          .onConflictDoNothing()
          .run();
      }
      lorebookIds.push(lb.id);
    }
    for (const e of bundle.entries) {
      const data = entryNodeToCreateData(e);
      // caseFormsKeys lives in entry metadata; the upsert-UPDATE branch must
      // merge it with the CURRENT stored metadata exactly like updateEntry
      // (buildEntryPatch alone never touches metadataJson).
      let currentMetadataJson: string | undefined;
      if (data.caseFormsKeys !== undefined) {
        const row = tx
          .select({ metadataJson: loreEntries.metadataJson })
          .from(loreEntries)
          .where(eq(loreEntries.id, e.id))
          .get();
        currentMetadataJson = row?.metadataJson;
      }
      const patch = buildEntryPatch(
        data.caseFormsKeys !== undefined
          ? {
              ...data,
              metadata: mergeCaseFormsKeys(
                currentMetadataJson !== undefined ? JSON.parse(currentMetadataJson) as Record<string, unknown> : undefined,
                data.caseFormsKeys,
              ),
            }
          : data,
      );
      tx
        .insert(loreEntries)
        .values({ id: e.id, lorebookId: e.lorebookId, createdAt: now, updatedAt: now, ...buildEntryInsert(data) })
        .onConflictDoUpdate({
          target: loreEntries.id,
          set: { lorebookId: e.lorebookId, updatedAt: now, ...patch },
        })
        .run();
      entryIds.push(e.id);
    }
  });

  return { lorebookIds, entryIds };
}

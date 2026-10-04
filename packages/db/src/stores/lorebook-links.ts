/**
 * Lorebook link-row operations (LORE_SCRIPT_OWNERS_AS_LINKS step 2).
 *
 * Since migration 0107 a lorebook's ONLY owners are `lorebook_links` rows —
 * the home-owner FK columns are gone. These are the pure junction operations
 * behind `LorebookStore`'s link methods, extracted from `lorebook-store.ts`
 * (which sits over its arch-gate line budget and may not grow — same
 * precedent as `coauthor-lore-apply.ts`) when the create-with-links and
 * owner-deletion paths landed. The store methods remain the public API; this
 * module is their implementation.
 */
import { eq, and } from 'drizzle-orm';
import { lorebookLinks } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';

/** One junction row. Structurally identical to `LorebookStore`'s `LorebookLink`. */
export interface LorebookLinkRow {
  lorebookId: string;
  targetType: 'character' | 'persona';
  targetId: string;
}

function mapRow(r: typeof lorebookLinks.$inferSelect): LorebookLinkRow {
  return {
    lorebookId: r.lorebookId,
    targetType: r.targetType as 'character' | 'persona',
    targetId: r.targetId,
  };
}

/** Read all link rows of one lorebook. */
export async function getLorebookLinks(db: AppDb, lorebookId: string): Promise<LorebookLinkRow[]> {
  const rows = await db
    .select()
    .from(lorebookLinks)
    .where(eq(lorebookLinks.lorebookId, lorebookId))
    .all();
  return rows.map(mapRow);
}

/**
 * Replace all links for a lorebook. Deletes existing and inserts new ones in a transaction.
 */
export async function setLorebookLinks(
  db: AppDb,
  lorebookId: string,
  links: Array<{ targetType: string; targetId: string }>,
): Promise<LorebookLinkRow[]> {
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

  // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 3): see reorderEntries
  // in lorebook-store.ts. A failure on a later link insert rolls the delete
  // back too — the prior complete graph survives instead of being wiped to empty.
  db.transaction((tx) => {
    tx.delete(lorebookLinks).where(eq(lorebookLinks.lorebookId, lorebookId)).run();
    for (const link of unique) {
      tx.insert(lorebookLinks).values({
        lorebookId,
        targetType: link.targetType,
        targetId: link.targetId,
      }).run();
    }
  });
  return getLorebookLinks(db, lorebookId);
}

/**
 * Add a single link (idempotent — ignores duplicates).
 */
export async function addLorebookLink(
  db: AppDb,
  lorebookId: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await db.insert(lorebookLinks).values({
    lorebookId,
    targetType,
    targetId,
  }).onConflictDoNothing().run();
}

/**
 * Remove a single link.
 */
export async function removeLorebookLink(
  db: AppDb,
  lorebookId: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await db.delete(lorebookLinks).where(
    and(
      eq(lorebookLinks.lorebookId, lorebookId),
      eq(lorebookLinks.targetType, targetType),
      eq(lorebookLinks.targetId, targetId),
    ),
  ).run();
}

/**
 * Insert the create API's explicit owner list (LORE_SCRIPT_OWNERS_AS_LINKS
 * step 2): an empty/absent list creates the book unbound — no owner is ever
 * derived from context. Duplicates within the input are ignored (junction
 * composite PK, onConflictDoNothing).
 */
export async function insertLorebookLinks(
  db: AppDb,
  lorebookId: string,
  links: ReadonlyArray<{ targetType: string; targetId: string }>,
): Promise<void> {
  for (const link of links) {
    await addLorebookLink(db, lorebookId, link.targetType, link.targetId);
  }
}

/**
 * Remove every link targeting one entity (owner deletion,
 * LORE_SCRIPT_OWNERS_AS_LINKS step 2 — the RegexStore/TtsStore
 * deleteLinksForTarget pattern): the deleted owner's link rows die with it
 * because nothing can ever resolve them again and the bindings UI would
 * render a nameless ghost row; the BOOK itself survives for its other owners.
 * `targetId` is a polymorphic text column without an FK, so this cleanup is
 * app-level.
 */
export async function deleteLorebookLinksForTarget(
  db: AppDb,
  targetType: 'character' | 'persona',
  targetId: string,
): Promise<void> {
  await db
    .delete(lorebookLinks)
    .where(and(eq(lorebookLinks.targetType, targetType), eq(lorebookLinks.targetId, targetId)))
    .run();
}

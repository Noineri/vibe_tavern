import { asc, eq } from 'drizzle-orm';
import { skillOrders } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';

/**
 * Stored list order for the FILESYSTEM skill catalog (ML-7).
 *
 * Skills are directories on disk — built-in skill folders ship in the app's
 * read-only assets root, user skills live under each library's user data root —
 * so the catalog has no DB row to carry a `sort_order` column. Instead one row
 * per (library, skill id) in `skill_orders` holds that skill's position in that
 * library's list. Library keys are OPAQUE here (their values — 'coauthor' plus
 * the copilot agent-kind ids — are owned by the services/api adapter layer that
 * wires the skill libraries; this store never enumerates them).
 *
 * The merge rule (the plan's ML-7 row): a library's catalog entries come back
 * in their stored order, with ids the table does not know (a freshly imported
 * or new built-in skill) sorted AFTER the known ones, alphabetically. This is
 * why the table starts EMPTY — the first boot has nothing to number, and every
 * id is simply "unknown" (alphabetical, the scanner's own order).
 *
 * Shadowing is resolved BEFORE ordering: the catalog layer (`buildSkillCatalog`)
 * collapses a builtin/user id collision to ONE user-won entry, so an id always
 * has exactly one catalog entry and one stored position; this store keys rows
 * by id alone and never sees sources.
 */

/** One stored catalog position: where a skill id sits in one library's list. */
export interface SkillOrderRow {
  library: string;
  skillId: string;
  sortOrder: number;
}

export class SkillOrderStore {
  constructor(private readonly db: AppDb) {}

  /** One library's stored positions, ordered by sort_order (id tiebreak). */
  async list(library: string): Promise<SkillOrderRow[]> {
    const rows = await this.db
      .select()
      .from(skillOrders)
      .where(eq(skillOrders.library, library))
      .orderBy(asc(skillOrders.sortOrder), asc(skillOrders.skillId))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * The merge rule (ML-7), derived HERE and nowhere else (one derivation; the
   * skill route adapters are pure consumers): entries whose id has a stored
   * position come first in that stored order; ids the table does not know
   * sort AFTER the known ones, alphabetically by id. Generic over any entry
   * shape carrying an `id`, so it applies directly to scanner catalog entries.
   * Both partitions are sorted here — the rule never depends on the caller's
   * input order (an empty table yields all-unknown, i.e. plain alphabetical).
   * Equal stored positions (a payload with duplicate sortOrders, or a
   * hand-edited row) fall back to id, keeping the result a total order. Rows
   * for ids not in `entries` are inert — they simply never surface.
   */
  async applyOrder<T extends { id: string }>(library: string, entries: readonly T[]): Promise<T[]> {
    const position = new Map((await this.list(library)).map((row) => [row.skillId, row.sortOrder] as const));
    const known = entries.filter((e) => position.has(e.id));
    const unknown = entries.filter((e) => !position.has(e.id));
    known.sort((a, b) => (position.get(a.id)! - position.get(b.id)!) || a.id.localeCompare(b.id));
    unknown.sort((a, b) => a.id.localeCompare(b.id));
    return [...known, ...unknown];
  }

  /**
   * Replace ONE library's whole order map in a single synchronous transaction
   * (the ProxyStore / CoauthorModuleStore.reorder pattern — drizzle-orm +
   * bun:sqlite commits at the end of the synchronous callback, so a throw
   * rolls back every write; a duplicate id in the payload violates the
   * composite PK mid-transaction and aborts the whole replace). The payload IS
   * the library's complete order: an id absent from it loses its row and
   * becomes unknown to the merge rule (it sorts last, alphabetically). An id
   * the catalog does not currently list still gets a row — it is inert until
   * that id exists, and then the skill appears at its stored position, so the
   * merge rule stays trivially true with no filesystem read here.
   */
  async reorder(library: string, updates: Array<{ id: string; sortOrder: number }>): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(skillOrders).where(eq(skillOrders.library, library)).run();
      for (const u of updates) {
        tx.insert(skillOrders).values({ library, skillId: u.id, sortOrder: u.sortOrder }).run();
      }
    });
  }

  private mapRow(row: typeof skillOrders.$inferSelect): SkillOrderRow {
    return { library: row.library, skillId: row.skillId, sortOrder: row.sortOrder };
  }
}

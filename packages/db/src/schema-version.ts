import type { AppDb } from "./db-connection.js";

/**
 * Applied drizzle migrations — the honest "schema version" of this database
 * (SM-7 diagnostics reads it; 0 for a pre-baseline database without the
 * table rather than a failed report).
 *
 * Own module so db-connection.ts stays under the architecture gate's
 * file-size ratchet. Reads through drizzle's `$client` (the raw bun:sqlite
 * handle): `db.get(sql\`…\`)` on this driver version returns array-shaped
 * rows for raw templates, which silently lost the alias.
 */
export function readSchemaVersion(db: AppDb): number {
  try {
    const row = db.$client.query("SELECT count(*) AS cnt FROM __drizzle_migrations").get() as { cnt?: number } | null;
    return typeof row?.cnt === "number" ? row.cnt : 0;
  } catch {
    return 0;
  }
}

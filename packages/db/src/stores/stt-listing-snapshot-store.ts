// fork #1 of ImageGenListingSnapshotStore (packages/db/src/stores/image-gen-listing-snapshot-store.ts)
import { and, eq } from 'drizzle-orm';
import { sttListingSnapshots } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

/** The listings a saved STT profile snapshots: the model catalog. */
export const STT_LISTING_SNAPSHOT_KINDS = {
  Models: 'models',
} as const;
export type SttListingSnapshotKind =
  (typeof STT_LISTING_SNAPSHOT_KINDS)[keyof typeof STT_LISTING_SNAPSHOT_KINDS];

export interface SttListingSnapshot {
  /** The listing exactly as the live route returned it (parsed JSON). */
  payload: unknown;
  /** ISO timestamp of the live fetch that produced it. */
  fetchedAt: string;
}

/**
 * Stored model list of a saved STT profile
 * (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b; owner 2026-10-15: pick
 * the model once, never re-request the list just to open the profile — the
 * LLM provider picker pattern). One row per (profile, kind): every
 * successful live listing for the saved profile overwrites it; the profile
 * editor opens on it with no upstream call. Rows cascade with the profile
 * and are cleared when the profile's server (endpoint/backend) changes.
 *
 * Deliberate deviation from the parent: no failure fallback — a failed live
 * call surfaces as an error, the stored copy is never served in its place.
 */
export class SttListingSnapshotStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  async get(profileId: string, kind: SttListingSnapshotKind): Promise<SttListingSnapshot | null> {
    const rows = await this.db
      .select()
      .from(sttListingSnapshots)
      .where(and(eq(sttListingSnapshots.sttProfileId, profileId), eq(sttListingSnapshots.kind, kind)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    try {
      return { payload: JSON.parse(row.payloadJson) as unknown, fetchedAt: row.fetchedAt };
    } catch (error) {
      // A corrupt row is no snapshot: drop it so the next live success rewrites it.
      console.warn(`[stt] dropping unreadable ${kind} snapshot for profile ${profileId}:`, error);
      await this.clear(profileId, kind);
      return null;
    }
  }

  /** Record a live listing (overwrites the previous snapshot of that kind). */
  async put(profileId: string, kind: SttListingSnapshotKind, payload: unknown): Promise<void> {
    const payloadJson = JSON.stringify(payload);
    const fetchedAt = this.clock.now();
    await this.db
      .insert(sttListingSnapshots)
      .values({ sttProfileId: profileId, kind, payloadJson, fetchedAt })
      .onConflictDoUpdate({
        target: [sttListingSnapshots.sttProfileId, sttListingSnapshots.kind],
        set: { payloadJson, fetchedAt },
      });
  }

  /** Drop one kind, or every snapshot of the profile when `kind` is omitted. */
  async clear(profileId: string, kind?: SttListingSnapshotKind): Promise<void> {
    await this.db
      .delete(sttListingSnapshots)
      .where(
        kind === undefined
          ? eq(sttListingSnapshots.sttProfileId, profileId)
          : and(eq(sttListingSnapshots.sttProfileId, profileId), eq(sttListingSnapshots.kind, kind)),
      );
  }
}

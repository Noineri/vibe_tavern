import { and, eq } from 'drizzle-orm';
import { imageGenListingSnapshots } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

/** The listings a profile snapshots (IF-20): the model catalog (with its
 *  template/family enrichment) and the ComfyUI DiT sidecar folders. */
export const IMAGE_GEN_LISTING_SNAPSHOT_KINDS = {
  Models: 'models',
  DitSidecars: 'dit-sidecars',
} as const;
export type ImageGenListingSnapshotKind =
  (typeof IMAGE_GEN_LISTING_SNAPSHOT_KINDS)[keyof typeof IMAGE_GEN_LISTING_SNAPSHOT_KINDS];

export interface ImageGenListingSnapshot {
  /** The listing exactly as the live route returned it (parsed JSON). */
  payload: unknown;
  /** ISO timestamp of the live fetch that produced it. */
  fetchedAt: string;
}

/**
 * Last-good listing snapshots (IF-20, owner 2026-09-27 «мы не можем их
 * как-то... хранить?»). One row per (profile, kind): every successful live
 * listing overwrites it; the adapter serves it — flagged stale — only when
 * the live fetch fails. Rows cascade with the profile and are cleared when
 * the profile's server (endpoint/backend) changes.
 */
export class ImageGenListingSnapshotStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  async get(profileId: string, kind: ImageGenListingSnapshotKind): Promise<ImageGenListingSnapshot | null> {
    const rows = await this.db
      .select()
      .from(imageGenListingSnapshots)
      .where(and(eq(imageGenListingSnapshots.imageGenProfileId, profileId), eq(imageGenListingSnapshots.kind, kind)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    try {
      return { payload: JSON.parse(row.payloadJson) as unknown, fetchedAt: row.fetchedAt };
    } catch (error) {
      // A corrupt row is no snapshot: drop it so the next live success rewrites it.
      console.warn(`[image-gen] dropping unreadable ${kind} snapshot for profile ${profileId}:`, error);
      await this.clear(profileId, kind);
      return null;
    }
  }

  /** Record a live listing (overwrites the previous snapshot of that kind). */
  async put(profileId: string, kind: ImageGenListingSnapshotKind, payload: unknown): Promise<void> {
    const payloadJson = JSON.stringify(payload);
    const fetchedAt = this.clock.now();
    await this.db
      .insert(imageGenListingSnapshots)
      .values({ imageGenProfileId: profileId, kind, payloadJson, fetchedAt })
      .onConflictDoUpdate({
        target: [imageGenListingSnapshots.imageGenProfileId, imageGenListingSnapshots.kind],
        set: { payloadJson, fetchedAt },
      });
  }

  /** Drop one kind, or every snapshot of the profile when `kind` is omitted. */
  async clear(profileId: string, kind?: ImageGenListingSnapshotKind): Promise<void> {
    await this.db
      .delete(imageGenListingSnapshots)
      .where(
        kind === undefined
          ? eq(imageGenListingSnapshots.imageGenProfileId, profileId)
          : and(eq(imageGenListingSnapshots.imageGenProfileId, profileId), eq(imageGenListingSnapshots.kind, kind)),
      );
  }
}

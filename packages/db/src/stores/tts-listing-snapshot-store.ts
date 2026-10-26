// fork #2 of ImageGenListingSnapshotStore (packages/db/src/stores/image-gen-listing-snapshot-store.ts)
import { and, eq } from 'drizzle-orm';
import { ttsListingSnapshots } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

/** The fixed listing a saved TTS profile snapshots: the model catalog. */
export const TTS_LISTING_SNAPSHOT_KINDS = {
  Models: 'models',
} as const;

/** Voice rosters are snapshotted per model: some backends (the aggregator
 *  catalogs behind an OpenAI-compatible endpoint) serve a different roster
 *  for each model, so the key is `voices:<modelId>` ('voices:' when the
 *  config names no model). */
export const TTS_VOICES_SNAPSHOT_KIND_PREFIX = 'voices:';

export type TtsListingSnapshotKind =
  | (typeof TTS_LISTING_SNAPSHOT_KINDS)[keyof typeof TTS_LISTING_SNAPSHOT_KINDS]
  | `${typeof TTS_VOICES_SNAPSHOT_KIND_PREFIX}${string}`;

/** The snapshot kind of one model's voice envelope. */
export function ttsVoicesSnapshotKind(modelId: string): TtsListingSnapshotKind {
  return `${TTS_VOICES_SNAPSHOT_KIND_PREFIX}${modelId}`;
}

export interface TtsListingSnapshot {
  /** The listing exactly as the live route returned it (parsed JSON). */
  payload: unknown;
  /** ISO timestamp of the live fetch that produced it. */
  fetchedAt: string;
}

/**
 * Stored model and voice lists of a saved TTS profile
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
export class TtsListingSnapshotStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  async get(profileId: string, kind: TtsListingSnapshotKind): Promise<TtsListingSnapshot | null> {
    const rows = await this.db
      .select()
      .from(ttsListingSnapshots)
      .where(and(eq(ttsListingSnapshots.ttsProfileId, profileId), eq(ttsListingSnapshots.kind, kind)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    try {
      return { payload: JSON.parse(row.payloadJson) as unknown, fetchedAt: row.fetchedAt };
    } catch (error) {
      // A corrupt row is no snapshot: drop it so the next live success rewrites it.
      console.warn(`[tts] dropping unreadable ${kind} snapshot for profile ${profileId}:`, error);
      await this.clear(profileId, kind);
      return null;
    }
  }

  /** Record a live listing (overwrites the previous snapshot of that kind). */
  async put(profileId: string, kind: TtsListingSnapshotKind, payload: unknown): Promise<void> {
    const payloadJson = JSON.stringify(payload);
    const fetchedAt = this.clock.now();
    await this.db
      .insert(ttsListingSnapshots)
      .values({ ttsProfileId: profileId, kind, payloadJson, fetchedAt })
      .onConflictDoUpdate({
        target: [ttsListingSnapshots.ttsProfileId, ttsListingSnapshots.kind],
        set: { payloadJson, fetchedAt },
      });
  }

  /** Drop one kind, or every snapshot of the profile when `kind` is omitted. */
  async clear(profileId: string, kind?: TtsListingSnapshotKind): Promise<void> {
    await this.db
      .delete(ttsListingSnapshots)
      .where(
        kind === undefined
          ? eq(ttsListingSnapshots.ttsProfileId, profileId)
          : and(eq(ttsListingSnapshots.ttsProfileId, profileId), eq(ttsListingSnapshots.kind, kind)),
      );
  }
}

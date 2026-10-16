/**
 * Saved-profile listings over the last-good snapshot table
 * (`image_gen_listing_snapshots`). Moved out of `image-gen-adapter.ts`
 * (file-size ratchet) when the stored-first read joined it.
 *
 * Two reads share the table:
 * - `listWithSnapshot` — the LIVE path (IF-20, owner 2026-09-27: a restarted
 *   server must not empty the pickers): a live listing; a success overwrites
 *   the snapshot, a failure serves it flagged with `snapshotAt`.
 * - `readStoredListing` — the STORED-FIRST path
 *   (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11, owner 2026-10-15: pick
 *   the model once, never re-request the list just to open the profile — the
 *   LLM provider picker pattern): the stored list with no upstream call.
 */
import type { ImageGenListingSnapshotKind, ImageGenListingSnapshotStore } from "@vibe-tavern/db";
import type { ImageGenListing } from "../contract/runtime-api.js";

/** The stored listing of that kind, re-validated by `parse`; null when none
 *  is stored or the payload no longer parses (counts as none). Makes no
 *  upstream call and never flags `snapshotAt` — the header keeps meaning
 *  "the live call failed". */
export async function readStoredListing<T>(
  store: ImageGenListingSnapshotStore,
  profileId: string,
  kind: ImageGenListingSnapshotKind,
  parse: (raw: unknown) => T | null,
): Promise<T | null> {
  const snapshot = await store.get(profileId, kind);
  return snapshot === null ? null : parse(snapshot.payload);
}

/**
 * Run a live listing; a success overwrites the profile's last-good
 * snapshot, a failure serves that snapshot flagged with `snapshotAt` —
 * never silent freshness — and rethrows when none exists. A caller-side
 * abort always rethrows (nobody is waiting for the fallback). The stored
 * payload is re-validated on read; an unreadable one counts as none.
 */
export async function listWithSnapshot<T>(
  store: ImageGenListingSnapshotStore,
  profileId: string,
  kind: ImageGenListingSnapshotKind,
  signal: AbortSignal | undefined,
  parse: (raw: unknown) => T | null,
  live: () => Promise<T>,
): Promise<ImageGenListing<T>> {
  let data: T;
  try {
    data = await live();
  } catch (error) {
    if (signal?.aborted === true) throw error;
    const snapshot = await store.get(profileId, kind);
    const stored = snapshot === null ? null : parse(snapshot.payload);
    if (snapshot === null || stored === null) throw error;
    return { data: stored, snapshotAt: snapshot.fetchedAt };
  }
  try {
    await store.put(profileId, kind, data);
  } catch (error) {
    // The live listing is still correct — a failed snapshot write only
    // costs the next outage its fallback.
    console.warn(`[image-gen] ${kind} snapshot write failed for profile ${profileId}:`, error);
  }
  return { data };
}

// fork #1 of image-gen-listing-snapshot.ts (services/api/src/api/adapters/image-gen-listing-snapshot.ts)
/**
 * Saved STT profile model list over the stored-snapshot table
 * (`stt_listing_snapshots`; IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b,
 * owner 2026-10-15: pick the model once, never re-request the list just to
 * open the profile — the LLM provider picker pattern).
 *
 * Two halves of the parent module, nothing else:
 * - `readStoredSttModels` — the open path: the stored list, re-validated; no
 *   upstream call.
 * - `recordSttModels` — after every successful live listing for the saved
 *   profile; a failed write only warns, the live answer stays correct.
 *
 * Deliberate deviation from the parent: no `listWithSnapshot` failure
 * fallback (the IF-20 stale answer with a `snapshotAt` header). A failed
 * live call surfaces exactly as it did before snapshots existed.
 */
import { sttModelInfoSchema, type SttModelInfoValue } from "@vibe-tavern/api-contracts";
import { STT_LISTING_SNAPSHOT_KINDS, type SttListingSnapshotStore } from "@vibe-tavern/db";

const sttModelListSchema = sttModelInfoSchema.array();

/** The stored model list re-validated; null when it no longer parses (an
 *  unreadable payload counts as nothing stored). */
function parseSttModels(raw: unknown): SttModelInfoValue[] | null {
  const parsed = sttModelListSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The stored model list of the profile, or null when none is stored, the
 *  payload is unreadable, or the stored list is EMPTY — the LLM picker rule
 *  (`cachedModels.length > 0`): an empty list is no answer, the open path
 *  lists live (probe-only backends record `[]` after a green probe; serving
 *  it would skip that probe). Makes no upstream call. */
export async function readStoredSttModels(
  store: SttListingSnapshotStore,
  profileId: string,
): Promise<SttModelInfoValue[] | null> {
  const snapshot = await store.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models);
  const models = snapshot === null ? null : parseSttModels(snapshot.payload);
  return models !== null && models.length > 0 ? models : null;
}

/** Overwrite the profile's stored model list with a live answer. */
export async function recordSttModels(
  store: SttListingSnapshotStore,
  profileId: string,
  models: SttModelInfoValue[],
): Promise<void> {
  try {
    await store.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, models);
  } catch (error) {
    // The live listing is still correct — a failed snapshot write only costs
    // the next open its stored list.
    console.warn(`[stt] models snapshot write failed for profile ${profileId}:`, error);
  }
}

/**
 * Scene history-backfill vocabulary (SCENE_TRACKER_PLAN SCN-14): the frozen
 * manifest item type and the small pure helpers the run loop parses rows
 * with. Extracted from tracker-service.ts (DK-4b arch-gate ratchet: the
 * service file could not grow); tracker-service re-exports the manifest type
 * so its public surface is unchanged, and stays the home of the run loop
 * itself (this module is pure vocabulary only — no I/O, no state).
 */
import type { SceneBackfillErrorEntry } from "@vibe-tavern/domain";

/** One frozen manifest item in a Scene history-backfill run (SCN-14): a selected
 *  assistant variant captured oldest-to-newest at run start, with its then-
 *  current source/schema/config fingerprint so resume/retry can revalidate the
 *  item is still generatable before spending an LLM call on it. Plain-string ids
 *  — this is serialized to JSON in the run row, not a branded domain record. */
export interface SceneBackfillManifestItem {
	/** Position in the frozen manifest (0 = oldest). */
	index: number;
	branchId: string;
	messageId: string;
	variantId: string;
	sourceHash: string;
	schemaHash: string;
	configRevision: number;
}

/** Inclusive-start, exclusive-end integer range (empty when start >= end). */
export function range(start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i < end; i += 1) out.push(i);
	return out;
}

/** Unique integers sorted ascending (for the retry-index union). */
export function uniqueSorted(values: number[]): number[] {
	return [...new Set(values)].sort((a, b) => a - b);
}

/** Parse a run row's errorsJson defensively; an unparseable/corrupt blob → []. */
export function parseBackfillErrors(json: string): SceneBackfillErrorEntry[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? (parsed as SceneBackfillErrorEntry[]) : [];
	} catch {
		return [];
	}
}

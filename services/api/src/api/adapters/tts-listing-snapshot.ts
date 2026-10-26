// fork #2 of image-gen-listing-snapshot.ts (services/api/src/api/adapters/image-gen-listing-snapshot.ts)
/**
 * Saved TTS profile model and voice lists over the stored-snapshot table
 * (`tts_listing_snapshots`; IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b,
 * owner 2026-10-15: pick the model once, never re-request the list just to
 * open the profile — the LLM provider picker pattern).
 *
 * Two halves of the parent module, nothing else:
 * - `readStoredTtsListing` — the open path: the stored payload of one kind,
 *   re-validated by that kind's parser; no upstream call.
 * - `recordTtsListing` — after every successful live listing for the saved
 *   profile; a failed write only warns, the live answer stays correct.
 *
 * Deliberate deviation from the parent: no `listWithSnapshot` failure
 * fallback (the IF-20 stale answer with a `snapshotAt` header). A failed
 * live call surfaces exactly as it did before snapshots existed.
 *
 * Kinds: `models` (the model array) and `voices:<modelId>` (the whole
 * `{ voices, capabilities }` envelope the voices route returns — the
 * capabilities depend on what `listVoices` saw, so voices are never served
 * without them). The voice roster is keyed by model because a roster can
 * depend on it: the aggregator catalogs behind an OpenAI-compatible endpoint
 * (OpenRouter / NanoGPT style, `catalogRequest` kinds `modality` and
 * `audio-models` in `openai-tts.ts`) resolve the roster from the catalog
 * entry of the config's model. Every other backend's roster is
 * model-independent, so the model only splits their rows without changing
 * them. The model id is read through the registry's per-backend model key
 * (`ttsConfigModelId`) — the field that backend itself reads.
 */
import { z } from "zod";
import {
  ttsVoicesSnapshotKind,
  type TtsListingSnapshotKind,
  type TtsListingSnapshotStore,
} from "@vibe-tavern/db";
import type { TtsBackendCapabilities, TtsModelInfo, TtsVoiceInfo } from "../../domain/tts/tts-backend.js";
import { ttsConfigModelId } from "../../domain/tts/tts-registry.js";

/** The `{ voices, capabilities }` envelope `POST /api/tts/draft/voices`
 *  returns (voices null = manual input floor / empty library). */
export interface TtsVoicesEnvelope {
  voices: TtsVoiceInfo[] | null;
  capabilities: TtsBackendCapabilities;
}

// Typed against the domain shapes: a required field added to TtsModelInfo /
// TtsVoiceInfo / TtsBackendCapabilities breaks the build here instead of
// silently stripping it from stored answers. Optional additions must be
// mirrored by hand.
const ttsModelListSchema: z.ZodType<TtsModelInfo[]> = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    isFree: z.boolean().optional(),
    description: z.string().optional(),
    contextLength: z.number().optional(),
    voices: z.array(z.string()).optional(),
  }),
);

const ttsVoicesEnvelopeSchema: z.ZodType<TtsVoicesEnvelope> = z.object({
  voices: z
    .array(z.object({ id: z.string(), label: z.string(), lang: z.string() }))
    .nullable(),
  capabilities: z.object({
    supportsCloning: z.boolean(),
    formats: z.array(z.string()).optional(),
    maxSizeMb: z.number().optional(),
    cloneRequiresReferenceText: z.boolean().optional(),
    cloneCaveatKey: z.literal("siliconflow").optional(),
  }),
});

/** Re-validate a stored model array; null = unreadable or EMPTY — both
 *  count as nothing stored (the LLM picker rule `cachedModels.length > 0`:
 *  an empty list is no answer, the open path lists live). */
export function parseTtsModels(raw: unknown): TtsModelInfo[] | null {
  const parsed = ttsModelListSchema.safeParse(raw);
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}

/** Re-validate a stored voices envelope; null = unreadable, or no voices
 *  (`voices` null or empty) — counts as nothing stored, the same empty rule.
 *  `voices: null` is also what the OpenAI-compatible backend answers when
 *  its voice listing fails upstream, so serving it would pin a transient
 *  failure until the next refresh. */
export function parseTtsVoicesEnvelope(raw: unknown): TtsVoicesEnvelope | null {
  const parsed = ttsVoicesEnvelopeSchema.safeParse(raw);
  return parsed.success && parsed.data.voices !== null && parsed.data.voices.length > 0 ? parsed.data : null;
}

/** The snapshot kind of the voice envelope a draft config lists: keyed by the
 *  config's model id as that backend reads it (registry model key);
 *  `voices:` alone when the config names no model or the backend reads none. */
export function ttsVoicesKindForConfig(backend: string, config: Record<string, unknown>): TtsListingSnapshotKind {
  return ttsVoicesSnapshotKind(ttsConfigModelId(backend, config));
}

/** The stored listing of that kind, re-validated by `parse`; null when none
 *  is stored or the payload no longer parses (counts as none). Makes no
 *  upstream call. */
export async function readStoredTtsListing<T>(
  store: TtsListingSnapshotStore,
  profileId: string,
  kind: TtsListingSnapshotKind,
  parse: (raw: unknown) => T | null,
): Promise<T | null> {
  const snapshot = await store.get(profileId, kind);
  return snapshot === null ? null : parse(snapshot.payload);
}

/** Overwrite the profile's stored listing of that kind with a live answer. */
export async function recordTtsListing(
  store: TtsListingSnapshotStore,
  profileId: string,
  kind: TtsListingSnapshotKind,
  data: unknown,
): Promise<void> {
  try {
    await store.put(profileId, kind, data);
  } catch (error) {
    // The live listing is still correct — a failed snapshot write only costs
    // the next open its stored list.
    console.warn(`[tts] ${kind} snapshot write failed for profile ${profileId}:`, error);
  }
}

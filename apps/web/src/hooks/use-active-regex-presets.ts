import { useEffect, useState } from "react";
import {
  brandId,
  type RegexPreset,
  type RegexPresetId,
  type RegexPlacement,
  type RegexSubstituteMode,
} from "@vibe-tavern/domain";
import { resolveActiveRegexPresets } from "../api/regex-api.js";
import type { RegexPresetRecord } from "../api/types.js";

/**
 * Active regex presets for one chat context (RX-13 display seam).
 *
 * Loads the same 3-source union the server prompt seam uses (global +
 * character-bound + preset-bound — `GET /api/regex/resolve-active`) and maps
 * the wire records into domain `RegexPreset`s at the API boundary (branded id,
 * numeric-union fields) so the pure engine functions take them directly.
 *
 * Caching: a module-level Map keyed by `characterId|presetId` — every mounted
 * MessageBlock subscribes to the same entry, so a chat with N blocks issues
 * ONE fetch. Entries live for the session; `invalidateActiveRegexPresets()`
 * (called from the Prompt Manager regex save/delete/link paths) clears the
 * cache and notifies mounted hooks to refetch, because preset edits otherwise
 * never reach an open chat view.
 *
 * Failures degrade to "no presets" — a missing regex list must never break
 * message rendering.
 */

/** Module cache: resolved presets per chat context key. */
const cache = new Map<string, RegexPreset[]>();
/** In-flight dedup: N mounted blocks for the same key share one request. */
const inflight = new Map<string, Promise<RegexPreset[]>>();
/** Invalidation listeners (one per mounted hook instance). */
const listeners = new Set<() => void>();
/** Bumped on invalidation; hook effect deps on it to refire the fetch. */
let version = 0;

/** Clear all cached resolutions and tell mounted hooks to refetch. */
export function invalidateActiveRegexPresets(): void {
  cache.clear();
  version += 1;
  for (const listener of listeners) listener();
}

/** API-boundary mapping: wire record → domain preset the engine consumes. */
function recordToDomainPreset(record: RegexPresetRecord): RegexPreset {
  return {
    ...record,
    id: brandId<RegexPresetId>(record.id),
    substituteRegex: record.substituteRegex as RegexSubstituteMode,
    placement: record.placement as RegexPlacement[],
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  };
}

/** Shared empty result — reference-stable so setState bails out (no render)
 *  when a fetch degrades to "no presets"; also cached so N mounted blocks
 *  share one failed request instead of N. Cleared by invalidation. */
const EMPTY_PRESETS: RegexPreset[] = [];

function loadKey(key: string, characterId: string, presetId: string | null): Promise<RegexPreset[]> {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(key);
  if (existing) return existing;
  const request = resolveActiveRegexPresets({ characterId, ...(presetId ? { presetId } : {}) })
    .then((records) => {
      const mapped = records.map(recordToDomainPreset);
      cache.set(key, mapped.length > 0 ? mapped : EMPTY_PRESETS);
      inflight.delete(key);
      return mapped;
    })
    .catch(() => {
      inflight.delete(key);
      // Degrade to "no presets" — regex is an enhancement, not a gate.
      // Cache the SHARED empty (not a fresh []) so every later mount and the
      // pending setState stay reference-equal → React bails out, no re-render.
      cache.set(key, EMPTY_PRESETS);
      return EMPTY_PRESETS;
    });
  inflight.set(key, request);
  return request;
}

export function useActiveRegexPresets(
  characterId: string | null,
  presetId: string | null,
): RegexPreset[] {
  const key = characterId ? `${characterId}|${presetId ?? ""}` : "";
  const [presets, setPresets] = useState<RegexPreset[]>(
    () => (key ? cache.get(key) ?? EMPTY_PRESETS : EMPTY_PRESETS),
  );
  // Local shadow of the module version so invalidation refires the effect.
  const [localVersion, setLocalVersion] = useState(version);

  useEffect(() => {
    const onInvalidate = () => setLocalVersion(version);
    listeners.add(onInvalidate);
    return () => {
      listeners.delete(onInvalidate);
    };
  }, []);

  useEffect(() => {
    if (!key || !characterId) {
      // Reference-stable clear: bails out when already empty.
      setPresets((prev) => (prev === EMPTY_PRESETS ? prev : EMPTY_PRESETS));
      return;
    }
    let cancelled = false;
    void loadKey(key, characterId, presetId).then((resolved) => {
      if (!cancelled) setPresets(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [key, characterId, presetId, localVersion]);

  // No-chat path returns the shared constant, not a fresh [].
  return key ? presets : EMPTY_PRESETS;
}

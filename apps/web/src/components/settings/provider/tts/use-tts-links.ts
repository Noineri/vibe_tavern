/**
 * TTS profile links hook (TTS_PLAN TS-9b) — the voice-map write path.
 *
 * Loads one profile's `ttsProfileLinks` rows and mutates them through
 * `setTtsLinks`, which is a FULL-SET PUT. Because mute rows live on the
 * DEFAULT profile, every PUT from this hook MERGES instead of blindly
 * replacing (see the two pure compute* functions) — a naive PUT from either
 * surface would wipe the other's rows.
 *
 * After every successful PUT the profile's links are reloaded AND the
 * module-cached voice map (`voice-map-data`) is refreshed — the chat-side
 * resolver reads that cache, not the per-profile state here.
 */

import { useCallback, useEffect, useState } from "react";

import {
  getTtsLinks,
  setTtsLinks,
  type TtsLinkRecord,
  type TtsProfileRecord,
} from "../../../../api/tts-api.js";
import { refreshVoiceMapData } from "../../../../lib/tts/voice-map-data.js";

// ── deps seam (same pattern as use-tts-preview / tts-playback-store) ──────
// Test-injectable API surface. A mock.module of tts-api would NOT reach this
// module once any earlier test file in the same bun process has executed it
// (module-registry mocks don't rebind already-evaluated import closures), so
// both the hook tests and the component tests drive this seam instead.

export interface TtsLinksDeps {
  getLinks(profileId: string): Promise<TtsLinkRecord[]>;
  putLinks(profileId: string, rows: TtsLinkPutRow[]): Promise<void>;
  refreshVoiceMap(): Promise<void>;
}

let depsOverride: TtsLinksDeps | null = null;

/** Test seam: replace the API deps. Pass null to restore defaults. */
export function __setTtsLinksDepsForTests(deps: TtsLinksDeps | null): void {
  depsOverride = deps;
}

function currentDeps(): TtsLinksDeps {
  if (depsOverride !== null) return depsOverride;
  return {
    getLinks: (id) => getTtsLinks(id),
    putLinks: async (id, rows) => {
      await setTtsLinks(id, rows);
    },
    refreshVoiceMap: () => refreshVoiceMapData(),
  };
}

/** A voice-map binding target (mute is characters-only by design). */
export interface TtsLinkTargetInput {
  targetType: "character" | "persona";
  targetId: string;
}

/** A `setTtsLinks` PUT row (same wire shape `tts-api` accepts). */
export interface TtsLinkPutRow {
  targetType: TtsLinkRecord["targetType"];
  targetId: string;
  mode?: "voice" | "disabled";
}

/**
 * Merge rule 1a — replace the profile's voice bindings with `selected`,
 * PRESERVING this profile's disabled (mute) rows whose target is not part of
 * the new selection. Binding a target that was muted replaces the mute (the
 * user's explicit intent beats an older mute marker).
 */
export function computeVoiceTargetsPut(
  current: TtsLinkRecord[],
  selected: TtsLinkTargetInput[],
): TtsLinkPutRow[] {
  const selectedKeys = new Set(selected.map((s) => `${s.targetType}:${s.targetId}`));
  const preservedMutes = current
    .filter((row) => row.mode === "disabled")
    .filter((row) => !selectedKeys.has(`${row.targetType}:${row.targetId}`))
    .map((row): TtsLinkPutRow => ({ targetType: row.targetType, targetId: row.targetId, mode: "disabled" }));
  const voiceRows = selected.map(
    (s): TtsLinkPutRow => ({ targetType: s.targetType, targetId: s.targetId, mode: "voice" }),
  );
  return [...preservedMutes, ...voiceRows];
}

/**
 * Merge rule 1b — replace the default profile's mute set with `ids`,
 * PRESERVING persona voice rows and character voice rows that are not being
 * muted. Muting a character that was voice-bound on this profile drops that
 * voice row — one target cannot hold both rows on the same profile
 * (composite PK).
 */
export function computeMutedPut(current: TtsLinkRecord[], ids: string[]): TtsLinkPutRow[] {
  const muted = new Set(ids);
  const kept = current
    .filter((row) => (row.mode ?? "voice") === "voice")
    .filter((row) => !(row.targetType === "character" && muted.has(row.targetId)))
    .map((row): TtsLinkPutRow => ({ targetType: row.targetType, targetId: row.targetId, mode: "voice" }));
  const muteRows = ids.map(
    (id): TtsLinkPutRow => ({ targetType: "character", targetId: id, mode: "disabled" }),
  );
  return [...kept, ...muteRows];
}

export function useTtsLinks(profileId: string | null): {
  links: TtsLinkRecord[];
  loading: boolean;
  error: string | null;
  /** Replace this profile's voice bindings; preserves its disabled rows (merge rule 1a). */
  setVoiceTargets(targets: TtsLinkTargetInput[]): Promise<void>;
  /** Replace the default profile's mute set; preserves voice rows (merge rule 1b). */
  setMutedCharacters(ids: string[]): Promise<void>;
  reload(): Promise<void>;
} {
  const [links, setLinks] = useState<TtsLinkRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same load the mount effect performs, reused by reload() and post-PUT
  // refreshes (rule 2: links reloaded after EVERY successful PUT).
  const load = useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await currentDeps().getLinks(id);
      setLinks(list);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount / profile switch; null id → empty, not loading (same
  // cancellation-flag pattern as the editor's voices effect).
  useEffect(() => {
    if (profileId === null) {
      setLinks([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    currentDeps()
      .getLinks(profileId)
      .then((list) => {
        if (cancelled) return;
        setLinks(list);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const put = useCallback(
    async (payload: TtsLinkPutRow[]): Promise<boolean> => {
      if (profileId === null) {
        setError("Cannot save the voice map before the profile is saved.");
        return false;
      }
      try {
        await currentDeps().putLinks(profileId, payload);
      } catch (cause) {
        // Failed PUT leaves the current links untouched (server state is
        // unchanged; the UI keeps showing what it had).
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
      await load(profileId);
      await currentDeps().refreshVoiceMap();
      return true;
    },
    [profileId, load],
  );

  const setVoiceTargets = useCallback(
    async (targets: TtsLinkTargetInput[]): Promise<void> => {
      await put(computeVoiceTargetsPut(links, targets));
    },
    [put, links],
  );

  const setMutedCharacters = useCallback(
    async (ids: string[]): Promise<void> => {
      await put(computeMutedPut(links, ids));
    },
    [put, links],
  );

  const reload = useCallback(async (): Promise<void> => {
    if (profileId === null) return;
    await load(profileId);
  }, [profileId, load]);

  return { links, loading, error, setVoiceTargets, setMutedCharacters, reload };
}

/** Test/derived helper: is `profile` the row the mute control writes to? */
export function isDefaultProfileRow(profiles: TtsProfileRecord[], profileId: string | null): boolean {
  if (profileId === null) return false;
  return profiles.find((p) => p.isDefault)?.id === profileId;
}

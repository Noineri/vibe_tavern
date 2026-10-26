import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackerTemplate } from "@vibe-tavern/domain";
import {
  deleteTrackerTemplate,
  getTrackerTemplate,
  updateTrackerTemplate,
} from "../api/character-api.js";

/** Loads and mutates the active version's character-owned tracker template. */
export function useCharacterTrackerTemplate(characterId: string | null): {
  template: TrackerTemplate | null;
  loading: boolean;
  error: string | null;
  save: (template: TrackerTemplate) => Promise<TrackerTemplate>;
  clear: () => Promise<void>;
  refetch: () => Promise<void>;
} {
  const [template, setTemplate] = useState<TrackerTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;

  const refetch = useCallback(async () => {
    const id = characterId;
    const sequence = ++requestSequence.current;
    if (!id) {
      setTemplate(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await getTrackerTemplate(id);
      if (sequence === requestSequence.current) setTemplate(next);
    } catch (reason: unknown) {
      if (sequence !== requestSequence.current) return;
      setTemplate(null);
      setError(reason instanceof Error ? reason.message : "Failed to load tracker template");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [characterId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const save = useCallback(async (next: TrackerTemplate) => {
    const id = characterId;
    if (!id) throw new Error("Cannot save a tracker template without a character");
    const saved = await updateTrackerTemplate(id, next);
    if (characterIdRef.current === id) setTemplate(saved);
    return saved;
  }, [characterId]);

  const clear = useCallback(async () => {
    const id = characterId;
    if (!id) return;
    await deleteTrackerTemplate(id);
    if (characterIdRef.current === id) setTemplate(null);
  }, [characterId]);

  return { template, loading, error, save, clear, refetch };
}

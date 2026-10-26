import { useCallback, useEffect, useRef, useState } from "react";

/** Pause between the last input change and the open-path request, so typing a
 *  model id into a plain field lists once, not once per keystroke. */
export const STORED_FIRST_LISTING_DEBOUNCE_MS = 400;

export interface StoredFirstListingOptions<T> {
  /** false = there is nothing to list (edit mode, a backend without the
   *  list): the state resets to empty and no request goes out. */
  enabled: boolean;
  /** Identity of the list's owner (a saved profile and its backend). A re-run
   *  inside the same scope keeps the current list on screen while it loads; a
   *  new scope starts from an empty slate, so one profile's list never shows
   *  under another. null = a draft (nothing saved yet): always an empty slate. */
  scope: string | null;
  /** Serialized listing inputs; a change re-runs the open path (debounced). */
  inputKey: string;
  /** The open path of a saved profile: the request asks the server for the
   *  stored list (`"stored"`) and a failure stays quiet. false = a draft: the
   *  request is live and a failure is loud. */
  storedFirst: boolean;
  /** One request. `"stored"` = the open path of a saved profile (the server
   *  answers from its stored copy, live only when nothing is stored);
   *  `undefined` = live. Always returns a promise (declare it `async`).
   *  Called with the LATEST render's closure, so it reads the form as it is
   *  when the request leaves, not when the effect was armed. */
  load: (source: "stored" | undefined) => Promise<T>;
  /** Runs for every successful answer that is still current (open path and
   *  refresh alike), after the list is set. */
  onLoaded?: (data: T) => void;
  /** Pause before the open-path request; defaults to
   *  {@link STORED_FIRST_LISTING_DEBOUNCE_MS}. Only the hook test shortens it. */
  debounceMs?: number;
}

export interface StoredFirstListing<T> {
  data: T | null;
  /** A request is in flight. The list may still be on screen (see `scope`):
   *  show a loading state only when `data` is null. */
  loading: boolean;
  /** Message of a failed REFRESH or a failed draft listing. A failed open
   *  path of a saved profile never sets it (options data must not shout). */
  error: string | null;
  /** The live path (the refresh buttons): always lists upstream, replaces the
   *  server's stored copy, and keeps the current list on screen meanwhile. */
  refresh: () => void;
}

/**
 * Stored-first picker listing (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11c,
 * owner 2026-10-15: "the first time you pick the model, after that it must not
 * be requested again for things to work" — the LLM provider picker pattern,
 * `useProviderModels`). Opening a saved profile asks the server for its STORED
 * list (`source: "stored"`; a live listing only when nothing is stored); the
 * refresh button is the only live path. One mechanism for the TTS models, the
 * TTS voices and the STT models.
 *
 * Every request is numbered. The effect, the refresh and a profile switch all
 * advance the number, and only the newest request may write state, so a late
 * answer never lands on another profile or overwrites a newer one.
 */
export function useStoredFirstListing<T>(options: StoredFirstListingOptions<T>): StoredFirstListing<T> {
  const { enabled, scope, inputKey, storedFirst, debounceMs = STORED_FIRST_LISTING_DEBOUNCE_MS } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  // The scope `data` belongs to; null while there is no list to protect.
  const dataScope = useRef<string | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const request = useCallback((mine: number, source: "stored" | undefined) => {
    latest.current.load(source).then(
      (result) => {
        if (sequence.current !== mine) return;
        setData(result);
        setError(null);
        setLoading(false);
        latest.current.onLoaded?.(result);
      },
      (cause: unknown) => {
        if (sequence.current !== mine) return;
        setLoading(false);
        if (source === "stored") {
          // Quiet open path: no list, no message — the picker degrades to its
          // manual input and the refresh button stays the way to retry.
          setData(null);
          return;
        }
        // A failed refresh keeps the list it had (the stored copy still
        // serves); a draft had none to begin with.
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, []);

  useEffect(() => {
    const mine = ++sequence.current;
    if (!enabled) {
      dataScope.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (scope === null || scope !== dataScope.current) setData(null);
    dataScope.current = scope;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      // A refresh pressed inside the debounce window already took over.
      if (sequence.current !== mine) return;
      request(mine, storedFirst ? "stored" : undefined);
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      // Retire the in-flight request (re-run, profile switch, unmount).
      sequence.current += 1;
    };
  }, [enabled, scope, inputKey, storedFirst, debounceMs, request]);

  const refresh = useCallback(() => {
    if (!latest.current.enabled) return;
    const mine = ++sequence.current;
    setLoading(true);
    setError(null);
    request(mine, undefined);
  }, [request]);

  return { data, loading, error, refresh };
}

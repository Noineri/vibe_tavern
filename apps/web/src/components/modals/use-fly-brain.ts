import { useCallback, useEffect, useState } from "react";
import type { FlyBrainManifest } from "@vibe-tavern/api-contracts";
import {
  FLY_BRAIN_CACHE_NAME,
  downloadFlyBrain,
  loadCachedFlyBrain,
  type FlyBrainDownloadingState,
  type FlyBrainLoadState,
} from "../../lib/fly/fly-brain-download.js";

/**
 * Browser-brain download hook (FLY_TRIBUNAL_PLAN FT-9).
 *
 * fork #1 of components/settings/provider/stt/use-whisper-model.ts
 *
 * The Fly brain is one immutable, sha-addressed MCNS artifact rather than a
 * roster pick. FT-6 owns byte streaming, integrity verification and Cache API
 * writes; this hook is the React state-machine projection for the modal.
 */

export type FlyBrainState = "idle" | "downloading" | "ready" | "error";

export interface FlyBrainDeps {
  loadCached: () => Promise<FlyBrainLoadState>;
  download: (onProgress: (state: FlyBrainDownloadingState) => void) => Promise<FlyBrainLoadState>;
  clearCache: () => Promise<void>;
}

let depsOverride: FlyBrainDeps | null = null;

/** Test seam: inject network/cache doubles; null restores browser dependencies. */
export function __setFlyBrainDepsForTests(deps: FlyBrainDeps | null): void {
  depsOverride = deps;
}

const DEFAULT_DEPS: FlyBrainDeps = {
  loadCached: () => loadCachedFlyBrain(),
  download: (onProgress) => downloadFlyBrain({ onProgress }),
  clearCache: async () => {
    if (globalThis.caches !== undefined) await globalThis.caches.delete(FLY_BRAIN_CACHE_NAME);
  },
};

function defaultDeps(): FlyBrainDeps {
  return DEFAULT_DEPS;
}

/** Enabling tribunal is blocked until its immutable brain artifact is ready. */
export function requiresCachedFlyBrain(enabled: boolean, hasCachedBrain: boolean): boolean {
  return enabled && !hasCachedBrain;
}

export function useFlyBrain(): {
  state: FlyBrainState;
  pct: number | null;
  receivedMb: number | null;
  totalMb: number | null;
  manifest: FlyBrainManifest | null;
  error: string | null;
  download: () => void;
  remove: () => void;
} {
  const deps = depsOverride ?? defaultDeps();
  const [state, setState] = useState<FlyBrainState>("idle");
  const [pct, setPct] = useState<number | null>(null);
  const [receivedMb, setReceivedMb] = useState<number | null>(null);
  const [totalMb, setTotalMb] = useState<number | null>(null);
  const [manifest, setManifest] = useState<FlyBrainManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyResult = useCallback((result: FlyBrainLoadState): void => {
    if (result.status === "ready") {
      setState("ready");
      setManifest(result.manifest);
      setError(null);
      setPct(null);
      return;
    }
    if (result.status === "error") {
      setState("error");
      setError(result.error);
      return;
    }
    setState("idle");
    setManifest(null);
  }, []);

  useEffect(() => {
    let live = true;
    void deps.loadCached().then((result) => {
      if (live) applyResult(result);
    });
    return () => { live = false; };
  }, [deps, applyResult]);

  const download = useCallback((): void => {
    setState("downloading");
    setError(null);
    setPct(0);
    setReceivedMb(0);
    setTotalMb(null);
    void deps.download((progress) => {
      setPct(progress.progress);
      setReceivedMb(Math.round(progress.receivedBytes / 1048576));
      setTotalMb(progress.totalBytes === null ? null : Math.round(progress.totalBytes / 1048576));
    }).then(applyResult);
  }, [deps, applyResult]);

  const remove = useCallback((): void => {
    void deps.clearCache().then(() => {
      setState("idle");
      setManifest(null);
      setError(null);
      setPct(null);
      setReceivedMb(null);
      setTotalMb(null);
    }).catch((cause: unknown) => {
      setState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [deps]);

  return { state, pct, receivedMb, totalMb, manifest, error, download, remove };
}

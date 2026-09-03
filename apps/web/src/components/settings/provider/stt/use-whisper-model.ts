/**
 * Whisper model download hook (audit P5) — a VERBATIM STRUCTURAL CLONE of
 * `use-kokoro-model.ts` (the TTS reference), trimmed to the whisper seams.
 *
 * First browser-tier use pulls the ONNX weights (~42–250 MB by roster
 * entry) from huggingface.co via transformers.js. Hiding that inside the
 * dictation button reads as a hang ("жму и висит"); this hook fronts it as
 * a deliberate panel action with live progress: per-file transformers
 * progress events aggregate into an overall loaded/total byte counter.
 *
 * Shares the app-wide WhisperSttClient singleton (one worker, one download)
 * with the dictation lane — a download started here is JOINED (never
 * duplicated) by a dictation press mid-download (ensureSharedWhisperModel:
 * same-model loads share one promise, a different model chains after).
 * The client's stall watchdog (30s silence → typed error) is the failure
 * surface; this hook only renders it. The deps seam injects a fake client
 * so tests never spawn a Worker.
 *
 * Named deviations from the kokoro twin (pre-approved, audit-scoped):
 * no webgpuAvailable gate, no gpu→cpu fallback notice (kokoro-only seams —
 * whisper always runs wasm/q8), no auto-preview effect (whisper has no
 * preview lane). Load targets are roster model ids (string), not variants.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ensureSharedWhisperModel,
  getSharedWhisperClient,
} from "../../../../lib/stt/whisper-client-instance.js";

export type WhisperModelState = "idle" | "downloading" | "ready" | "error";

/** The subset of the client this hook needs (tests fake exactly this). */
export interface WhisperModelClient {
  isLoaded(): boolean;
  onLoadProgress(listener: (progress: { data: unknown }) => void): () => void;
}

export interface WhisperModelDeps {
  client: WhisperModelClient;
  /** Load the roster model into the shared singleton (Download/Switch). */
  loadModel: (modelId: string) => Promise<void>;
  /** Which roster model the shared client currently holds (null = none). */
  activeModel: () => string | null;
}

let depsOverride: WhisperModelDeps | null = null;

/** Test seam: inject fakes. Pass null to restore the shared singletons. */
export function __setWhisperModelDepsForTests(deps: WhisperModelDeps | null): void {
  depsOverride = deps;
}

function defaultDeps(): WhisperModelDeps {
  return {
    client: getSharedWhisperClient(),
    loadModel: (modelId) => ensureSharedWhisperModel(modelId).then(() => undefined),
    activeModel: () => getSharedWhisperClient().getLoadedModelId(),
  };
}

/** transformers.js per-file progress payload shape, narrowed from unknown. */
interface FileProgress {
  file: string;
  loaded: number;
  total: number;
}

function parseFileProgress(data: unknown): FileProgress | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("file" in data) || !("loaded" in data) || !("total" in data)) return null;
  const { file, loaded, total } = data;
  if (typeof file !== "string" || typeof loaded !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return null;
  return { file, loaded: Math.min(loaded, total), total };
}

export function useWhisperModel(): {
  state: WhisperModelState;
  /** Overall percent 0-100 while downloading; null otherwise. */
  pct: number | null;
  loadedMb: number | null;
  totalMb: number | null;
  error: string | null;
  /** Load the roster model into the shared singleton (Download/Switch). */
  download(modelId: string): void;
  /** Roster model currently loaded in the shared client (null = none yet). */
  activeModel: string | null;
} {
  const deps = depsOverride ?? defaultDeps();
  const [state, setState] = useState<WhisperModelState>(() => (deps.client.isLoaded() ? "ready" : "idle"));
  const [pct, setPct] = useState<number | null>(null);
  const [loadedMb, setLoadedMb] = useState<number | null>(null);
  const [totalMb, setTotalMb] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(() => deps.activeModel());
  const filesRef = useRef(new Map<string, FileProgress>());

  const runLoad = useCallback(
    (load: Promise<void>): void => {
      setError(null);
      setState("downloading");
      filesRef.current.clear();
      load
        .then(() => {
          setPct(null);
          setActiveModel(deps.activeModel());
          setState("ready");
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setState("error");
        });
    },
    [deps],
  );

  const download = useCallback(
    (modelId: string): void => {
      runLoad(deps.loadModel(modelId));
    },
    [deps, runLoad],
  );

  // Live aggregate: subscribe for the hook's lifetime (progress events also
  // arrive from loads started elsewhere — a dictation press — keeping this
  // panel honest about a download already in flight).
  useEffect(() => {
    const unsubscribe = deps.client.onLoadProgress((progress) => {
      const file = parseFileProgress(progress.data);
      if (file === null) return;
      filesRef.current.set(file.file, file);
      let loaded = 0;
      let total = 0;
      for (const entry of filesRef.current.values()) {
        loaded += entry.loaded;
        total += entry.total;
      }
      if (total > 0) {
        setLoadedMb(Math.round(loaded / 1048576));
        setTotalMb(Math.round(total / 1048576));
        setPct(Math.min(100, Math.floor((loaded / total) * 100)));
      }
    });
    return unsubscribe;
  }, [deps]);

  return { state, pct, loadedMb, totalMb, error, download, activeModel };
}

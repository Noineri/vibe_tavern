/**
 * Kokoro model download hook — the explicit "Скачать модель" action plus the
 * variant picker state (owner decision 2026-08-28: gpu = full model/WebGPU,
 * cpu = lightweight/wasm; see kokoro-load-options.ts).
 *
 * First kokoro use pulls the ONNX model (~90–310 MB depending on variant)
 * from huggingface.co via transformers.js. Hiding that inside the preview
 * button read as a hang ("нажимаю и генерация виснет"); this hook fronts it
 * as a deliberate action with live progress: per-file transformers progress
 * events are aggregated into an overall loaded/total byte counter.
 *
 * Shares the app-wide KokoroTtsClient singleton (one worker, one download)
 * with the preview and narration lanes — clicking Download here and then
 * Preview just joins the same load promise. The client's stall watchdog
 * (30s silence → typed error) is the failure surface; this hook only renders
 * it. Deps seam injects a fake client/engine so tests never spawn a Worker.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  consumeKokoroFallbackNotice,
  getActiveKokoroVariant,
  getSharedKokoroClient,
  loadSharedKokoroModel,
} from "../../../../lib/tts/kokoro/kokoro-client-instance.js";
import { detectWebGpu, type KokoroModelVariant } from "../../../../lib/tts/kokoro/kokoro-load-options.js";

export type KokoroModelState = "idle" | "downloading" | "ready" | "error";

/** The subset of the client this hook needs (tests fake exactly this). */
export interface KokoroModelClient {
  isLoaded(): boolean;
  onLoadProgress(listener: (progress: { data: unknown }) => void): () => void;
}

export interface KokoroModelDeps {
  client: KokoroModelClient;
  /** Persist the user's choice and (re)load that variant (Download/Switch). */
  loadModel: (variant: KokoroModelVariant) => Promise<void>;
  /** Which variant the shared client currently has loaded (null = none). */
  activeVariant: () => KokoroModelVariant | null;
  /** One-shot gpu→cpu fallback explanation (null when none). */
  consumeFallbackNotice: () => string | null;
  /** WebGPU availability — hides/disable the gpu card when false. */
  webgpuAvailable: boolean;
}

let depsOverride: KokoroModelDeps | null = null;

/** Test seam: inject fakes. Pass null to restore the shared singletons. */
export function __setKokoroModelDepsForTests(deps: KokoroModelDeps | null): void {
  depsOverride = deps;
}

function defaultDeps(): KokoroModelDeps {
  return {
    client: getSharedKokoroClient(),
    loadModel: (variant) => loadSharedKokoroModel(variant).then(() => undefined),
    activeVariant: getActiveKokoroVariant,
    consumeFallbackNotice: consumeKokoroFallbackNotice,
    webgpuAvailable: detectWebGpu(),
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

export function useKokoroModel(): {
  state: KokoroModelState;
  /** Overall percent 0-100 while downloading; null otherwise. */
  pct: number | null;
  loadedMb: number | null;
  totalMb: number | null;
  error: string | null;
  /** Persist the choice and load that variant (Download/Switch actions). */
  download(variant: KokoroModelVariant): void;
  /** Variant currently loaded in the shared client (null = none yet). */
  activeVariant: KokoroModelVariant | null;
  /** Whether the gpu variant is even offerable in this browser. */
  webgpuAvailable: boolean;
  /** Set right after a load that had to fall back gpu→cpu (the reason). */
  fallbackNotice: string | null;
} {
  const deps = depsOverride ?? defaultDeps();
  const [state, setState] = useState<KokoroModelState>(() => (deps.client.isLoaded() ? "ready" : "idle"));
  const [pct, setPct] = useState<number | null>(null);
  const [loadedMb, setLoadedMb] = useState<number | null>(null);
  const [totalMb, setTotalMb] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeVariant, setActiveVariant] = useState<KokoroModelVariant | null>(() => deps.activeVariant());
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const filesRef = useRef(new Map<string, FileProgress>());

  const runLoad = useCallback(
    (load: Promise<void>): void => {
      setError(null);
      setFallbackNotice(null);
      setState("downloading");
      filesRef.current.clear();
      load
        .then(() => {
          setPct(null);
          setActiveVariant(deps.activeVariant());
          setFallbackNotice(deps.consumeFallbackNotice());
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
    (variant: KokoroModelVariant): void => {
      runLoad(deps.loadModel(variant));
    },
    [deps, runLoad],
  );

  // Live aggregate: subscribe for the hook's lifetime (progress events also
  // arrive from loads started elsewhere — preview/narration — keeping this
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

  return { state, pct, loadedMb, totalMb, error, download, activeVariant, webgpuAvailable: deps.webgpuAvailable, fallbackNotice };
}

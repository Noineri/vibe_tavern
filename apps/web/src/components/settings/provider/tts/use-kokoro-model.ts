/**
 * Kokoro model download hook — the explicit "Скачать модель" action.
 *
 * First kokoro use pulls the ONNX model (~100 MB across files) from
 * huggingface.co via transformers.js. Hiding that inside the preview button
 * read as a hang ("нажимаю и генерация виснет"); this hook fronts it as a
 * deliberate action with live progress: per-file transformers progress events
 * are aggregated into an overall loaded/total byte counter.
 *
 * Shares the app-wide KokoroTtsClient singleton (one worker, one download)
 * with the preview and narration lanes — clicking Download here and then
 * Preview just joins the same load promise. The client's stall watchdog
 * (30s silence → typed error) is the failure surface; this hook only renders
 * it. Deps seam injects a fake client so tests never spawn a real Worker.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getSharedKokoroClient } from "../../../../lib/tts/kokoro/kokoro-client-instance.js";
import type { KokoroTtsClient } from "../../../../lib/tts/kokoro/kokoro-client.js";

export type KokoroModelState = "idle" | "downloading" | "ready" | "error";

/** The subset of the client this hook needs (tests fake exactly this). */
export interface KokoroModelClient {
  isLoaded(): boolean;
  load(): Promise<void>;
  onLoadProgress(listener: (progress: { data: unknown }) => void): () => void;
}

export interface KokoroModelDeps {
  client: KokoroModelClient;
}

let depsOverride: KokoroModelDeps | null = null;

/** Test seam: inject a fake client. Pass null to restore the shared singleton. */
export function __setKokoroModelDepsForTests(deps: KokoroModelDeps | null): void {
  depsOverride = deps;
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
  download(): void;
} {
  const deps = depsOverride ?? { client: getSharedKokoroClient() };
  const [state, setState] = useState<KokoroModelState>(() => (deps.client.isLoaded() ? "ready" : "idle"));
  const [pct, setPct] = useState<number | null>(null);
  const [loadedMb, setLoadedMb] = useState<number | null>(null);
  const [totalMb, setTotalMb] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filesRef = useRef(new Map<string, FileProgress>());

  const download = useCallback((): void => {
    setError(null);
    setState("downloading");
    filesRef.current.clear();
    deps.client
      .load()
      .then(() => {
        setPct(null);
        setState("ready");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setState("error");
      });
  }, [deps.client]);

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
  }, [deps.client]);

  return { state, pct, loadedMb, totalMb, error, download };
}

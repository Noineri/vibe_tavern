/**
 * Docker availability status for the TTS "Local server" panel (D8): one
 * server-side probe on mount, honest states only — no retries, no polling.
 * The panel renders non-docker quickstart variants regardless, so a failed
 * probe is information, not a blocker.
 */

import { useEffect, useState } from "react";

import { fetchLocalDockerStatus } from "../../../../api/tts-api.js";

export interface DockerStatusDeps {
  fetchStatus: typeof fetchLocalDockerStatus;
}

let depsOverride: DockerStatusDeps | null = null;

export function __setDockerStatusDepsForTests(deps: DockerStatusDeps | null): void {
  depsOverride = deps;
}

export interface DockerStatusState {
  /** null = probing; {available:false,version:null} = not found. */
  status: { available: boolean; version: string | null } | null;
  /** Transport-level failure (route unreachable) — shown as "unknown". */
  error: string | null;
}

export function useDockerStatus(): DockerStatusState {
  const [status, setStatus] = useState<{ available: boolean; version: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetcher = depsOverride?.fetchStatus ?? fetchLocalDockerStatus;
    fetcher()
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, error };
}

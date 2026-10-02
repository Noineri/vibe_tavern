import { useEffect, useState } from "react";

import { fetchImageGenProgress } from "../api/image-gen-api.js";
import type { ImageGenProgressInfoValue } from "@vibe-tavern/api-contracts";

/**
 * Poll a local run's live progress snapshot (IMAGE_GENERATION_PLAN PG-2):
 * one immediate fetch on activation, then a fixed-interval tick. Polls ONLY
 * while `active` — the A1111 `/sdapi/v1/progress` endpoint is
 * global-per-instance, so it is read exclusively while OUR own generate
 * request is outstanding (the polish report's cross-talk constraint);
 * outside a run nothing is ever requested.
 *
 * A failed tick is not a terminal state (a poll cadence must survive one
 * dead request): the last good snapshot stays on screen, the next tick
 * retries. Deactivation clears the snapshot and aborts the in-flight poll.
 *
 * `intervalMs` is injectable so tests run a fast cadence without touching
 * real time budgets.
 */
export function useImageGenProgress(
  active: boolean,
  profileId: string | null,
  intervalMs = 1500,
): ImageGenProgressInfoValue | null {
  const [snapshot, setSnapshot] = useState<ImageGenProgressInfoValue | null>(null);

  useEffect(() => {
    if (!active || profileId === null) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const tick = () => {
      void fetchImageGenProgress(profileId, controller.signal)
        .then((value) => {
          if (!cancelled && value !== null) setSnapshot(value);
        })
        .catch(() => {
          // Deliberately swallowed: one failed tick must not kill the poll
          // loop nor surface over the running UI — the next tick retries
          // and the run's own settle clears the row.
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      setSnapshot(null);
    };
  }, [active, profileId, intervalMs]);

  return snapshot;
}

/**
 * Timer-effect resync (INTERACTIVE_ENGINE_EXPANSION, fix step 2d).
 *
 * Host-fired ticks land on the server with no frontend involvement — the
 * spike for this step proved the existing resync paths insufficient for an
 * idle open surface (they fire on mount, action submit, effect run, and tab
 * visibility change only, so a tick applied while the user watches and does
 * nothing would never appear). This hook adds the minimal missing machinery:
 * while the surface is active AND the scope has at least one pending/running
 * timer effect, rehydrate the scope on a slow interval. It self-disarms the
 * moment no live timer remains — sessions without timers pay nothing, and the
 * poll stops as soon as the last timer reaches a terminal state.
 *
 * AC-3 (ASYNC_FLAVOR_CHATTER_PLAN): the same poll also serves async flavor
 * chatter — a chatter-marked flavor resolves out-of-band (fire-and-forget
 * model call whose result lands in the NEXT projected view), so an idle
 * surface would otherwise never see the resolved line. The gate extends to
 * `view.flavor.status === "pending"` with the same cadence and the same
 * self-disarm; a static or terminal flavor keeps the surface idle.
 */
import { useEffect } from "react";
import { EXPERIENCE_EFFECT_KIND, EXPERIENCE_EFFECT_STATUS } from "@vibe-tavern/domain";
import type { ExperienceEffectRow } from "@vibe-tavern/db";
import type { ExperienceChatterViewDto } from "@vibe-tavern/api-contracts";

import { useExperienceStore } from "../stores/experience-store.js";

/** Production poll cadence. Slow on purpose: ticks are game-paced (seconds+),
 *  not animation-paced, and each poll is a full scope rehydrate. */
export const TIMER_RESYNC_INTERVAL_MS = 2000;

/** Type guard for the host-normalized chatter view (AC-1 contract) riding in
 *  `view.flavor`. A plain object without `status` is static flavor — never a
 *  poll trigger. */
function isPendingChatter(flavor: unknown): flavor is ExperienceChatterViewDto {
  return (
    typeof flavor === "object" &&
    flavor !== null &&
    (flavor as Record<string, unknown>).status === "pending"
  );
}

export function useExperienceTimerResync(opts: {
  chatId: string | null;
  branchId: string | null;
  effects: ExperienceEffectRow[];
  active: boolean;
  /** The freshest projected view for the scope (AC-3: chatter-pending gate).
   *  Optional so pre-AC-3 callers and tests keep compiling. */
  view?: { flavor?: unknown } | null;
  /** Test seam: poll cadence override. */
  intervalMs?: number;
}): void {
  const { chatId, branchId, effects, active, view, intervalMs } = opts;
  const hasLiveTimer = effects.some(
    (e) =>
      e.kind === EXPERIENCE_EFFECT_KIND.timer &&
      (e.status === EXPERIENCE_EFFECT_STATUS.pending || e.status === EXPERIENCE_EFFECT_STATUS.running),
  );
  const hasPendingChatter = isPendingChatter(view?.flavor);
  const cadence = intervalMs ?? TIMER_RESYNC_INTERVAL_MS;
  useEffect(() => {
    if (!active || (!hasLiveTimer && !hasPendingChatter) || chatId === null || branchId === null) return;
    const interval = setInterval(() => {
      const state = useExperienceStore.getState();
      void state.rehydrate(chatId, branchId);
    }, cadence);
    return () => clearInterval(interval);
  }, [active, hasLiveTimer, hasPendingChatter, chatId, branchId, cadence]);
}

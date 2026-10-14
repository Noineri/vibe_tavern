import type { AgentReviewSnapshot as WireAgentReviewSnapshot, ReviewOutcome, ReviewTargetRecord } from "@vibe-tavern/api-contracts";

export type ExperienceReviewTarget = "rules" | "visual";

export interface ExperienceReviewTargetInput {
  target: ExperienceReviewTarget;
  base: string;
  proposed: string;
  offeredHunkIds: readonly number[];
  acceptedHunkIds: ReadonlySet<number>;
  dismissedHunkIds: ReadonlySet<number>;
  /** Only ids whose local buffer change completed successfully count applied. */
  appliedHunkIds?: ReadonlySet<number>;
  cancelled?: boolean;
}

/** Browser-safe, deterministic FNV-1a identifier for review content. */
export function experienceReviewRoundId(base: string, proposed: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${base}\u0000${proposed}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Builds the compact wire snapshot without carrying either review document.
 * Overlapping decisions are rejected deliberately: an id cannot safely claim
 * both local application and dismissal.
 */
export function buildExperienceCopilotReviewSnapshot(
  targets: readonly ExperienceReviewTargetInput[],
): WireAgentReviewSnapshot {
  return { targets: targets.map(buildTarget) };
}

function buildTarget(input: ExperienceReviewTargetInput): ReviewTargetRecord {
  const accepted = new Set(input.acceptedHunkIds);
  const dismissed = new Set(input.dismissedHunkIds);
  const applied = input.appliedHunkIds ?? new Set<number>();
  let acceptedCount = 0;
  let rejected = 0;
  let pending = 0;
  let appliedCount = 0;

  for (const id of input.offeredHunkIds) {
    if (accepted.has(id) && dismissed.has(id)) {
      rejected++;
      continue;
    }
    if (dismissed.has(id)) {
      rejected++;
      continue;
    }
    if (accepted.has(id)) {
      acceptedCount++;
      if (applied.has(id)) appliedCount++;
      else pending++;
      continue;
    }
    pending++;
  }

  const outcome: ReviewOutcome = input.cancelled
    ? "cancelled"
    : appliedCount === 0
      ? rejected > 0 && pending === 0 ? "rejected" : "awaiting"
      : pending === 0 ? "applied" : "applied-partial";

  return {
    target: input.target,
    roundId: experienceReviewRoundId(input.base, input.proposed),
    outcome,
    hunks: { accepted: appliedCount, rejected, pending },
  };
}

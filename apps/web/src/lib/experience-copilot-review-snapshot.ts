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

/** Browser-safe deterministic content identifier over every UTF-16 code unit. */
export function experienceReviewRoundId(base: string, proposed: string): string {
  const input = `${base}\u0000${proposed}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${(second >>> 16).toString(16).padStart(4, "0")}`;
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
    : pending === 0 && rejected === 0 ? "applied" : "applied-partial";

  return {
    target: input.target,
    roundId: experienceReviewRoundId(input.base, input.proposed),
    outcome,
    hunks: { accepted: appliedCount, rejected, pending },
  };
}

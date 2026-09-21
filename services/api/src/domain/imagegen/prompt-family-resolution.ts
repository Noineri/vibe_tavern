import { IMAGE_PROMPT_DEFAULT_FAMILY, type ImagePromptFamilyId } from "@vibe-tavern/domain";

/** The profile's family-state columns the resolution reads (an
 *  `ImageGenProfile` subset — callers pass the real profile row). */
export interface ImageGenPromptFamilyState {
  /** The manual pin — authoritative when present. */
  familyOverride?: ImagePromptFamilyId;
  /** The last auto-detection result. */
  familyDetected?: ImagePromptFamilyId;
  /** The model id the detection ran against (the stale marker). */
  familyDetectedForModel?: string;
}

/** How the winning family was chosen. */
export type ImageGenPromptFamilySource = "manual" | "auto" | "default";

export interface ResolvedImageGenPromptFamily {
  family: ImagePromptFamilyId;
  source: ImageGenPromptFamilySource;
}

/**
 * The generation-time family resolution chain (IPT Wave 2, the plan's
 * assembly rule):
 *
 * 1. `familyOverride` — the manual pin, authoritative.
 * 2. `familyDetected` — the auto result, fresh ONLY when the model it ran
 *    against (`familyDetectedForModel`) equals the model ACTUALLY
 *    generating (`effectiveModelId`, the adapter's `overrides.model ??
 *    profile.modelId`); a model swap marks the detection stale.
 * 3. The universal default family (prose).
 *
 * Pure on purpose (T0): the same function backs generation, the Wave 3
 * family API's source labels, and the pane's read model.
 */
export function resolveImageGenPromptFamily(
  state: ImageGenPromptFamilyState,
  effectiveModelId: string | undefined,
): ResolvedImageGenPromptFamily {
  if (state.familyOverride !== undefined) {
    return { family: state.familyOverride, source: "manual" };
  }
  if (
    state.familyDetected !== undefined &&
    state.familyDetectedForModel !== undefined &&
    state.familyDetectedForModel !== "" &&
    effectiveModelId !== undefined &&
    effectiveModelId !== "" &&
    state.familyDetectedForModel === effectiveModelId
  ) {
    return { family: state.familyDetected, source: "auto" };
  }
  return { family: IMAGE_PROMPT_DEFAULT_FAMILY, source: "default" };
}

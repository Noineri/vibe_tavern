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
export type ImageGenPromptFamilySource = "manual" | "auto" | "backend-default" | "default";

export interface ResolvedImageGenPromptFamily {
  family: ImagePromptFamilyId;
  source: ImageGenPromptFamilySource;
}

/**
 * The generation-time family resolution chain (IPT Wave 2, the plan's
 * assembly rule; NAI-6a adds tier 3):
 *
 * 1. `familyOverride` — the manual pin, authoritative.
 * 2. `familyDetected` — the auto result, fresh ONLY when the model it ran
 *    against (`familyDetectedForModel`) equals the model ACTUALLY
 *    generating (`effectiveModelId`, the adapter's `overrides.model ??
 *    profile.modelId`); a model swap marks the detection stale.
 * 3. `backendDefaultFamily` — the backend's own default family
 *    (NOVELAI_PROVIDER_PLAN NAI-6a: NovelAI models prompt in NovelAI's
 *    tag dialect), passed from the STATIC capability table by the caller.
 *    Backends without one skip this tier unchanged.
 * 4. The universal default family (prose).
 *
 * Pure on purpose (T0): the same function backs generation, the Wave 3
 * family API's source labels, and the pane's read model.
 */
export function resolveImageGenPromptFamily(
  state: ImageGenPromptFamilyState,
  effectiveModelId: string | undefined,
  backendDefaultFamily?: ImagePromptFamilyId,
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
  if (backendDefaultFamily !== undefined) {
    return { family: backendDefaultFamily, source: "backend-default" };
  }
  return { family: IMAGE_PROMPT_DEFAULT_FAMILY, source: "default" };
}

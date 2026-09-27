import type { FlyAutoSwipeConfidence, FlySensitivity } from "@vibe-tavern/api-contracts";

/** FT-13 confidence table: flagging stays below the independent auto bar. */
export const FLY_SENSITIVITY_CONFIDENCE: Record<FlySensitivity, number> = {
  soft: 0.25,
  normal: 0.5,
  strict: 0.7,
};

export const FLY_AUTO_SWIPE_CONFIDENCE: Record<FlyAutoSwipeConfidence, number> = {
  normal: 0.75,
  high: 0.85,
  "very-high": 0.95,
};

export function flySensitivityThreshold(sensitivity: FlySensitivity): number {
  return FLY_SENSITIVITY_CONFIDENCE[sensitivity];
}

export function flyAutoSwipeThreshold(confidence: FlyAutoSwipeConfidence): number {
  return FLY_AUTO_SWIPE_CONFIDENCE[confidence];
}

export function flyAutoBarExceedsAllSensitivityBars(): boolean {
  return Math.min(...Object.values(FLY_AUTO_SWIPE_CONFIDENCE)) > Math.max(...Object.values(FLY_SENSITIVITY_CONFIDENCE));
}

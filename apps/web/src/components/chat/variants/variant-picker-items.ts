import type { MessageVariant } from "@vibe-tavern/domain";
import { resolveModelLabel } from "../../../lib/model-resolve.js";
import type { VariantPickerItem } from "./types.js";

type VariantPickerSource = Pick<MessageVariant, "id" | "variantIndex" | "modelId" | "presetName">;

/**
 * Derives the immutable-id picker metadata shared by the swipe browser and
 * queue timeline finished rows.
 */
export function deriveVariantPickerItems(variants: readonly VariantPickerSource[]): VariantPickerItem[] {
  return variants.map((variant) => ({
    variantId: variant.id,
    displayIndex: variant.variantIndex + 1,
    modelLabel: variant.modelId ? resolveModelLabel(variant.modelId) : "",
    presetName: variant.presetName ?? null,
  }));
}

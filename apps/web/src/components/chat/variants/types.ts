/**
 * Shared types for the variant sub-components (chat/variants/). Extracted from
 * MessageBlock.tsx in the god-object audit step 2 — kept here so the carousel /
 * controls / jump components and the MessageBlock main body share one source of
 * truth for the swipe-direction and picker-item shapes.
 */
import type { MessageVariantId } from "@vibe-tavern/domain";

/** Variant swipe direction: -1 = previous, +1 = next. */
export type SwipeDirection = -1 | 1;

/**
 * Picker item for the variant-jump browser (model + preset + immutable id).
 *
 * Populated ONLY when variantCount > 6; below that the MessageBlock main body
 * falls back to EMPTY_PICKER_ITEMS and the counter "N/total" is shown instead
 * of the jump UI.
 *
 * IMMUTABLE-ID CONTRACT (MAE-53 / MESSAGE_AI_EDITOR_PLAN Wave 5):
 *   `variantId` is the canonical `message_variants.id` (single-column PRIMARY
 *   KEY, packages/db/src/db-schema.ts) — NEVER the display index. Stars key on
 *   `variantId` so they survive index recompaction on variant deletion
 *   (pruneStaleStars drops deleted IDs; the star never silently retargets the
 *   variant that now occupies the deleted one's index). `displayIndex` is the
 *   1-based human-readable position reflected in the row label "#N" — derived
 *   from `variantIndex + 1` at the moment the picker items are built, and is
 *   NOT a stable identity.
 */
export type VariantPickerItem = {
  variantId: MessageVariantId;
  /** 1-based display position. Recomputed on each render from variantIndex. */
  displayIndex: number;
  modelLabel: string;
  presetName: string | null;
};

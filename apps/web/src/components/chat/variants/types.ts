/**
 * Shared types for the variant sub-components (chat/variants/). Extracted from
 * MessageBlock.tsx in the god-object audit step 2 — kept here so the carousel /
 * controls / jump components and the MessageBlock main body share one source of
 * truth for the swipe-direction and provenance row shapes.
 */

/** Variant swipe direction: -1 = previous, +1 = next. */
export type SwipeDirection = -1 | 1;

/**
 * Provenance row for the variant-jump dropdown (model + preset). Populated only
 * when variantCount > 6; below that the MessageBlock main body falls back to
 * EMPTY_PROVENANCE and the counter "N/total" is shown instead of the jump UI.
 */
export type VariantProvenance = { modelLabel: string; presetName: string | null };

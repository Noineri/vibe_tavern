import type { UpdateImagePromptProfileRequest } from "@vibe-tavern/api-contracts";

/**
 * The image prompt profile draft contract, shared by the template rows in
 * `ImagePromptTemplatesPane` and the assist row in
 * `image-prompt-assist-row.tsx` (SC-8e split the assist row out when the
 * pane hit its file-size ratchet — one home for the shape both rows ride).
 * A draft is the profile overrides map in pane-local normalized form; the
 * whole-profile save and the dirty compare both run through this module.
 */

/** One draft cell — the pane-local normalized shape (qualityText always
 *  resolved to string | null; absent key = canon). */
export type DraftCell = { body: string; qualityText: string | null };
export type DraftOverrides = Record<string, DraftCell>;

export function normalizeDraftCell(cell: { body: string; qualityText?: string | null }): DraftCell {
  return { body: cell.body, qualityText: cell.qualityText ?? null };
}

export function overridesEqual(a: DraftOverrides, b: DraftOverrides): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if ((left?.body ?? "") !== (right?.body ?? "")) return false;
    if ((left?.qualityText ?? null) !== (right?.qualityText ?? null)) return false;
  }
  return true;
}

/** Save-shape normalization: a blank body means the cell returns to canon
 *  (the cell contract has no blank override — the key is dropped); a blank
 *  quality text clears to canon quality (null). */
export function toWireOverrides(draft: DraftOverrides): UpdateImagePromptProfileRequest["overrides"] {
  const out: NonNullable<UpdateImagePromptProfileRequest["overrides"]> = {};
  for (const [key, cell] of Object.entries(draft)) {
    const body = cell.body.trim();
    if (body === "") continue;
    const quality = cell.qualityText?.trim() ?? "";
    out[key as keyof typeof out] = { body, qualityText: quality === "" ? null : cell.qualityText };
  }
  return out;
}

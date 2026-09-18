/** Comfyui template-marker labels (CG-B1; moved out of ImageGenPane for
 *  CG-B2 so the chat fine-tuning chip renders the same «Detected» readout
 *  as the providers pane — one mapping, two surfaces). */

import type { TFunc } from "../../i18n/locale-helpers.js";

/** The two comfyui template markers → display labels. A marker string
 *  outside this map (a future dialect revision) renders verbatim — label
 *  mapping, not a data list (the live lists rule bans DATA lists, not i18n
 *  maps over known enum values). */
export const TEMPLATE_LABEL_KEYS: Record<string, Parameters<TFunc>[0]> = {
  checkpoint: "image_gen_template_checkpoint",
  "krea2-dit": "image_gen_template_krea2_dit",
};

/** «Detected» label for a template marker — the known map through i18n,
 *  an unknown marker verbatim (a future dialect revision stays readable). */
export function templateDisplayLabel(template: string, t: TFunc): string {
  const key = TEMPLATE_LABEL_KEYS[template];
  return key !== undefined ? t(key) : template;
}

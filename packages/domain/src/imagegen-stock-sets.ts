import type { ImageGenSamplerSetPayload } from "./entities.js";

/**
 * Built-in stock sampler sets (IF-7b, owner-provided matrix 2026-09-22;
 * owner rulings for this file — see reports/IMAGEGEN_FOLLOWUP_REPORT.md).
 *
 * Seeded once as ORDINARY editable rows (owner ruling: editable like any
 * user row — rename/delete allowed; the re-seed guard makes deletes
 * stick). The fixed
 * ids exist for two mechanical reasons only: per-row seed idempotency
 * (crash between rows → the next boot completes the missing ones) and the
 * pane's auto-preselect resolver (find a stock row deterministically even
 * after a rename).
 *
 * Payload values carry NO size (owner ruling: size is the user's call at
 * generation time — the IG-CF14 payload boundary) and NO auto-enabled
 * hires (owner ruling: the user opts in — the block ships configured but
 * disabled; Diffusion strictly wants it configured because diffusion
 * checkpoints do poorly from scratch, owner 2026-09-22).
 *
 * Range midpoints where the owner gave a range instead of a value:
 * Diffusion steps 20–30 → 25, clip skip 1–2 → 2 (the SD1.5/anime lore
 * default — the common failure mode is forgetting it), CFG 4–6 → 5,
 * hires denoising 0.65–0.8 → 0.7. Anima's defaults were given explicitly
 * (steps 30, CFG 5, scale 1.5 cap, denoise 0.35, R-ESRGAN 4x+ Anime6B).
 *
 * Sampler/scheduler dialect note: stock rows store names in the dialect
 * their target family actually runs (Krea/Anima → comfy lowercase ids;
 * Diffusion → the A1111 display name). The per-dialect alias map and
 * apply-time validation against the LIVE lists is IF-7(c) — applying a
 * stock set on the "wrong" dialect waits for that alias map.
 */
export const IMAGE_GEN_STOCK_SAMPLER_SET_IDS = {
  krea2Turbo: "igset_stock_krea2_turbo",
  krea2Raw: "igset_stock_krea2_raw",
  anima: "igset_stock_anima",
  diffusion: "igset_stock_diffusion",
} as const;

export type ImageGenStockSamplerSetId =
  (typeof IMAGE_GEN_STOCK_SAMPLER_SET_IDS)[keyof typeof IMAGE_GEN_STOCK_SAMPLER_SET_IDS];

/** The stock rows to seed (IF-7b) — id + name + payload, deterministic. */
export function imageGenStockSamplerSets(): Array<{
  id: ImageGenStockSamplerSetId;
  name: string;
  payload: ImageGenSamplerSetPayload;
}> {
  return [
    {
      id: IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Turbo,
      name: "Krea 2 Turbo",
      payload: { sampler: "euler", scheduler: "simple", steps: 8, cfgScale: 1, adetailer: false },
    },
    {
      id: IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Raw,
      name: "Krea 2 RAW",
      payload: { sampler: "euler", scheduler: "simple", steps: 50, cfgScale: 3.5, adetailer: false },
    },
    {
      id: IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima,
      name: "Anima",
      // Euler SDE (owner-confirmed), 1024×1536-class checkpoint lore:
      // steps 25–35 → 30, CFG 4–6 → 5; hires CONFIGURED, opt-in only, hard
      // scale cap 1.5 (checkpoint creator's "do NOT go over 1.5x"). The
      // creator's recommended upscaler is deliberately NOT named here
      // (owner ruling 2026-09-27: no hardcoded upscaler names) — its name
      // is dialect vocabulary (an A1111 label, a Comfy upscale_models
      // FILE), so unset lets each dialect fill its own default; the
      // numeric recommendations are dialect-neutral and stay.
      payload: {
        sampler: "euler_sde",
        scheduler: "simple",
        steps: 30,
        cfgScale: 5,
        adetailer: false,
        hires: {
          enabled: false,
          scale: 1.5,
          denoisingStrength: 0.35,
        },
      },
    },
    {
      id: IMAGE_GEN_STOCK_SAMPLER_SET_IDS.diffusion,
      name: "Diffusion",
      // Generic diffusion (SD1.5/SDXL class): Euler a, midpoint knobs, and
      // the strictly-wanted-but-off hires block (owner: configure, never
      // auto-enable). Upscaler/scale stay unset — the dialect's own server
      // defaults fill them; the stock row carries opinions the owner gave.
      // The face-fix block rides EVERY stock set (owner ruling 2026-09-27):
      // configured, opt-in only; the detector model stays unset — the
      // dialect's own default fills it (no hardcoded names).
      payload: {
        sampler: "Euler a",
        steps: 25,
        clipSkip: 2,
        cfgScale: 5,
        adetailer: false,
        hires: { enabled: false, denoisingStrength: 0.7 },
      },
    },
  ];
}

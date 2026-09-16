/** Free-size image dimension vocabulary (IG-CF14): the stepper ladder
 *  constant, sanity bounds, the display default, and the preset table the
 *  per-mode dropdown offers. Pure data, no I/O — the pane renders it; the
 *  stored `modeSizePresets` stays a raw W/H bag and never sees these.
 *
 *  Ladder rule (owner 2026-09-16, example: 720 → up 848 / down 592): the
 *  grid every SD-family resolution lives on is multiples of 16; ONE stepper
 *  click walks ±IMAGE_SIZE_STEP_PX (8 grid notches — a click must move an
 *  image side by a sensible amount, ±16 is noise). Raw typing is never
 *  snapped: 733 stays 733; only the bounds below clamp it.
 *
 *  Preset labels are built as «purpose + ratio + concrete resolution» —
 *  NEVER a bare ratio (owner: «не писать сырое соотношение без отображения
 *  разрешения»): the ratio string is approximate community shorthand (the
 *  canonical SDXL buckets), the exact pixels beside it are the truth. */
export const IMAGE_SIZE_STEP_PX = 128;
export const IMAGE_SIZE_MIN_PX = 64;
export const IMAGE_SIZE_MAX_PX = 4096;

/** What an UNSET (auto) row displays so the steppers always have an
 *  anchor — the SDXL native square. Display-only: an untouched row still
 *  stores nothing (the backend default stays in effect until the user
 *  edits, steps, swaps, or picks a preset). */
export const IMAGE_SIZE_DEFAULT = { width: 1024, height: 1024 } as const;

/** Canonical SDXL buckets (~1MP budget) — the community-standard ratio
 *  table; three shapes × portrait/landscape orientations. */
export const IMAGE_SIZE_PRESETS = [
  { width: 1024, height: 1024, ratio: "1:1", orientation: "square" },
  { width: 896, height: 1152, ratio: "3:4", orientation: "portrait" },
  { width: 832, height: 1216, ratio: "2:3", orientation: "portrait" },
  { width: 768, height: 1344, ratio: "9:16", orientation: "portrait" },
  { width: 1152, height: 896, ratio: "4:3", orientation: "landscape" },
  { width: 1216, height: 832, ratio: "3:2", orientation: "landscape" },
  { width: 1344, height: 768, ratio: "16:9", orientation: "landscape" },
] as const;

export type ImageSizeOrientation = (typeof IMAGE_SIZE_PRESETS)[number]["orientation"];

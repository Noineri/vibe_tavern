import type { CSSProperties } from "react";

/**
 * Crop data stored in avatarCropJson — percentages from react-easy-crop.
 */
export interface AvatarCropData {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Returns CSS `objectPosition` derived from crop center.
 * Use with `objectFit: "cover"` on an `<img>` inside a square container.
 * Returns empty object when no crop — caller should use `object-top` fallback.
 */
export function avatarCropStyle(crop: AvatarCropData | string | null | undefined): CSSProperties {
  if (!crop) return {};
  const parsed: AvatarCropData = typeof crop === "string" ? JSON.parse(crop) : crop;
  if (!parsed || parsed.width == null) return {};
  const cx = parsed.x + parsed.width / 2;
  const cy = parsed.y + parsed.height / 2;
  return { objectPosition: `${cx}% ${cy}%` };
}

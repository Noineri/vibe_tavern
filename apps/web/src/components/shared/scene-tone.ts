/**
 * Scene tone semantics — the ONE derivation of the schema color DSL
 * (`tone` on any node, `toneBy` value→tone map on string nodes) into class
 * names. Extracted from SceneStateView.tsx (R7) so the render variants and the
 * Co-Author tracker-template review card consume the SAME token maps — no
 * second hand-written derivation may exist (fork law).
 *
 * Tones reference the app theme's semantic tokens by name ONLY
 * (theme-tuner compatibility — validation rejects raw hex). Every map holds
 * full literal class names so the Tailwind scanner generates them: fills use
 * the solid brand tokens (`bg-*`); soft rules reuse the established `/40`
 * alpha shape the HUD already uses (`border-accent/40`).
 */
import type { SceneTone, SceneTrackerSchemaNode } from "@vibe-tavern/domain";

export const SCENE_TONE_TEXT: Record<SceneTone, string> = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export const SCENE_TONE_FILL: Record<SceneTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export const SCENE_TONE_BORDER: Record<SceneTone, string> = {
  accent: "border-accent",
  success: "border-success",
  warning: "border-warning",
  danger: "border-danger",
};

export const SCENE_TONE_FILL_SOFT: Record<SceneTone, string> = {
  accent: "bg-accent/40",
  success: "bg-success/40",
  warning: "bg-warning/40",
  danger: "bg-danger/40",
};

export const SCENE_TONE_BORDER_SOFT: Record<SceneTone, string> = {
  accent: "border-accent/40",
  success: "border-success/40",
  warning: "border-warning/40",
  danger: "border-danger/40",
};

/**
 * Resolve the display tone for a schema node + its current value. For STRING
 * nodes a `toneBy` entry matching the CURRENT value wins (the value-specific
 * signal); otherwise the node's own `tone` applies; absent both → neutral
 * (undefined — render exactly as today). Non-string nodes resolve `tone` only.
 */
export function resolveSceneTone(node: SceneTrackerSchemaNode, value: unknown): SceneTone | undefined {
  if (node.$type === "string" && typeof value === "string") {
    const mapped = node.toneBy?.[value];
    if (mapped !== undefined) return mapped;
  }
  return node.tone;
}

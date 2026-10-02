/**
 * One-line section summaries for the fine-tuning chip's collapsible sections
 * (IMAGEGEN_CHIP_REDESIGN_PLAN ICR-2): pure string builders taking VALUES +
 * `t` — no React, no stores. The values are the EFFECTIVE DISPLAY values the
 * fields show (the same anchors: an unset field contributes its display
 * anchor, not a bare default constant), so a summary never disagrees with
 * what the opened section's controls say.
 *
 * User data (model/detector ids, scales) truncates in the header (the shell's
 * `truncate` summary span); the full value stays reachable by expanding the
 * section. Plural keys ride i18next's `count` resolution (the
 * `image_gen_loras_enabled{,_one,_few,_many,_other}` repo pattern).
 */

import type { TFunc } from "../../i18n/context.js";

/** The chip-draft hires block, trimmed to the summary's needs (structural —
 *  the full schema type is not a dependency of this leaf module). */
export interface HiresSummaryBlock {
  enabled: boolean;
  steps?: number;
  scale?: number;
}

/** The display anchors the section's sliders show for unset fields (the
 *  server's own defaults — pass `buildHiresControl(...).sliders[i]`
 *  `.displayAnchor`, never a hardcoded number). */
export interface HiresSummaryAnchors {
  steps: number;
  scale: number;
}

/** LoRA: «Включено: 1» when any are enabled, else «не выбраны». */
export function lorasSummary(enabledCount: number, t: TFunc): string {
  if (enabledCount > 0) return t("image_gen_loras_enabled", { count: enabledCount });
  return t("image_gen_chip_loras_none");
}

/** Hires: off → «выкл»; on → «×1.5 · шагов: 20» (steps/scale display
 *  anchors for unset fields — the same values the sliders show). */
export function hiresSummary(block: HiresSummaryBlock, anchors: HiresSummaryAnchors, t: TFunc): string {
  if (!block.enabled) return t("image_gen_chip_section_off");
  const steps = block.steps ?? anchors.steps;
  const scale = block.scale ?? anchors.scale;
  return t("image_gen_chip_hires_summary", { count: steps, scale });
}

/** ADetailer: off → «выкл»; on → «face_yolov8m.pt · шагов: 12» (model = the
 *  dropdown's display value — the stored pick or the control's fallback). */
export function adetailerSummary(enabled: boolean, model: string, steps: number, t: TFunc): string {
  if (!enabled) return t("image_gen_chip_section_off");
  return t("image_gen_chip_adetailer_summary", { model, count: steps });
}

/** The parts of the samplers summary. A property PRESENT with `undefined`
 *  means the control is rendered but unset → «Авто»; a property ABSENT means
 *  the control is not rendered for this backend → the part is omitted
 *  (checked via `Object.hasOwn`, so callers spread-render optional parts:
 *  `...(control ? { sampler: overlay.sampler } : {})`). */
export interface SamplerSummaryParts {
  sampler?: string;
  scheduler?: string;
  steps?: number;
  cfgScale?: number;
}

/** Samplers: the present parts joined with « · » — «euler · simple ·
 *  шагов: 8 · CFG 1». */
export function samplersSummary(parts: SamplerSummaryParts, t: TFunc): string {
  const chunks: string[] = [];
  if (Object.hasOwn(parts, "sampler")) {
    chunks.push(parts.sampler !== undefined && parts.sampler !== "" ? parts.sampler : t("image_gen_chip_auto"));
  }
  if (Object.hasOwn(parts, "scheduler")) {
    chunks.push(
      parts.scheduler !== undefined && parts.scheduler !== "" ? parts.scheduler : t("image_gen_chip_auto"),
    );
  }
  if (Object.hasOwn(parts, "steps")) {
    chunks.push(t("image_gen_chip_steps_summary", { count: parts.steps ?? 0 }));
  }
  if (Object.hasOwn(parts, "cfgScale")) {
    chunks.push(`CFG ${parts.cfgScale ?? 0}`);
  }
  return chunks.join(" · ");
}

/** Krea 2: the translated creativity option label (the SegmentedControl's
 *  own display value). An unknown value falls back to the raw string. */
export function kreaSummary(
  creativity: string,
  options: ReadonlyArray<{ value: string; labelKey: Parameters<TFunc>[0] }>,
  t: TFunc,
): string {
  const option = options.find((candidate) => candidate.value === creativity);
  return option !== undefined ? t(option.labelKey) : creativity;
}

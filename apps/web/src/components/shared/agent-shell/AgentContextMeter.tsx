/**
 * ExperienceContextMeter (COPILOT_CONTEXT_METER_PLAN, Wave 3 / CM-7) — the thin
 * segmented context-usage line under the copilot session switcher.
 *
 * PRESENTATIONAL + controlled: it owns NO async work and NO context state. The
 * shell owns `useCopilotContext` (fetch/apply/compact/toggle) and passes the
 * resolved values down; this component only renders the track + control cluster
 * and forwards clicks. It reuses the shared `CustomTooltip` (no hand-rolled
 * tooltip) and the shared `Toggle` (no hand-rolled switch) — §9.
 *
 * Segmented fill: system / digest / history against `budgetTokens`, with the
 * response reserve hatched at the tail. Unmetered (no metrics yet, or the
 * profile has no explicit context budget — `budgetTokens === 0`) renders a
 * labelled empty state, never a misleading zero bar. The compact button glows
 * (urgent) at >= 80% and is inert while a turn streams or a compact is already
 * running.
 */

import { cn } from "../../../lib/cn.js";
import type { CSSProperties } from "react";
import { Icons } from "../icons.js";
import { CustomTooltip } from "../Tooltip.js";
import { Toggle } from "../Toggle.js";
import { useT } from "../../../i18n/context.js";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
import type { AgentI18nKey } from "../../../lib/agent-host-registry.js";
import { meterSegments, isMeterUrgent } from "../../../lib/copilot-context.js";

export interface AgentContextMeterProps {
  metrics: ExperienceCopilotContextMetrics | null;
  autoCompact: boolean;
  isCompacting: boolean;
  /** True while a turn streams → the compact button is inert (no mid-stream compact). */
  isSending: boolean;
  onCompact: () => void;
  onToggleAutoCompact: (enabled: boolean) => void;
  /** SC-0j: the host descriptor's `meterSegmentLabels` — existing i18n keys
   *  for the kind-provided `metrics.segments`. Absent (or metrics without
   *  `segments`) = today's fixed-segment rendering, byte-identical. */
  segmentLabels?: Record<string, AgentI18nKey>;
}

/** Reserve zone: a hatched strip drawn with a CSS repeating gradient so it reads
 *  as "reserved, not yet used" without pulling in an SVG. */
const RESERVE_STYLE: CSSProperties = {
  background:
    "repeating-linear-gradient(45deg, var(--border) 0px, var(--border) 2px, transparent 2px, transparent 5px)",
};

/** SC-0j: the kind-provided segments reuse the fixed segments' fill classes in
 *  fixed-segment order (`bg-accent` = system, `bg-accent-dim` = digest,
 *  `bg-s2` = history), cycling when a kind provides more than three — reuse,
 *  not invention (the reserve hatch keeps RESERVE_STYLE at the tail).
 *  SC-13b: the sidechat kind provides FIVE segments, so the cycle extends with
 *  the existing theme colours `bg-info` and `bg-info-dim` — status colours
 *  (success, warning, danger) are excluded: they mean a state, not a part.
 *  Five distinct fills, so every part reads as its own; the fixed
 *  three-segment meter below is unchanged. */
const CUSTOM_SEGMENT_FILL_CLASSES = ["bg-accent", "bg-accent-dim", "bg-s2", "bg-info", "bg-info-dim"];

export function AgentContextMeter({
  metrics,
  autoCompact,
  isCompacting,
  isSending,
  onCompact,
  onToggleAutoCompact,
  segmentLabels,
}: AgentContextMeterProps) {
  const { t } = useT();
  const segments = meterSegments(metrics);
  const urgent = isMeterUrgent(metrics);

  // SC-0j: the kind-provided path renders when `segments` is a non-empty
  // array on metered metrics. An empty array falls back to the fixed
  // rendering (an empty track would read as broken); unmetered metrics fall
  // back to today's unmetered label below. Absent `segments` → the legacy
  // branch, byte-identical.
  const customSegments = metrics?.segments;
  const showCustomSegments =
    segments !== null && customSegments !== undefined && customSegments.length > 0;

  const compactDisabled = isSending || isCompacting;

  // The reserve/total/source rows are shared by both tooltip variants (SC-0j:
  // the single spelling — the custom tooltip differs only in its per-segment
  // rows above this footer).
  const tooltipFooter = metrics ? (
    <>
      <div className="flex items-center justify-between gap-3">
        <span>{t("copilot_context_segment_reserve")}</span>
        <span className="tabular-nums text-[11px]">{metrics.reserveTokens}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
        <span>{t("copilot_context_total")}</span>
        <span className="tabular-nums text-[11px]">{metrics.totalTokens}</span>
      </div>
      <div className="text-[11px] opacity-70">
        {metrics.source === "provider"
          ? t("copilot_context_source_provider")
          : t("copilot_context_source_estimate")}
      </div>
    </>
  ) : null;

  // SC-0j: one row per kind-provided segment, in the kind's array order. A
  // key missing from the host's label map renders RAW (a descriptor wiring
  // bug stays visible and debuggable — never thrown, never hidden).
  const customTooltip =
    showCustomSegments && metrics && customSegments ? (
      <div className="flex flex-col gap-1">
        {customSegments.map((segment, index) => {
          const labelKey = segmentLabels?.[segment.key];
          // SC-13b: each tooltip row carries a small dot in its segment's
          // fill — the row structure is otherwise the SC-0j one.
          const fill = CUSTOM_SEGMENT_FILL_CLASSES[index % CUSTOM_SEGMENT_FILL_CLASSES.length];
          return (
            <div key={segment.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span data-testid={`copilot-context-segment-dot-${segment.key}`} className={cn("h-2 w-2 shrink-0 rounded-full", fill)} />
                <span>{labelKey !== undefined ? t(labelKey) : segment.key}</span>
              </span>
              <span className="tabular-nums text-[11px]">{segment.tokens}</span>
            </div>
          );
        })}
        {tooltipFooter}
      </div>
    ) : null;

  const tooltip = metrics ? (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span>{t("copilot_context_segment_system")}</span>
        <span className="tabular-nums text-[11px]">{metrics.systemTokens}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>{t("copilot_context_segment_digest")}</span>
        <span className="tabular-nums text-[11px]">{metrics.digestTokens}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>{t("copilot_context_segment_history")}</span>
        <span className="tabular-nums text-[11px]">{metrics.historyTokens}</span>
      </div>
      {tooltipFooter}
    </div>
  ) : null;

  return (
    <div
      data-testid="copilot-context-meter"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1"
    >
      <CustomTooltip content={showCustomSegments ? customTooltip : tooltip} side="bottom" align="start">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {showCustomSegments && customSegments && segments ? (
            <div className="flex h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-s3" data-testid="copilot-context-track">
              {customSegments.map((segment, index) => {
                if (segment.tokens <= 0) return null;
                const fraction = Math.min(1, Math.max(0, segment.tokens / segments.budgetTokens));
                return (
                  <div
                    key={segment.key}
                    data-testid={`copilot-context-segment-${segment.key}`}
                    className={cn(
                      "h-full",
                      CUSTOM_SEGMENT_FILL_CLASSES[index % CUSTOM_SEGMENT_FILL_CLASSES.length],
                    )}
                    style={{ width: `${fraction * 100}%` }}
                  />
                );
              })}
              {segments.reserve > 0 && (
                <div
                  data-testid="copilot-context-segment-reserve"
                  className="h-full"
                  style={{ width: `${segments.reserve * 100}%`, ...RESERVE_STYLE }}
                />
              )}
            </div>
          ) : segments ? (
            <div className="flex h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-s3" data-testid="copilot-context-track">
              {segments.system > 0 && (
                <div
                  data-testid="copilot-context-segment-system"
                  className="h-full bg-accent"
                  style={{ width: `${segments.system * 100}%` }}
                />
              )}
              {segments.digest > 0 && (
                <div
                  data-testid="copilot-context-segment-digest"
                  className="h-full bg-accent-dim"
                  style={{ width: `${segments.digest * 100}%` }}
                />
              )}
              {segments.history > 0 && (
                <div
                  data-testid="copilot-context-segment-history"
                  className="h-full bg-s2"
                  style={{ width: `${segments.history * 100}%` }}
                />
              )}
              {segments.reserve > 0 && (
                <div
                  data-testid="copilot-context-segment-reserve"
                  className="h-full"
                  style={{ width: `${segments.reserve * 100}%`, ...RESERVE_STYLE }}
                />
              )}
            </div>
          ) : (
            <div className="min-w-0 flex-1 truncate font-ui text-[11px] text-t4">
              {metrics === null
                ? t("copilot_context_no_metrics")
                : t("copilot_context_unmetered")}
            </div>
          )}
        </div>
      </CustomTooltip>

      <button
        type="button"
        data-testid="copilot-context-compact-btn"
        data-urgent={urgent ? "true" : "false"}
        disabled={compactDisabled}
        onClick={onCompact}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-ui text-[11px] font-medium transition-colors",
          urgent ? "text-warning-text" : "text-t3 hover:bg-s2 hover:text-t1",
          "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
        )}
      >
        <Icons.Stack className={cn("h-3 w-3 shrink-0", isCompacting && "animate-pulse")} />
        <span>{t("copilot_context_compact")}</span>
      </button>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="font-ui text-[11px] text-t4">{t("copilot_context_auto")}</span>
        <Toggle
          checked={autoCompact}
          onChange={onToggleAutoCompact}
          aria-label={t("copilot_context_auto_aria")}
        />
      </div>
    </div>
  );
}

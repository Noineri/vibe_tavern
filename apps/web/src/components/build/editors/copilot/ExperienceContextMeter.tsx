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

import { cn } from "../../../../lib/cn.js";
import type { CSSProperties } from "react";
import { Icons } from "../../../shared/icons.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { Toggle } from "../../../shared/Toggle.js";
import { useT } from "../../../../i18n/context.js";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
import { meterSegments, isMeterUrgent } from "../../../../lib/copilot-context.js";

export interface ExperienceContextMeterProps {
  metrics: ExperienceCopilotContextMetrics | null;
  autoCompact: boolean;
  isCompacting: boolean;
  /** True while a turn streams → the compact button is inert (no mid-stream compact). */
  isSending: boolean;
  onCompact: () => void;
  onToggleAutoCompact: (enabled: boolean) => void;
}

/** Reserve zone: a hatched strip drawn with a CSS repeating gradient so it reads
 *  as "reserved, not yet used" without pulling in an SVG. */
const RESERVE_STYLE: CSSProperties = {
  background:
    "repeating-linear-gradient(45deg, var(--border) 0px, var(--border) 2px, transparent 2px, transparent 5px)",
};

export function ExperienceContextMeter({
  metrics,
  autoCompact,
  isCompacting,
  isSending,
  onCompact,
  onToggleAutoCompact,
}: ExperienceContextMeterProps) {
  const { t } = useT();
  const segments = meterSegments(metrics);
  const urgent = isMeterUrgent(metrics);

  const compactDisabled = isSending || isCompacting;

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
    </div>
  ) : null;

  return (
    <div
      data-testid="copilot-context-meter"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1"
    >
      <CustomTooltip content={tooltip} side="bottom" align="start">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {segments ? (
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

/**
 * AgentContextMeter — the context-usage panel body (COPILOT_CONTEXT_METER_PLAN
 * CM-7; since AGENT_SHELL_POLISH AP-14 it lives in the header ring's popover /
 * phone sheet, its only consumer).
 *
 * Layout (the AP-14 mockup, owner-approved 2026-10-21; built as drawn on
 * 2026-10-23 after the first cut embedded the old one-line row): an optional
 * heading ("Context" + `% · used / budget`), the segmented bar, a legend
 * with one row per part (dot, name, tokens) plus the response reserve, the
 * measurement source, and a footer with Compact and the Auto toggle.
 * Everything is visible at once — no hover tooltip.
 *
 * PRESENTATIONAL + controlled: it owns NO async work and NO context state. The
 * shell owns `useCopilotContext` (fetch/apply/compact/toggle) and passes the
 * resolved values down; this component only renders and forwards clicks
 * (shared `Toggle`, no hand-rolled switch — §9).
 *
 * Segmented fill: system / digest / history against `budgetTokens` (or the
 * kind-provided `metrics.segments`), the response reserve hatched at the
 * tail. Unmetered (the profile has no explicit context budget —
 * `budgetTokens === 0`) shows a label instead of a misleading zero bar; no
 * metrics yet shows its own label. The compact button turns urgent at >= 80%
 * and is inert while a turn streams or a compact is already running.
 */

import { cn } from "../../../lib/cn.js";
import type { CSSProperties } from "react";
import { Icons } from "../icons.js";
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
   *  `segments`) = the fixed system / digest / history segments. */
  segmentLabels?: Record<string, AgentI18nKey>;
  /** Render the "Context · % · used / budget" heading inside the body (the
   *  desktop popover). The phone sheet shows the same heading as its title. */
  showHeading?: boolean;
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
 *  (success, warning, danger) are excluded: they mean a state, not a part. */
const CUSTOM_SEGMENT_FILL_CLASSES = ["bg-accent", "bg-accent-dim", "bg-s2", "bg-info", "bg-info-dim"];

/** Rounded usage percentage of a metered profile (0 when unmetered). The one
 *  derivation the header ring and the panel heading share. */
export function contextPercent(metrics: ExperienceCopilotContextMetrics): number {
  return metrics.budgetTokens > 0 ? Math.round((metrics.totalTokens / metrics.budgetTokens) * 100) : 0;
}

/** "Context" + `% · used / budget` (metered) or the token count (unmetered).
 *  Shared by the popover body and the phone sheet title. */
export function AgentContextHeading({ metrics }: { metrics: ExperienceCopilotContextMetrics }) {
  const { t } = useT();
  const metered = metrics.budgetTokens > 0;
  return (
    <div data-testid="copilot-context-heading" className="flex w-full items-baseline justify-between gap-3">
      <span>{t("context_label")}</span>
      <span className="shrink-0 font-normal tabular-nums text-t2">
        {metered
          ? `${contextPercent(metrics)}% · ${metrics.totalTokens.toLocaleString()} / ${metrics.budgetTokens.toLocaleString()}`
          : metrics.totalTokens.toLocaleString()}
      </span>
    </div>
  );
}

interface MeterRow {
  key: string;
  label: string;
  tokens: number;
  fill: string;
  /** Fraction of the budget; null on an unmetered profile (no bar). */
  width: number | null;
}

export function AgentContextMeter({
  metrics,
  autoCompact,
  isCompacting,
  isSending,
  onCompact,
  onToggleAutoCompact,
  segmentLabels,
  showHeading = false,
}: AgentContextMeterProps) {
  const { t } = useT();
  const segments = meterSegments(metrics);
  const urgent = isMeterUrgent(metrics);
  const compactDisabled = isSending || isCompacting;

  // SC-0j: the kind-provided path renders when `segments` is a non-empty
  // array. An empty array falls back to the fixed rows. A key missing from
  // the host's label map renders RAW (a descriptor wiring bug stays visible).
  const customSegments = metrics?.segments;
  const rows: MeterRow[] = !metrics
    ? []
    : customSegments !== undefined && customSegments.length > 0
      ? customSegments.map((segment, index) => {
          const labelKey = segmentLabels?.[segment.key];
          return {
            key: segment.key,
            label: labelKey !== undefined ? t(labelKey) : segment.key,
            tokens: segment.tokens,
            fill: CUSTOM_SEGMENT_FILL_CLASSES[index % CUSTOM_SEGMENT_FILL_CLASSES.length]!,
            width: segments ? Math.min(1, Math.max(0, segment.tokens / segments.budgetTokens)) : null,
          };
        })
      : [
          { key: "system", label: t("copilot_context_segment_system"), tokens: metrics.systemTokens, fill: "bg-accent", width: segments?.system ?? null },
          { key: "digest", label: t("copilot_context_segment_digest"), tokens: metrics.digestTokens, fill: "bg-accent-dim", width: segments?.digest ?? null },
          { key: "history", label: t("copilot_context_segment_history"), tokens: metrics.historyTokens, fill: "bg-s2", width: segments?.history ?? null },
        ];

  return (
    <div data-testid="copilot-context-meter" className="flex flex-col font-ui text-[calc(var(--ui-fs)-2px)] text-t1">
      {showHeading && metrics && (
        <div className="mb-2 font-medium">
          <AgentContextHeading metrics={metrics} />
        </div>
      )}

      {segments ? (
        <div className="flex h-1.5 overflow-hidden rounded-full bg-s3" data-testid="copilot-context-track">
          {rows.map((row) =>
            row.width !== null && row.width > 0 ? (
              <div
                key={row.key}
                data-testid={`copilot-context-segment-${row.key}`}
                className={cn("h-full", row.fill)}
                style={{ width: `${row.width * 100}%` }}
              />
            ) : null,
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
        <div className="text-t3">
          {metrics === null ? t("copilot_context_no_metrics") : t("copilot_context_unmetered")}
        </div>
      )}

      {metrics && (
        <div data-testid="copilot-context-legend" className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-t2">
          {rows.map((row) => (
            <LegendRow key={row.key} dotTestId={`copilot-context-segment-dot-${row.key}`} dotClassName={row.fill} label={row.label} tokens={row.tokens} />
          ))}
          <LegendRow
            dotTestId="copilot-context-segment-dot-reserve"
            dotClassName="border border-border"
            dotStyle={RESERVE_STYLE}
            label={t("copilot_context_segment_reserve")}
            tokens={metrics.reserveTokens}
          />
        </div>
      )}

      {metrics && (
        <div data-testid="copilot-context-source" className="mt-1.5 text-[calc(var(--ui-fs)-3px)] text-t4">
          {metrics.source === "provider" ? t("copilot_context_source_provider") : t("copilot_context_source_estimate")}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5">
        <button
          type="button"
          data-testid="copilot-context-compact-btn"
          data-urgent={urgent ? "true" : "false"}
          disabled={compactDisabled}
          onClick={onCompact}
          className={cn(
            "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border bg-s3 px-2.5 font-ui text-[11px] transition-all hover:bg-s2",
            urgent ? "border-warning/60 text-warning-text" : "border-border text-t2 hover:text-t1",
            "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-s3",
          )}
        >
          <Icons.Stack className={cn("h-3 w-3 shrink-0", isCompacting && "animate-pulse")} />
          <span>{t("copilot_context_compact")}</span>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="font-ui text-[11px] text-t3">{t("copilot_context_auto")}</span>
          <Toggle
            checked={autoCompact}
            onChange={onToggleAutoCompact}
            aria-label={t("copilot_context_auto_aria")}
          />
        </div>
      </div>
    </div>
  );
}

function LegendRow({ dotTestId, dotClassName, dotStyle, label, tokens }: {
  dotTestId: string;
  dotClassName: string;
  dotStyle?: CSSProperties;
  label: string;
  tokens: number;
}) {
  return (
    <>
      <span data-testid={dotTestId} className={cn("h-2 w-2 shrink-0 rounded-full", dotClassName)} style={dotStyle} />
      <span className="min-w-0">{label}</span>
      <span className="tabular-nums">{tokens.toLocaleString()}</span>
    </>
  );
}

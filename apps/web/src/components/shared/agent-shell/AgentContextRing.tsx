import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { isMeterUrgent } from "../../../lib/copilot-context.js";
import type { AgentI18nKey } from "../../../lib/agent-host-registry.js";
import { useT } from "../../../i18n/context.js";
import { getModalPortal } from "../modal-helpers.js";
import { BottomSheet } from "../BottomSheet.js";
import { ContextRing } from "../TokenCounterPopover.js";
import { CustomTooltip } from "../Tooltip.js";
import { AgentContextMeter } from "./AgentContextMeter.js";

export interface AgentContextRingProps {
  metrics: ExperienceCopilotContextMetrics | null;
  autoCompact: boolean;
  isCompacting: boolean;
  /** True while a turn streams → the compact button is inert (no mid-stream compact). */
  isSending: boolean;
  onCompact: () => void;
  onToggleAutoCompact: (enabled: boolean) => void;
  /** The host descriptor's `meterSegmentLabels` — forwarded to the meter body. */
  segmentLabels?: Record<string, AgentI18nKey>;
  /** Mobile uses a BottomSheet instead of the desktop popover. */
  mobile?: boolean;
}

/**
 * AgentContextRing (AGENT_SHELL_POLISH AP-14) — the header's compact context
 * trigger: a ring with the used % between the session switcher and the gear
 * (mockup §1). Clicking opens the EXISTING `AgentContextMeter` body (bar,
 * segments, «Сжать», «Авто») in a Radix popover on desktop and a BottomSheet
 * on the phone — the `TokenCounterPopover` / `ImageGenFineTuningChip`
 * dual-mode pattern (ONE trigger, desktop-only popover content, a `BottomSheet`
 * sibling on mobile, the same body on both).
 *
 * The ring drawing is the SHARED `ContextRing` (no hand-rolled SVG); its band
 * is the meter's OWN band (`isMeterUrgent`, the 80% auto-compact gate — the
 * single derivation, no copy): urgent renders the shared `warn` state, calm
 * renders `ok`.
 *
 * States (the contract):
 * - no usage data yet (`metrics === null`) → NO ring; the slot keeps today's
 *   `copilot_context_no_metrics` text (with its tooltip), non-interactive;
 * - unmetered profile (`budgetTokens === 0`) → the token COUNT instead of a
 *   percentage, equally compact, still opening the meter body;
 * - metered → ring + `%`, colored by the urgent band.
 */
export function AgentContextRing({
  metrics,
  autoCompact,
  isCompacting,
  isSending,
  onCompact,
  onToggleAutoCompact,
  segmentLabels,
  mobile = false,
}: AgentContextRingProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  // Before the first answer there is no usage data — no ring, no popover;
  // the slot keeps today's no-metrics text (with its tooltip).
  if (metrics === null) {
    return (
      <CustomTooltip content={t("copilot_context_no_metrics")} side="bottom">
        <span
          data-testid="copilot-context-ring-idle"
          className="min-w-0 max-w-[140px] shrink truncate px-1 font-ui text-[11px] text-t4"
        >
          {t("copilot_context_no_metrics")}
        </span>
      </CustomTooltip>
    );
  }

  const metered = metrics.budgetTokens > 0;
  const percent = metered ? Math.round((metrics.totalTokens / metrics.budgetTokens) * 100) : 0;
  const urgent = isMeterUrgent(metrics);
  const tokenState = urgent ? "warn" : "ok";

  const body = (
    <AgentContextMeter
      metrics={metrics}
      segmentLabels={segmentLabels}
      autoCompact={autoCompact}
      isCompacting={isCompacting}
      isSending={isSending}
      onCompact={onCompact}
      onToggleAutoCompact={onToggleAutoCompact}
    />
  );

  const trigger = metered ? (
    <button
      type="button"
      data-testid="copilot-context-ring"
      aria-label={t("context_usage_percent", { n: percent })}
      aria-expanded={open}
      onClick={() => setOpen(true)}
      className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-t3 transition-colors hover:bg-s2 hover:text-t1"
    >
      <ContextRing percent={percent} tokenState={tokenState} size={18} radius={7} strokeWidth={2.4} />
      <span className={cn("font-ui text-[11px] tabular-nums", urgent && "text-danger-text")}>
        {percent}%
      </span>
    </button>
  ) : (
    <button
      type="button"
      data-testid="copilot-context-ring"
      data-metered="false"
      aria-label={t("copilot_context_unmetered")}
      aria-expanded={open}
      onClick={() => setOpen(true)}
      className="flex h-7 shrink-0 items-center rounded-md px-1.5 text-t3 transition-colors hover:bg-s2 hover:text-t1"
    >
      <span className="font-ui text-[11px] tabular-nums">{metrics.totalTokens.toLocaleString()}</span>
    </button>
  );

  // The FineTuningChip structure verbatim: ONE popover (Root + Trigger own
  // the click → open on BOTH platforms), its Popover content desktop-only,
  // and a BottomSheet sibling for mobile — the same `body` on both.
  const popover = (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      {!mobile && (
        <Popover.Portal container={getModalPortal() ?? document.body}>
          <Popover.Content
            side="bottom"
            align="center"
            sideOffset={4}
            className="glass-blur z-[220] w-[240px] rounded-lg border border-border2 bg-glass-bg px-3.5 py-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {body}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );

  const sheetTitle = metered ? (
    <div className="flex w-full items-center justify-between gap-3">
      <span>{t("context_label")}</span>
      <span className="shrink-0 font-normal tabular-nums text-t2">
        {percent}% · {metrics.totalTokens.toLocaleString()} / {metrics.budgetTokens.toLocaleString()}
      </span>
    </div>
  ) : (
    <div className="flex w-full items-center justify-between gap-3">
      <span>{t("context_label")}</span>
      <span className="shrink-0 font-normal tabular-nums text-t2">
        {metrics.totalTokens.toLocaleString()}
      </span>
    </div>
  );

  const sheet = open && mobile && (
    <BottomSheet open={true} onClose={() => setOpen(false)} title={sheetTitle}>
      {body}
    </BottomSheet>
  );

  return (
    <>
      {popover}
      {sheet}
    </>
  );
}

// Mobile model sheet — opened by the star button of MobileInputArea. One sheet
// for everything that answers "what am I generating with, and how much room
// is left": the context fill (collapsed to a summary, expands in place to the
// full breakdown), the provider quota when the active profile exposes one,
// then the starred models to switch between.
//
// The breakdown rows are the shared ContextBreakdownRows (desktop popover and
// the ring's sheet render the same component); the quota show/hide gate and
// its fetch are the shared useProviderQuotaDisplay (the desktop QuotaIndicator
// uses it too); the quota rows are the shared QuotaSummaryRows. This file only
// arranges them into cards.

import { useState } from "react";
import type { FavoriteProviderModelRecord } from "../../api/types.js";
import { useT } from "../../i18n/context.js";
import { useProviderQuotaDisplay } from "../../hooks/use-provider-quota-display.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { Icons } from "../shared/icons.js";
import { QuotaSummaryRows } from "../shared/QuotaSummaryRows.js";
import {
  ContextBreakdownRows,
  ContextUsageBar,
  getContextUsage,
  type TokenCounterItem,
} from "../shared/TokenCounterPopover.js";

/** The context numbers `useInputArea()` already derives for the ring. */
export interface ModelSheetContext {
  permanent: number;
  history: number;
  inputTokens: number;
  maxTokens: number;
  availableBudget: number;
  permanentItems: TokenCounterItem[];
}

export interface MobileModelSheetProps {
  open: boolean;
  onClose: () => void;
  context: ModelSheetContext;
  /** Active provider profile (id for the quota gate, name for the quota card). */
  providerProfile: { id: string; name: string } | null;
  favoriteModels: FavoriteProviderModelRecord[];
  activeModelId: string | null;
  onSelectModel: (modelId: string) => void;
}

export function MobileModelSheet({ open, onClose, context, providerProfile, favoriteModels, activeModelId, onSelectModel }: MobileModelSheetProps) {
  const { t } = useT();
  return (
    <BottomSheet open={open} onClose={onClose} title={t("model_label")}>
      {/* The body mounts only while the sheet is open, so its quota fetch runs
          on open and the context card starts collapsed every time. */}
      <MobileModelSheetBody
        onClose={onClose}
        context={context}
        providerProfile={providerProfile}
        favoriteModels={favoriteModels}
        activeModelId={activeModelId}
        onSelectModel={onSelectModel}
      />
    </BottomSheet>
  );
}

function MobileModelSheetBody({ onClose, context, providerProfile, favoriteModels, activeModelId, onSelectModel }: Omit<MobileModelSheetProps, "open">) {
  const { t } = useT();
  const { entry, visible } = useProviderQuotaDisplay(providerProfile?.id ?? null);
  // Countdowns are sampled once when the sheet opens — no ticking interval.
  const [openedAt] = useState(() => Date.now());
  const showQuota = visible && entry.snapshot !== null;

  return (
    <>
      <div className="max-h-[70vh] overflow-y-auto">
        <ContextCard context={context} />
        {showQuota && (
          <div className="mx-3.5 mb-2.5 rounded-xl bg-s2 px-3 py-2.5">
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[calc(var(--ui-fs)-1px)]">
              <span className="shrink-0 text-t1">{t("quota_section")}</span>
              <span className="min-w-0 truncate text-[calc(var(--ui-fs)-2px)] text-t3">{providerProfile?.name}</span>
            </div>
            <QuotaSummaryRows snapshot={entry.snapshot} lastError={entry.lastError} now={openedAt} />
          </div>
        )}
        <div className="px-5 pb-1 pt-0.5 text-[calc(var(--ui-fs)-2px)] text-t4">{t("starred_models")}</div>
        {favoriteModels.length > 0 ? (
          <div>
            {favoriteModels.map(model => (
              <button type="button" key={model.modelId} className="flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-5 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3" onClick={() => { onSelectModel(model.modelId); onClose(); }}>
                <div className="w-5 shrink-0 flex justify-center text-accent-t">{activeModelId === model.modelId && <Icons.Check />}</div>
                <div className="min-w-0 truncate">{model.label || model.modelId}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-5 py-4 text-[calc(var(--ui-fs)-1px)] text-t3">{t("no_starred_models")}</div>
        )}
      </div>
      <div className="mx-4 mt-2 h-px bg-border" />
      <button type="button" className="flex w-full min-h-[52px] cursor-pointer items-center justify-center rounded-b-2xl text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3" onClick={onClose}>
        {t("cancel")}
      </button>
    </>
  );
}

/**
 * The context card. The whole card is one toggle (≥ 44 px target):
 * collapsed it shows percent · used / available, the usage bar and a
 * one-line permanent · history · input summary; expanded it swaps the summary
 * for the full breakdown rows. With no known budget (`availableBudget` 0) the
 * bar and summary have nothing to measure against — the card then shows only
 * what the ring's sheet shows in that case: the figures and the rows.
 */
function ContextCard({ context }: { context: ModelSheetContext }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const { permanent, history, inputTokens, maxTokens, availableBudget, permanentItems } = context;
  const usage = getContextUsage(permanent, history, inputTokens, availableBudget);
  const hasBudget = availableBudget > 0;
  const share = (tokens: number): number => Math.round(tokens / availableBudget * 100);

  return (
    <div className="px-3.5 pb-2.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(open => !open)}
        className="block min-h-[44px] w-full cursor-pointer rounded-xl bg-s2 px-3 py-2.5 text-left active:bg-s3"
      >
        <div className="flex items-baseline justify-between gap-3 text-[calc(var(--ui-fs)-1px)]">
          <span className="shrink-0 text-t1">{t("context_label")}</span>
          <span className="min-w-0 whitespace-nowrap tabular-nums text-accent-t">{usage.percent}% · {usage.used.toLocaleString()} / {availableBudget.toLocaleString()}</span>
        </div>
        {hasBudget && (
          <div className="my-2">
            <ContextUsageBar permanent={permanent} history={history} inputTokens={inputTokens} availableBudget={availableBudget} mobile />
          </div>
        )}
        {expanded && (
          <div className="mt-2 text-t2">
            <ContextBreakdownRows history={history} inputTokens={inputTokens} maxTokens={maxTokens} availableBudget={availableBudget} permanentItems={permanentItems} />
          </div>
        )}
        <div className="mt-1 flex items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t3">
          {!expanded && hasBudget && (
            <span className="min-w-0">{t("context_summary", { permanent: share(permanent), history: share(history), input: share(inputTokens) })}</span>
          )}
          <span className="ml-auto shrink-0">{expanded ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}</span>
        </div>
      </button>
    </div>
  );
}

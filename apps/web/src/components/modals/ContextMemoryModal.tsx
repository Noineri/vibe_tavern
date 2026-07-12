import { useState } from "react";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { useSummaryTab, type ContextMemoryModalProps } from "../context/SummaryTab.js";

/**
 * Context Memory modal — the tab-switching shell.
 *
 * Owns the active tab + the SegmentedControl tab bar and renders a single
 * MasterDetailModal whose master/detail/footer slots come from the active tab.
 * The Summary strategy body (state, handlers, JSX) lives in the useSummaryTab
 * hook (components/context/SummaryTab.tsx), extracted out of this file per
 * CONTEXT_MEMORY_MODAL_GOD_OBJECT_AUDIT. This shell is the seam the Phase-2
 * tab plans (CONTEXT_MEMORY_AUTO_MEMORY_TAB / CONTEXT_MEMORY_DREAM_TAB /
 * CONTEXT_MEMORY_BUDGET_FOOTER) plug siblings into: add a tab id, an option to
 * the SegmentedControl, and a branch rendering that tab's content.
 *
 * MasterDetailModal is owned by the shell (not per-tab) deliberately: it wraps
 * a Radix Dialog that animates open/close, so a per-tab MasterDetailModal would
 * remount the overlay on every tab switch and flicker. Keeping one instance
 * means Phase-2 tab switches swap content only.
 */
export type ContextMemoryTabId = "summary";

export function ContextMemoryModal(props: ContextMemoryModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<ContextMemoryTabId>("summary");
  const summary = useSummaryTab(props);

  // Hooks run on every render (state persists across open/close); the early
  // return mirrors the pre-extraction modal so no MasterDetailModal is mounted
  // while closed (identical to before).
  if (!props.isOpen) return null;

  const tabs = (
    <div className="mt-4 px-6">
      <SegmentedControl
        value={activeTab}
        onChange={(v) => setActiveTab(v as ContextMemoryTabId)}
        options={[{ value: "summary", label: t("memory_tab_summary") }]}
      />
    </div>
  );

  if (activeTab === "summary") {
    return (
      <MasterDetailModal
        isOpen={true}
        onClose={props.onClose}
        title={t("context_memory_title")}
        subtitle={t("context_memory_sub")}
        detailTitle={summary.detailTitle}
        dirty={summary.dirty}
        containerClassName="h-[min(86vh,780px)] w-[min(920px,calc(100vw-32px))] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
        masterClassName="flex w-[240px] shrink-0 flex-col border-r border-border bg-s1"
        detailClassName="p-5"
        headerBottom={!isMobile && tabs}
        masterContent={summary.masterContent}
        detailContent={summary.detailEditor}
        footer={summary.footer}
      />
    );
  }

  return null;
}

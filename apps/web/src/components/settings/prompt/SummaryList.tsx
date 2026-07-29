import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import type { CanvasSummaryEntry } from "../../../lib/prompt-canvas-summary.js";

export type SummaryLoadState = "idle" | "loading" | "ready" | "error";

/** Read-only expandable list of chat-summary memory blocks injected at the
 *  `chatSummary` canvas anchor. Each row collapses to label + range/source and
 *  expands to the full summary text. No edit controls — mirrors the read-only
 *  `LoreAnchorList` pattern. */
export function SummaryList({
  entries,
  loadState,
}: {
  entries: CanvasSummaryEntry[];
  loadState: SummaryLoadState;
}) {
  const { t } = useT();

  if (loadState === "idle") {
    return <p className="font-ui text-[11px] text-t4">{t("cc_summary_no_context")}</p>;
  }
  if (loadState === "loading") {
    return <p className="font-ui text-[11px] text-t4">{t("cc_summary_loading")}</p>;
  }
  if (loadState === "error") {
    return <p className="font-ui text-[11px] text-danger-text">{t("cc_summary_load_error")}</p>;
  }

  if (entries.length === 0) {
    return <p className="font-ui text-[11px] text-t4">{t("cc_summary_empty")}</p>;
  }

  return (
    <ul className="flex flex-col gap-1" aria-label={t("cc_summary_entries")}>
      {entries.map((entry) => (
        <SummaryRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}

function SummaryRow({ entry }: { entry: CanvasSummaryEntry }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const range =
    entry.summarizedFrom != null && entry.summarizedTo != null
      ? `${entry.summarizedFrom}–${entry.summarizedTo}`
      : null;

  return (
    <li className="overflow-hidden rounded border border-border bg-surface">
      <button
        type="button"
        className="canvas-disclosure-btn flex min-w-0 w-full items-baseline justify-between gap-3 px-2.5 py-2 text-left cursor-pointer transition-colors hover:bg-s2"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 truncate font-ui text-[12px] text-t1">
          {entry.label.trim() || t("unnamed")}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {range && (
            <span className="font-mono text-[10px] text-t4">{range}</span>
          )}
          <SourceBadge source={entry.source} />
          <span className={cn("text-[10px] text-t4 transition-transform", open && "rotate-90")} aria-hidden="true">▶</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border2 px-2.5 py-2">
          <p className="whitespace-pre-wrap break-words rounded bg-s2/60 px-2 py-1.5 font-mono text-[11px] leading-[1.55] text-t2">
            {entry.content.trim() || t("cc_lore_empty_content")}
          </p>
        </div>
      )}
    </li>
  );
}

function SourceBadge({ source }: { source: CanvasSummaryEntry["source"] }) {
  const { t } = useT();
  const label: ReactNode =
    source === "legacy" ? t("cc_summary_source_legacy")
      : source === "auto" ? t("cc_summary_source_auto")
        : t("cc_summary_source_manual");
  return (
    <span className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] opacity-70">
      {label}
    </span>
  );
}

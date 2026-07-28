import { useState } from "react";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import type {
  CanvasLoreAnchorPosition,
  CanvasLoreEntrySummary,
} from "../../../lib/prompt-canvas-lore.js";

export type LoreAnchorLoadState = "idle" | "loading" | "ready" | "error";

/** A key/value activation fact rendered in the expansion block. */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-t4">{label}</span>
      <span className="min-w-0 break-words font-ui text-[11px] text-t2">{value}</span>
    </div>
  );
}

/** One expandable lore-entry row. Collapsed shows the title + lorebook; the
 *  expanded body reveals read-only content + the activation conditions
 *  (keys, logic, constant/probability). Read-only — no edit controls. */
function LoreEntryRow({ entry }: { entry: CanvasLoreEntrySummary }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const hasDetail =
    entry.content !== undefined ||
    entry.keys !== undefined ||
    entry.secondaryKeys !== undefined ||
    entry.logic !== undefined ||
    entry.constant !== undefined ||
    entry.probability !== undefined;

  return (
    <li className="overflow-hidden rounded border border-border bg-surface">
      <button
        type="button"
        className={cn(
          "flex min-w-0 w-full items-baseline justify-between gap-3 px-2.5 py-2 text-left transition-colors",
          hasDetail && "cursor-pointer hover:bg-s2",
        )}
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <span className="min-w-0 truncate font-ui text-[12px] text-t1">
          {entry.title.trim() || t("unnamed")}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="max-w-[45%] truncate font-mono text-[10px] text-t4">
            {entry.lorebookName}
          </span>
          {hasDetail && (
            <span className={cn("text-[10px] text-t4 transition-transform", open && "rotate-90")} aria-hidden="true">▶</span>
          )}
        </span>
      </button>
      {open && hasDetail && (
        <div className="flex flex-col gap-2 border-t border-border2 px-2.5 py-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {entry.keys !== undefined && (
              <Fact label={t("cc_lore_keys")} value={entry.keys.length ? entry.keys.join(", ") : "—"} />
            )}
            {entry.secondaryKeys !== undefined && (
              <Fact label={t("cc_lore_secondary_keys")} value={entry.secondaryKeys.length ? entry.secondaryKeys.join(", ") : "—"} />
            )}
            {entry.logic !== undefined && (
              <Fact label={t("cc_lore_logic")} value={entry.logic || "—"} />
            )}
            {entry.role !== undefined && (
              <Fact label={t("role")} value={entry.role} />
            )}
            {entry.constant !== undefined && (
              <Fact label={t("cc_lore_constant")} value={entry.constant ? t("cc_lore_constant_on") : t("cc_lore_constant_off")} />
            )}
            {entry.probability !== undefined && (
              <Fact label={t("cc_lore_probability")} value={`${entry.probability}%`} />
            )}
          </div>
          {entry.content !== undefined && (
            <p className="whitespace-pre-wrap break-words rounded bg-s2/60 px-2 py-1.5 font-mono text-[11px] leading-[1.55] text-t2">
              {entry.content.trim() || t("cc_lore_empty_content")}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function LoreAnchorList({
  entries,
  position,
  loadState,
}: {
  entries: CanvasLoreEntrySummary[];
  position: CanvasLoreAnchorPosition;
  loadState: LoreAnchorLoadState;
}) {
  const { t } = useT();

  if (loadState === "idle") {
    return <p className="font-ui text-[11px] text-t4">{t("cc_lore_no_context")}</p>;
  }
  if (loadState === "loading") {
    return <p className="font-ui text-[11px] text-t4">{t("cc_lore_loading")}</p>;
  }
  if (loadState === "error") {
    return <p className="font-ui text-[11px] text-danger-text">{t("cc_lore_load_error")}</p>;
  }

  const matching = entries.filter((entry) => entry.position === position);
  if (matching.length === 0) {
    return <p className="font-ui text-[11px] text-t4">{t("cc_lore_empty")}</p>;
  }

  return (
    <ul className="flex flex-col gap-1" aria-label={t("cc_lore_entries")}>
      {matching.map((entry) => (
        <LoreEntryRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}

import { useT } from "../../../i18n/context.js";
import type {
  CanvasLoreAnchorPosition,
  CanvasLoreEntrySummary,
} from "../../../lib/prompt-canvas-lore.js";

export type LoreAnchorLoadState = "idle" | "loading" | "ready" | "error";

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
        <li
          key={entry.id}
          className="flex min-w-0 items-baseline justify-between gap-3 rounded border border-border bg-surface px-2.5 py-2"
        >
          <span className="min-w-0 truncate font-ui text-[12px] text-t1">
            {entry.title.trim() || t("unnamed")}
          </span>
          <span className="shrink-0 truncate font-mono text-[10px] text-t4 max-w-[45%]">
            {entry.lorebookName}
          </span>
        </li>
      ))}
    </ul>
  );
}

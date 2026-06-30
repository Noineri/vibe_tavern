/**
 * ListSortToggle — cycle button for sidebar list sort mode.
 *
 * Shared by the characters and chats lists (desktop Sidebar + mobile Rail).
 * One click cycles alphabetical ↔ recent; the icon reflects the active mode
 * and a tooltip names it. Two modes today; future modes append to the cycle.
 *
 * The mode itself lives in the navigation store (characterSortMode /
 * chatSortMode), owned by the parent — this component is a pure controlled
 * trigger so it stays decoupled from where the mode is persisted.
 */

import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "./Tooltip.js";
import { Ic } from "./icons.js";
import { useT } from "../../i18n/context.js";
import type { ListSortMode } from "../../stores/navigation-store.js";

interface ListSortToggleProps {
  mode: ListSortMode;
  onChange: (mode: ListSortMode) => void;
  className?: string;
}

const CYCLE: readonly ListSortMode[] = ["alphabetical", "recent"] as const;

export function ListSortToggle({ mode, onChange, className }: ListSortToggleProps) {
  const { t } = useT();
  const next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length];
  const label = mode === "alphabetical" ? t("sort_alphabetical") : t("sort_recent");
  // Tooltip names the active mode, since the icon alone distinguishes them but
  // a first-time user benefits from the explicit label on hover.
  const tooltip = `${t("sort_toggle")}: ${label}`;
  return (
    <CustomTooltip content={tooltip}>
      <button
        type="button"
        className={cn("iBtn size-5", className)}
        aria-label={tooltip}
        onClick={() => onChange(next)}
      >
        {mode === "alphabetical" ? <Ic.sortAlpha /> : <Ic.sortRecent />}
      </button>
    </CustomTooltip>
  );
}

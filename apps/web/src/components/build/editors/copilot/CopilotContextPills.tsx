import { Icons } from "../../../shared/icons.js";
import { useT } from "../../../../i18n/context.js";

/**
 * Removable pills row for the experience-copilot pinned context (CX-6,
 * COPILOT_CONTEXT_PICKER_PLAN). Pure presentational: the shell owns the
 * pinned links + PATCH, this renders each pin as a small chip with an ×
 * and reports unpins up. Renders nothing when empty.
 *
 * A dangling target (entity deleted after pinning) is handled by the CALLER
 * passing `label` = the raw targetId — the pill itself does not care.
 */
export interface CopilotContextPillItem {
  targetType: string;
  targetId: string;
  /** Display label (the shell resolves it from the catalog; falls back to
   *  the raw id for dangling targets). */
  label: string;
}

export interface CopilotContextPillsProps {
  items: readonly CopilotContextPillItem[];
  onUnpin: (targetType: string, targetId: string) => void;
}

export function CopilotContextPills({ items, onUnpin }: CopilotContextPillsProps) {
  const { t } = useT();
  if (items.length === 0) return null;
  return (
    <div
      role="list"
      aria-label={t("copilot_context_pills_label")}
      className="flex flex-wrap items-center gap-1.5 px-4 pt-2.5"
    >
      {items.map((item) => (
        <div
          key={`${item.targetType}:${item.targetId}`}
          role="listitem"
          data-testid={`copilot-context-pill-${item.targetType}-${item.targetId}`}
          className="flex items-center gap-1 rounded-[5px] bg-s2 px-2 py-0.5 font-ui text-[11px] text-t2"
        >
          <span className="max-w-[160px] truncate">{item.label}</span>
          <button
            type="button"
            data-testid={`copilot-context-pill-remove-${item.targetType}-${item.targetId}`}
            aria-label={t("copilot_context_pill_remove", { label: item.label })}
            className="flex h-4 w-4 items-center justify-center rounded text-t4 transition-colors hover:text-danger-text"
            onClick={() => onUnpin(item.targetType, item.targetId)}
          >
            <Icons.close className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

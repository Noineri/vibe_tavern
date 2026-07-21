import type { ReactNode } from "react";
import { Icons } from "../icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";

export interface AiAssistantShellProps {
  /** Title node on the left of the header — a plain span for AiAssistantModal,
   *  a rich icon+title block for the message AI editor. */
  title: ReactNode;
  onClose: () => void;
  /** Disables the close button while a generation/apply is in flight. */
  streaming: boolean;
  /** When 0, the content area renders the no-providers guard instead of children. */
  providerCount: number;
  /** No-providers guard wording — per-modal i18n key, preserved exactly. */
  noProvidersLabel: string;
  /** Optional slot between title and close button (e.g. the MAE mode toggle). */
  headerExtra?: ReactNode;
  /** Footer actions; when omitted/undefined the footer row is not rendered. */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Layout-only chrome shared by the AI-assistant modals
 * (AI_ASSISTANT_SHELL_REFACTOR_REPORT Step 3): header strip (title + optional
 * headerExtra + close button with streaming disable), the scrollable content
 * container with the no-providers guard, and the footer action row.
 *
 * Owns NO business logic and NO body markup — body, footer buttons, and
 * header-extra stay per-modal via slots, because the two modals' operational
 * contracts diverge (polymorphic free-text generator vs guarded chat-variant
 * editor) and must not be merged. The outer bordered container and the
 * Modal/BottomSheet wrapper stay per-modal too: they legitimately diverge
 * (per-mode widths, mobile bottom-sheet path, MAE container classes), unlike
 * the header/content/footer chrome which was byte-identical.
 */
export function AiAssistantShell({
  title,
  onClose,
  streaming,
  providerCount,
  noProvidersLabel,
  headerExtra,
  footer,
  children,
}: AiAssistantShellProps) {
  const { t } = useT();
  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
        {title}
        {headerExtra}
        <button
          type="button"
          aria-label={t("cancel_btn")}
          className={cn(
            "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1",
            streaming && "pointer-events-none opacity-30",
          )}
          onClick={onClose}
        >
          <Icons.close />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
        {providerCount === 0 ? (
          <div className="py-6 text-center font-ui text-[13px] text-t3">{noProvidersLabel}</div>
        ) : (
          children
        )}
      </div>

      {/* Footer */}
      {footer && (
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
          {footer}
        </div>
      )}
    </>
  );
}

import type { ReactNode } from "react";
import { Icons } from "../icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";

export interface AiAssistantShellFooterAction {
  label: string;
  onClick: () => void;
  /** Prevents the action from being activated. */
  disabled?: boolean;
  /** Prevents activation and exposes the in-flight action state. */
  busy?: boolean;
  /** Replaces the visible label while the action is busy. */
  busyLabel?: string;
}

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
  /** Legacy custom footer slot; preserves existing consumer output exactly. */
  footer?: ReactNode;
  /** Compact emphasized action, stacked full-width with secondary actions on mobile. */
  primaryAction?: AiAssistantShellFooterAction;
  /** Compact supporting actions, stacked full-width on mobile. */
  secondaryActions?: AiAssistantShellFooterAction[];
  children: ReactNode;
}

/**
 * Layout-only chrome shared by the AI-assistant modals
 * (AI_ASSISTANT_SHELL_REFACTOR_REPORT Step 3): header strip (title + optional
 * headerExtra + close button with streaming disable), the scrollable content
 * container with the no-providers guard, and the footer action row.
 *
 * Owns NO business logic and NO body markup — body and header-extra stay
 * per-modal via slots, because the two modals' operational contracts diverge
 * (polymorphic free-text generator vs guarded chat-variant editor) and must
 * not be merged. Footer controls may use the structured action contract;
 * legacy custom footer slots remain available for existing consumers. The outer bordered container and the
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
  primaryAction,
  secondaryActions,
  children,
}: AiAssistantShellProps) {
  const { t } = useT();
  const hasStructuredFooter = primaryAction !== undefined || Boolean(secondaryActions?.length);
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
      {hasStructuredFooter ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3 max-md:px-3 max-md:pt-2.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+0.625rem)]">
          {secondaryActions?.map((action) => {
            const disabled = action.disabled || action.busy;
            return (
              <button
                key={action.label}
                type="button"
                className="h-[37px] cursor-pointer rounded-md border border-border bg-surface px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 max-md:w-full"
                disabled={disabled}
                aria-busy={action.busy || undefined}
                onClick={action.onClick}
              >
                {action.busy && action.busyLabel ? action.busyLabel : action.label}
              </button>
            );
          })}
          {primaryAction && (
            <button
              type="button"
              className="h-[37px] cursor-pointer rounded-md bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 max-md:w-full"
              disabled={primaryAction.disabled || primaryAction.busy}
              aria-busy={primaryAction.busy || undefined}
              onClick={primaryAction.onClick}
            >
              {primaryAction.busy && primaryAction.busyLabel ? primaryAction.busyLabel : primaryAction.label}
            </button>
          )}
        </div>
      ) : footer ? (
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
          {footer}
        </div>
      ) : null}
    </>
  );
}

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";

// ────────────────────────────────────────────────────────────────────────────
// Message-shell text action rows (moved from MessageShell.tsx under the
// file-size ratchet, SC-18 — the rows are the part SC-18 changes, so they
// live here now; MessageShell keeps the container, the metadata bar and the
// image-slot rows). Byte-identical move: rendered output is pinned by the
// MessageShell.* characterization suites.
// ────────────────────────────────────────────────────────────────────────────
// Desktop Message Actions
// ────────────────────────────────────────────────────────────────────────────

const desktopActionClass = "flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2";

export function DesktopMessageActions(props: {
  aiEditTooltip: string;
  canAiEdit: boolean;
  aiAnnotateTooltip?: string;
  canAiAnnotate?: boolean;
  branchLabel: string;
  canBranch: boolean;
  canRegenerate: boolean;
  canResend: boolean;
  canContinue?: boolean;
  continueTooltip?: string;
  canSwitchVariant: boolean;
  copied: boolean;
  copiedLabel: string;
  copyLabel: string;
  editLabel: string;
  hiddenVariantControls: boolean;
  /** IG-16: the image-generation menu (trigger + popover + Stop morph). */
  imageMenu: ReactNode;
  /** SC-18: the «Discuss in the sidechat» entry (icon button / choice menu). */
  discussMenu: ReactNode;
  isBusy: boolean;
  isBranching: boolean;
  isGreeting: boolean;
  isUser: boolean;
  regenLabel: string;
  resendLabel: string;
  selectedVariantIndex: number;
  variantControlsRef: React.RefObject<HTMLSpanElement | null>;
  variantCount: number;
  variantControls?: ReactNode;
  onAiEdit: () => void;
  onAiAnnotate?: () => void;
  onBranch: () => void;
  onContinue?: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onNarrate?: () => void;
  narrating?: boolean;
  narrateTooltip?: string;
  narrateStopTooltip?: string;
  onRegenerate: () => void;
  onResend: () => void;
}) {
  const {
    aiEditTooltip, canAiEdit, aiAnnotateTooltip, canAiAnnotate,
    branchLabel, canBranch, canRegenerate, canResend, canContinue, continueTooltip, canSwitchVariant,
    copied, copiedLabel, copyLabel, editLabel, hiddenVariantControls,
    imageMenu, discussMenu,
    isBusy, isBranching, isGreeting, isUser, regenLabel, resendLabel,
    variantControlsRef, variantCount,
    variantControls,
    onAiEdit, onAiAnnotate, onBranch, onContinue, onCopy, onDelete, onEdit, onNarrate, narrating, narrateTooltip, narrateStopTooltip, onRegenerate, onResend,
  } = props;

  return (
    <div className="relative flex items-center gap-px mt-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <span
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all duration-150 hover:bg-s2 hover:text-t2",
          copied && "translate-y-[-1px] bg-success-dim text-success-text",
        )}
        onClick={() => { if (!isBusy) onCopy(); }}
      >{copied ? <Icons.Check /> : <Icons.Copy />}{copied ? copiedLabel : copyLabel}</span>

      <span
        className={desktopActionClass}
        onClick={() => { if (!isBusy) onEdit(); }}
      ><Icons.Edit />{editLabel}</span>

      {/* LS-4a: Continue — icon-only, directly next to Edit, last AI reply
          only (canContinue is gated upstream in MessageBlock), tooltip on
          hover per the owner spec (fast-forward >>, no caption, tooltip
          highlight). */}
      {canContinue && onContinue && (
        <CustomTooltip content={continueTooltip ?? ""}>
          <button
            type="button"
            aria-label={continueTooltip}
            aria-disabled={isBusy}
            disabled={isBusy}
            data-testid="desktop-continue-btn"
            className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
            onClick={() => { if (!isBusy) onContinue(); }}
          ><Icons.fastForward /></button>
        </CustomTooltip>
      )}

      {onNarrate && (
        <CustomTooltip content={narrating ? narrateStopTooltip : narrateTooltip}>
          <button
            type="button"
            aria-label={narrating ? narrateStopTooltip : narrateTooltip}
            aria-disabled={isBusy}
            disabled={isBusy}
            data-testid="desktop-narrate-btn"
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40",
              narrating ? "text-accent animate-pulse" : "text-t3",
            )}
            onClick={() => { if (!isBusy) onNarrate(); }}
          >{narrating ? <Icons.stopSquare /> : <Icons.speaker />}</button>
        </CustomTooltip>
      )}

      {canAiEdit && (
        <CustomTooltip content={aiEditTooltip}>
          <button
            type="button"
            aria-label={aiEditTooltip}
            aria-disabled={isBusy}
            disabled={isBusy}
            className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
            onClick={() => { if (!isBusy) onAiEdit(); }}
          ><Icons.Sparkles /></button>
        </CustomTooltip>
      )}

      {/* TPE-14: greeting-only "prepare for narration" entry. Same row
          affordance as the AI-edit button; shown only on greetings, where
          the edit button is absent by design. */}
      {canAiAnnotate && onAiAnnotate && (
        <CustomTooltip content={aiAnnotateTooltip ?? ""}>
          <button
            type="button"
            aria-label={aiAnnotateTooltip}
            aria-disabled={isBusy}
            disabled={isBusy}
            data-testid="desktop-annotate-btn"
            className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
            onClick={() => { if (!isBusy) onAiAnnotate(); }}
          ><Icons.Sparkles /></button>
        </CustomTooltip>
      )}

      {/* SC-18: «Discuss in the sidechat» sits next to the AI-editor button. */}
      {discussMenu}

      {canResend && <span className={desktopActionClass} onClick={() => { if (!isBusy) onResend(); }}><Icons.Regen />{resendLabel}</span>}
      {canBranch && <span className={desktopActionClass} aria-busy={isBranching} onClick={() => { if (!isBusy) onBranch(); }}>{isBranching ? <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" /> : <Icons.Branch />}{branchLabel}</span>}
      {canRegenerate && <span className={desktopActionClass} onClick={() => { if (!isBusy) onRegenerate(); }}><Icons.Regen />{regenLabel}</span>}

      {/* IG-16: image generation menu (icon+caret popover; Stop while running). */}
      {imageMenu}

      {!isUser && !isGreeting && variantCount > 1 && canSwitchVariant && variantControls}

      {/* Pre-CF6 affordance: the generic per-message delete. The IG-CF6
          worker initially tagged it image-slot-delete, which broke the
          slot-shaped gate tests on text messages — the generic delete is
          part of the TEXT surface, not slot chrome. The SLOT row's delete
          keeps image-slot-delete. */}
      {!isGreeting && (
        <span
          data-testid="message-delete"
          className="absolute right-0 flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
          onClick={() => { if (!isBusy) onDelete(); }}
        ><Icons.Trash /></span>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Mobile Message Actions
// ────────────────────────────────────────────────────────────────────────────

export function MobileMessageActions(props: {
  aiEditTooltip: string;
  canAiEdit: boolean;
  aiAnnotateTooltip?: string;
  canAiAnnotate?: boolean;
  branchLabel: string;
  canBranch: boolean;
  canRegenerate: boolean;
  canResend: boolean;
  canSwitchVariant: boolean;
  /** IG-16: the image-generation menu (icon button + sheet + Stop morph). */
  imageMenu: ReactNode;
  /** SC-18: the «Discuss in the sidechat» entry (icon button / choice sheet). */
  discussMenu: ReactNode;
  isBusy: boolean;
  isBranching: boolean;
  isGreeting: boolean;
  isUser: boolean;
  regenLabel: string;
  resendLabel: string;
  selectedVariantIndex: number;
  variantCount: number;
  variantControls?: ReactNode;
  onAiEdit: () => void;
  onAiAnnotate?: () => void;
  onBranch: () => void;
  onNarrate?: () => void;
  narrating?: boolean;
  narrateTooltip?: string;
  narrateStopTooltip?: string;
  onRegenerate: () => void;
  onResend: () => void;
}) {
  const {
    aiEditTooltip, canAiEdit, aiAnnotateTooltip, canAiAnnotate,
    branchLabel, canBranch, canRegenerate, canResend, canSwitchVariant,
    imageMenu, discussMenu,
    isBusy, isBranching, isGreeting, isUser, regenLabel, resendLabel,
    variantControls,
    onAiEdit, onAiAnnotate, onBranch, onNarrate, narrating, narrateTooltip, narrateStopTooltip, onRegenerate, onResend,
  } = props;

  return (
    <div className="mt-2 grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2">
      <div className="flex justify-start">
        {canBranch && (
          <button type="button" className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 [&_svg]:h-5 [&_svg]:w-5" aria-busy={isBranching} onClick={() => { if (!isBusy) onBranch(); }} title={branchLabel}>
            {isBranching ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Icons.Branch />}
          </button>
        )}
      </div>
      <div className="flex min-w-0 justify-center">
        {!isUser && !isGreeting && canSwitchVariant && variantControls}
      </div>
      <div className="flex justify-end gap-1">
        {/* IG-16: image generation menu (icon button + sheet; Stop while running). */}
        {imageMenu}
        {onNarrate && (
          <button type="button" aria-label={narrating ? narrateStopTooltip : narrateTooltip} data-testid="mobile-narrate-btn" className={cn("flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg active:bg-s2 [&_svg]:h-5 [&_svg]:w-5", narrating ? "text-accent animate-pulse" : "text-t3")} onClick={() => { if (!isBusy) onNarrate(); }} title={narrating ? narrateStopTooltip : narrateTooltip}>
            {narrating ? <Icons.stopSquare /> : <Icons.speaker />}
          </button>
        )}
        {canAiEdit && (
          <button type="button" aria-label={aiEditTooltip} disabled={isBusy} className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:cursor-default disabled:opacity-40 [&_svg]:h-5 [&_svg]:w-5" onClick={() => { if (!isBusy) onAiEdit(); }} title={aiEditTooltip}>
            <Icons.Sparkles />
          </button>
        )}
        {/* TPE-14: greeting-only "prepare for narration" entry (mobile row). */}
        {canAiAnnotate && onAiAnnotate && (
          <button type="button" aria-label={aiAnnotateTooltip} data-testid="mobile-annotate-btn" disabled={isBusy} className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:cursor-default disabled:opacity-40 [&_svg]:h-5 [&_svg]:w-5" onClick={() => { if (!isBusy) onAiAnnotate(); }} title={aiAnnotateTooltip}>
            <Icons.Sparkles />
          </button>
        )}
        {/* SC-18: «Discuss in the sidechat» sits next to the AI-editor button. */}
        {discussMenu}
        {canResend && (
          <button type="button" className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 [&_svg]:h-5 [&_svg]:w-5" onClick={() => { if (!isBusy) onResend(); }} title={resendLabel}>
            <Icons.Regen />
          </button>
        )}
        {canRegenerate && (
          <button type="button" className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 [&_svg]:h-5 [&_svg]:w-5" onClick={() => { if (!isBusy) onRegenerate(); }} title={regenLabel}>
            <Icons.Regen />
          </button>
        )}
      </div>
    </div>
  );
}

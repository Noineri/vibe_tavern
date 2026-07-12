import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.js";
import { initials } from "../layout/app-shell-helpers.js";
import { Icons } from "../shared/icons.js";
import { ActionSheet, type ActionSheetItem } from "../shared/ActionSheet.js";
import { AssistantContextHeader } from "./AssistantContextHeader.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import {
  resolveMessageMeta,
  type MessageMetaContext,
} from "../../lib/message-meta-registry.js";
import {
  resolveMessageSlots,
  type MessageSlotId,
  type MessageSlotContext,
} from "../../lib/message-slot-registry.js";

// Side-effect import: registers the core provenance badges (model, preset,
// coauthor module+skill) with the message-meta registry at module load.
import "./message-meta/badges.js";

// ────────────────────────────────────────────────────────────────────────────
// MessageShell
// ────────────────────────────────────────────────────────────────────────────
// Reusable container for a single chat message. Renders:
//   1. Separator line (if showSeparator)
//   2. Author header (avatar + name)
//   3. Greeting variant controls (inline in header, optional)
//   4. Mobile three-dot menu (optional)
//   5. Slot: "after_reasoning"
//   6. Slot: "before_content"
//   7. {children} — message content (text / editing / streaming / variants)
//   8. Slot: "after_content"
//   9. Slot: "before_metadata"
//  10. Message metadata bar
//  11. Desktop action buttons
//  12. Mobile action buttons
//  13. Slot: "attachment_area"
//
// All slot positions produce zero DOM when no slots are registered or all
// return visible: false.
// ────────────────────────────────────────────────────────────────────────────

export interface MessageShellAuthorInfo {
  name: string;
  avatarAssetId: string | null;
  avatarCropJson: string | null;
  /** Pre-resolved avatar URL (folder avatar when migrated, else legacy flat). Null = no avatar. */
  avatarSrc: string | null;
  /** Optional ReactNode to override the default avatar rendering */
  avatarNode?: React.ReactNode;
  /** Optional ReactNode to override the default text rendering of the name */
  nameNode?: React.ReactNode;
}

export interface MessageShellActions {
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onBranch: () => void;
  onRegenerate: () => void;
  onResend: () => void;
}

export interface MessageShellProps {
  /** Message ID — used for slot context. */
  messageId: string;
  /** Chat ID — used for slot context. */
  chatId: string;
  /** Message role — determines alignment, styling, and slot filtering. */
  role: "user" | "assistant" | "system" | "tool";
  /** Whether to show a separator line above this message. */
  showSeparator: boolean;
  /** Author info for the message sender. */
  author: MessageShellAuthorInfo;
  /** Whether this is a user message (affects layout direction). */
  isUser: boolean;
  /** Whether this message is a greeting (first assistant message). */
  isGreeting: boolean;
  /** Whether this message is currently in editing mode. */
  isEditing: boolean;
  /** Whether a generation is in progress for this message. */
  isGenerating: boolean;
  /** Whether the app is busy (sending or processing). */
  isBusy: boolean;
  /** Whether this message is waiting for a branch fork response. */
  isBranching?: boolean;
  /** Whether user can branch from this message. */
  canBranch: boolean;
  /** Whether user can regenerate this message. */
  canRegenerate: boolean;
  /** Whether user can resend from this message. */
  canResend: boolean;
  /** Currently selected variant index. */
  selectedVariantIndex: number;
  /** Total number of variants. */
  variantCount: number;
  /** Whether variant switching is allowed. */
  canSwitchVariant: boolean;
  /** Message metadata context — variant-scoped provenance + token count + timestamp. */
  metaCtx: MessageMetaContext;
  /** Whether the copy button was recently clicked (shows checkmark). */
  copied: boolean;
  /** Slot context extras (feature-specific data). */
  slotExtras: Record<string, unknown>;
  /** Variant controls overlay state (desktop positioning). */
  variantControlsOverlay: { rect: DOMRectReadOnly } | null;
  /** Ref for variant controls positioning. */
  variantControlsRef: React.RefObject<HTMLSpanElement | null>;
  /** Greeting counter controls (only rendered when isGreeting && variantCount > 1). */
  greetingControls?: ReactNode;
  /** Desktop variant controls rendered in action bar. */
  desktopVariantControls?: ReactNode;
  /** Mobile variant controls rendered in mobile action bar. */
  mobileVariantControls?: ReactNode;
  /** Message content — the main body of the message. */
  children: ReactNode;
  /** Callbacks. */
  actions: MessageShellActions;
}

const msgWrap = "relative group py-2.5";

export function MessageShell(props: MessageShellProps) {
  const {
    messageId,
    chatId,
    role,
    showSeparator,
    author,
    isUser,
    isGreeting,
    isEditing,
    isGenerating,
    isBusy,
    isBranching = false,
    canBranch,
    canRegenerate,
    canResend,
    selectedVariantIndex,
    variantCount,
    canSwitchVariant,
    metaCtx,
    copied,
    slotExtras,
    variantControlsOverlay,
    variantControlsRef,
    greetingControls,
    desktopVariantControls,
    mobileVariantControls,
    children,
    actions,
  } = props;

  const { t } = useT();
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Build slot context
  const slotCtx: MessageSlotContext = {
    chatId,
    messageId,
    messageRole: role,
    variantIndex: selectedVariantIndex,
    isStreaming: isGenerating,
    extras: slotExtras,
  };

  const copyLabel = t("copy");
  const editLabel = t("edit");
  const branchLabel = t("branch");
  const regenLabel = t("regen");
  const deleteLabel = t("delete");
  const resendLabel = t("resend");

  // Resolve slots for each position
  const slotsAfterReasoning = resolveMessageSlots("after_reasoning", slotCtx);
  const slotsToolActivity = resolveMessageSlots("tool_activity", slotCtx);
  const slotsBeforeContent = resolveMessageSlots("before_content", slotCtx);
  const slotsAfterContent = resolveMessageSlots("after_content", slotCtx);
  const slotsBeforeMetadata = resolveMessageSlots("before_metadata", slotCtx);
  const slotsAttachmentArea = resolveMessageSlots("attachment_area", slotCtx);

  const hasAfterReasoning = slotsAfterReasoning.length > 0;
  const hasToolActivity = slotsToolActivity.length > 0;
  const hasBeforeContent = slotsBeforeContent.length > 0;
  const hasAfterContent = slotsAfterContent.length > 0;
  const hasBeforeMetadata = slotsBeforeMetadata.length > 0;
  const hasAttachmentArea = slotsAttachmentArea.length > 0;

  return (
    <>
      {showSeparator && (
        <div className={isMobile ? "mx-auto mb-1 mt-1 px-2" : "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7 my-[6px] mt-2"}>
          <div className="h-px bg-border opacity-40" />
        </div>
      )}
      {variantControlsOverlay && !isMobile && createPortal(
        <div
          style={{
            position: "fixed",
            top: variantControlsOverlay.rect.top,
            left: variantControlsOverlay.rect.left,
            width: variantControlsOverlay.rect.width,
            height: variantControlsOverlay.rect.height,
            zIndex: 1000,
          }}
        >
          {desktopVariantControls}
        </div>,
        document.body,
      )}
      <div className={isMobile ? "relative mx-auto w-full px-3" : "relative mx-auto max-w-[min(calc(var(--mw)+160px),calc(100vw-var(--sw)-64px))] px-7"}>
        <div className={msgWrap}>
          {/* ── Author Header ── */}
          {/* Assistant messages use the adaptive context header (identity +
              insight zones; the flat avatar+name row is the 0-zone fallback).
              User/system/tool keep the legacy inline row. See
              AssistantContextHeader + the ASSISTANT_CONTEXT_HEADER report. */}
          {role === "assistant" ? (
            <AssistantContextHeader
              author={author}
              slotCtx={slotCtx}
              greetingControls={greetingControls}
              isMobile={isMobile}
              isEditing={isEditing}
              isGenerating={isGenerating}
              onToggleMobileMenu={() => setMobileMenuOpen(v => !v)}
            />
          ) : (
          <div className={cn(
            "mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3",
            !isUser && "text-accent-t opacity-85",
            isUser && "flex-row-reverse",
            isMobile && "gap-[7px] text-[calc(var(--ui-fs)-3px)] mb-[3px]",
          )}>
            <div className={cn(
              "shrink-0 overflow-hidden rounded-full bg-s3 font-body italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover ",
              "flex h-11 w-11 items-center justify-center text-[calc(var(--ui-fs)+1px)]",
            )}>
              {author.avatarNode ? author.avatarNode : (
                author.avatarSrc
                  ? <img src={author.avatarSrc} alt={author.name} className="h-full w-full object-cover" />
                  : initials(author.name)
              )}
            </div>
            {author.nameNode ? author.nameNode : <span>{author.name}</span>}

            {/* Greeting variant controls */}
            {greetingControls}

            {/* Mobile: three-dot action menu.
                F11 — position mirrors the AI row by screen edge. The AI row
                is not reversed, so `ml-auto` (margin-left:auto) absorbs the
                free space to the LEFT of the dots, pinning them to the right
                edge. The user row uses `flex-row-reverse` (avatar on the
                right); there `ml-auto` would keep the dots near the avatar, so
                `mr-auto` (margin-right:auto) is used instead — it absorbs the
                free space to the RIGHT of the dots, pushing them to the LEFT
                edge (the near-thumb side). Auto margins are physical, so this
                hits the intended screen edge regardless of flex direction. */}
            {isMobile && !isEditing && !isGenerating && (
              <div className={cn("relative", isUser ? "mr-auto" : "ml-auto")}>
                <div
                  className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded text-t3 transition-colors active:bg-s2"
                  onClick={() => setMobileMenuOpen(v => !v)}
                >
                  <Icons.Ellipsis />
                </div>
              </div>
            )}
          </div>
          )}

          {/* F12 — Mobile message actions: shared bottom sheet instead of a
              bespoke getBoundingClientRect popover. Items mirror the old
              inline rows (Copy/Edit/Delete); the copy row swaps its icon +
              label to the "copied" state via the `copied` prop. */}
          {isMobile && (
            <ActionSheet
              open={mobileMenuOpen}
              onClose={() => setMobileMenuOpen(false)}
              title={t("message_actions_title")}
              items={[
                {
                  icon: copied ? <Icons.Check /> : <Icons.Copy />,
                  label: copied ? t("copied") : copyLabel,
                  action: actions.onCopy,
                },
                {
                  icon: <Icons.Edit />,
                  label: editLabel,
                  action: actions.onEdit,
                },
                {
                  icon: <Icons.Trash />,
                  label: deleteLabel,
                  danger: true,
                  action: actions.onDelete,
                },
              ] satisfies ActionSheetItem[]}
            />
          )}

          {/* ── Slot: after_reasoning ── */}
          {hasAfterReasoning && slotsAfterReasoning.map((s) => (
            <SlotRenderer key={s.id} descriptor={s} ctx={slotCtx} />
          ))}

          {/* ── Slot: tool_activity (co-author) ── */}
          {hasToolActivity && slotsToolActivity.map((s) => (
            <SlotRenderer key={s.id} descriptor={s} ctx={slotCtx} />
          ))}

          {/* ── Slot: before_content ── */}
          {hasBeforeContent && slotsBeforeContent.map((s) => (
            <SlotRenderer key={s.id} descriptor={s} ctx={slotCtx} />
          ))}

          {/* ── Message Content ── */}
          {children}

          {/* ── Slot: after_content ── */}
          {hasAfterContent && slotsAfterContent.map((s) => (
            <SlotRenderer key={s.id} descriptor={s} ctx={slotCtx} />
          ))}

          {/* ── Slot: before_metadata ── */}
          {hasBeforeMetadata && slotsBeforeMetadata.map((s) => (
            <SlotRenderer key={s.id} descriptor={s} ctx={slotCtx} />
          ))}

          {/* ── Metadata ── */}
          {!isEditing && !isGenerating && (
            <MessageMetadata metaCtx={metaCtx} />
          )}

          {/* ── Desktop Actions ── */}
          {!isEditing && !isGenerating && !isMobile && (
            <DesktopMessageActions
              branchLabel={branchLabel}
              canBranch={canBranch}
              canRegenerate={canRegenerate}
              canResend={canResend}
              canSwitchVariant={canSwitchVariant}
              copied={copied}
              copiedLabel={t("copied")}
              copyLabel={copyLabel}
              editLabel={editLabel}
              hiddenVariantControls={!!variantControlsOverlay}
              isBusy={isBusy}
              isBranching={isBranching}
              isGreeting={isGreeting}
              isUser={isUser}
              regenLabel={regenLabel}
              resendLabel={resendLabel}
              selectedVariantIndex={selectedVariantIndex}
              variantControlsRef={variantControlsRef}
              variantCount={variantCount}
              onBranch={actions.onBranch}
              onCopy={actions.onCopy}
              onDelete={actions.onDelete}
              onEdit={actions.onEdit}
              onRegenerate={actions.onRegenerate}
              onResend={actions.onResend}
              variantControls={desktopVariantControls}
            />
          )}

          {/* ── Mobile Actions ── */}
          {isMobile && !isEditing && !isGenerating && (
            <MobileMessageActions
              branchLabel={branchLabel}
              canBranch={canBranch}
              canRegenerate={canRegenerate}
              canResend={canResend}
              canSwitchVariant={canSwitchVariant}
              isBusy={isBusy}
              isBranching={isBranching}
              isGreeting={isGreeting}
              isUser={isUser}
              regenLabel={regenLabel}
              resendLabel={resendLabel}
              selectedVariantIndex={selectedVariantIndex}
              variantCount={variantCount}
              onBranch={actions.onBranch}
              onRegenerate={actions.onRegenerate}
              onResend={actions.onResend}
              variantControls={mobileVariantControls}
            />
          )}

          {/* ── Slot: attachment_area ── */}
          {hasAttachmentArea && slotsAttachmentArea.map((s) => (
            <SlotRenderer key={s.id} descriptor={s} ctx={slotCtx} />
          ))}
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Slot Renderer — renders a single slot descriptor
// ────────────────────────────────────────────────────────────────────────────

function SlotRenderer({ descriptor, ctx }: {
  descriptor: { render: (ctx: MessageSlotContext) => ReactNode };
  ctx: MessageSlotContext;
}) {
  return <>{descriptor.render(ctx)}</>;
}

// ────────────────────────────────────────────────────────────────────────────
// Message Metadata
// ────────────────────────────────────────────────────────────────────────────
// The metadata bar is registry-driven: badges (model, preset, coauthor
// module+skill, and anything future features register) are resolved via
// resolveMessageMeta(ctx). The leading timestamp + token-count span are always
// present and rendered here (not feature-pluggable). When no badges are
// visible, zero badge DOM is produced.

function MessageMetadata({ metaCtx }: { metaCtx: MessageMetaContext }) {
  const { t } = useT();
  const createdLabel = formatMessageTime(metaCtx.createdAt);
  const badges = resolveMessageMeta(metaCtx);
  if (!createdLabel) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 font-ui text-[calc(var(--ui-fs)-4px)] text-t3/50">
      {createdLabel}
      <span className="tabular-nums">{metaCtx.tokenCount} {t("tokens_label")}</span>
      {badges.map((b) => (
        <MetaBadgeRenderer key={b.id} descriptor={b} ctx={metaCtx} />
      ))}
    </div>
  );
}

function MetaBadgeRenderer({ descriptor, ctx }: {
  descriptor: { render: (ctx: MessageMetaContext) => ReactNode };
  ctx: MessageMetaContext;
}) {
  return <>{descriptor.render(ctx)}</>;
}

// ────────────────────────────────────────────────────────────────────────────
// Desktop Message Actions
// ────────────────────────────────────────────────────────────────────────────

const desktopActionClass = "flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2";

function DesktopMessageActions(props: {
  branchLabel: string;
  canBranch: boolean;
  canRegenerate: boolean;
  canResend: boolean;
  canSwitchVariant: boolean;
  copied: boolean;
  copiedLabel: string;
  copyLabel: string;
  editLabel: string;
  hiddenVariantControls: boolean;
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
  onBranch: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onResend: () => void;
}) {
  const {
    branchLabel, canBranch, canRegenerate, canResend, canSwitchVariant,
    copied, copiedLabel, copyLabel, editLabel, hiddenVariantControls,
    isBusy, isBranching, isGreeting, isUser, regenLabel, resendLabel,
    variantControlsRef, variantCount,
    variantControls,
    onBranch, onCopy, onDelete, onEdit, onRegenerate, onResend,
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

      <span className={desktopActionClass} onClick={() => { if (!isBusy) onEdit(); }}><Icons.Edit />{editLabel}</span>

      {canResend && <span className={desktopActionClass} onClick={() => { if (!isBusy) onResend(); }}><Icons.Regen />{resendLabel}</span>}
      {canBranch && <span className={desktopActionClass} aria-busy={isBranching} onClick={() => { if (!isBusy) onBranch(); }}>{isBranching ? <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" /> : <Icons.Branch />}{branchLabel}</span>}
      {canRegenerate && <span className={desktopActionClass} onClick={() => { if (!isBusy) onRegenerate(); }}><Icons.Regen />{regenLabel}</span>}

      {!isUser && !isGreeting && variantCount > 1 && canSwitchVariant && variantControls}

      {!isGreeting && (
        <span
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

function MobileMessageActions(props: {
  branchLabel: string;
  canBranch: boolean;
  canRegenerate: boolean;
  canResend: boolean;
  canSwitchVariant: boolean;
  isBusy: boolean;
  isBranching: boolean;
  isGreeting: boolean;
  isUser: boolean;
  regenLabel: string;
  resendLabel: string;
  selectedVariantIndex: number;
  variantCount: number;
  variantControls?: ReactNode;
  onBranch: () => void;
  onRegenerate: () => void;
  onResend: () => void;
}) {
  const {
    branchLabel, canBranch, canRegenerate, canResend, canSwitchVariant,
    isBusy, isBranching, isGreeting, isUser, regenLabel, resendLabel,
    variantControls,
    onBranch, onRegenerate, onResend,
  } = props;

  return (
    <div className="mt-2 grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
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
      <div className="flex justify-end">
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

// ────────────────────────────────────────────────────────────────────────────
// Utilities (kept from original MessageBlock)
// ────────────────────────────────────────────────────────────────────────────

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

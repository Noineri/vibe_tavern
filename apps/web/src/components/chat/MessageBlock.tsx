import { memo, useState, useMemo, useRef, useEffect, useLayoutEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useAnimationControls, type PanInfo } from "framer-motion";
import { cn } from "../../lib/cn.js";
import { Markdown } from "../../lib/markdown.js";
import { avatarUrl } from "../../lib/avatar.js";
import { initials } from "../layout/app-shell-helpers.js";
import { useDisplayMessage, useChatMeta, useMessageOrder, useMacroContext } from "../../stores/chat-selectors.js";
import { useChatStore, useActiveGeneration, useIsSending } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import type { MessageBlockProps } from "../play/play-mode-types.js";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { useT } from "../../i18n/context.js";
import { MessageReasoning } from "./MessageReasoning.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { replaceUiMacros } from "../../lib/macros.js";
import { resolveModelLabel } from "../../lib/model-resolve.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

const msgWrap = "relative group py-2.5";
const sepWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7 my-[6px] mt-2";

type SwipeDirection = -1 | 1;

type VariantControlsOverlayState = {
  rect: DOMRectReadOnly;
};

export const MessageBlock = memo(function MessageBlock(input: MessageBlockProps) {
  const { t } = useT();
  const chat = useChatController();
  const [copied, setCopied] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [variantControlsOverlay, setVariantControlsOverlay] = useState<VariantControlsOverlayState | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const variantControlsRef = useRef<HTMLSpanElement>(null);
  const variantOverlayTimerRef = useRef<number | undefined>(undefined);
  const bottomPinRafRef = useRef<number | undefined>(undefined);
  const bottomPinUntilRef = useRef(0);

  // Read ALL display data from memoized selector — re-renders only when THIS message changes
  const msg = useDisplayMessage(input.messageId);
  const chatMeta = useChatMeta();
  const messageOrder = useMessageOrder();
  const macroContext = useMacroContext();

  const editingMessageId = useChatStore(s => s.editingMessageId);
  const editingDraft = useChatStore(s => s.editingDraft);
  const isSending = useIsSending();
  const messageActionId = useChatStore(s => s.messageActionId);
  const activeGen = useActiveGeneration();
  const pendingUserMessageContent = activeGen?.pendingUserMessageContent ?? null;

  // ── ALL hooks must be called before any early return (React Rules of Hooks) ──

  // Find first assistant message ID for greeting logic
  const firstAssistantMsgId = useMemo(() => {
    const state = useSnapshotStore.getState();
    for (const id of messageOrder) {
      if (state.messagesById[id]?.role === "assistant") return id;
    }
    return null;
  }, [messageOrder]);

  // Macros for variants — use safe defaults when msg is null
  const variants = useMemo(() => {
    if (!msg?.variants || !macroContext) return msg?.variants ?? [];
    return msg.variants.map(v => ({
      ...v,
      content: replaceUiMacros(v.content, macroContext),
    }));
  }, [msg?.variants, macroContext]);

  const selectedVariantIndex = msg?.selectedVariantIndex ?? 0;
  const variantCount = variants.length;

  // Greeting logic
  const isGreeting = !!msg && input.messageId === firstAssistantMsgId;

  const isUser = msg?.role === "user";

  // -- Variant slide: direction derived locally to prevent phantom renders --
  const prevVariantIndexRef = useRef(selectedVariantIndex);
  const directionRef = useRef(1);

  if (selectedVariantIndex !== prevVariantIndexRef.current) {
    directionRef.current = selectedVariantIndex > prevVariantIndexRef.current ? 1 : -1;
    prevVariantIndexRef.current = selectedVariantIndex;
  }
  const direction = directionRef.current;

  useEffect(() => {
    return () => {
      if (variantOverlayTimerRef.current !== undefined) window.clearTimeout(variantOverlayTimerRef.current);
      if (bottomPinRafRef.current !== undefined) window.cancelAnimationFrame(bottomPinRafRef.current);
    };
  }, []);

  // Streaming text for regeneration
  const globalStreamingText = activeGen?.streamingText ?? "";
  const globalStreamingReasoning = activeGen?.streamingReasoningText ?? "";

  // Separator logic
  const showSeparator = useMemo(() => {
    if (input.index === 0) return false;
    const state = useSnapshotStore.getState();
    const prevId = messageOrder[input.index - 1];
    const prev = state.messagesById[prevId];
    if (!prev || !msg) return false;
    return !isBreakoutRole(prev.role) && !isBreakoutRole(msg.role);
  }, [input.index, messageOrder, msg?.role]);

  // ── EARLY RETURN — after all hooks ──
  const isMobile = useIsMobile();
  if (!msg || !chatMeta) return null;

  // ── Derived values (non-hook, safe to be after return) ──
  const messageTokens = msg.tokenCount;

  // Metadata
  const characterName = chatMeta.character.name;
  const characterAvatarAssetId = chatMeta.character.avatarAssetId;
  const personaName = chatMeta.persona?.name ?? "";
  const personaAvatarAssetId = chatMeta.persona?.avatarAssetId ?? null;

  // UI State
  const isEditing = editingMessageId === input.messageId;
  const isBusy = isSending || messageActionId === input.messageId;

  const isLast = input.index === messageOrder.length - 1;
  const isLastAssistant = isLast && msg.role === "assistant";

  const isGenerating =
    !isGreeting &&
    msg.role === "assistant" &&
    isSending &&
    !pendingUserMessageContent &&
    isLastAssistant;

  const canBranch = !isGreeting;
  const canRegenerate = !isGreeting && isLastAssistant;
  const canResend = isLast && msg.role === "user" && !pendingUserMessageContent;
  const canSwitchVariant = isLast;

  // Server sets message.content = selected variant's content at load time,
  // but client-side switching only changes selectedVariantIndex.
  // Read the actual variant text directly.
  const selectedVariant = variants[selectedVariantIndex] ?? variants[0];
  const activeContent = selectedVariant ? selectedVariant.content : msg.displayContent;

  const renderContent = activeContent;
  const greetingActive = isGreeting && !isUser && variantCount > 1;

  const isStreamingHere = !isUser && messageActionId === input.messageId && (globalStreamingText || globalStreamingReasoning);
  const activeStreamingText = isStreamingHere ? globalStreamingText : null;
  const activeStreamingReasoning = isStreamingHere ? globalStreamingReasoning : null;

  const copyLabel = t("copy");
  const editLabel = t("edit");
  const branchLabel = t("branch");
  const regenLabel = t("regen");
  const deleteLabel = t("delete");
  const createdLabel = formatMessageTime(msg.createdAt);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ⚠️  FRAGILE — Variant Switch Bottom Pinning
  // ⚠️  DO NOT REMOVE OR "SIMPLIFY" without manually testing long↔short swipes.
  //
  // When the user switches variants on the last assistant message, the message
  // height can change while Framer Motion and Virtuoso are both recalculating
  // layout. Without an explicit bottom anchor, switching short → long pushes the
  // action row downward after the animation settles, so the variant arrows drift
  // away from the cursor. A tiny one-frame/12-frame scroll fix is not enough:
  // Virtuoso may still correct measurements near the end of the spring.
  //
  // This loop pins the Virtuoso scroller to its absolute bottom for the whole
  // switch window, then does one final pin. Combined with the fixed overlay for
  // the clickable arrows, this keeps the real controls and the cursor aligned
  // regardless of variant length. If this code changes, test BOTH directions:
  //   1. long variant → short variant
  //   2. short variant → long variant
  // especially at the bottom of a chat.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const pinVirtuosoToBottomDuringVariantSwitch = () => {
    bottomPinUntilRef.current = Math.max(bottomPinUntilRef.current, performance.now() + 900);
    if (bottomPinRafRef.current !== undefined) return;

    const pin = () => {
      const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      }

      if (performance.now() < bottomPinUntilRef.current) {
        bottomPinRafRef.current = window.requestAnimationFrame(pin);
      } else {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        bottomPinRafRef.current = undefined;
      }
    };

    pin();
  };

  const handleSelectVariant = (targetIndex: number, swipeDirection: SwipeDirection) => {
    const controlsRect = variantControlsOverlay?.rect ?? variantControlsRef.current?.getBoundingClientRect();
    if (!isMobile && controlsRect) {
      setVariantControlsOverlay({ rect: controlsRect });
      if (variantOverlayTimerRef.current !== undefined) window.clearTimeout(variantOverlayTimerRef.current);
      variantOverlayTimerRef.current = window.setTimeout(() => {
        setVariantControlsOverlay(null);
        variantOverlayTimerRef.current = undefined;
      }, 450);
    }

    if (!isMobile) pinVirtuosoToBottomDuringVariantSwitch();
    useSnapshotStore.getState().selectVariant(msg.id, targetIndex, swipeDirection);
    chat.handleSelectMessageVariant(msg.id, targetIndex);
  };

  // Reasoning from persisted variant data only (not streaming)
  const reasoningText = selectedVariant?.reasoning || null;
  const reasoningDuration = selectedVariant?.reasoningDurationMs ?? null;

  return (
    <>
      {showSeparator && (
        <div className={isMobile ? "mx-auto mb-1 mt-1 px-2" : sepWrap}>
          <div className="h-px bg-border opacity-40"/>
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
          <VariantControls
            overlay
            isBusy={isBusy}
            selectedVariantIndex={selectedVariantIndex}
            variantCount={variantCount}
            onSelectVariant={handleSelectVariant}
          />
        </div>,
        document.body,
      )}
      <div className={isMobile ? "relative mx-auto w-full px-3" : "relative mx-auto max-w-[min(calc(var(--mw)+160px),calc(100vw-var(--sw)-64px))] px-7"}>
        <div className={msgWrap}>
          <div className={cn(
            "mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3",
            !isUser && "text-accent-t opacity-85",
            isUser && "flex-row-reverse",
            isMobile && "gap-[7px] text-[calc(var(--ui-fs)-3px)] mb-[3px]",
          )}>
            <div className={cn(
              "shrink-0 overflow-hidden rounded-full bg-s3 font-body italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top",
                isMobile ? "flex h-11 w-11 items-center justify-center text-[calc(var(--ui-fs)+1px)]" : "flex h-11 w-11 items-center justify-center text-[calc(var(--ui-fs)+1px)]",
            )}>
              {isUser
                ? (personaAvatarAssetId
                  ? <img src={avatarUrl(personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                  : (personaName ? initials(personaName) : "Y"))
                : (characterAvatarAssetId
                  ? <img src={avatarUrl(characterAvatarAssetId)} alt={characterName} className="h-full w-full object-cover object-top" />
                  : initials(characterName))
              }
            </div>
            <span>{isUser ? personaName : characterName}</span>
            {greetingActive && (
              <span className="ml-auto flex items-center gap-1 text-[calc(var(--ui-fs)-3px)] text-t3">
                <button type="button"
                  className={cn("cursor-pointer text-t3 transition-colors duration-100", isMobile ? "active:text-accent" : "hover:text-accent")}
                  disabled={!canSwitchVariant || selectedVariantIndex <= 0}
                  onClick={() => { handleSelectVariant(Math.max(0, selectedVariantIndex - 1), -1); }}
                >◀</button>
                {t("greeting_counter").replace("{n}", String(selectedVariantIndex + 1)).replace("{total}", String(variantCount))}
                <button type="button"
                  className={cn("cursor-pointer text-t3 transition-colors duration-100", isMobile ? "active:text-accent" : "hover:text-accent")}
                  disabled={!canSwitchVariant || selectedVariantIndex >= variantCount - 1}
                  onClick={() => { handleSelectVariant(Math.min(variantCount - 1, selectedVariantIndex + 1), 1); }}
                >▶</button>
              </span>
            )}
            {/* Mobile: three-dot action menu */}
            {isMobile && !isEditing && !isGenerating && (
              <div className="relative ml-auto" ref={mobileMenuRef}>
                <div
                  className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded text-t3 transition-colors active:bg-s2"
                  onClick={() => setMobileMenuOpen(v => !v)}
                >
                  <Icons.Ellipsis />
                </div>
                {mobileMenuOpen && createPortal(
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.2)' }}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: ((mobileMenuRef.current?.getBoundingClientRect()?.bottom ?? 0) + 4) + 'px',
                        right: (window.innerWidth - (mobileMenuRef.current?.getBoundingClientRect()?.right ?? 0)) + 'px',
                        minWidth: 160,
                        background: 'var(--surface)',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                        overflow: 'hidden',
                      } as React.CSSProperties}
                      className="bg-surface"
                      onClick={e => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2.5 min-h-[44px] px-4 text-[calc(var(--ui-fs)-1px)] text-t1 active:bg-s2 cursor-pointer" onClick={() => { setMobileMenuOpen(false); void navigator.clipboard?.writeText(msg.displayContent); setCopied(true); setTimeout(() => setCopied(false), 1000); }}>
                        {copied ? <Icons.Check /> : <Icons.Copy />}<span className={copied ? 'text-success-text' : ''}>{copied ? t("copied") : copyLabel}</span>
                      </div>
                      <div className="flex items-center gap-2.5 min-h-[44px] px-4 text-[calc(var(--ui-fs)-1px)] text-t1 active:bg-s2 cursor-pointer" onClick={() => { setMobileMenuOpen(false); chat.handleStartEdit(msg); }}>
                        <Icons.Edit />{editLabel}
                      </div>
                      <div style={{ borderTop: '1px solid var(--border)' }}>
                        <div className="flex items-center gap-2.5 min-h-[44px] px-4 text-[calc(var(--ui-fs)-1px)] text-danger active:bg-danger/20 cursor-pointer" onClick={() => { setMobileMenuOpen(false); void chat.handleDeleteMessage(msg.id); }}>
                          <Icons.Trash />{deleteLabel}
                        </div>
                      </div>
                    </div>
                  </div>,
                  document.body
                )}
              </div>
            )}
          </div>

          {isEditing ? (
            <>
              <AutoTextarea
                className="w-full resize-none overflow-hidden rounded-md border border-accent bg-s2 px-3.5 py-3 font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 outline-none"
                style={{ minHeight: 140 }}
                value={editingDraft}
                onChange={e => useChatStore.getState().setEditingDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') chat.handleCancelEdit(); }}
                autoFocus
              />
              <div className="mt-1.5 flex gap-1.5">
                <button type="button"
                  className="cursor-pointer rounded-[5px] bg-accent px-3 py-[5px] font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110"
                  disabled={isBusy}
                  onClick={() => void chat.handleSaveMessageEdit(msg.id)}
                >{t("save_edit")}</button>
                <button type="button"
                  className="cursor-pointer rounded-[5px] bg-s2 px-3 py-[5px] font-ui text-xs font-medium text-t2 transition-all duration-100 hover:bg-s3"
                  disabled={isBusy}
                  onClick={chat.handleCancelEdit}
                >{t("cancel_edit")}</button>
              </div>
            </>
          ) : isUser ? (
            <div className={isMobile ? "my-0.5 rounded-md bg-user-bg" : "my-0.5 rounded-md bg-user-bg px-4 py-[13px]"} style={isMobile ? { padding: '10px 12px' } : undefined}>
              <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 opacity-88 [&_em]:italic [&_em]:text-msg-t2">
                <Markdown text={renderContent} />
              </div>
            </div>
          ) : isGenerating && !renderContent?.trim() ? (
            <div className={isMobile ? "my-0.5 w-full" : ""}>
              {(reasoningText || reasoningDuration) && (
                <MessageReasoning reasoning={reasoningText} reasoningDurationMs={reasoningDuration} />
              )}
              <div className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
                <GenerationDots label={t("generating_response")} />
              </div>
            </div>
          ) : isStreamingHere ? (
            <div className={isMobile ? "my-0.5 w-full" : ""}>
              {(activeStreamingReasoning || reasoningDuration) && (
                <MessageReasoning reasoning={activeStreamingReasoning || reasoningText} reasoningDurationMs={reasoningDuration} />
              )}
              <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
                {activeStreamingText ? <Markdown text={activeStreamingText} /> : null}
                <GenerationDots label={t("generating_response")} />
              </div>
            </div>
          ) : (
            <div>
              {!isUser && (reasoningText || reasoningDuration) && (
                <MessageReasoning reasoning={reasoningText} reasoningDurationMs={reasoningDuration} />
              )}
              {isMobile && variantCount > 1 ? (
                <MobileVariantCarousel
                  selectedVariantIndex={selectedVariantIndex}
                  variants={variants}
                  onSelectVariant={handleSelectVariant}
                />
              ) : (
                <div className="relative overflow-hidden">
                  <AnimatePresence initial={false}>
                    <motion.div
                      key={`v-${selectedVariantIndex}`}
                      initial={{ x: direction * 40, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 35 }}
                      translate="yes"
                      className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2"
                    >
                      <Markdown text={renderContent} />
                    </motion.div>
                  </AnimatePresence>
                </div>
              )}
              {isGenerating && <GenerationDots label={t("generating_response")} />}
            </div>
          )}

          {!isEditing && !isGenerating && createdLabel && (
            <MessageMetadata
              createdLabel={createdLabel}
              isUser={isUser}
              messageTokens={messageTokens}
              modelId={msg.modelId}
              tokensLabel={t("tokens_label")}
            />
          )}

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
              isGreeting={isGreeting}
              isUser={isUser}
              regenLabel={regenLabel}
              resendLabel={t("resend")}
              selectedVariantIndex={selectedVariantIndex}
              variantControlsRef={variantControlsRef}
              variantCount={variantCount}
              onBranch={() => void chat.handleFork(msg.id)}
              onCopy={() => { void navigator.clipboard?.writeText(msg.displayContent); setCopied(true); setTimeout(() => setCopied(false), 1000); }}
              onDelete={() => void chat.handleDeleteMessage(msg.id)}
              onEdit={() => chat.handleStartEdit(msg)}
              onRegenerate={() => void chat.handleRegenerateMessage(msg.id)}
              onResend={() => void chat.handleResend()}
              onSelectVariant={handleSelectVariant}
            />
          )}
          {isMobile && !isEditing && !isGenerating && (
            <MobileMessageActions
              branchLabel={branchLabel}
              canBranch={canBranch}
              canRegenerate={canRegenerate}
              canResend={canResend}
              canSwitchVariant={canSwitchVariant}
              isBusy={isBusy}
              isGreeting={isGreeting}
              isUser={isUser}
              regenLabel={regenLabel}
              resendLabel={t("resend")}
              selectedVariantIndex={selectedVariantIndex}
              variantCount={variantCount}
              onBranch={() => void chat.handleFork(msg.id)}
              onRegenerate={() => void chat.handleRegenerateMessage(msg.id)}
              onResend={() => void chat.handleResend()}
              onSelectVariant={handleSelectVariant}
            />
          )}
        </div>
      </div>
    </>
  );
});

type MobileVariantCarouselProps = {
  selectedVariantIndex: number;
  variants: { content: string }[];
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
};

// Mobile-only true carousel for assistant variants/greetings.
// It renders previous/current/next panels in a 3-wide track so the content can
// follow the finger during horizontal drag. The desktop variant controls use a
// separate bottom-pin strategy; mobile deliberately avoids that and relies on
// direct gesture interaction instead.
function MobileVariantCarousel(props: MobileVariantCarouselProps) {
  const { selectedVariantIndex, variants, onSelectVariant } = props;
  const controls = useAnimationControls();
  const viewportRef = useRef<HTMLDivElement>(null);
  const currentPanelRef = useRef<HTMLDivElement>(null);
  const isAnimatingRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const currentVariant = variants[selectedVariantIndex] ?? variants[0];
  const previousVariant = selectedVariantIndex > 0 ? variants[selectedVariantIndex - 1] : null;
  const nextVariant = selectedVariantIndex < variants.length - 1 ? variants[selectedVariantIndex + 1] : null;
  const canGoPrevious = selectedVariantIndex > 0;
  const canGoNext = selectedVariantIndex < variants.length - 1;

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateWidth = () => {
      const nextWidth = el.getBoundingClientRect().width;
      setViewportWidth((currentWidth) => Math.abs(currentWidth - nextWidth) > 0.5 ? nextWidth : currentWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The viewport must be locked to the CURRENT panel height, not the tallest
  // neighbor. Otherwise short variants show a large blank gap above the action
  // row. Height is then smoothly adjusted after the selected index changes.
  useLayoutEffect(() => {
    const el = currentPanelRef.current;
    if (!el) return;

    const updateHeight = () => {
      const nextHeight = el.getBoundingClientRect().height;
      setViewportHeight((currentHeight) => currentHeight === null || Math.abs(currentHeight - nextHeight) > 0.5 ? nextHeight : currentHeight);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [currentVariant?.content, selectedVariantIndex]);

  useLayoutEffect(() => {
    if (viewportWidth > 0) controls.set({ x: -viewportWidth });
  }, [controls, selectedVariantIndex, viewportWidth]);

  const snapToCenter = () => {
    void controls.start({
      x: -viewportWidth,
      transition: { type: "spring", stiffness: 420, damping: 38 },
    });
  };

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (isAnimatingRef.current || viewportWidth <= 0) return;

    const threshold = Math.min(120, Math.max(55, viewportWidth * 0.22));
    const shouldGoNext = canGoNext && (info.offset.x < -threshold || info.velocity.x < -650);
    const shouldGoPrevious = canGoPrevious && (info.offset.x > threshold || info.velocity.x > 650);

    if (!shouldGoNext && !shouldGoPrevious) {
      snapToCenter();
      return;
    }

    const direction: SwipeDirection = shouldGoNext ? 1 : -1;
    const targetIndex = selectedVariantIndex + direction;
    const targetX = shouldGoNext ? -viewportWidth * 2 : 0;

    isAnimatingRef.current = true;
    void controls.start({
      x: targetX,
      transition: { type: "spring", stiffness: 420, damping: 38 },
    }).then(() => {
      onSelectVariant(targetIndex, direction);
      controls.set({ x: -viewportWidth });
      isAnimatingRef.current = false;
    });
  };

  if (!currentVariant) return null;

  return (
    <motion.div
      ref={viewportRef}
      className="relative overflow-hidden"
      style={{ height: viewportHeight ?? undefined, transition: "height 180ms ease", touchAction: "pan-y" }}
    >
      <motion.div
        // `items-start` is critical: default flex stretch would force all three
        // panels to the tallest panel's height, breaking current-panel height
        // measurement and creating permanent blank space under short variants.
        className="absolute left-0 top-0 flex w-[300%] items-start"
        animate={controls}
        drag="x"
        dragConstraints={{
          left: canGoNext ? -viewportWidth * 2 : -viewportWidth,
          right: canGoPrevious ? 0 : -viewportWidth,
        }}
        // Keep vertical chat scrolling usable: Framer only captures the gesture
        // once horizontal movement wins, while CSS `touchAction: pan-y` leaves
        // normal vertical scrolling to the browser.
        dragDirectionLock
        dragElastic={0.08}
        onDragEnd={handleDragEnd}
      >
        <div className="w-1/3 shrink-0 pr-3" aria-hidden={!previousVariant}>
          {previousVariant && (
            <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
              <Markdown text={previousVariant.content} />
            </div>
          )}
        </div>
        <div ref={currentPanelRef} className="w-1/3 shrink-0" translate="yes">
          <div className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
            <Markdown text={currentVariant.content} />
          </div>
        </div>
        <div className="w-1/3 shrink-0 pl-3" aria-hidden={!nextVariant}>
          {nextVariant && (
            <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
              <Markdown text={nextVariant.content} />
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

type DesktopMessageActionsProps = {
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
  isGreeting: boolean;
  isUser: boolean;
  regenLabel: string;
  resendLabel: string;
  selectedVariantIndex: number;
  variantControlsRef: RefObject<HTMLSpanElement | null>;
  variantCount: number;
  onBranch: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onResend: () => void;
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
};

const desktopActionClass = "flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2";

function DesktopMessageActions(props: DesktopMessageActionsProps) {
  const {
    branchLabel,
    canBranch,
    canRegenerate,
    canResend,
    canSwitchVariant,
    copied,
    copiedLabel,
    copyLabel,
    editLabel,
    hiddenVariantControls,
    isBusy,
    isGreeting,
    isUser,
    regenLabel,
    resendLabel,
    selectedVariantIndex,
    variantControlsRef,
    variantCount,
    onBranch,
    onCopy,
    onDelete,
    onEdit,
    onRegenerate,
    onResend,
    onSelectVariant,
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
      {canBranch && <span className={desktopActionClass} onClick={() => { if (!isBusy) onBranch(); }}><Icons.Branch />{branchLabel}</span>}
      {canRegenerate && <span className={desktopActionClass} onClick={() => { if (!isBusy) onRegenerate(); }}><Icons.Regen />{regenLabel}</span>}

      {!isUser && !isGreeting && variantCount > 1 && canSwitchVariant && (
        <VariantControls
          controlsRef={variantControlsRef}
          hidden={hiddenVariantControls}
          isBusy={isBusy}
          selectedVariantIndex={selectedVariantIndex}
          variantCount={variantCount}
          onSelectVariant={onSelectVariant}
        />
      )}

      {!isGreeting && (
        <span
          className="absolute right-0 flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
          onClick={() => { if (!isBusy) onDelete(); }}
        ><Icons.Trash /></span>
      )}
    </div>
  );
}

type MobileMessageActionsProps = {
  branchLabel: string;
  canBranch: boolean;
  canRegenerate: boolean;
  canResend: boolean;
  canSwitchVariant: boolean;
  isBusy: boolean;
  isGreeting: boolean;
  isUser: boolean;
  regenLabel: string;
  resendLabel: string;
  selectedVariantIndex: number;
  variantCount: number;
  onBranch: () => void;
  onRegenerate: () => void;
  onResend: () => void;
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
};

function MobileMessageActions(props: MobileMessageActionsProps) {
  const {
    branchLabel,
    canBranch,
    canRegenerate,
    canResend,
    canSwitchVariant,
    isBusy,
    isGreeting,
    isUser,
    regenLabel,
    resendLabel,
    selectedVariantIndex,
    variantCount,
    onBranch,
    onRegenerate,
    onResend,
    onSelectVariant,
  } = props;

  return (
    <div className="mt-1.5 flex items-center gap-3">
      {canResend && (
        <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { if (!isBusy) onResend(); }} title={resendLabel}>
          <Icons.Regen />
        </div>
      )}
      {canRegenerate && (
        <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { if (!isBusy) onRegenerate(); }} title={regenLabel}>
          <Icons.Regen />
        </div>
      )}
      {canBranch && (
        <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { if (!isBusy) onBranch(); }} title={branchLabel}>
          <Icons.Branch />
        </div>
      )}
      {!isUser && !isGreeting && variantCount > 1 && canSwitchVariant && (
        <VariantControls
          mobile
          isBusy={isBusy}
          selectedVariantIndex={selectedVariantIndex}
          variantCount={variantCount}
          onSelectVariant={onSelectVariant}
        />
      )}
    </div>
  );
}

type MessageMetadataProps = {
  createdLabel: string;
  isUser: boolean;
  messageTokens: number;
  modelId?: string | null;
  tokensLabel: string;
};

function MessageMetadata(props: MessageMetadataProps) {
  const { createdLabel, isUser, messageTokens, modelId, tokensLabel } = props;
  return (
    <div className="mt-1 flex items-center gap-2 font-ui text-[calc(var(--ui-fs)-4px)] text-t3/50">
      {createdLabel}
      <span className="tabular-nums">{messageTokens} {tokensLabel}</span>
      {!isUser && modelId && <span>{resolveModelLabel(modelId)}</span>}
    </div>
  );
}

function GenerationDots(props: { label: string }) {
  return (
    <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={props.label}>
      <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
      <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
      <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
    </span>
  );
}

type VariantControlsProps = {
  isBusy: boolean;
  selectedVariantIndex: number;
  variantCount: number;
  controlsRef?: RefObject<HTMLSpanElement | null>;
  hidden?: boolean;
  mobile?: boolean;
  overlay?: boolean;
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
};

function VariantControls(props: VariantControlsProps) {
  const { controlsRef, hidden = false, isBusy, selectedVariantIndex, variantCount, mobile = false, overlay = false, onSelectVariant } = props;

  const canGoPrevious = !isBusy && selectedVariantIndex > 0;
  const canGoNext = !isBusy && selectedVariantIndex < variantCount - 1;
  const selectPrevious = () => { if (canGoPrevious) onSelectVariant(selectedVariantIndex - 1, -1); };
  const selectNext = () => { if (canGoNext) onSelectVariant(selectedVariantIndex + 1, 1); };

  if (mobile) {
    return (
      <>
        <div className="mx-1 h-4 w-px bg-border"/>
        <div
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2"
          onClick={selectPrevious}
        ><Icons.Caret direction="l" /></div>
        <span className="min-w-6 text-center text-[12px] tabular-nums text-t3">{selectedVariantIndex + 1}/{variantCount}</span>
        <div
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2"
          onClick={selectNext}
        ><Icons.Caret direction="r" /></div>
      </>
    );
  }

  return (
    <span
      ref={controlsRef}
      className={cn(
        "flex items-center gap-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3",
        !overlay && "ml-auto mr-auto",
      )}
      style={hidden ? { visibility: "hidden" } : undefined}
    >
      <button type="button"
        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
        disabled={!canGoPrevious}
        onClick={selectPrevious}
      ><Icons.Caret direction="l" /></button>
      <span className="min-w-6 text-center tabular-nums">{selectedVariantIndex + 1}/{variantCount}</span>
      <button type="button"
        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
        disabled={!canGoNext}
        onClick={selectNext}
      ><Icons.Caret direction="r" /></button>
    </span>
  );
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isBreakoutRole(role: string): boolean {
  return role === "tool";
}

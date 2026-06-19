import { memo, useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { motion, AnimatePresence, useAnimationControls, type PanInfo } from "framer-motion";
import { cn } from "../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { Markdown } from "../../lib/markdown.js";
import { useDisplayMessage, useChatMeta, useMacroContext, useMessageAuthor, useIsStreamingTarget, useStreamingRevealedFor } from "../../stores/chat-selectors.js";
import { useChatStore, useActiveGeneration, useIsSending } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import type { MessageBlockProps } from "../play/play-mode-types.js";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { useT } from "../../i18n/context.js";
import "./MessageReasoning.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { replaceUiMacros } from "../../lib/macros.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { MessageShell, type MessageShellAuthorInfo } from "./MessageShell.js";
import { Modal } from "../shared/Modal.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { AttachmentGrid } from "./AttachmentGrid.js";

type SwipeDirection = -1 | 1;

type VariantControlsOverlayState = {
  rect: DOMRectReadOnly;
};

export const MessageBlock = memo(function MessageBlock(input: MessageBlockProps) {
  const { t } = useT();
  const chat = useChatController();
  const [copied, setCopied] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [variantControlsOverlay, setVariantControlsOverlay] = useState<VariantControlsOverlayState | null>(null);
  const variantControlsRef = useRef<HTMLSpanElement>(null);
  const variantOverlayTimerRef = useRef<number | undefined>(undefined);
  const bottomPinRafRef = useRef<number | undefined>(undefined);
  const bottomPinUntilRef = useRef(0);

  // Read ALL display data from memoized selector — re-renders only when THIS message changes
  const msg = useDisplayMessage(input.messageId);
  const authorInfo = useMessageAuthor();
  const macroContext = useMacroContext();

  const editingMessageId = useChatStore(s => s.editingMessageId);
  const editingDraft = useChatStore(s => s.editingDraft);
  const isSending = useIsSending();
  const messageActionId = useChatStore(s => s.messageActionId);
  // Narrow primitive selector — only the active chat's pending user content.
  // Replaces reading it off the whole activeGen object (which mutated every tick).
  const pendingUserMessageContent = useChatStore(s => {
    if (!s.activeChatId) return null;
    return s.generations[s.activeChatId]?.pendingUserMessageContent ?? null;
  });
  // Source-agnostic streaming identity: reads streamingMessageId, so non-target
  // blocks get `false` / EMPTY and never re-render on a streaming tick.
  const isStreamingTarget = useIsStreamingTarget(input.messageId);
  const streamingReveal = useStreamingRevealedFor(input.messageId);

  // ── ALL hooks must be called before any early return (React Rules of Hooks) ──

  // Macros for variants — use safe defaults when msg is null
  const variants = useMemo(() => {
    if (!msg?.variants || !macroContext) return msg?.variants ?? [];
    return msg.variants.map(v => ({
      ...v,
      content: replaceUiMacros(v.content, macroContext),
    }));
  }, [msg?.variants, macroContext]);

  const selectedVariantDbIndex = msg?.selectedVariantIndex ?? null;
  const selectedVariantIndex = useMemo(() => {
    if (variants.length === 0) return 0;
    if (selectedVariantDbIndex !== null) {
      const position = variants.findIndex((variant) => variant.variantIndex === selectedVariantDbIndex);
      if (position >= 0) return position;
    }
    const selectedFlagPosition = variants.findIndex((variant) => variant.isSelected);
    return selectedFlagPosition >= 0 ? selectedFlagPosition : 0;
  }, [variants, selectedVariantDbIndex]);
  const variantCount = variants.length;

  // Greeting logic
  const isGreeting = !!msg && input.isFirstAssistant;
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

  // Streaming text — only populated for the streaming-target block (see
  // useStreamingRevealedFor). Non-target blocks receive the stable EMPTY
  // sentinel, so these are "" and never trigger downstream re-renders.
  const globalStreamingText = streamingReveal.streamingText;
  const globalStreamingRevealedText = streamingReveal.revealedText;
  const globalStreamingReasoning = streamingReveal.reasoningText;

  // Separator logic — uses the hoisted prevRole prop instead of subscribing
  // to the full messageOrder array.
  const showSeparator = useMemo(() => {
    if (input.index === 0 || !input.prevRole || !msg) return false;
    return !isBreakoutRole(input.prevRole) && !isBreakoutRole(msg.role);
  }, [input.index, input.prevRole, msg?.role]);

  // ── EARLY RETURN — after all hooks ──
  const isMobile = useIsMobile();

  if (input.messageId === "__pending-user") {
    return <PendingUserMessage />;
  }
  if (input.messageId === "__pending-assistant") {
    return <PendingAssistantMessage />;
  }

  if (!msg || !authorInfo) return null;

  // ── Derived values (non-hook, safe to be after return) ──

  // Author info
  const author: MessageShellAuthorInfo = isUser
    ? { name: authorInfo.persona?.name ?? "", avatarAssetId: authorInfo.persona?.avatarAssetId ?? null, avatarCropJson: authorInfo.persona?.avatarCropJson ?? null, avatarSrc: authorInfo.persona ? resolveEntityAvatarUrl({ kind: "personas", id: authorInfo.persona.id, avatarExt: authorInfo.persona.avatarExt, avatarAssetId: authorInfo.persona.avatarAssetId, updatedAt: authorInfo.persona.updatedAt }) : null }
    : { name: authorInfo.character.name, avatarAssetId: authorInfo.character.avatarAssetId, avatarCropJson: authorInfo.character.avatarCropJson, avatarSrc: resolveEntityAvatarUrl({ kind: "characters", id: authorInfo.character.id, avatarExt: authorInfo.character.avatarExt, avatarAssetId: authorInfo.character.avatarAssetId, updatedAt: authorInfo.character.updatedAt }) };

  // UI State
  const isEditing = editingMessageId === input.messageId;
  const isBusy = isSending || messageActionId === input.messageId;

  const isLast = input.isLast;
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
  const selectedVariantBackendIndex = selectedVariant?.variantIndex ?? selectedVariantIndex;
  const activeContent = selectedVariant ? selectedVariant.content : msg.displayContent;

  const renderContent = activeContent;
  const greetingActive = isGreeting && !isUser && variantCount > 1;

  const isStreamingHere = !isUser && isStreamingTarget && (globalStreamingText || globalStreamingReasoning);
  const activeStreamingText = isStreamingHere ? globalStreamingText : null;
  const activeStreamingRevealedText = isStreamingHere ? globalStreamingRevealedText : "";
  const activeStreamingReasoning = isStreamingHere ? globalStreamingReasoning : null;

  // Reasoning from persisted variant data only (not streaming)
  const reasoningText = selectedVariant?.reasoning || null;
  const reasoningDuration = selectedVariant?.reasoningDurationMs ?? null;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ⚠️  FRAGILE — Variant Switch Bottom Pinning
  // ⚠️  DO NOT REMOVE OR "SIMPLIFY" without manually testing long↔short swipes.
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

    if (!isMobile && !isGreeting) pinVirtuosoToBottomDuringVariantSwitch();
    const targetVariant = variants[targetIndex];
    if (!targetVariant) return;
    useSnapshotStore.getState().selectVariant(msg.id, targetVariant.variantIndex, swipeDirection);
    chat.handleSelectMessageVariant(msg.id, targetVariant.variantIndex);
  };

  // ── Greeting counter controls ──
  const greetingControls = greetingActive ? (
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
  ) : undefined;

  // ── Variant controls (desktop) ──
  const desktopVariantControls = (
    <VariantControls
      controlsRef={variantControlsRef}
      hidden={!!variantControlsOverlay}
      isBusy={isBusy}
      selectedVariantIndex={selectedVariantIndex}
      variantCount={variantCount}
      onSelectVariant={handleSelectVariant}
    />
  );

  // ── Variant controls (mobile) ──
  const mobileVariantControls = (
    <VariantControls
      mobile
      isBusy={isBusy}
      selectedVariantIndex={selectedVariantIndex}
      variantCount={variantCount}
      onSelectVariant={handleSelectVariant}
    />
  );

  const reasoningForSlot = !isUser && !isEditing
    ? {
        reasoning: isStreamingHere ? (activeStreamingReasoning || reasoningText) : reasoningText,
        reasoningDurationMs: reasoningDuration,
      }
    : null;

  // ── Message content rendering ──
  const messageContent = isEditing ? (
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
      <AttachmentGrid attachments={msg.attachments} messageId={msg.id} />
    </div>
  ) : isGenerating && !renderContent?.trim() ? (
    <div className={isMobile ? "my-0.5 w-full" : ""}>
      <div className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
        <GenerationDots label={t("generating_response")} />
      </div>
    </div>
  ) : isStreamingHere ? (
    <div className={isMobile ? "my-0.5 w-full" : ""}>
      <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
        {activeStreamingText ? <StreamingMarkdown text={activeStreamingRevealedText} /> : null}
        <GenerationDots label={t("generating_response")} />
      </div>
    </div>
  ) : (
    <div>
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
      <AttachmentGrid attachments={msg.attachments} messageId={msg.id} />
      {isGenerating && <GenerationDots label={t("generating_response")} />}
    </div>
  );

  const confirmDeleteMessage = async () => {
    setDeleteConfirmOpen(false);
    await chat.handleDeleteMessage(msg.id);
  };

  const confirmDeleteVariant = async () => {
    setDeleteConfirmOpen(false);
    await chat.handleDeleteVariant(msg.id, selectedVariantBackendIndex);
  };

  return (
    <>
    {deleteConfirmOpen && (
      <DeleteMessageConfirm
        hasSwipes={variantCount > 1}
        onDeleteSwipe={() => void confirmDeleteVariant()}
        onDeleteMessage={() => void confirmDeleteMessage()}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    )}
    <MessageShell
      messageId={msg.id}
      chatId={authorInfo.activeChatId}
      role={msg.role}
      showSeparator={showSeparator}
      author={author}
      isUser={isUser}
      isGreeting={isGreeting}
      isEditing={isEditing}
      isGenerating={isGenerating}
      isBusy={isBusy}
      canBranch={canBranch}
      canRegenerate={canRegenerate}
      canResend={canResend}
      selectedVariantIndex={selectedVariantIndex}
      variantCount={variantCount}
      canSwitchVariant={canSwitchVariant}
      tokenCount={msg.tokenCount}
      modelId={msg.modelId}
      createdAt={msg.createdAt}
      copied={copied}
      slotExtras={{ reasoning: reasoningForSlot }}
      variantControlsOverlay={variantControlsOverlay}
      variantControlsRef={variantControlsRef}
      greetingControls={greetingControls}
      desktopVariantControls={desktopVariantControls}
      mobileVariantControls={mobileVariantControls}
      actions={{
        onCopy: () => { void navigator.clipboard?.writeText(msg.displayContent); setCopied(true); setTimeout(() => setCopied(false), 1000); },
        onEdit: () => chat.handleStartEdit(msg),
        onDelete: () => setDeleteConfirmOpen(true),
        onBranch: () => void chat.handleFork(msg.id),
        onRegenerate: () => void chat.handleRegenerateMessage(msg.id),
        onResend: () => void chat.handleResend(),
      }}
    >
      {messageContent}
    </MessageShell>
    </>
  );
});

function DeleteMessageConfirm(input: {
  hasSwipes: boolean;
  onDeleteSwipe: () => void;
  onDeleteMessage: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const btnBase = "h-[37px] cursor-pointer rounded-md px-4 font-ui text-[calc(var(--ui-fs)-2px)] transition-all";

  return (
    <Modal
      open={true}
      onClose={input.onCancel}
      compact
      title={t("delete_message_title")}
      description={t("delete_message_body")}
    >
      <div className="w-[640px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-border bg-surface shadow-theme-lg">
        <div className="border-b border-border px-5 py-4">
          <div className="font-ui text-sm font-semibold text-t1">{t("delete_message_title")}</div>
          <div className="mt-1 font-ui text-xs leading-relaxed text-t3">{t("delete_message_body")}</div>
        </div>
        <div className="flex flex-nowrap justify-end gap-2 px-5 py-3">
          <button type="button" className={`${btnBase} shrink-0 whitespace-nowrap bg-transparent text-t3 hover:text-t1`} onClick={input.onCancel}>
            {t("cancel_btn")}
          </button>
          {input.hasSwipes && (
            <button type="button" className={`${btnBase} shrink-0 whitespace-nowrap bg-s2 text-t1 hover:bg-s3`} onClick={input.onDeleteSwipe}>
              {t("delete_swipe_btn")}
            </button>
          )}
          <button type="button" className={`${btnBase} shrink-0 whitespace-nowrap bg-danger font-medium text-on-danger hover:brightness-110`} onClick={input.onDeleteMessage}>
            {input.hasSwipes ? t("delete_message_btn") : t("delete")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Mobile Variant Carousel
// ────────────────────────────────────────────────────────────────────────────

type MobileVariantCarouselProps = {
  selectedVariantIndex: number;
  variants: { content: string }[];
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
};

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

    const swipeDirection: SwipeDirection = shouldGoNext ? 1 : -1;
    const targetIndex = selectedVariantIndex + swipeDirection;
    const targetX = shouldGoNext ? -viewportWidth * 2 : 0;

    isAnimatingRef.current = true;
    void controls.start({
      x: targetX,
      transition: { type: "spring", stiffness: 420, damping: 38 },
    }).then(() => {
      onSelectVariant(targetIndex, swipeDirection);
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
        className="absolute left-0 top-0 flex w-[300%] items-start"
        animate={controls}
        drag="x"
        dragConstraints={{
          left: canGoNext ? -viewportWidth * 2 : -viewportWidth,
          right: canGoPrevious ? 0 : -viewportWidth,
        }}
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

// ────────────────────────────────────────────────────────────────────────────
// Generation Dots
// ────────────────────────────────────────────────────────────────────────────

function GenerationDots(props: { label: string }) {
  return (
    <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={props.label}>
      <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
      <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
      <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Variant Controls
// ────────────────────────────────────────────────────────────────────────────

type VariantControlsProps = {
  isBusy: boolean;
  selectedVariantIndex: number;
  variantCount: number;
  controlsRef?: React.RefObject<HTMLSpanElement | null>;
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
      <div className="inline-flex items-center justify-center gap-1 rounded-lg bg-s1/60 px-1 py-0.5">
        <button
          type="button"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:opacity-35 [&_svg]:h-5 [&_svg]:w-5"
          disabled={!canGoPrevious}
          onClick={selectPrevious}
        ><Icons.Caret direction="l" /></button>
        <span className="min-w-12 text-center font-ui text-[13px] tabular-nums text-t2">{selectedVariantIndex + 1}/{variantCount}</span>
        <button
          type="button"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:opacity-35 [&_svg]:h-5 [&_svg]:w-5"
          disabled={!canGoNext}
          onClick={selectNext}
        ><Icons.Caret direction="r" /></button>
      </div>
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

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

function isBreakoutRole(role: string): boolean {
  return role === "tool";
}

function PendingUserMessage() {
  const chatMeta = useChatMeta();
  const activeGen = useActiveGeneration();
  const isMobile = useIsMobile();
  const macroContext = useMacroContext();
  const variantControlsRef = useRef<HTMLSpanElement>(null);
  if (!chatMeta || !activeGen) return null;

  const content = activeGen.pendingUserMessageContent ?? "";
  const pendingAttachments = activeGen.pendingUserMessageAttachments ?? [];
  const displayContent = macroContext ? replaceUiMacros(content, macroContext) : content;
  const author = { name: chatMeta.persona?.name ?? "", avatarAssetId: chatMeta.persona?.avatarAssetId ?? null, avatarCropJson: chatMeta.persona?.avatarCropJson ?? null, avatarSrc: chatMeta.persona ? resolveEntityAvatarUrl({ kind: "personas", id: chatMeta.persona.id, avatarExt: chatMeta.persona.avatarExt, avatarAssetId: chatMeta.persona.avatarAssetId, updatedAt: chatMeta.persona.updatedAt }) : null };

  return (
    <MessageShell
      messageId="__pending-user"
      chatId={chatMeta.activeChat?.id ?? ""}
      role="user"
      showSeparator={true}
      author={author}
      isUser={true}
      isGreeting={false}
      isEditing={false}
      isGenerating={false}
      isBusy={true}
      canBranch={false}
      canRegenerate={false}
      canResend={false}
      selectedVariantIndex={0}
      variantCount={1}
      canSwitchVariant={false}
      tokenCount={0}
      modelId=""
      createdAt={Date.now().toString()}
      copied={false}
      slotExtras={{}}
      variantControlsOverlay={null}
      variantControlsRef={variantControlsRef}
      actions={{
        onCopy: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onBranch: () => {},
        onRegenerate: () => {},
        onResend: () => {},
      }}
    >
      <div className={isMobile ? "my-0.5 rounded-md bg-user-bg" : "my-0.5 rounded-md bg-user-bg px-4 py-[13px]"} style={isMobile ? { padding: '10px 12px' } : undefined}>
        <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 opacity-88 [&_em]:italic [&_em]:text-msg-t2">
          <Markdown text={displayContent} />
        </div>
        <AttachmentGrid attachments={pendingAttachments} messageId={undefined} />
      </div>
    </MessageShell>
  );
}

function PendingAssistantMessage() {
  const { t } = useT();
  const chatMeta = useChatMeta();
  const activeGen = useActiveGeneration();
  const isMobile = useIsMobile();
  const variantControlsRef = useRef<HTMLSpanElement>(null);
  if (!chatMeta || !activeGen) return null;

  const author = { name: chatMeta.character.name, avatarAssetId: chatMeta.character.avatarAssetId, avatarCropJson: chatMeta.character.avatarCropJson, avatarSrc: resolveEntityAvatarUrl({ kind: "characters", id: chatMeta.character.id, avatarExt: chatMeta.character.avatarExt, avatarAssetId: chatMeta.character.avatarAssetId, updatedAt: chatMeta.character.updatedAt }) };
  const streamingText = activeGen.streamingText;
  const streamingRevealedText = activeGen.streamingRevealedText;
  const streamingReasoning = activeGen.streamingReasoningText;

  const reasoningForSlot = streamingReasoning ? {
    reasoning: streamingReasoning,
    reasoningDurationMs: null,
  } : null;

  return (
    <MessageShell
      messageId="__pending-assistant"
      chatId={chatMeta.activeChat?.id ?? ""}
      role="assistant"
      showSeparator={true}
      author={author}
      isUser={false}
      isGreeting={false}
      isEditing={false}
      isGenerating={true}
      isBusy={true}
      canBranch={false}
      canRegenerate={false}
      canResend={false}
      selectedVariantIndex={0}
      variantCount={1}
      canSwitchVariant={false}
      tokenCount={0}
      modelId=""
      createdAt={Date.now().toString()}
      copied={false}
      slotExtras={{ reasoning: reasoningForSlot }}
      variantControlsOverlay={null}
      variantControlsRef={variantControlsRef}
      actions={{
        onCopy: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onBranch: () => {},
        onRegenerate: () => {},
        onResend: () => {},
      }}
    >
      <div className={isMobile ? "my-0.5 w-full" : ""}>
        <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
          {streamingText ? <StreamingMarkdown text={streamingRevealedText} /> : null}
          <GenerationDots label={t("generating_response")} />
        </div>
      </div>
    </MessageShell>
  );
}

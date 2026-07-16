import { memo, useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { motion, AnimatePresence, useAnimationControls, type PanInfo } from "framer-motion";
import { cn } from "../../lib/cn.js";
import { resolveModelLabel } from "../../lib/model-resolve.js";
import type { MessageMetaContext } from "../../lib/message-meta-registry.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { Markdown } from "../../lib/markdown.js";

import { BottomSheet } from "../shared/BottomSheet.js";
import * as Select from "@radix-ui/react-select";
import { useDisplayMessage, useMacroContext, useMessageAuthor, useIsStreamingTarget, useStreamingRevealedFor } from "../../stores/chat-selectors.js";
import { useChatStore, useIsSending } from "../../stores/index.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import type { MessageBlockProps } from "../play/play-mode-types.js";
import { Icons } from "../shared/icons.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { useT } from "../../i18n/context.js";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import "./MessageReasoning.js";
import "./CoauthorToolActivitySlot.js";
import "./message-slots/objective-zone.js";
import "./message-slots/scene-zone.js";
import { useSceneGenerationStore, isVariantSceneGenerating } from "../../stores/scene-generation-store.js";
import { cancelSceneAction } from "../../stores/api-actions/chat-actions.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { replaceUiMacros } from "../../lib/macros.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { MessageShell, type MessageShellAuthorInfo } from "./MessageShell.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { AttachmentGrid } from "./AttachmentGrid.js";
import { MobileVariantCarousel } from "./variants/mobile-variant-carousel.js";
import { VariantControls } from "./variants/variant-controls.js";
import { GenerationDots } from "./variants/generation-dots.js";
import type { SwipeDirection, VariantProvenance } from "./variants/types.js";
import { PendingUserMessage } from "./pending/pending-user-message.js";
import { PendingAssistantMessage } from "./pending/pending-assistant-message.js";

/** Stable empty array for the variantProvenance fallback (variantCount <= 6). */
const EMPTY_PROVENANCE: VariantProvenance[] = [];

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
  const isCoauthorMode = useSnapshotStore(s => s.activeChat?.mode === "coauthor");
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
      content: isCoauthorMode ? v.content : replaceUiMacros(v.content, macroContext),
    }));
  }, [msg?.variants, macroContext, isCoauthorMode]);

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

  // ── All hooks below MUST run before any early return (React Rules of Hooks).
  // During a chat switch, `clearMessages()` makes `msg` null on a already-mounted
  // MessageBlock. If we early-return before finishing the hook list, React
  // detects fewer hooks than the previous render → React error #300 → blank page.
  const isMobile = useIsMobile();
  const promptPresets = useBootstrapStore((s) => s.data?.promptPresets ?? null);
  const selectedVariant = variants[selectedVariantIndex] ?? variants[0];
  const presetName = useMemo(() => {
    const pid = selectedVariant?.presetId ?? null;
    if (!pid || !promptPresets) return null;
    return promptPresets.find((p) => p.id === pid)?.name ?? null;
  }, [selectedVariant?.presetId, promptPresets]);
  // Q5: per-variant provenance for the jump dropdown (>6 variants). Resolves
  // modelLabel + presetName for EVERY variant once; the dropdown rows read from
  // this. Skipped when variantCount <= 6 (the simple counter stays).
  const variantProvenance = useMemo(() => {
    if (variantCount <= 6) return EMPTY_PROVENANCE;
    return variants.map((v) => ({
      modelLabel: v.modelId ? resolveModelLabel(v.modelId) : "",
      presetName: v.presetId && promptPresets ? promptPresets.find((p) => p.id === v.presetId)?.name ?? null : null,
    }));
  }, [variants, variantCount, promptPresets]);


  if (input.messageId === "__pending-user") {
    return <PendingUserMessage />;
  }
  if (input.messageId === "__pending-assistant") {
    return <PendingAssistantMessage />;
  }

  if (!msg || !authorInfo) return null;

  // ── Derived values (non-hook, safe to be after return) ──

  // Author info
  const author: MessageShellAuthorInfo = input.authorOverride ?? (isUser
    ? { name: authorInfo.persona?.name ?? "", avatarAssetId: authorInfo.persona?.avatarAssetId ?? null, avatarCropJson: authorInfo.persona?.avatarCropJson ?? null, avatarSrc: authorInfo.persona ? resolveEntityAvatarUrl({ kind: "personas", id: authorInfo.persona.id, avatarExt: authorInfo.persona.avatarExt, avatarAssetId: authorInfo.persona.avatarAssetId, updatedAt: authorInfo.persona.updatedAt }) : null }
    : { name: authorInfo.character.name, avatarAssetId: authorInfo.character.avatarAssetId, avatarCropJson: authorInfo.character.avatarCropJson, avatarSrc: resolveEntityAvatarUrl({ kind: "characters", id: authorInfo.character.id, avatarExt: authorInfo.character.avatarExt, avatarAssetId: authorInfo.character.avatarAssetId, updatedAt: authorInfo.character.updatedAt }) });

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

  const canBranch = !isGreeting && !isCoauthorMode;
  const canRegenerate = !isGreeting && isLastAssistant && !isCoauthorMode;
  const canResend = isLast && msg.role === "user" && !pendingUserMessageContent;
  const canSwitchVariant = isLast && !isCoauthorMode;

  // Server sets message.content = selected variant's content at load time,
  // but client-side switching only changes selectedVariantIndex.
  // Read the actual variant text directly.
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
      {t("greeting_counter", { n: selectedVariantIndex + 1, total: variantCount })}
      <button type="button"
        className={cn("cursor-pointer text-t3 transition-colors duration-100", isMobile ? "active:text-accent" : "hover:text-accent")}
        disabled={!canSwitchVariant || selectedVariantIndex >= variantCount - 1}
        onClick={() => { handleSelectVariant(Math.min(variantCount - 1, selectedVariantIndex + 1), 1); }}
      >▶</button>
    </span>
  ) : undefined;

  const desktopVariantControls = (
    <VariantControls
      controlsRef={variantControlsRef}
      hidden={!!variantControlsOverlay}
      isBusy={isBusy}
      selectedVariantIndex={selectedVariantIndex}
      variantCount={variantCount}
      provenance={variantProvenance}
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
      provenance={variantProvenance}
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
      <MobileExpandTextarea
        value={editingDraft}
        onChange={(v) => useChatStore.getState().setEditingDraft(v)}
        label={t("edit")}
      >
        <AutoTextarea
          className="w-full resize-none overflow-hidden rounded-md border border-accent bg-s2 px-3.5 py-3 font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 outline-none"
          style={{}}
          minRows={7}
          value={editingDraft}
          onChange={e => useChatStore.getState().setEditingDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') chat.handleCancelEdit(); }}
          autoFocus
        />
      </MobileExpandTextarea>
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
    // SCN-13: cancel any in-flight Scene job for this message's variants before
    // the delete removes the rows, so the coordinator slot is freed. Best-effort
    // — a cancel failure must not block the user's delete.
    const chatId = brandId<ChatId>(authorInfo.activeChatId);
    const gen = useSceneGenerationStore.getState().generating;
    for (const v of msg.variants) {
      if (gen.has(v.id)) {
        try { await cancelSceneAction(chatId, { branchId: msg.branchId, messageId: msg.id, variantId: v.id }); }
        catch { /* best-effort: delete proceeds regardless */ }
      }
    }
    await chat.handleDeleteMessage(msg.id);
  };

  const confirmDeleteVariant = async () => {
    setDeleteConfirmOpen(false);
    // SCN-13: cancel the selected variant's Scene job (if generating) before
    // deleting the variant, freeing the coordinator slot.
    const variantId = selectedVariant?.id;
    const chatId = brandId<ChatId>(authorInfo.activeChatId);
    if (variantId && isVariantSceneGenerating(variantId)) {
      try { await cancelSceneAction(chatId, { branchId: msg.branchId, messageId: msg.id, variantId }); }
      catch { /* best-effort: delete proceeds regardless */ }
    }
    await chat.handleDeleteVariant(msg.id, selectedVariantBackendIndex);
  };

  const hasSwipes = variantCount > 1 && !isCoauthorMode;

  // Edit entrypoint. Editing is NEVER blocked by Scene generation: the record
  // is a persisted fact, and a concurrent Scene job simply discards its result
  // on the source-content drift check at commit, leaving the prior record intact.
  const handleEditClick = async () => {
    if (isBusy) return;
    chat.handleStartEdit(msg);
  };

  // ── Message metadata context (variant-scoped provenance) ──
  const metaCtx: MessageMetaContext = {
    chatId: authorInfo.activeChatId,
    messageId: msg.id,
    messageRole: msg.role,
    variant: selectedVariant ?? null,
    variantIndex: selectedVariantIndex,
    isStreaming: isGenerating,
    isCoauthorTurn: false,
    presetName,
    tokenCount: msg.tokenCount,
    createdAt: msg.createdAt,
  };

  return (
    <>
    {deleteConfirmOpen && (
      <DestructiveConfirmModal
        title={t("delete_message_title")}
        body={t("delete_message_body")}
        confirmLabel={t(hasSwipes ? "delete_message_btn" : "delete")}
        onConfirm={() => void confirmDeleteMessage()}
        onCancel={() => setDeleteConfirmOpen(false)}
        secondaryLabel={hasSwipes ? t("delete_swipe_btn") : undefined}
        onSecondary={hasSwipes ? () => void confirmDeleteVariant() : undefined}
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
      isBranching={messageActionId === input.messageId}
      canBranch={canBranch}
      canRegenerate={canRegenerate}
      canResend={canResend}
      selectedVariantIndex={selectedVariantIndex}
      variantCount={isCoauthorMode ? 1 : variantCount}
      canSwitchVariant={canSwitchVariant}
      metaCtx={metaCtx}
      copied={copied}
      slotExtras={{ reasoning: reasoningForSlot }}
      variantControlsOverlay={variantControlsOverlay}
      variantControlsRef={variantControlsRef}
      greetingControls={greetingControls}
      desktopVariantControls={desktopVariantControls}
      mobileVariantControls={mobileVariantControls}
      actions={{
        onCopy: () => { void navigator.clipboard?.writeText(msg.displayContent); setCopied(true); setTimeout(() => setCopied(false), 1000); },
        onEdit: () => void handleEditClick(),
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


// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

function isBreakoutRole(role: string): boolean {
  return role === "tool";
}


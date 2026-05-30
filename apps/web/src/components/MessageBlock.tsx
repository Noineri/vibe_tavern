import { memo, useState, useMemo, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "../lib/cn.js";
import { Markdown } from "../lib/markdown.js";
import { avatarUrl } from "../lib/avatar.js";
import { initials } from "./app-shell-helpers.js";
import { useDisplayMessage, useChatMeta, useMessageOrder, useMacroContext } from "../stores/chat-selectors.js";
import { useChatStore, useActiveGeneration, useIsSending } from "../stores/index.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import type { MessageBlockProps } from "./play-mode-types.js";
import { Icons } from "./shared/icons.js";
import { AutoTextarea } from "./shared/auto-textarea.js";
import { useT } from "../i18n/context.js";
import { MessageReasoning } from "./MessageReasoning.js";
import { useChatController } from "../hooks/use-chat-controller.js";
import { replaceUiMacros } from "../lib/macros.js";
import { resolveModelLabel } from "../lib/model-resolve.js";
import { useIsMobile } from "../hooks/use-mobile.js";

const msgWrap = "relative group py-2.5";
const sepWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7 my-[6px] mt-2";

export const MessageBlock = memo(function MessageBlock(input: MessageBlockProps) {
  const { t } = useT();
  const chat = useChatController();
  const [copied, setCopied] = useState(false);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

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

  const alternateGreetings = useMemo(() => {
    if (!isGreeting || !macroContext || !chatMeta) return [];
    return chatMeta.character.alternateGreetings.map(g => replaceUiMacros(g, macroContext));
  }, [isGreeting, macroContext, chatMeta?.character?.alternateGreetings]);

  const greetingOptions = useMemo(() => {
    if (!isGreeting || !msg) return undefined;
    return [msg.displayContent, ...alternateGreetings];
  }, [isGreeting, msg?.displayContent, alternateGreetings]);

  const isUser = msg?.role === "user";
  const greetingActive = !isUser && !!greetingOptions && greetingOptions.length > 1;

  // -- Variant slide: direction derived locally to prevent phantom renders --
  const prevVariantIndexRef = useRef(selectedVariantIndex);
  const prevGreetingIndexRef = useRef(greetingIndex);
  const directionRef = useRef(1);

  if (selectedVariantIndex !== prevVariantIndexRef.current) {
    directionRef.current = selectedVariantIndex > prevVariantIndexRef.current ? 1 : -1;
    prevVariantIndexRef.current = selectedVariantIndex;
  }
  if (greetingIndex !== prevGreetingIndexRef.current) {
    directionRef.current = greetingIndex > prevGreetingIndexRef.current ? 1 : -1;
    prevGreetingIndexRef.current = greetingIndex;
  }
  const direction = directionRef.current;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ⚠️  FRAGILE — Synchronous Scroll Anchoring (SillyTavern style)
  // ⚠️  DO NOT TOUCH unless absolutely necessary.
  //
  // This keeps the scroll pinned to the bottom when swiping between variants
  // of different lengths. It measures the bottom edge delta synchronously
  // in useLayoutEffect (before paint) and adjusts the Virtuoso scroller.
  //
  // Breaking this = scroll jumps on every swipe. You have been warned.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const msgWrapRef = useRef<HTMLDivElement>(null);
  const lastBottomRef = useRef<number | undefined>(undefined);
  const isSwipingRef = useRef(false);

  useLayoutEffect(() => {
    const el = msgWrapRef.current;
    if (!el) return;

    const currentBottom = el.getBoundingClientRect().bottom;
    const prevBottom = lastBottomRef.current;

    if (isSwipingRef.current) {
      if (prevBottom !== undefined && Math.abs(currentBottom - prevBottom) > 0.5) {
        const delta = currentBottom - prevBottom;
        const scroller = document.querySelector('[data-virtuoso-scroller="true"]');
        if (scroller) {
          scroller.scrollTop += delta;
        }
      }
      isSwipingRef.current = false;
    }
    
    // Always track the exact bottom position after any mutations/scrolls
    lastBottomRef.current = el.getBoundingClientRect().bottom;
  });

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

  const renderContent = greetingActive ? (greetingOptions[greetingIndex] ?? msg.displayContent) : activeContent;

  const isStreamingHere = !isUser && messageActionId === input.messageId && (globalStreamingText || globalStreamingReasoning);
  const activeStreamingText = isStreamingHere ? globalStreamingText : null;
  const activeStreamingReasoning = isStreamingHere ? globalStreamingReasoning : null;

  const copyLabel = t("copy");
  const editLabel = t("edit");
  const branchLabel = t("branch");
  const regenLabel = t("regen");
  const deleteLabel = t("delete");
  const createdLabel = formatMessageTime(msg.createdAt);

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
      <div className={isMobile ? "relative mx-auto w-full px-3" : "relative mx-auto max-w-[min(calc(var(--mw)+160px),calc(100vw-var(--sw)-64px))] px-7"}>
        <div className={msgWrap} ref={msgWrapRef}>
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
                  disabled={!canSwitchVariant || greetingIndex <= 0}
                  onClick={() => { if (!isGreeting) isSwipingRef.current = true; useSnapshotStore.getState().setSwipeDirection(-1); setGreetingIndex(Math.max(0, greetingIndex - 1)); }}
                >◀</button>
                {t("greeting_counter").replace("{n}", String(greetingIndex + 1)).replace("{total}", String(greetingOptions!.length))}
                <button type="button"
                  className={cn("cursor-pointer text-t3 transition-colors duration-100", isMobile ? "active:text-accent" : "hover:text-accent")}
                  disabled={!canSwitchVariant || greetingIndex >= greetingOptions!.length - 1}
                  onClick={() => { if (!isGreeting) isSwipingRef.current = true; useSnapshotStore.getState().setSwipeDirection(1); setGreetingIndex(Math.min(greetingOptions!.length - 1, greetingIndex + 1)); }}
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
                <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={t("generating_response")}>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
                </span>
              </div>
            </div>
          ) : isStreamingHere ? (
            <div className={isMobile ? "my-0.5 w-full" : ""}>
              {(activeStreamingReasoning || reasoningDuration) && (
                <MessageReasoning reasoning={activeStreamingReasoning || reasoningText} reasoningDurationMs={reasoningDuration} />
              )}
              <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
                {activeStreamingText ? <Markdown text={activeStreamingText} /> : null}
                <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={t("generating_response")}>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
                </span>
              </div>
            </div>
          ) : (
            <div>
              {!isUser && (reasoningText || reasoningDuration) && (
                <MessageReasoning reasoning={reasoningText} reasoningDurationMs={reasoningDuration} />
              )}
              {isGreeting ? (
                <div className="relative overflow-hidden">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={`g-${greetingIndex}`}
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
              ) : (
                <div className="relative overflow-hidden" ref={msgWrapRef}>
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
              {isGenerating && (
                <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={t("generating_response")}>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
                  <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
                </span>
              )}
            </div>
          )}

          {!isEditing && !isGenerating && createdLabel && (
            <div className="mt-1 flex items-center gap-2 font-ui text-[calc(var(--ui-fs)-4px)] text-t3/50">
              {createdLabel}
              <span className="tabular-nums">{messageTokens} {t("tokens_label")}</span>
              {!isUser && msg.modelId && (
                <span>{resolveModelLabel(msg.modelId)}</span>
              )}
            </div>
          )}

          {!isEditing && !isGenerating && !isMobile && (
            <div className="relative flex items-center gap-px mt-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              <span
                className={cn('flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all duration-150 hover:bg-s2 hover:text-t2', copied && 'translate-y-[-1px] bg-success-dim text-success-text')}
                onClick={() => { if (isBusy) return; void navigator.clipboard?.writeText(msg.displayContent); setCopied(true); setTimeout(() => setCopied(false), 1000); }}
              >{copied ? <Icons.Check /> : <Icons.Copy />}{copied ? t("copied") : copyLabel}</span>

              <span
                className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                onClick={() => { if (!isBusy) chat.handleStartEdit(msg); }}
              ><Icons.Edit />{editLabel}</span>

              {canResend && (
                <span
                  className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                  onClick={() => { if (!isBusy) void chat.handleResend(); }}
                ><Icons.Regen />{t("resend")}</span>
              )}

              {canBranch && (
                <span
                  className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                  onClick={() => { if (!isBusy) void chat.handleFork(msg.id); }}
                ><Icons.Branch />{branchLabel}</span>
              )}

              {canRegenerate && (
                <span
                  className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                  onClick={() => { if (!isBusy) void chat.handleRegenerateMessage(msg.id); }}
                ><Icons.Regen />{regenLabel}</span>
              )}

              {!isUser && variantCount > 1 && canSwitchVariant && (
                <span className="ml-auto mr-auto flex items-center gap-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
                  <button type="button"
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
                    disabled={isBusy || selectedVariantIndex <= 0}
                    onClick={() => {
                      isSwipingRef.current = true;
                      useSnapshotStore.getState().selectVariant(msg.id, selectedVariantIndex - 1, -1);
                      chat.handleSelectMessageVariant(msg.id, selectedVariantIndex - 1);
                    }}
                  ><Icons.Caret direction="l" /></button>
                  <span className="min-w-6 text-center tabular-nums">{selectedVariantIndex + 1}/{variantCount}</span>
                  <button type="button"
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
                    disabled={isBusy || selectedVariantIndex >= variantCount - 1}
                    onClick={() => {
                      isSwipingRef.current = true;
                      useSnapshotStore.getState().selectVariant(msg.id, selectedVariantIndex + 1, 1);
                      chat.handleSelectMessageVariant(msg.id, selectedVariantIndex + 1);
                    }}
                  ><Icons.Caret direction="r" /></button>
                </span>
              )}

              {!isGreeting && (
                <span
                  className="absolute right-0 flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                  onClick={() => { if (!isBusy) void chat.handleDeleteMessage(msg.id); }}
                ><Icons.Trash /></span>
              )}
            </div>
          )}
          {/* Mobile: bottom action row for regen/branch/swipe */}
          {isMobile && !isEditing && !isGenerating && (
            <div className="mt-1.5 flex items-center gap-3">
              {canResend && (
                <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { if (!isBusy) void chat.handleResend(); }} title={t("resend")}>
                  <Icons.Regen />
                </div>
              )}
              {canRegenerate && (
                <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { if (!isBusy) void chat.handleRegenerateMessage(msg.id); }} title={regenLabel}>
                  <Icons.Regen />
                </div>
              )}
              {canBranch && (
                <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { if (!isBusy) void chat.handleFork(msg.id); }} title={branchLabel}>
                  <Icons.Branch />
                </div>
              )}
              {!isUser && variantCount > 1 && canSwitchVariant && (
                <>
                  <div className="mx-1 h-4 w-px bg-border"/>
                  <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { isSwipingRef.current = true; useSnapshotStore.getState().selectVariant(msg.id, selectedVariantIndex - 1, -1); chat.handleSelectMessageVariant(msg.id, selectedVariantIndex - 1); }}><Icons.Caret direction="l" /></div>
                  <span className="min-w-6 text-center text-[12px] tabular-nums text-t3">{selectedVariantIndex + 1}/{variantCount}</span>
                  <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-t3 active:bg-s2" onClick={() => { isSwipingRef.current = true; useSnapshotStore.getState().selectVariant(msg.id, selectedVariantIndex + 1, 1); chat.handleSelectMessageVariant(msg.id, selectedVariantIndex + 1); }}><Icons.Caret direction="r" /></div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
});

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

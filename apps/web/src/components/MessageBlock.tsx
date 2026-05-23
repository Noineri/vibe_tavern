import { memo, useState, useMemo, useRef, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "../lib/cn.js";
import { Markdown } from "../lib/markdown.js";
import { avatarUrl } from "../lib/avatar.js";
import { initials } from "./app-shell-helpers.js";
import { useDisplayMessage, useChatMeta, useMessageOrder } from "../stores/chat-selectors.js";
import { useChatStore, useChatDataStore } from "../stores/index.js";
import type { MessageBlockProps } from "./play-mode-types.js";
import { Icons } from "./shared/icons.js";
import { AutoTextarea } from "./shared/auto-textarea.js";
import { useT } from "../i18n/context.js";
import { MessageReasoning } from "./MessageReasoning.js";
import { useChatController } from "../hooks/use-chat-controller.js";
import { replaceUiMacros } from "../lib/macros.js";

const msgWrap = "relative group py-2.5";
const sepWrap = "max-w-[min(calc(var(--mw)_+_160px),calc(100vw_-_var(--sw)_-_64px))] mx-auto px-7 my-[6px] mt-2";

// ── Swipe animation diagnostic logger ──────────────────────────────────────
const _swipeLog: string[] = [];
const MAX_LOG = 200;
function _logSwipe(event: string, data: Record<string, unknown>) {
  const ts = performance.now().toFixed(1);
  const entry = `[${ts}ms] ${event} ${JSON.stringify(data)}`;
  _swipeLog.push(entry);
  if (_swipeLog.length > MAX_LOG) _swipeLog.shift();
  console.log(`%c[SWIPE] ${entry}`, 'color: #0af', data);
}

(window as unknown as Record<string, unknown>).getSwipeLog = () => {
  const text = _swipeLog.join('\n');
  console.log(text);
  return text;
};
(window as unknown as Record<string, unknown>).downloadSwipeLog = () => {
  const blob = new Blob([_swipeLog.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'swipe-log.txt';
  a.click();
  URL.revokeObjectURL(url);
};
// ────────────────────────────────────────────────────────────────────────────



// ── Height Measurement for Smooth Swipes ───────────────────────────────────
const MeasureHeight = memo(function MeasureHeight({ children, onHeightChange }: { children: React.ReactNode; onHeightChange: (h: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onHeightChange);
  cbRef.current = onHeightChange;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) cbRef.current(entry.target.getBoundingClientRect().height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="flow-root">{children}</div>;
});
// ────────────────────────────────────────────────────────────────────────────

export const MessageBlock = memo(function MessageBlock(input: MessageBlockProps) {
  const { t } = useT();
  const chat = useChatController();
  const [copied, setCopied] = useState(false);
  const [greetingIndex, setGreetingIndex] = useState(0);

  // Read ALL display data from memoized selector — re-renders only when THIS message changes
  const msg = useDisplayMessage(input.messageId);
  const chatMeta = useChatMeta();
  const messageOrder = useMessageOrder();
  const macroContext = useChatDataStore(s => s.macroContext);

  const editingMessageId = useChatStore(s => s.editingMessageId);
  const editingDraft = useChatStore(s => s.editingDraft);
  const isSending = useChatStore(s => s.isSending);
  const messageActionId = useChatStore(s => s.messageActionId);
  const pendingUserMessageContent = useChatStore(s => s.pendingUserMessageContent);

  // -- Height measurement state --
  const prevHeightRef = useRef<number>(undefined);
  const [displayHeight, setDisplayHeight] = useState<number | undefined>();

  // Diagnostics: render counter
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  if (!msg || !chatMeta) return null;

  const isUser = msg.role === "user";
  const messageTokens = msg.tokenCount;

  // Metadata
  const characterName = chatMeta.character.name;
  const characterAvatarAssetId = chatMeta.character.avatarAssetId;
  const personaName = chatMeta.persona?.name ?? "";
  const personaAvatarAssetId = chatMeta.persona?.avatarAssetId ?? null;

  // UI State
  const isEditing = editingMessageId === input.messageId;
  const isBusy = isSending || messageActionId === input.messageId;

  // Find first assistant message ID for greeting logic
  const firstAssistantMsgId = useMemo(() => {
    const state = useChatDataStore.getState();
    for (const id of messageOrder) {
      if (state.messagesById[id]?.role === "assistant") return id;
    }
    return null;
  }, [messageOrder]);

  const isGreeting = input.messageId === firstAssistantMsgId;
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

  // Macros for variants
  const variants = useMemo(() => {
    if (!msg.variants || !macroContext) return msg.variants ?? [];
    return msg.variants.map(v => ({
      ...v,
      content: replaceUiMacros(v.content, macroContext),
    }));
  }, [msg.variants, macroContext]);

  const variantCount = variants.length;
  const selectedVariantIndex = msg.selectedVariantIndex ?? 0;

  // Greeting logic
  const alternateGreetings = useMemo(() => {
    if (!isGreeting || !macroContext) return [];
    return chatMeta.character.alternateGreetings.map(g => replaceUiMacros(g, macroContext));
  }, [isGreeting, macroContext, chatMeta.character.alternateGreetings]);

  const greetingOptions = useMemo(() => {
    if (!isGreeting) return undefined;
    return [msg.displayContent, ...alternateGreetings];
  }, [isGreeting, msg.displayContent, alternateGreetings]);

  const greetingActive = !isUser && greetingOptions && greetingOptions.length > 1;

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

  // -- Height lock during variant transitions --
  // We use useMemo here instead of useLayoutEffect so it's strictly synchronous
  // before the render commits.
  useMemo(() => {
    if (prevHeightRef.current !== undefined && displayHeight !== undefined) {
      setDisplayHeight(prevHeightRef.current);
    }
  }, [selectedVariantIndex, greetingIndex]);

  const handleHeightMeasured = (newHeight: number) => {
    prevHeightRef.current = newHeight;
    setDisplayHeight(newHeight);
  };

  // Server sets message.content = selected variant's content at load time,
  // but client-side switching only changes selectedVariantIndex.
  // Read the actual variant text directly.
  const selectedVariant = variants[selectedVariantIndex] ?? variants[0];
  const activeContent = selectedVariant ? selectedVariant.content : msg.displayContent;

  const renderContent = greetingActive ? (greetingOptions[greetingIndex] ?? msg.displayContent) : activeContent;

  // Diagnostics: log every render with key animation state
  _logSwipe(`render #${renderCountRef.current}`, {
    msgId: input.messageId.slice(0, 8),
    variant: selectedVariantIndex,
    greeting: greetingIndex,
    dir: direction,
    contentLen: renderContent?.length ?? 0,
    activeContentLen: activeContent?.length ?? 0,
    msgDisplayContentLen: msg.displayContent?.length ?? 0,
    variantsLen: variants.length,
    rawVariantsLen: msg.variants?.length ?? 0,
    key: greetingActive ? `g-${greetingIndex}` : `v-${selectedVariantIndex}`,
  });

  // Streaming text for regeneration — only shown on the specific message being regenerated
  const globalStreamingText = useChatStore((s) => s.streamingText);
  const globalStreamingReasoning = useChatStore((s) => s.streamingReasoningText);
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

  // Separator logic
  const showSeparator = useMemo(() => {
    if (input.index === 0) return false;
    const state = useChatDataStore.getState();
    const prevId = messageOrder[input.index - 1];
    const prev = state.messagesById[prevId];
    if (!prev) return false;
    return !isBreakoutRole(prev.role) && !isBreakoutRole(msg.role);
  }, [input.index, messageOrder, msg.role]);

  return (
    <>
      {showSeparator && (
        <div className={sepWrap}>
          <div className="h-px bg-border opacity-40"/>
        </div>
      )}
      <div className="relative mx-auto max-w-[min(calc(var(--mw)+160px),calc(100vw-var(--sw)-64px))] px-7">
        <div className={msgWrap}>
          <div className={cn(
            "mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3",
            !isUser && "text-accent-t opacity-85",
            isUser && "flex-row-reverse",
          )}>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
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
                <button
                  className="cursor-pointer text-t3 transition-colors duration-100 hover:text-accent"
                  disabled={!canSwitchVariant || greetingIndex <= 0}
                  onClick={() => { _logSwipe('click:prevGreeting', { greetingIndex, target: Math.max(0, greetingIndex - 1) }); useChatDataStore.getState().setSwipeDirection(-1); setGreetingIndex(Math.max(0, greetingIndex - 1)); }}
                >◀</button>
                {t("greeting_counter").replace("{n}", String(greetingIndex + 1)).replace("{total}", String(greetingOptions!.length))}
                <button
                  className="cursor-pointer text-t3 transition-colors duration-100 hover:text-accent"
                  disabled={!canSwitchVariant || greetingIndex >= greetingOptions!.length - 1}
                  onClick={() => { _logSwipe('click:nextGreeting', { greetingIndex, target: Math.min(greetingOptions!.length - 1, greetingIndex + 1) }); useChatDataStore.getState().setSwipeDirection(1); setGreetingIndex(Math.min(greetingOptions!.length - 1, greetingIndex + 1)); }}
                >▶</button>
              </span>
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
                <button
                  className="cursor-pointer rounded-[5px] bg-accent px-3 py-[5px] font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110"
                  disabled={isBusy}
                  onClick={() => void chat.handleSaveMessageEdit(msg.id)}
                >{t("save_edit")}</button>
                <button
                  className="cursor-pointer rounded-[5px] bg-s2 px-3 py-[5px] font-ui text-xs font-medium text-t2 transition-all duration-100 hover:bg-s3"
                  disabled={isBusy}
                  onClick={chat.handleCancelEdit}
                >{t("cancel_edit")}</button>
              </div>
            </>
          ) : isUser ? (
            <div className="my-0.5 rounded-md bg-user-bg px-4 py-[13px]">
              <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 opacity-88 [&_em]:italic [&_em]:text-msg-t2">
                <Markdown text={renderContent} />
              </div>
            </div>
          ) : isGenerating && !renderContent?.trim() ? (
            <div>
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
            <>
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
            </>
          ) : (
            <div>
              {!isUser && (reasoningText || reasoningDuration) && (
                <MessageReasoning reasoning={reasoningText} reasoningDurationMs={reasoningDuration} />
              )}
              <motion.div
                className="relative overflow-hidden"
                animate={{ height: displayHeight ?? "auto" }}
                transition={{ type: "spring", stiffness: 400, damping: 40, restDelta: 0.1 }}
              >
                <MeasureHeight onHeightChange={handleHeightMeasured}>
                  <div className="relative overflow-hidden">
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.div
                        key={greetingActive ? `g-${greetingIndex}` : `v-${selectedVariantIndex}`}
                        initial={{ x: direction * 80, opacity: 0, filter: "blur(4px)" }}
                        animate={{ x: 0, opacity: 1, filter: "blur(0px)" }}
                        exit={{ x: direction * -80, opacity: 0, filter: "blur(4px)" }}
                        transition={{ type: "spring", stiffness: 350, damping: 32 }}
                        translate="yes"
                        className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2"
                      >
                        <Markdown text={renderContent} />
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </MeasureHeight>
              </motion.div>
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
            </div>
          )}

          {!isEditing && !isGenerating && (
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
                  <button
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
                    disabled={isBusy || selectedVariantIndex <= 0}
                    onClick={() => {
                      _logSwipe('click:prevVariant', { msgId: msg.id.slice(0, 8), currentIdx: selectedVariantIndex, targetIdx: selectedVariantIndex - 1 });
                      useChatDataStore.getState().selectVariant(msg.id, selectedVariantIndex - 1, -1);
                      chat.handleSelectMessageVariant(msg.id, selectedVariantIndex - 1);
                    }}
                  ><Icons.Caret direction="l" /></button>
                  <span className="min-w-6 text-center tabular-nums">{selectedVariantIndex + 1}/{variantCount}</span>
                  <button
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
                    disabled={isBusy || selectedVariantIndex >= variantCount - 1}
                    onClick={() => {
                      _logSwipe('click:nextVariant', { msgId: msg.id.slice(0, 8), currentIdx: selectedVariantIndex, targetIdx: selectedVariantIndex + 1 });
                      useChatDataStore.getState().selectVariant(msg.id, selectedVariantIndex + 1, 1);
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

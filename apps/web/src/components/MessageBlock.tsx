import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";
import { Markdown } from "../lib/markdown.js";
import { avatarUrl } from "../lib/avatar.js";
import { initials } from "./app-shell-helpers.js";
import { useDisplayMessage } from "../stores/chat-selectors.js";
import { useChatStore } from "../stores/index.js";
import type { MessageBlockProps } from "./play-mode-types.js";
import { Icons } from "./shared/icons.js";
import { AutoTextarea } from "./shared/auto-textarea.js";
import { useT } from "../i18n/context.js";
import { MessageReasoning } from "./MessageReasoning.js";

export const MessageBlock = memo(function MessageBlock(input: MessageBlockProps) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const prevHeightRef = useRef<number>(0);
  const prevVariantRef = useRef<number>(-1);

  // Read ALL display data from memoized selector — re-renders only when THIS message changes
  const msg = useDisplayMessage(input.messageId);
  if (!msg) return null;

  const isUser = msg.role === "user";
  const displayContent = msg.displayContent;
  const messageTokens = msg.tokenCount;

  // Streaming text for regeneration — only shown on the specific message being regenerated
  const globalStreamingText = useChatStore((s) => s.streamingText);
  const globalStreamingReasoning = useChatStore((s) => s.streamingReasoningText);
  const messageActionId = useChatStore((s) => s.messageActionId);
  const isStreamingHere = !isUser && messageActionId === input.messageId && (globalStreamingText || globalStreamingReasoning);
  const activeStreamingText = isStreamingHere ? globalStreamingText : null;
  const activeStreamingReasoning = isStreamingHere ? globalStreamingReasoning : null;

  const variants = Array.isArray(msg.variants) ? msg.variants : [];
  const variantCount = variants.length;
  const selectedVariantIndex = msg.selectedVariantIndex ?? 0;
  const isGenerating = Boolean(input.isGenerating);
  const greetingOptions = input.greetingOptions;
  const greetIdx = input.greetingIndex;
  const greetingActive = !isUser && greetingOptions && greetingOptions.length > 1;
  const canSwitch = input.canSwitchVariant;
  const renderContent = greetingActive ? (greetingOptions[greetIdx] ?? displayContent) : displayContent;
  const copyLabel = t("copy");
  const editLabel = t("edit");
  const branchLabel = t("branch");
  const regenLabel = t("regen");
  const deleteLabel = t("delete");
  const createdLabel = formatMessageTime(msg.createdAt);

  // Reasoning from persisted variant data only (not streaming)
  const selectedVariant = variants[selectedVariantIndex];
  const reasoningText = selectedVariant?.reasoning || null;
  const reasoningDuration = selectedVariant?.reasoningDurationMs ?? null;

  // Scroll compensation: when variant changes, keep the scroll position stable
  // by adjusting for the height difference of this message.
  useLayoutEffect(() => {
    if (prevVariantRef.current >= 0 && prevVariantRef.current !== selectedVariantIndex && rootRef.current) {
      const scrollEl = rootRef.current.closest(".overflow-y-auto");
      if (scrollEl) {
        const oldHeight = prevHeightRef.current;
        const newHeight = rootRef.current.offsetHeight;
        const delta = newHeight - oldHeight;
        if (delta !== 0) {
          scrollEl.scrollTop += delta;
        }
      }
    }
    if (rootRef.current) {
      prevHeightRef.current = rootRef.current.offsetHeight;
    }
    prevVariantRef.current = selectedVariantIndex;
  }, [selectedVariantIndex]);

  return (
    <div ref={rootRef} className="relative mx-auto max-w-[min(calc(var(--mw)+160px),calc(100vw-var(--sw)-64px))] px-7">
      <div className="relative group py-2.5">
        <div className={cn(
          "mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3",
          !isUser && "text-accent-t opacity-85",
          isUser && "flex-row-reverse",
        )}>
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[calc(var(--ui-fs)+1px)] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
            {isUser
              ? (input.personaAvatarAssetId
                ? <img src={avatarUrl(input.personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                : (input.personaName ? initials(input.personaName) : "Y"))
              : (input.characterAvatarAssetId
                ? <img src={avatarUrl(input.characterAvatarAssetId)} alt={input.characterName} className="h-full w-full object-cover object-top" />
                : initials(input.characterName))
            }
          </div>
          <span>{isUser ? input.personaName : input.characterName}</span>
          {greetingActive && (
            <span className="ml-auto flex items-center gap-1 text-[calc(var(--ui-fs)-3px)] text-t3">
              <button
                className="cursor-pointer text-t3 transition-colors duration-100 hover:text-accent"
                disabled={!canSwitch || greetIdx <= 0}
                onClick={() => input.onGreetingIndexChange(Math.max(0, greetIdx - 1))}
              >◀</button>
              {t("greeting_counter").replace("{n}", String(greetIdx + 1)).replace("{total}", String(greetingOptions!.length))}
              <button
                className="cursor-pointer text-t3 transition-colors duration-100 hover:text-accent"
                disabled={!canSwitch || greetIdx >= greetingOptions!.length - 1}
                onClick={() => input.onGreetingIndexChange(Math.min(greetingOptions!.length - 1, greetIdx + 1))}
              >▶</button>
            </span>
          )}

        </div>

        {input.isEditing ? (
          <>
            <AutoTextarea
              className="w-full resize-none overflow-hidden rounded-md border border-accent bg-s2 px-3.5 py-3 font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 outline-none"
              style={{ minHeight: 140 }}
              value={input.editingDraft}
              onChange={e => input.onEditingDraftChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') input.onCancelEdit(); }}
              autoFocus
            />
            <div className="mt-1.5 flex gap-1.5">
              <button
                className="cursor-pointer rounded-[5px] bg-accent px-3 py-[5px] font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110"
                disabled={input.isBusy}
                onClick={input.onSaveEdit}
              >{t("save_edit")}</button>
              <button
                className="cursor-pointer rounded-[5px] bg-s2 px-3 py-[5px] font-ui text-xs font-medium text-t2 transition-all duration-100 hover:bg-s3"
                disabled={input.isBusy}
                onClick={input.onCancelEdit}
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
          <div key={selectedVariantIndex} style={{ animation: "contentFadeIn 150ms ease-out" }}>
            {!isUser && (reasoningText || reasoningDuration) && (
              <MessageReasoning reasoning={reasoningText} reasoningDurationMs={reasoningDuration} />
            )}
            <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
              <Markdown text={renderContent} />
            </div>
            {isGenerating && (
              <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={t("generating_response")}>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
              </span>
            )}
          </div>
        )}

        {!input.isEditing && !isGenerating && createdLabel && (
          <div className="mt-1 flex items-center gap-2 font-ui text-[calc(var(--ui-fs)-4px)] text-t3/50">
            {createdLabel}
            <span className="tabular-nums">{messageTokens} {t("tokens_label")}</span>
          </div>
        )}

        {!input.isEditing && !isGenerating && (
          <div className="relative flex items-center gap-px mt-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <span
              className={cn('flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all duration-150 hover:bg-s2 hover:text-t2', copied && 'translate-y-[-1px] bg-success-dim text-success-text')}
              onClick={() => { if (input.isBusy) return; void navigator.clipboard?.writeText(displayContent); setCopied(true); setTimeout(() => setCopied(false), 1000); }}
              title={copyLabel}
            >{copied ? <Icons.Check /> : <Icons.Copy />}{copied ? t("copied") : copyLabel}</span>
            <span
              className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
              onClick={() => { if (!input.isBusy) input.onStartEdit(); }}
              title={editLabel}
            ><Icons.Edit />{editLabel}</span>
            {input.canResend && (
              <span
                className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                onClick={() => { if (!input.isBusy) input.onResend(); }}
                title={t("resend")}
              ><Icons.Regen />{t("resend")}</span>
            )}
            {input.canBranch && (
              <span
                className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                onClick={() => { if (!input.isBusy) input.onBranch(input.messageId); }}
                title={branchLabel}
              ><Icons.Branch />{branchLabel}</span>
            )}
            {input.canRegenerate && (
              <span
                className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                onClick={() => { if (!input.isBusy) input.onRegenerate(); }}
                title={regenLabel}
              ><Icons.Regen />{regenLabel}</span>
            )}
            {!isUser && variantCount > 1 && canSwitch && (
              <span className="ml-auto mr-auto flex items-center gap-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
                <button
                  className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
                  disabled={input.isBusy || selectedVariantIndex <= 0}
                  onClick={input.onSelectPreviousVariant}
                ><Icons.Caret direction="l" /></button>
                <span className="min-w-6 text-center tabular-nums">{selectedVariantIndex + 1}/{variantCount}</span>
                <button
                  className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
                  disabled={input.isBusy || selectedVariantIndex >= variantCount - 1}
                  onClick={input.onSelectNextVariant}
                ><Icons.Caret direction="r" /></button>
              </span>
            )}
            {!input.isGreeting && (
              <span
                className="absolute right-0 flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                onClick={() => { if (!input.isBusy) input.onDelete(); }}
                title={deleteLabel}
              ><Icons.Trash /></span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

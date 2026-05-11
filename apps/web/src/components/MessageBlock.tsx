import { useState } from "react";
import { cn } from "../lib/cn.js";
import { Markdown } from "../lib/markdown.js";
import { avatarUrl } from "../lib/avatar.js";
import { initials } from "./app-shell-helpers.js";
import { useChatStore } from "../stores/chat-store.js";
import type { MessageBlockProps } from "./play-mode-types.js";
import { Icons } from "./shared/icons.js";
import { useTokenCount } from "../hooks/use-token-count.js";
import { useT } from "../i18n/context.js";

export function MessageBlock(input: MessageBlockProps) {
  const { t } = useT();
  const streamingText = useChatStore((s) => s.streamingText);
  const [copied, setCopied] = useState(false);
  const isUser = input.message.role === "user";
  const variants = Array.isArray(input.message.variants) ? input.message.variants : [];
  const variantCount = variants.length;
  const selectedVariantIndex = input.message.selectedVariantIndex ?? 0;
  const isGenerating = Boolean(input.isGenerating);
  const greetingOptions = input.greetingOptions;
  const greetIdx = input.greetingIndex;
  const greetingActive = !isUser && greetingOptions && greetingOptions.length > 1;
  // Greetings and variant swipes are separate entities:
  // - Greetings come from the character card (first message only)
  // - Variants come from regeneration (any assistant message)
  // Both lock when there are subsequent messages (canSwitchVariant).
  const canSwitch = input.canSwitchVariant;
  const displayContent = greetingActive ? (greetingOptions[greetIdx] ?? input.message.content) : input.message.content;
  // When streaming, show streamed text instead of stale server content
  const showStreaming = isGenerating && streamingText;
  const renderContent = showStreaming ? streamingText : displayContent;
  const copyLabel = t("copy");
  const editLabel = t("edit");
  const branchLabel = t("branch");
  const regenLabel = t("regen");
  const deleteLabel = t("delete");
  const createdLabel = formatMessageTime(input.message.createdAt);
  const messageTokens = useTokenCount(displayContent);

  return (
    <div className="relative mx-auto max-w-[min(calc(var(--mw)+160px),calc(100vw-var(--sw)-64px))] px-7">
      <div className="relative group py-2.5">
        <div className={isUser
          ? "mb-[5px] flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3"
          : "mb-[5px] flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3 text-accent-t opacity-85"
        }>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[12px] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
            {isUser
              ? (input.personaAvatarAssetId
                ? <img src={avatarUrl(input.personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                : "Y")
              : (input.characterAvatarAssetId
                ? <img src={avatarUrl(input.characterAvatarAssetId)} alt={input.characterName} className="h-full w-full object-cover object-top" />
                : initials(input.characterName))
            }
          </div>
          <span>{isUser ? t("message_user_label") : input.characterName}</span>
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
          {!isUser && variantCount > 1 && canSwitch && (
            <span className="ml-auto flex items-center gap-1">
              <button
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1"
                disabled={input.isBusy || selectedVariantIndex <= 0}
                onClick={input.onSelectPreviousVariant}
              ><Icons.Caret direction="l" /></button>
              <span className="min-w-6 text-center text-[calc(var(--ui-fs)-3px)] tabular-nums text-t3">{selectedVariantIndex + 1}/{variantCount}</span>
              <button
                className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1"
                disabled={input.isBusy || selectedVariantIndex >= variantCount - 1}
                onClick={input.onSelectNextVariant}
              ><Icons.Caret direction="r" /></button>
            </span>
          )}
        </div>

        {input.isEditing ? (
          <>
            <textarea
              className="min-h-[140px] w-full resize-y rounded-md border border-accent bg-s2 px-3.5 py-3 font-body text-[length:var(--mfs)] leading-[1.82] text-t1 outline-none"
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
            <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 opacity-88 [&_em]:italic [&_em]:text-t2">
              <Markdown text={renderContent} />
            </div>
          </div>
        ) : isGenerating && !renderContent?.trim() ? (
          <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
            <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={t("generating_response")}>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
            </span>
          </div>
        ) : (
          <>
            <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
              <Markdown text={renderContent} />
            </div>
            {isGenerating && (
              <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label={t("generating_response")}>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
              </span>
            )}
          </>
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
                onClick={() => { if (!input.isBusy) input.onBranch(); }}
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
            <span
              className="absolute right-0 flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
              onClick={() => { if (!input.isBusy) input.onDelete(); }}
              title={deleteLabel}
            ><Icons.Trash /></span>
          </div>
        )}
      </div>
    </div>
  );
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

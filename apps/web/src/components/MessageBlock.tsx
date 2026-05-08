import { useState } from "react";
import { cn } from "../lib/cn.js";
import { Markdown } from "../lib/markdown.js";
import { initials } from "./app-shell-helpers.js";
import type { MessageBlockProps } from "./play-mode-types.js";
import { Icons } from "./shared/icons.js";

export function MessageBlock(input: MessageBlockProps) {
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
  const copyLabel = "copy";
  const editLabel = "edit";
  const branchLabel = "branch";
  const regenLabel = "regen";
  const deleteLabel = "delete";
  const createdLabel = formatMessageTime(input.message.createdAt);
  const updatedLabel = input.message.updatedAt !== input.message.createdAt ? "edited" : null;
  const stateLabel = input.message.state !== "complete" ? input.message.state : null;
  const variantLabel = !isUser && variantCount > 1 ? `swipe ${selectedVariantIndex + 1}/${variantCount}` : null;

  return (
    <div className="relative" style={{maxWidth:'min(calc(var(--mw) + 160px), calc(100vw - var(--sw) - 64px))', margin:'0 auto', paddingLeft:28, paddingRight:28}}>
      <div className="relative group" style={{paddingTop:10,paddingBottom:10}}>
        <div className={isUser
          ? "flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3"
          : "flex items-center gap-[7px] text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.04em] text-t3 text-accent-t opacity-85"
        } style={{marginBottom:'5px'}}>
          <div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-body text-[9px] italic text-t3 [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
            {isUser ? "Y" : initials(input.characterName)}
          </div>
          <span>{isUser ? "You" : input.characterName}</span>
          {greetingActive && (
            <span className="ml-auto flex items-center gap-1 text-[calc(var(--ui-fs)-3px)] text-t3">
              <button
                className="cursor-pointer text-t3 transition-colors duration-100 hover:text-accent"
                disabled={!canSwitch || greetIdx <= 0}
                onClick={() => input.onGreetingIndexChange(Math.max(0, greetIdx - 1))}
              >◀</button>
              Greeting {greetIdx + 1}/{greetingOptions!.length}
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
              className="min-h-[140px] w-full resize-y rounded-md border border-accent bg-s2 font-body text-[length:var(--mfs)] leading-[1.82] text-t1 outline-none"
              style={{padding:'12px 14px'}}
              value={input.editingDraft}
              onChange={e => input.onEditingDraftChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') input.onCancelEdit(); }}
              autoFocus
            />
            <div className="mt-1.5 flex gap-1.5">
              <button
                className="cursor-pointer rounded-[5px] bg-accent font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110"
                style={{padding:'5px 12px'}}
                disabled={input.isBusy}
                onClick={input.onSaveEdit}
              >Save</button>
              <button
                className="cursor-pointer rounded-[5px] bg-s2 font-ui text-xs font-medium text-t2 transition-all duration-100 hover:bg-s3"
                style={{padding:'5px 12px'}}
                disabled={input.isBusy}
                onClick={input.onCancelEdit}
              >Cancel</button>
            </div>
          </>
        ) : isUser ? (
          <div className="my-0.5 rounded-md bg-user-bg" style={{padding:'13px 16px'}}>
            <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 opacity-88 [&_em]:italic [&_em]:text-t2">
              <Markdown text={displayContent} />
            </div>
          </div>
        ) : isGenerating && !input.message.content?.trim() ? (
          <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
            <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label="Generating response">
              <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
            </span>
          </div>
        ) : (
          <>
            <div className="font-body text-[length:var(--mfs)] leading-[1.82] text-t1 [&_em]:italic [&_em]:text-t2">
              <Markdown text={displayContent} />
            </div>
            {isGenerating && (
              <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle" aria-label="Generating response">
                <span className="h-1 w-1 rounded-full bg-accent animate-genp"/>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]"/>
                <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]"/>
              </span>
            )}
          </>
        )}

        {!input.isEditing && !isGenerating && (
          <div className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] text-t3/50" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
            {createdLabel && <span style={{background:'var(--s2)',border:'1px solid var(--border)',borderRadius:4,padding:'2px 6px'}}>{createdLabel}</span>}
            {updatedLabel && <span style={{background:'var(--s2)',border:'1px solid var(--border)',borderRadius:4,padding:'2px 6px'}}>{updatedLabel}</span>}
            {stateLabel && <span style={{background:'var(--s2)',border:'1px solid var(--border)',borderRadius:4,padding:'2px 6px'}}>{stateLabel}</span>}
            {variantLabel && <span style={{background:'var(--s2)',border:'1px solid var(--border)',borderRadius:4,padding:'2px 6px'}}>{variantLabel}</span>}
          </div>
        )}

        {!input.isEditing && !isGenerating && (
          <div className="flex items-center gap-px mt-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <span
              className={cn('flex cursor-pointer items-center gap-1 rounded font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all duration-150 hover:bg-s2 hover:text-t2', copied && 'translate-y-[-1px] bg-success-dim text-success-text')}
              style={{padding:'3px 7px'}}
              onClick={() => { if (input.isBusy) return; void navigator.clipboard?.writeText(displayContent); setCopied(true); setTimeout(() => setCopied(false), 1000); }}
              title={copyLabel}
            >{copied ? <Icons.Check /> : <Icons.Copy />}{copied ? "copied" : copyLabel}</span>
            <span
              className="flex cursor-pointer items-center gap-1 rounded font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
              style={{padding:'3px 7px'}}
              onClick={() => { if (!input.isBusy) input.onStartEdit(); }}
              title={editLabel}
            ><Icons.Edit />{editLabel}</span>
            {input.canBranch && (
              <span
                className="flex cursor-pointer items-center gap-1 rounded font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                style={{padding:'3px 7px'}}
                onClick={() => { if (!input.isBusy) input.onBranch(); }}
                title={branchLabel}
              ><Icons.Branch />{branchLabel}</span>
            )}
            {input.canRegenerate && (
              <span
                className="flex cursor-pointer items-center gap-1 rounded font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                style={{padding:'3px 7px'}}
                onClick={() => { if (!input.isBusy) input.onRegenerate(); }}
                title={regenLabel}
              ><Icons.Regen />{regenLabel}</span>
            )}
            <span
              className="ml-auto flex cursor-pointer items-center gap-1 rounded font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
              style={{padding:'3px 7px'}}
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

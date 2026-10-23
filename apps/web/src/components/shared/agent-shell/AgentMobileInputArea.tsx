import { useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn.js";
import { composerCls } from "../../../lib/field-tokens.js";
import { Icons } from "../icons.js";
import { AutoTextarea } from "../auto-textarea.js";
import { useT } from "../../../i18n/context.js";
import { useAgentMention } from "./use-agent-mention.js";
import { AgentContextPills } from "./AgentContextPills.js";
import { AgentModelPills } from "./AgentModelPills.js";
import type { AgentInputAreaProps } from "./AgentInputArea.js";

/**
 * Experience-copilot input area (ER-11c, mobile). Same props + controlled
 * contract as `ExperienceCopilotInputArea`; only the chrome differs (compact
 * two-row surface: provider/model pills, then the textarea + send/cancel).
 *
 * Fork of `CoauthorMobileInputArea`, with the auto-grow textarea moved onto the
 * shared `AutoTextarea` (the co-author mobile hand-rolled `<textarea rows={1}>`
 * + manual height adjustment is exactly the §9 pattern this surface must NOT
 * repeat).
 */
export function AgentMobileInputArea(props: AgentInputAreaProps) {
  const {
    isSending,
    onSend,
    onCancel,
    providerProfileId,
    model,
    onProviderChange,
    prefill,
    mentionCatalog,
    pinnedContext,
    onPinContext,
    onUnpinContext,
    topSlot,
    answeringAsk = false,
  } = props;

  const [draft, setDraft] = useState("");
  // CX-6: the @-popover anchors to the input CARD (not the textarea —
  // AutoTextarea forwards no ref).
  const cardRef = useRef<HTMLDivElement | null>(null);

  const mention = useAgentMention({
    draft,
    setDraft,
    catalog: mentionCatalog ?? [],
    onPick: (item) => onPinContext?.(item),
    anchorEl: cardRef.current,
  });

  // UX 2026-08-16 remark 6 — see `prefill` on the shared props interface. Same
  // contract as the desktop input area: fresh object → replace the draft.
  useEffect(() => {
    if (prefill) setDraft(prefill.text);
  }, [prefill]);

  const { t } = useT();

  const canSend = draft.trim().length > 0 && !isSending;

  const handleSend = () => {
    const content = draft.trim();
    if (!content || isSending) return;
    setDraft("");
    onSend(content);
  };

  // E4 (MOBILE_DEFECTS_ROUND_2): NO Enter-to-send on mobile — the on-screen
  // enter key is the newline key; sending happens via the send button only.
  // The mention picker still intercepts its own keys (Enter/Tab/Arrows/Escape)
  // before any fallback; desktop (AgentInputArea) keeps Enter-to-send.

  // AP-19: the ONE fallback keydown on mobile — Escape while the turn
  // streams cancels it (the controller's quiet abort; no error card). Bare
  // Enter stays the newline key (E4 above), and the picker's own Escape
  // wins while its popover is open (the hook runs before this fallback).
  const handleCancelKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && isSending) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-surface px-1.5 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2">
      <div ref={cardRef} className={cn("flex flex-col gap-1.5 rounded-xl border bg-s2 p-1.5 transition-colors duration-150", answeringAsk ? "border-accent" : "border-transparent")}>
        {/* Toolbar row: provider + model pills (AP-26b: the one pills
            component's mobile variant — bottom sheets, same test ids). */}
        <div className="flex flex-wrap items-center gap-2">
          <AgentModelPills mobile providerProfileId={providerProfileId} model={model} onProviderChange={onProviderChange} />
        </div>

        {/* CX-6: pinned-context pills between the toolbar row and the input. */}
        <AgentContextPills items={pinnedContext ?? []} onUnpin={(tt, id) => onUnpinContext?.(tt, id)} />
        {topSlot}

        {/* Input row. */}
        <div className="flex items-end gap-2">
          <AutoTextarea
            bare
            className={composerCls}
            minRows={1}
            maxRows={6}
            data-testid="copilot-chat-input"
            placeholder={t(answeringAsk ? "agent_input_answering_placeholder" : "agent_input_placeholder")}
            value={draft}
            onChange={mention.handleChange}
            onSelect={mention.handleSelect}
            onClick={mention.handleClick}
            onBlur={mention.handleBlur}
            onKeyDown={(e) => mention.handleKeyDown(e, handleCancelKeyDown)}
          />
          <div className="flex shrink-0 items-center">
            {isSending ? (
              <button
                type="button"
                data-testid="copilot-cancel-btn"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger text-danger-text active:bg-danger/10"
                onClick={onCancel}
              >
                <span className="text-[11px] font-bold">✕</span>
              </button>
            ) : (
              <button
                type="button"
                data-testid="copilot-send-btn"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent active:scale-95",
                  "disabled:opacity-45",
                )}
                disabled={!canSend}
                onClick={handleSend}
              >
                <Icons.Caret direction="r" />
              </button>
            )}
          </div>
        </div>
      </div>
      {mention.popover}
    </div>
  );
}

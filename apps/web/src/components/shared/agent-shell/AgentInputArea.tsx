import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../../lib/cn.js";
import { composerCls } from "../../../lib/field-tokens.js";
import { Icons } from "../icons.js";
import { AutoTextarea } from "../auto-textarea.js";
import { CustomTooltip } from "../Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { useAgentMention } from "./use-agent-mention.js";
import type { MentionAutocompleteItem } from "../mention-autocomplete-query.js";
import { AgentContextPills, type AgentContextPillItem } from "./AgentContextPills.js";
import { AgentModelPills } from "./AgentModelPills.js";

/**
 * Experience-copilot input area (ER-11c, desktop). Props-driven and CONTROLLED:
 * the shell (ER-11d) owns the provider/model selection and the send/cancel
 * wiring; this component owns only the local draft text state.
 *
 * Fork of `CoauthorInputArea`, stripped of the co-author-only module switch,
 * context token counter, and (RP) chat-pipeline send. The provider/model
 * pills live in `AgentModelPills` (AP-26 extraction), rendered into the
 * bottom row with the same controlled binding this component receives.
 */
export interface AgentInputAreaProps {
  isSending: boolean;
  onSend: (content: string) => void;
  onCancel: () => void;
  providerProfileId: string | null;
  model?: string;
  onProviderChange: (profileId: string, model?: string) => void;
  /** Outside-set draft text (UX 2026-08-16 remark 6): the tester/playground
 *  "send to copilot" button COPIES the digest into the chat input instead of
 *  dispatching the turn — the user presses send themselves. Applied whenever
 *  a new object arrives (replaces the current draft). */
  prefill?: { text: string };
  /** CX-6: catalog for the @-mention popover (shared MentionAutocompleteItem
   *  shape). Default [] — absent means the picker is inert. */
  mentionCatalog?: readonly MentionAutocompleteItem[];
  /** CX-6: currently pinned context (rendered as removable pills above the
   *  textarea). Default [] — absent renders no pills. */
  pinnedContext?: readonly AgentContextPillItem[];
  /** CX-6: fired when an item is picked from the @-popover (the @query is
   *  ALREADY stripped from the draft). */
  onPinContext?: (item: MentionAutocompleteItem) => void;
  /** CX-6: fired when a pill's × is clicked. */
  onUnpinContext?: (targetType: string, targetId: string) => void;
  /** SC-18: an optional host row inside the input card above the textarea
   *  (the sidechat's attached-variant chips). Default absent — no row. */
  topSlot?: ReactNode;
  /** AP-6: true while the thread's live awaiting ask exists (computed by the
   *  pane via `selectAgentLiveAsk`) — the next send ANSWERS the ask, so the
   *  card carries the accent border and the answering placeholder. The
   *  composer stays dumb: no store reads, just the prop. */
  answeringAsk?: boolean;
}

export function AgentInputArea(props: AgentInputAreaProps) {
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

  // UX 2026-08-16 remark 6 — see `prefill` above. Object identity is the
  // trigger: the Shell mints a fresh object per copy click.
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // AP-19: Escape while the turn streams cancels it (the controller's
    // quiet abort — no error card). The mention picker's own Escape wins
    // while its popover is open: the hook handles that key before this
    // fallback ever runs, and a not-streaming Escape falls through untouched.
    if (e.key === "Escape" && isSending) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-surface px-4 pt-2.5 pb-3.5">
      <div ref={cardRef} className={cn("relative rounded-lg border bg-input-bg transition-colors duration-150", answeringAsk ? "border-accent focus-within:border-accent" : "border-border focus-within:border-border2")}>
        <AgentContextPills items={pinnedContext ?? []} onUnpin={(tt, id) => onUnpinContext?.(tt, id)} />
        {topSlot}
        <AutoTextarea
          bare
          className={cn(composerCls, "w-full !min-h-[55px] !px-4 !pt-[13px] !pb-2 !text-[15.5px] !leading-tight")}
          maxRows={12}
          minRows={3}
          data-testid="copilot-chat-input"
          placeholder={t(answeringAsk ? "agent_input_answering_placeholder" : "agent_input_placeholder")}
          value={draft}
          onChange={mention.handleChange}
          onSelect={mention.handleSelect}
          onClick={mention.handleClick}
          onBlur={mention.handleBlur}
          onKeyDown={(e) => mention.handleKeyDown(e, handleKeyDown)}
        />

        <div className="relative flex items-center gap-2 pt-1.5 pb-[9px] pl-3 pr-3">
          <AgentModelPills providerProfileId={providerProfileId} model={model} onProviderChange={onProviderChange} />

          <div className="ml-auto flex items-center gap-[9px]">
            {isSending ? (
              <CustomTooltip content={t("agent_cancel")}>
                <button
                  type="button"
                  data-testid="copilot-cancel-btn"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[5px] border border-danger text-danger-text transition-colors duration-150 hover:bg-danger-dim"
                  onClick={onCancel}
                  aria-label={t("agent_cancel")}
                >
                  <Icons.close />
                </button>
              </CustomTooltip>
            ) : (
              <CustomTooltip content={t("agent_send")}>
                <button
                  type="button"
                  data-testid="copilot-send-btn"
                  className={cn(
                    "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[5px] bg-accent text-on-accent transition-all duration-150 hover:brightness-110",
                    "disabled:cursor-default disabled:opacity-45 disabled:filter-none",
                  )}
                  disabled={!canSend}
                  onClick={handleSend}
                  aria-label={t("agent_send")}
                >
                  <Icons.Caret direction="r" />
                </button>
              </CustomTooltip>
            )}
          </div>
        </div>
      </div>
      {mention.popover}
    </div>
  );
}

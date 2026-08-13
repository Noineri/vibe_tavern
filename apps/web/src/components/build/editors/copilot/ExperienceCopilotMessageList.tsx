import { useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useExperienceCopilotTurnStore, type ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";
import type { ExperienceCopilotApplyPatch } from "../../../../lib/experience-copilot-apply.js";
import { ExperienceCopilotMessageBlock } from "./ExperienceCopilotMessageBlock.js";
import { ExperienceCopilotTurnShell } from "./ExperienceCopilotTurnShell.js";
import { Icons } from "../../../shared/icons.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { useT } from "../../../../i18n/context.js";

const EMPTY: ExperienceCopilotToolActivity[] = [];

/**
 * Experience-copilot message surface (ER-11c). Props-driven: the shell (ER-11d)
 * owns the persisted message list and the two-buffer state; this component
 * reads ONLY the ephemeral turn store (the one store read allowed inside these
 * presentation components, mirroring how `CoauthorMessageList` reads its turn
 * store) and renders the current turn's activity cards + Apply via
 * `ExperienceCopilotTurnShell`.
 *
 * Auto-scroll mirrors the co-author surface's bottom-pinning intent (stick to
 * the bottom while the user is already there; a jump-to-bottom button appears
 * when they scroll up). The copilot editor is an embedded surface, so this is a
 * plain scroll container rather than the chat `MessageScroller` (which is bound
 * to the RP chat stores).
 */
export interface ExperienceCopilotMessageListProps {
  threadId: string;
  messages: ExperienceCopilotMessageWire[];
  /** Live assistant text accumulated this turn (cleared by the shell on settle). */
  pendingText: string;
  /** Forwarded to the turn shell's diff view ("before" side). */
  baseRules: string;
  /** Forwarded to the turn shell's diff view ("before" side). */
  baseVisual: string;
  /** Forwarded to the turn shell's Apply button. */
  onApply: (patch: ExperienceCopilotApplyPatch) => void;
}

export function ExperienceCopilotMessageList({
  threadId,
  messages,
  pendingText,
  baseRules,
  baseVisual,
  onApply,
}: ExperienceCopilotMessageListProps) {
  const { t } = useT();
  const activities = useExperienceCopilotTurnStore(
    useShallow((s) => s.turnsByThread[threadId] ?? EMPTY),
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const hasPendingText = pendingText.trim().length > 0;

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinnedRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  };

  const contentCount = visibleMessages.length + (hasPendingText ? 1 : 0) + (activities.length > 0 ? 1 : 0);

  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [contentCount, pendingText, activities.length]);

  const isEmpty = visibleMessages.length === 0 && !hasPendingText && activities.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={<Icons.Sparkles className="h-6 w-6 text-t3" />}
          title={t("experience_copilot_title")}
          sub={t("experience_copilot_subtitle")}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          {visibleMessages.map((message) => (
            <ExperienceCopilotMessageBlock key={message.id} message={message} />
          ))}

          {activities.length > 0 && (
            <ExperienceCopilotTurnShell
              activities={activities}
              baseRules={baseRules}
              baseVisual={baseVisual}
              onApply={onApply}
            />
          )}

          {hasPendingText && (
            <ExperienceCopilotMessageBlock
              message={{
                id: "__pending-assistant",
                threadId,
                role: "assistant",
                content: pendingText,
                toolCallsJson: null,
                toolCallId: null,
                createdAt: "",
              }}
            />
          )}
        </div>
      </div>

      {showJumpToBottom && (
        <button
          type="button"
          className="absolute bottom-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95"
          onClick={() => {
            pinnedRef.current = true;
            scrollToBottom();
          }}
        >
          <Icons.Caret direction="d" />
        </button>
      )}
    </div>
  );
}

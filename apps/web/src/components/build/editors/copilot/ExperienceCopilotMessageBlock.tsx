import { memo } from "react";
import { cn } from "../../../../lib/cn.js";
import { Markdown } from "../../../../lib/markdown.js";
import { Icons } from "../../../shared/icons.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";

/**
 * One experience-copilot message bubble (ER-11c). Props-driven presentation:
 * the shell owns the message list; this component renders a single wire message
 * with role-based chrome (assistant vs user).
 *
 * Fork of `CoauthorMessageBlock`, simplified for the copilot's wire shape: a
 * message is just `{ id, threadId, role, content, toolCallsJson, toolCallId,
 * createdAt }`. The co-author-only fields (greeting variants, author identity
 * from the active chat, macro resolution) have no copilot counterpart, so this
 * block is self-contained rather than delegating to the RP `MessageBlock`.
 */
export interface ExperienceCopilotMessageBlockProps {
  message: ExperienceCopilotMessageWire;
}

export const ExperienceCopilotMessageBlock = memo(function ExperienceCopilotMessageBlock({
  message,
}: ExperienceCopilotMessageBlockProps) {
  const isUser = message.role === "user";

  // Tool-call carrier assistant turns have empty `content`; their activity is
  // surfaced by `ExperienceCopilotTurnShell`, so render nothing here (a
  // zero-height bubble would be visually orphaned).
  if (message.content.trim().length === 0) return null;

  return (
    <div className={cn("flex gap-2.5", isUser ? "flex-row-reverse" : "flex-row")} data-role={message.role}>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-s3">
        {isUser ? (
          <Icons.User className="h-4 w-4 text-t3" />
        ) : (
          <Icons.Sparkles className="h-4 w-4 text-accent-t" />
        )}
      </div>
      <div
        className={cn(
          // min-w-0: the bubble is a flex item, so its automatic min-width is
          // the content's min-content — for a code block that is the LONGEST
          // line, which beat max-w-[80%] and blew the chat sideways (fix:
          // code-block overflow). min-w-0 lets the bubble shrink; .md-pre then
          // gets a bounded containing block and scrolls INTERNALLY as designed.
          "max-w-[80%] min-w-0 rounded-lg px-3.5 py-2.5",
          isUser ? "bg-user-bg" : "bg-s2",
        )}
      >
        <div className="font-ui text-[calc(var(--ui-fs)-1px)] leading-[1.5] text-msg-t1 [overflow-wrap:anywhere] [&_.md-pre]:[overflow-wrap:normal] [&_em]:italic [&_em]:text-msg-t2">
          {/* overflow-wrap:anywhere — long unbreakable inline tokens (inline
           * code, paths, ids) wrap instead of spilling past the bubble edge.
           * Reset inside .md-pre: fenced code keeps its own overflow-x:auto
           * internal scroll with preserved indentation (lib/markdown contract). */}
          <Markdown text={message.content} />
        </div>
      </div>
    </div>
  );
});

import { memo, useState } from "react";
import { cn } from "../../../../lib/cn.js";
import { Markdown } from "../../../../lib/markdown.js";
import { Icons } from "../../../shared/icons.js";
import { useT } from "../../../../i18n/context.js";
import { formatRelativeTime } from "../../../layout/sidebar-utils.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";

/**
 * One experience-copilot message bubble (ER-11c). Props-driven presentation:
 * the shell owns the message list; this component renders a single wire message
 * with role-based chrome (assistant vs user), plus the CM-9 compaction digest
 * card (role === "digest").
 *
 * Fork of `CoauthorMessageBlock`, simplified for the copilot's wire shape: a
 * message is just `{ id, threadId, role, content, toolCallsJson, toolCallId,
 * createdAt }`. The co-author-only fields (greeting variants, author identity
 * from the active chat, macro resolution) have no copilot counterpart, so this
 * block is self-contained rather than delegating to the RP `MessageBlock`.
 */
export interface ExperienceCopilotMessageBlockProps {
  message: ExperienceCopilotMessageWire;
  /** For digest messages: the number of flow messages the digest covers (derived
   *  by the list via `orderMessagesWithDigests`). Null for non-digest messages
   *  and for a digest with no attributable count. */
  coveredCount?: number | null;
}

export const ExperienceCopilotMessageBlock = memo(function ExperienceCopilotMessageBlock({
  message,
  coveredCount = null,
}: ExperienceCopilotMessageBlockProps) {
  if (message.role === "digest") {
    return <DigestCard message={message} coveredCount={coveredCount} />;
  }

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

/** CM-9: the collapsed compaction-digest card. «Контекст сжат» header + caption
 *  (covers N messages / relative time), expand on click to the raw summary text.
 *  Reuses the durable tool-card chrome (a bordered `bg-s2` row with an icon +
 *  caret) rather than inventing new visual language. No fixed heights — the
 *  expanded body scrolls internally (`max-h-64`) so RU strings (20–30% longer)
 *  never clip. */
function DigestCard({
  message,
  coveredCount,
}: {
  message: ExperienceCopilotMessageWire;
  coveredCount: number | null;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const relative = formatRelativeTime(message.createdAt);

  return (
    <div className="mx-auto w-full max-w-[85%]" data-role="digest" data-testid="copilot-digest-card">
      <button
        type="button"
        data-testid="copilot-digest-card-toggle"
        data-covered-count={coveredCount ?? 0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full flex-col gap-1 rounded-lg border border-border bg-s2 px-3 py-2 text-left transition-colors hover:bg-s3"
      >
        <div className="flex items-center gap-2">
          <Icons.Stack className="h-3.5 w-3.5 shrink-0 text-t3" />
          <span className="font-ui text-[12px] font-medium text-t2">{t("copilot_context_digest_title")}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
            {coveredCount != null && coveredCount > 0 && (
              <span>{t("copilot_context_digest_caption", { n: coveredCount })}</span>
            )}
            {relative && (
              <span className="tabular-nums">{relative}</span>
            )}
            <Icons.Caret direction={expanded ? "u" : "d"} className="h-3 w-3 shrink-0" />
          </span>
        </div>
        {expanded && (
          <div
            data-testid="copilot-digest-card-body"
            className="max-h-64 overflow-y-auto rounded-md bg-s3 p-2.5 font-mono text-[12px] leading-[1.5] text-msg-t1 whitespace-pre-wrap"
          >
            {message.content}
          </div>
        )}
      </button>
    </div>
  );
}

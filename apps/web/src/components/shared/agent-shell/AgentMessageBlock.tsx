import { memo, useEffect, useState } from "react";
import { cn } from "../../../lib/cn.js";
import { Markdown } from "../../../lib/markdown.js";
import { AgentEditMessage } from "./AgentEditMessage.js";
import { Icons } from "../icons.js";
import { CustomTooltip } from "../Tooltip.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT } from "../../../i18n/context.js";
import { formatRelativeTime } from "../../layout/sidebar-utils.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { AgentMessageAction, AgentMessageMarkup } from "../../../lib/agent-host-registry.js";

/**
 * One experience-copilot message bubble (ER-11c). Props-driven presentation:
 * the shell owns the message list; this component renders a single wire message
 * with role-based chrome (flat assistant text vs the right-aligned user
 * bubble, AP-4), plus the CM-9 compaction digest card (role === "digest").
 *
 * Fork of `CoauthorMessageBlock`, simplified for the copilot's wire shape: a
 * message is just `{ id, threadId, role, content, toolCallsJson, toolCallId,
 * createdAt }`. The co-author-only fields (greeting variants, author identity
 * from the active chat, macro resolution) have no copilot counterpart, so this
 * block is self-contained rather than delegating to the RP `MessageBlock`.
 */
export interface AgentMessageBlockProps {
  message: ExperienceCopilotMessageWire;
  /** AP-2: the host's message markup — `rp-colors` renders the `agent-rp`
   *  Markdown variant (RP colors, no RP sizes), `plain` the `agent-plain`
   *  variant (plain typography). Resolved by the list from the host
   *  descriptor; required, so a caller that forgets it is a compile break. */
  messageMarkup: AgentMessageMarkup;
  /** For digest messages: the number of flow messages the digest covers (derived
   *  by the list via `orderMessagesWithDigests`). Null for non-digest messages
   *  and for a digest with no attributable count. */
  coveredCount?: number | null;
  /** SC-16: the host's message actions — rendered as a row under ASSISTANT
   *  messages only (user bubbles never carry them). Absent/empty = the message
   *  renders exactly as before (the fragment adds no DOM). The list passes
   *  this only for persisted messages — pending/streaming messages render no
   *  row (the RP row hides its actions while generating). */
  messageActions?: AgentMessageAction[];
  /** AP-11: the turn's actions (copy / regenerate / delete) — EITHER role.
   *  On assistant bubbles they merge with the host actions in the SAME row
   *  (host first); on user bubbles they render alone under the bubble. The
   *  list derives them per message (last turn, digest cover, streaming) —
   *  absent/empty = exactly as before (SC-16's assistant-only rule covered
   *  HOST actions; turn actions are new). */
  turnActions?: AgentMessageAction[];
  /** AP-12: the row belongs to the LAST user message (from
   *  `buildAgentTurnRow`'s `canEditLast`) — the block prepends its own
   *  «Изменить» opener to the user row. Gated with `onEditLast`: no submit
   *  path, no edit button. */
  canEditLast?: boolean;
  /** AP-12: submit an inline edit (delete the last exchange, then send —
   *  the controller's `handleEditLast`). The editor closes immediately on
   *  submit; the normal pending-user flow runs after. */
  onEditLast?: (content: string) => void;
  /** AP-12: follows the controller's `isSending` — both editor buttons
   *  disable, and a stream started from another row's action closes an
   *  open editor (editing is impossible while streaming). */
  isBusy?: boolean;
}

export const AgentMessageBlock = memo(function AgentMessageBlock({
  message,
  messageMarkup,
  coveredCount = null,
  messageActions,
  turnActions,
  canEditLast = false,
  onEditLast,
  isBusy = false,
}: AgentMessageBlockProps) {
  // AP-12: block-local editing state — the draft itself lives in
  // `AgentEditMessage` (local useState; the agent shell has no chat store
  // seam). Unconditional hooks: the digest/empty early returns below must
  // stay AFTER them.
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (isBusy) setEditing(false); }, [isBusy]);

  if (message.role === "digest") {
    return <DigestCard message={message} coveredCount={coveredCount} />;
  }

  const isUser = message.role === "user";

  // Tool-call carrier assistant turns have empty `content`; their activity is
  // surfaced inline by the message list (`CopilotActivityCard`), so render
  // nothing here (a zero-height bubble would be visually orphaned).
  if (message.content.trim().length === 0) return null;

  // SC-16: host actions stay assistant-only — user messages never carry them.
  // AP-11: turn actions ride either role; on assistant bubbles they merge
  // with the host actions in the SAME row (host first).
  const hostRow = !isUser && messageActions !== undefined && messageActions.length > 0 ? messageActions : undefined;
  const turnRow = turnActions !== undefined && turnActions.length > 0 ? turnActions : undefined;
  const actions = hostRow !== undefined || turnRow !== undefined
    ? [...(hostRow ?? []), ...(turnRow ?? [])]
    : undefined;

  // AP-4: the shared message body — the inner text container keeps `min-w-0`,
  // the `overflow-wrap:anywhere` / `[&_.md-pre]:[overflow-wrap:normal]` pair,
  // and the AP-2 Markdown variant below. Only the chrome around it differs
  // per role: the user keeps the bubble, the assistant renders flat.
  const body = (
    <div className="font-ui text-[calc(var(--ui-fs)-1px)] leading-[1.5] text-msg-t1 [overflow-wrap:anywhere] [&_.md-pre]:[overflow-wrap:normal]">
      {/* overflow-wrap:anywhere — long unbreakable inline tokens (inline
       * code, paths, ids) wrap instead of spilling past the bubble edge.
       * Reset inside .md-pre: fenced code keeps its own overflow-x:auto
       * internal scroll with preserved indentation (lib/markdown contract).
       * AP-2: no em override here — the agent-rp / agent-plain Markdown
       * variants own `em` (RP colors vs plain typography). */}
      <Markdown text={message.content} variant={messageMarkup === "rp-colors" ? "agent-rp" : "agent-plain"} />
    </div>
  );

  // AP-4 (mockup §1): user messages keep the right-aligned `bg-user-bg`
  // bubble, no avatar, `max-w-[85%]`. AP-11: with turn actions the row
  // becomes a right-aligned column (bubble above, action row below — the
  // parent's `items-end` is the alignment, mirroring mockup §1); without
  // them the shape below is byte-identical to the bubble-only row.
  if (isUser && turnRow === undefined) {
    return (
      <div className="flex flex-row-reverse" data-role={message.role}>
        <div
          className={cn(
            // min-w-0: the bubble is a flex item, so its automatic min-width is
            // the content's min-content — for a code block that is the LONGEST
            // line, which beat max-w-[85%] and blew the chat sideways (fix:
            // code-block overflow). min-w-0 lets the bubble shrink; .md-pre then
            // gets a bounded containing block and scrolls INTERNALLY as designed.
            "max-w-[85%] min-w-0 rounded-lg bg-user-bg px-3.5 py-2.5",
          )}
        >
          {body}
        </div>
      </div>
    );
  }

  // AP-12: the «Изменить» opener — constructed HERE (not in the row
  // builder): its `onSelect` flips the block-local editing state above,
  // which only this renderer can do. Eligibility still comes from the
  // builder (`canEditLast`); the reuses-the-existing-keys rule holds
  // (`edit` label, `copilot-turn-edit` testid family).
  const editAction: AgentMessageAction | undefined =
    canEditLast && onEditLast !== undefined && turnRow !== undefined
      ? {
        labelKey: "edit",
        icon: Icons.Edit,
        onSelect: () => setEditing(true),
        testId: "copilot-turn-edit",
      }
      : undefined;

  // AP-12: while editing, the editor swaps the WHOLE user arm (bubble +
  // row) in place — the action row hides, the save/cancel pair replaces
  // it; nothing else in the feed moves.
  if (isUser && editing && onEditLast !== undefined) {
    return (
      <div className="flex min-w-0 flex-col items-end group" data-role={message.role}>
        <AgentEditMessage
          initialText={message.content}
          isBusy={isBusy}
          onSubmit={(content) => { setEditing(false); onEditLast(content); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  // AP-11: the user bubble WITH turn actions — the right-aligned column.
  // AP-12: the «Изменить» opener leads the row on the last user message.
  const userRowActions: AgentMessageAction[] =
    editAction !== undefined && turnRow !== undefined ? [editAction, ...turnRow] : (turnRow ?? []);
  if (isUser) {
    return (
      <div className="flex min-w-0 flex-col items-end group" data-role={message.role}>
        <div
          className={cn(
            "max-w-[85%] min-w-0 rounded-lg bg-user-bg px-3.5 py-2.5",
          )}
        >
          {body}
        </div>
        <MessageActionRow actions={userRowActions} text={message.content} />
      </div>
    );
  }

  // AP-4 (mockup §1): assistant messages render flat — no avatar, no bubble
  // chrome, full row width. The per-turn caption («✦ {host title}») above the
  // turn's first visible text is the list's concern (it owns the turn
  // boundaries); this block stays caption-agnostic.
  return (
    <div
      className={cn(
        // min-w-0: the row is a flex item of the feed column — without it a
        // wide code block's min-content width beats the row and blows the
        // chat sideways (the same code-block overflow fix the user bubble
        // above carries).
        "min-w-0",
        actions !== undefined && "group",
      )}
      data-role={message.role}
    >
      {body}
      {actions !== undefined && <MessageActionRow actions={actions} text={message.content} />}
    </div>
  );
});

/**
 * SC-16: the message-action row under one bubble (AP-11: assistant bubbles
 * merge host + turn actions, user bubbles carry turn actions alone).
 * Correspondence map against the RP row (`MessageShell.tsx`):
 * - desktop row: `DesktopMessageActions`' container
 *   (`relative flex items-center gap-px mt-1.5 opacity-0 transition-opacity
 *   duration-150 group-hover:opacity-100`) — plus `focus-within:opacity-100`
 *   (NAMED deviation: the owner quote settles desktop reveal as "hover AND
 *   keyboard focus within the message"; the RP row has hover only).
 * - desktop button: the LS-4a Continue button (icon-only + `CustomTooltip`,
 *   `aria-label`, the same px/py/font-text hover chrome) — no `disabled`
 *   arm (the block carries no sending flag; the list passes actions for
 *   persisted bubbles only).
 * - mobile button: `MobileMessageActions`' icon button (`h-11 w-11` = 44px
 *   hit area, `[&_svg]:h-5 [&_svg]:w-5`, `title` + `aria-label`) — always
 *   visible (no opacity gate), same as the RP mobile row.
 * Alignment: none (AP-4) — the feed is flat, with no avatar column to align
 * to, so the row sits at the text edge with no left offset (the `pl-[38px]`
 * avatar-column offset is gone: w-7 = 28px + gap-2.5 = 10px no longer exists
 * in the block above). The row renders INSIDE the `.group` message row
 * (after the body) so the desktop `group-hover:opacity-100` fires — as a
 * sibling of the row it never did (group-hover matches descendants only).
 */
function MessageActionRow({ actions, text }: { actions: AgentMessageAction[]; text: string }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <div data-testid="copilot-message-actions">
        <div className="mt-1 flex items-center gap-1">
          {actions.map((action) => {
            const label = t(action.labelKey);
            const Icon = action.icon;
            return (
              <CustomTooltip key={action.testId} content={label}>
                <button
                  type="button"
                  aria-label={label}
                  title={label}
                  data-testid={action.testId}
                  className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 [&_svg]:h-5 [&_svg]:w-5"
                  onClick={() => action.onSelect(text)}
                >
                  <Icon />
                </button>
              </CustomTooltip>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="copilot-message-actions">
      <div className="relative mt-1.5 flex items-center gap-px opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        {actions.map((action) => {
          const label = t(action.labelKey);
          const Icon = action.icon;
          return (
            <CustomTooltip key={action.testId} content={label}>
              <button
                type="button"
                aria-label={label}
                data-testid={action.testId}
                className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
                onClick={() => action.onSelect(text)}
              >
                <Icon />
              </button>
            </CustomTooltip>
          );
        })}
      </div>
    </div>
  );
}

/** CM-9: the collapsed compaction-digest card. "Context compacted" header + caption
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
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{t("copilot_context_digest_title")}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t4">
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
            className="max-h-64 overflow-y-auto rounded-md bg-s3 p-2.5 font-mono text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-msg-t1 whitespace-pre-wrap"
          >
            {message.content}
          </div>
        )}
      </button>
    </div>
  );
}

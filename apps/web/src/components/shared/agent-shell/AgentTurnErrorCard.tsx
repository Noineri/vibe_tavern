/**
 * AgentTurnErrorCard (AGENT_SHELL_POLISH, Wave 3 / AP-13) — the turn-failure
 * card at the feed end (mockup §3). Two variants, one frame:
 *
 * - `failed` (live): the thread's last turn failed — title («Не удалось
 *   получить ответ») + the category description the toast carried (the ONE
 *   derivation in `use-agent-turn-actions.ts` — unknown categories render no
 *   description, like the bare toast) + «Повторить» (the controller's
 *   `handleRegenerate` — no new server surface).
 * - `unanswered` (after a reload): the thread's last row is an unanswered
 *   user message and no live failure survives — quieter title («Ответ не
 *   получен») + retry, never a description.
 *
 * fork #2 of AgentAskCard.tsx. Frame correspondence (named deviations):
 * the ask frame's border-y/border-r/border-l-2 shape, surface bg, and
 * `--ui-fs` ladder throughout; D1 — the left rule is `border-l-danger` (error
 * semantics, not the ask's accent/muted); D2 — the retry is the compact
 * action-button canon (the lore-entry «ИИ-помощник» shape) with the
 * regenerate icon, not the ask's 44px option rows (retry is chrome, not a
 * choice). Phone and desktop render the same shape (mockup §3 is
 * viewport-agnostic — no `useIsMobile` branch).
 */
import { cn } from "../../../lib/cn.js";
import { Ic } from "../icons.js";
import { useT } from "../../../i18n/context.js";
import { copilotFailureDescriptionKey, type AgentTurnFailure } from "./use-agent-turn-actions.js";

export interface AgentTurnErrorCardProps {
  /** The thread's live turn failure — null renders the quiet after-reload
   *  variant (no category survives a reload, so no description either). */
  failure: AgentTurnFailure | null;
  /** Retry the failed turn (the pane wires the controller's
   *  `handleRegenerate` — fire-and-forget, like the answer arm). */
  onRetry: () => void;
}

export function AgentTurnErrorCard({ failure, onRetry }: AgentTurnErrorCardProps) {
  const { t } = useT();
  const descriptionKey = failure !== null ? copilotFailureDescriptionKey(failure.category) : undefined;

  return (
    <div
      data-testid="copilot-error-card"
      data-variant={failure !== null ? "failed" : "unanswered"}
      className="flex min-w-0 flex-col gap-2 rounded-md border-y border-r border-l-2 border-border border-l-danger bg-surface px-2.5 py-2"
    >
      <span className="flex min-w-0 items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-danger-text">
        <span className="shrink-0 leading-[1.45]"><Ic.alert /></span>
        <span className="min-w-0 truncate">
          {t(failure !== null ? "copilot_turn_error_title" : "copilot_turn_error_unanswered_title")}
        </span>
      </span>

      {descriptionKey !== undefined && (
        <span
          data-testid="copilot-error-card-description"
          className="min-w-0 whitespace-normal break-words font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-t3"
        >
          {t(descriptionKey)}
        </span>
      )}

      <span>
        <button
          type="button"
          data-testid="copilot-error-card-retry"
          onClick={onRetry}
          className={cn(
            "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1",
          )}
        >
          <Ic.regen />
          {t("retry")}
        </button>
      </span>
    </div>
  );
}

/**
 * CopilotAskCard (TAG-9, AP-7 redesign) — the `ask_user` card in the copilot
 * message feed: the model's ONE clarifying question with option rows
 * (mockup §1–§2). Frame: the accent left rule, the header row («Вопрос
 * помощника» + quiet «Пропустить»), the question at the base ladder size in
 * `text-t1`, the options as full-width rows (number label, full wrapping
 * text, the «рекомендую» badge on the recommended one — no star); click =
 * answer. There is NO inner input: free-text answers go through the MAIN
 * composer (AP-5 — the composer answers the live ask), so the card is
 * options + skip only.
 *
 * forks: 2 — AgentPermissionCard.tsx (SC-23f, the `read_message_prompt`
 * permission gate; it takes this frame — the accent left rule, the header
 * row's layout and sizes, its title at the base ladder size in `text-t1`,
 * the `--ui-fs` ladder throughout, phone targets ≥ 44 px, the muted receipt
 * style — deviations D1–D5 named in the copy's header) +
 * AgentTurnErrorCard.tsx (AGENT_SHELL_POLISH AP-13, the turn-failure card;
 * takes the frame's shape, surface bg, and `--ui-fs` ladder — deviations
 * D1–D2 named in the copy's header).
 *
 * Submitting goes through the TAG-5 split-turn answer mode (style B): the
 * answer REPLACES the awaiting tool-result row server-side (no separate user
 * row) and the turn resumes as a continuation — this card never starts a new
 * user message.
 *
 * States (`data-state`):
 * - `awaiting` — the interactive rows: option rows (the single
 *   `recommended` one carries the badge) + the quiet skip button (a
 *   deliberate `(skipped)` non-answer, not a dismissal).
 * - `answered` — read-only receipt: the question muted + `→ answer` in
 *   `text-t1` (no green).
 * - `skipped` — read-only muted receipt (the question + the muted marker).
 * - `expired` — the ask was never answered and a LATER activity exists (the
 *   user moved on; the backend self-heals the model side with the
 *   "(the user did not answer…)" prose). Read-only muted.
 *
 * The card itself is dumb: the MessageList decides `interactive` (last
 * activity of the thread + awaiting + no stream running) and resolves the
 * optimistic `pendingAskAnswer` override before passing `ask` down.
 */
import type { AgentAskState } from "../../../stores/agent-turn-store.js";
import type { CopilotAskAnswerInput } from "../../../api/experience-copilot-api.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../icons.js";
import { useT } from "../../../i18n/context.js";

export interface AgentAskCardProps {
  /** The ask state (already resolved through the optimistic override). */
  ask: AgentAskState;
  /** True only while this is the thread's last activity, still awaiting an
   *  answer, and no stream is running. Everything else renders read-only. */
  interactive: boolean;
  onSubmit?: (answer: CopilotAskAnswerInput) => void;
}

export function AgentAskCard({ ask, interactive, onSubmit }: AgentAskCardProps) {
  const { t } = useT();
  const options = ask.options ?? [];
  // Defensive: the recommended label only marks a row when it IS one of the
  // options (the backend schema pins recommended ∈ options; a legacy or
  // hand-built payload that violates this renders every row unmarked).
  const recommended =
    ask.recommended !== undefined && options.includes(ask.recommended)
      ? ask.recommended
      : undefined;

  const state: "awaiting" | "answered" | "skipped" | "expired" =
    ask.status === "awaiting_answer" ? (interactive ? "awaiting" : "expired") : ask.status;

  return (
    <div
      data-testid="copilot-ask-card"
      data-state={state}
      className={cn(
        // The left rule is the frame's signature (the profile/skill list rows
        // use the same border-l-2 idiom): accent while awaiting, muted on the
        // read-only receipts. border-y/border-r (not the `border` shorthand)
        // so the left width never loses to shorthand cascade order.
        "flex min-w-0 flex-col gap-2 rounded-md border-y border-r border-l-2 border-border bg-surface px-2.5 py-2",
        state === "awaiting" ? "border-l-accent" : "border-l-border",
      )}
    >
      {state === "awaiting" && (
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-accent">
            <span className="shrink-0 leading-[1.45]"><Ic.help /></span>
            <span className="min-w-0 truncate">{t("copilot_ask_title")}</span>
          </span>
          <button
            type="button"
            data-testid="copilot-ask-skip"
            onClick={() => onSubmit?.({ skipped: true })}
            className="shrink-0 rounded-md px-2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t2"
          >
            {t("copilot_ask_skip")}
          </button>
        </div>
      )}

      <span
        data-testid="copilot-ask-question"
        className={cn(
          "min-w-0 whitespace-normal break-words font-ui leading-snug",
          state === "awaiting" ? "text-[var(--ui-fs)] text-t1" : "text-[calc(var(--ui-fs)-2px)] text-t4",
        )}
      >
        {ask.question}
      </span>

      {state === "awaiting" && options.length > 0 && (
        <div className="flex flex-col gap-1">
          {options.map((option, index) => {
            const isRecommended = option === recommended;
            return (
              <button
                key={`${index}-${option}`}
                type="button"
                data-testid={`copilot-ask-chip-${index}`}
                {...(isRecommended ? { "data-recommended": "true" } : {})}
                onClick={() => onSubmit?.({ text: option })}
                className={cn(
                  "flex min-h-[44px] w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left font-ui text-[calc(var(--ui-fs)-2px)] leading-snug transition-colors",
                  isRecommended
                    ? "border-accent bg-accent/10 text-t1 hover:bg-accent/15"
                    : "border-border text-t2 hover:bg-s2 hover:text-t1",
                )}
              >
                <span className="shrink-0 text-t4">{index + 1}</span>
                <span className="min-w-0 flex-1 whitespace-normal break-words">{option}</span>
                {isRecommended && (
                  <span className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[calc(var(--ui-fs)-3px)] text-accent">
                    {t("copilot_ask_recommended_badge")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {state === "answered" && (
        <div
          data-testid="copilot-ask-answer"
          className="min-w-0 whitespace-normal break-words font-ui text-[var(--ui-fs)] leading-snug text-t1"
        >
          → {ask.answer}
        </div>
      )}
      {state === "skipped" && (
        <div
          data-testid="copilot-ask-skipped"
          className="flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-2px)] italic text-t4"
        >
          <Ic.close />
          {t("copilot_ask_skipped")}
        </div>
      )}
      {state === "expired" && (
        <div
          data-testid="copilot-ask-expired"
          className="font-ui text-[calc(var(--ui-fs)-2px)] italic text-t4"
        >
          {t("copilot_ask_expired")}
        </div>
      )}
    </div>
  );
}

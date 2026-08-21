/**
 * CopilotAskCard (TAG-9) — the `ask_user` card in the copilot message feed:
 * the model's ONE clarifying question with the hybrid answer affordances
 * (verbatim user decisions: «насчет аска: стиль б. формат: гибрид» +
 * «8 да, рекомендуемый» — option chips AND free text, one option flagged
 * recommended).
 *
 * Submitting goes through the TAG-5 split-turn answer mode (style B): the
 * answer REPLACES the awaiting tool-result row server-side (no separate user
 * row) and the turn resumes as a continuation — this card never starts a new
 * user message.
 *
 * States (`data-state`):
 * - `awaiting` — the interactive form: option chips (the single
 *   `recommended` one is accent-highlighted with a star marker), a free-text
 *   input (Enter submits, Shift+Enter newline), and the skip button (a
 *   deliberate `(skipped)` non-answer, not a dismissal).
 * - `answered` — read-only: the user's answer text.
 * - `skipped` — read-only muted skip marker.
 * - `expired` — the ask was never answered and a LATER activity exists (the
 *   user moved on; the backend self-heals the model side with the
 *   "(the user did not answer…)" prose). Read-only muted.
 *
 * The card itself is dumb: the MessageList decides `interactive` (last
 * activity of the thread + awaiting + no stream running) and resolves the
 * optimistic `pendingAskAnswer` override before passing `ask` down.
 */
import { useState } from "react";
import type { CopilotAskState } from "../../../../stores/experience-copilot-turn-store.js";
import type { CopilotAskAnswerInput } from "../../../../api/experience-copilot-api.js";
import { cn } from "../../../../lib/cn.js";
import { inputCls } from "../../fields/field-styles.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { Ic } from "../../../shared/icons.js";
import { useT } from "../../../../i18n/context.js";

export interface CopilotAskCardProps {
  /** The ask state (already resolved through the optimistic override). */
  ask: CopilotAskState;
  /** True only while this is the thread's last activity, still awaiting an
   *  answer, and no stream is running. Everything else renders read-only. */
  interactive: boolean;
  onSubmit?: (answer: CopilotAskAnswerInput) => void;
}

export function CopilotAskCard({ ask, interactive, onSubmit }: CopilotAskCardProps) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const options = ask.options ?? [];
  // Defensive: the recommended label only marks a chip when it IS one of the
  // options (the backend schema pins recommended ∈ options; a legacy or
  // hand-built payload that violates this renders every chip unmarked).
  const recommended =
    ask.recommended !== undefined && options.includes(ask.recommended)
      ? ask.recommended
      : undefined;

  const state: "awaiting" | "answered" | "skipped" | "expired" =
    ask.status === "awaiting_answer" ? (interactive ? "awaiting" : "expired") : ask.status;

  const submitText = () => {
    const text = draft.trim();
    if (!text || !onSubmit) return;
    setDraft("");
    onSubmit({ text });
  };

  return (
    <div
      data-testid="copilot-ask-card"
      data-state={state}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5">
        <span className={cn("mt-px shrink-0 leading-[1.45]", state === "awaiting" ? "text-accent" : "text-t4")}>
          <Ic.help />
        </span>
        <span
          data-testid="copilot-ask-question"
          className="min-w-0 whitespace-normal break-words font-ui text-[12px] leading-snug text-t2"
        >
          {ask.question}
        </span>
      </div>

      {state === "awaiting" && (
        <>
          {options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {options.map((option, index) => {
                const isRecommended = option === recommended;
                const chip = (
                  <button
                    key={`${index}-${option}`}
                    type="button"
                    data-testid={`copilot-ask-chip-${index}`}
                    {...(isRecommended ? { "data-recommended": "true" } : {})}
                    onClick={() => onSubmit?.({ text: option })}
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-2 py-0.5 font-ui text-[11px] transition-colors",
                      isRecommended
                        ? "border-accent bg-accent/15 text-accent hover:bg-accent/25"
                        : "border-border text-t2 hover:bg-s2 hover:text-t1",
                    )}
                  >
                    {isRecommended && <Ic.starFilled />}
                    {option}
                  </button>
                );
                return isRecommended ? (
                  <CustomTooltip key={`${index}-${option}`} content={t("copilot_ask_recommended")}>
                    {chip}
                  </CustomTooltip>
                ) : (
                  chip
                );
              })}
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <AutoTextarea
              className={cn(inputCls, "text-[12px]")}
              minRows={1}
              maxRows={4}
              macroAutocomplete={false}
              data-testid="copilot-ask-input"
              placeholder={t("copilot_ask_placeholder")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitText();
                }
              }}
            />
            <button
              type="button"
              data-testid="copilot-ask-submit"
              aria-label={t("copilot_ask_submit")}
              disabled={draft.trim().length === 0}
              onClick={submitText}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent transition-opacity disabled:opacity-40"
            >
              <Ic.send />
            </button>
            <button
              type="button"
              data-testid="copilot-ask-skip"
              onClick={() => onSubmit?.({ skipped: true })}
              className="shrink-0 rounded-md px-2 py-1 font-ui text-[11px] text-t3 transition-colors hover:bg-s2 hover:text-t2"
            >
              {t("copilot_ask_skip")}
            </button>
          </div>
        </>
      )}

      {state === "answered" && (
        <div className="flex items-start gap-1.5 text-success-text">
          <span className="mt-px shrink-0 leading-[1.45]"><Ic.check /></span>
          <span
            data-testid="copilot-ask-answer"
            className="min-w-0 whitespace-normal break-words font-ui text-[11px] leading-snug"
          >
            {ask.answer}
          </span>
        </div>
      )}
      {state === "skipped" && (
        <div
          data-testid="copilot-ask-skipped"
          className="flex items-center gap-1.5 font-ui text-[11px] italic text-t4"
        >
          <Ic.close />
          {t("copilot_ask_skipped")}
        </div>
      )}
      {state === "expired" && (
        <div
          data-testid="copilot-ask-expired"
          className="font-ui text-[11px] italic text-t4"
        >
          {t("copilot_ask_expired")}
        </div>
      )}
    </div>
  );
}

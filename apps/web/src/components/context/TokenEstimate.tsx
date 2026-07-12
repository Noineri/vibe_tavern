import { useT } from "../../i18n/context.js";
import { countTokens } from "../../utils/tokenizer.js";

/**
 * Compute the token-savings estimate for the Summary memory strategy. Pure
 * (mirrors the original `useMemo` body in ContextMemoryModal) so the
 * arithmetic — history excludes summarized ranges then slices to the limit;
 * `saved`/`pct` derive from the selected-range raw tokens minus the summary —
 * is unit-testable without rendering the modal.
 */
export function computeTokenEstimate(
  draftText: string,
  excludedRanges: ReadonlyArray<{ from: number; to: number }>,
  historyLimit: number,
  messages: ReadonlyArray<{ position?: number | null; content: string }>,
  selectedRangeMessages: ReadonlyArray<{ content: string }>,
): { summaryTokens: number; historyTokens: number; total: number; selectedRawTokens: number; saved: number; pct: number } {
  const summaryTokens = countTokens(draftText);
  const limitedMessages = messages
    .filter((m) => {
      const pos = (m.position ?? 0) + 1;
      return !excludedRanges.some((r) => pos >= r.from && pos <= r.to);
    })
    .slice(-(historyLimit || messages.length));
  const historyTokens = limitedMessages.reduce((sum, m) => sum + countTokens(m.content), 0);
  const selectedRawTokens = selectedRangeMessages.reduce((sum, m) => sum + countTokens(m.content), 0);
  const saved = Math.max(0, selectedRawTokens - summaryTokens);
  const pct = selectedRawTokens > 0 ? Math.round((saved / selectedRawTokens) * 100) : 0;
  return { summaryTokens, historyTokens, total: summaryTokens + historyTokens, selectedRawTokens, saved, pct };
}

export type TokenEstimateShape = ReturnType<typeof computeTokenEstimate>;

/**
 * Token-savings bar + lines for the Summary tab. Presentational: takes the
 * computed shape (from `computeTokenEstimate`) so the parent can also read
 * `summaryTokens` for the textarea footer line, and the arithmetic stays a
 * pure, unit-tested function rather than buried in a component.
 */
export function TokenEstimate({ estimate }: { estimate: TokenEstimateShape }) {
  const { t } = useT();
  return (
    <section className="mt-3 rounded-lg border border-border bg-input-bg p-4">
      <div className="mb-2 font-ui text-[12px] text-t3">
        {t("summary_token_line", {
          summary: estimate.summaryTokens,
          history: estimate.historyTokens,
          total: estimate.total,
        })}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-s3">
        <div className="h-full bg-accent transition-all" style={{ width: `${estimate.total > 0 ? Math.min(100, Math.round((estimate.summaryTokens / estimate.total) * 100)) : 0}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between font-ui text-[11px] text-t4">
        <span>{t("summary_without_line", { tokens: estimate.selectedRawTokens })}</span>
        <span className="text-success-text">{t("summary_saved_line", { tokens: estimate.saved, pct: estimate.pct })}</span>
      </div>
    </section>
  );
}

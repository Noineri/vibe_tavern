/**
 * ExperienceEffectDiagnostics — trusted-chrome surface for durable effect
 * failures (EXPERIENCE_ENGINE_LOBBY_REPORT, pending queue position 1: effect
 * diagnostics + retry). Built by the launcher from server-authoritative store
 * rows and rendered INSIDE the session modal chrome — never inside the
 * sandboxed visual (the z-index trap: a visual-rendered error toast can sit
 * physically under a full-screen overlay and be invisible on every platform).
 *
 * Pure presentational + the one async retry action (same contract as
 * ExperienceReportControls): every status and error string comes from the
 * effect rows; nothing is synthesized. Only failed/cancelled/unknown rows
 * render — pending/running/succeeded rows are the header badge's business
 * (pendingPhase), not this block's.
 *
 * Retry contract: `onRetry` resolves on success (the store resync supplies the
 * new pending row; the chat-page runner picks it up — LB-10) and rejects on
 * failure so this component can surface a fail-closed localized error next to
 * the row. Duplicate clicks are suppressed while a retry is in flight. After a
 * successful retry the row leaves the failed set and the block drops the row
 * (often the whole block) on the next authoritative render.
 */
import { useState, type ReactNode } from "react";
import { EXPERIENCE_EFFECT_STATUS } from "@vibe-tavern/domain";
import type { ExperienceEffectRow } from "../../api/types.js";
import { useT, type TFunc } from "../../i18n/context.js";

/** Statuses this block renders; everything else is deliberately not shown.
 *  Exported so the parent can decide whether to mount the block at all (the
 *  modal renders its chrome wrapper for ANY truthy ReactNode — an element
 *  that renders null would still paint an empty bordered strip). */
export const RETRYABLE_EFFECT_STATUSES: readonly string[] = [
  EXPERIENCE_EFFECT_STATUS.failed,
  EXPERIENCE_EFFECT_STATUS.cancelled,
  EXPERIENCE_EFFECT_STATUS.unknown,
];

const STATUS_LABEL_KEY: Record<string, Parameters<TFunc>[0]> = {
  [EXPERIENCE_EFFECT_STATUS.pending]: "experience_effect_status_pending",
  [EXPERIENCE_EFFECT_STATUS.running]: "experience_effect_status_running",
  [EXPERIENCE_EFFECT_STATUS.succeeded]: "experience_effect_status_succeeded",
  [EXPERIENCE_EFFECT_STATUS.failed]: "experience_effect_status_failed",
  [EXPERIENCE_EFFECT_STATUS.cancelled]: "experience_effect_status_cancelled",
  [EXPERIENCE_EFFECT_STATUS.unknown]: "experience_effect_status_unknown",
};

export interface ExperienceEffectDiagnosticsProps {
  /** The scope's full durable effect rows (server-authoritative). The block
   *  filters to the retryable statuses itself. */
  readonly effects: readonly ExperienceEffectRow[];
  /** Retry one effect through the store (`store.retryEffect`). Resolves on
   *  success; rejects on failure so the row-local error is surfaced here. */
  readonly onRetry: (effectId: string) => Promise<void>;
}

export function ExperienceEffectDiagnostics(props: ExperienceEffectDiagnosticsProps): ReactNode {
  const { effects, onRetry } = props;
  const { t } = useT();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retryable = effects.filter((e) => RETRYABLE_EFFECT_STATUSES.includes(e.status));
  if (retryable.length === 0) return null;

  async function handleRetry(effectId: string): Promise<void> {
    if (retryingId !== null) return; // one retry in flight at a time
    setRetryingId(effectId);
    setError(null);
    try {
      await onRetry(effectId);
    } catch {
      // Fail-closed: the row stays as-is (the store resync is authoritative);
      // surface a localized error, never an optimistic status change.
      setError(t("experience_effect_retry_error"));
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="experience-effect-diagnostics">
      {retryable.map((effect) => (
        <div
          key={effect.id}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 font-ui text-[11px]"
          data-testid={`experience-effect-row-${effect.id}`}
        >
          <span
            className="shrink-0 rounded bg-danger-dim px-1.5 py-0.5 text-danger-text"
            data-testid="experience-effect-status"
          >
            {t(STATUS_LABEL_KEY[effect.status] ?? "experience_effect_status_unknown")}
          </span>
          {effect.error && (
            <span className="min-w-0 flex-1 truncate text-t3" data-testid="experience-effect-error" title={effect.error}>
              <span className="text-t4">{t("experience_effect_error_label")} </span>
              {effect.error}
            </span>
          )}
          <button
            type="button"
            className="ml-auto shrink-0 cursor-pointer rounded border border-border bg-bg px-2 py-1 font-ui text-[11px] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40 max-md:min-h-9"
            disabled={retryingId !== null}
            onClick={() => void handleRetry(effect.id)}
            data-testid={`experience-effect-retry-${effect.id}`}
          >
            {retryingId === effect.id ? t("experience_effect_retrying") : t("experience_effect_retry")}
          </button>
        </div>
      ))}
      {error && (
        <span className="text-danger-text" data-testid="experience-effect-retry-error">
          {error}
        </span>
      )}
    </div>
  );
}

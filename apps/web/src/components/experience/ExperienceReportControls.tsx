/**
 * ExperienceReportControls — the trusted report-control surface for an active
 * interactive-experience session (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 7 /
 * IR-73C_report_controls). A PURE presentational component plus the one async
 * queue/clear actions: every displayed count, frontier, and revision comes from
 * server-authoritative props, never inferred from reducer revisions or
 * synthesized locally.
 *
 * Server-authoritative contract (no silent growth — the frozen queued snapshot
 * NEVER grows locally):
 *  - Frozen queued public-event count: `queuedAttachment.publicReport?.events.length`.
 *    A malformed/null public report is fail-closed — the count is NOT guessed.
 *  - Later/pending public-event count: `reportStatus.pendingPublicEventCount` ONLY.
 *  - Report frontier: `reportStatus.reportFrontier` (distinct from event count).
 *  - Queue/session revisions: `queuedAttachment.queueRevision` / `.sessionRevision`.
 *
 * Action states (all driven by props — no endpoint call without a user click):
 *  - No queued attachment + pending > 0 → enabled "Queue for next message".
 *  - Queued attachment + pending > 0   → enabled "Add later events".
 *  - Queued attachment + pending === 0 → disabled "Up to date" (no call).
 *  - No queued attachment + no pending → disabled "No events" (no call).
 *
 * The queue action calls `onQueue` (the parent wires it to
 * `store.queueReport`, which is the same server operation for both the initial
 * manual Queue and a replacement/Add-later). Duplicate clicks are suppressed
 * while pending. On rejection the frozen values stay unchanged and a fail-closed
 * localized error is shown — never an optimistic count or revision bump. On
 * success the component renders ONLY the new props supplied by the store
 * rehydrate/response; it does not synthesize a queue revision or append events.
 */
import { useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import type {
  ExperienceQueuedAttachmentView,
  ExperienceReportStatus,
} from "../../api/types.js";

export interface ExperienceReportControlsProps {
  /** The session's frozen queued attachment (null when none is queued). */
  readonly queuedAttachment: ExperienceQueuedAttachmentView | null;
  /** The session's server report status (null while unloaded / no session). */
  readonly reportStatus: ExperienceReportStatus | null;
  /** Submit the queue / add-later action through the store. Resolves on
   *  success; rejects on failure so the component surfaces a fail-closed
   *  error without touching the frozen values. */
  readonly onQueue: () => Promise<void>;
  /** Clear the queue; reject on failure and leave all frozen props unchanged. */
  readonly onClear: () => Promise<void>;
}

/** The four mutually-exclusive action-surface states, computed purely from
 *  the server-authoritative props. Exported for unit testing. */
export type ReportActionState =
  | { kind: "queue"; pending: number }
  | { kind: "addLater"; pending: number }
  | { kind: "upToDate" }
  | { kind: "noEvents" };

/** Pure derivation of the action state from the server-authoritative props.
 *  No local counting or revision inference — `pendingPublicEventCount` is the
 *  sole source of "are there new events to freeze". Exported for unit testing. */
export function computeReportActionState(
  queuedAttachment: ExperienceQueuedAttachmentView | null,
  reportStatus: ExperienceReportStatus | null,
): ReportActionState {
  // pending count comes ONLY from the server report status; a null/unloaded
  // status is fail-closed (treated as 0 — no action offered until loaded).
  const pending = reportStatus?.pendingPublicEventCount ?? 0;
  const hasAttachment = queuedAttachment !== null;
  if (pending > 0) {
    return hasAttachment ? { kind: "addLater", pending } : { kind: "queue", pending };
  }
  return hasAttachment ? { kind: "upToDate" } : { kind: "noEvents" };
}

export function ExperienceReportControls(props: ExperienceReportControlsProps): ReactNode {
  const { queuedAttachment, reportStatus, onQueue, onClear } = props;
  const { t } = useT();
  const [pending, setPending] = useState<"queue" | "clear" | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // ── Server-authoritative values (props only — never synthesized) ──────────
  // `frozenCount` is `undefined` when there is no attachment OR the report is
  // malformed (publicReport null) — that is the fail-closed "do not guess"
  // state, distinct from a real zero.
  const frozenCount = queuedAttachment?.publicReport?.events.length;
  const pendingCount = reportStatus?.pendingPublicEventCount ?? 0;
  const reportFrontier = reportStatus?.reportFrontier;
  const queueRevision = queuedAttachment?.queueRevision;
  const sessionRevision = queuedAttachment?.sessionRevision;
  const action = computeReportActionState(queuedAttachment, reportStatus);
  const actionable = action.kind === "queue" || action.kind === "addLater";

  async function handleClick(kind: "queue" | "clear"): Promise<void> {
    // Disable duplicate clicks; never act on a non-actionable state.
    if (inFlight.current || (kind === "queue" ? !actionable : queuedAttachment === null)) return;
    inFlight.current = true;
    setPending(kind);
    setError(null);
    try {
      await (kind === "queue" ? onQueue() : onClear());
      // On success the store rehydrate supplies the new props; clear any
      // previous local error. No optimistic count/revision change here.
      setError(null);
    } catch {
      // Fail-closed: keep the old frozen values; surface a localized error.
      setError(t(kind === "queue" ? "experience_report_action_error" : "experience_report_clear_error"));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  const label =
    action.kind === "queue"
      ? t("experience_report_queue")
      : action.kind === "addLater"
        ? t("experience_report_add_later")
        : action.kind === "upToDate"
          ? t("experience_report_up_to_date")
          : t("experience_report_no_events");

  const showFrozenMalformed = queuedAttachment !== null && frozenCount === undefined;

  return (
    <div className="@container/report flex flex-col gap-1.5" data-testid="experience-report-controls">
      <div className="flex flex-col gap-1.5 @min-[40rem]/report:flex-row @min-[40rem]/report:items-center @min-[40rem]/report:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* Frozen + pending counts (server-authoritative; never synthesized). */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-ui text-[calc(var(--ui-fs)-3px)]">
            {showFrozenMalformed ? (
              <span className="text-warning-text" data-testid="experience-report-frozen-malformed">
                {t("experience_report_queued_malformed")}
              </span>
            ) : (
              frozenCount !== undefined && (
                <span className="text-t3" data-testid="experience-report-frozen">
                  {t("experience_report_queued_events", { n: frozenCount })}
                </span>
              )
            )}
            <span className="text-t4" data-testid="experience-report-pending">
              {t("experience_report_pending_events", { n: pendingCount })}
            </span>
          </div>

          {/* Frontier / revisions metadata (distinct from event counts). */}
          {(reportFrontier !== undefined || queueRevision !== undefined || sessionRevision !== undefined) && (
            <div
              className="flex flex-wrap gap-x-3 gap-y-0.5 font-ui text-[calc(var(--ui-fs)-4px)] text-t4"
              data-testid="experience-report-meta"
            >
              {reportFrontier !== undefined && (
                <span data-testid="experience-report-frontier">
                  {t("experience_report_frontier", { n: reportFrontier })}
                </span>
              )}
              {queueRevision !== undefined && (
                <span data-testid="experience-report-queue-rev">
                  {t("experience_report_queue_rev", { n: queueRevision })}
                </span>
              )}
              {sessionRevision !== undefined && (
                <span data-testid="experience-report-session-rev">
                  {t("experience_report_session_rev", { n: sessionRevision })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Narrow surfaces stack primary then secondary; wide footers put Clear first on the right. */}
        <div className="flex flex-col gap-1.5 @min-[40rem]/report:shrink-0 @min-[40rem]/report:flex-row-reverse">
          <button
            type="button"
            className={cn(
              "rounded px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium transition-colors max-md:min-h-9",
              actionable && !pending
                ? "bg-accent text-on-accent hover:opacity-90"
                : "cursor-not-allowed bg-s2 text-t4",
            )}
            disabled={!actionable || pending !== null}
            onClick={() => void handleClick("queue")}
            data-testid="experience-report-action"
            data-action={action.kind}
          >
            {pending === "queue" ? t("experience_report_pending_action") : label}
          </button>
          <button
            type="button"
            className="rounded bg-s2 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-colors hover:bg-s3 disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-9"
            disabled={queuedAttachment === null || pending !== null}
            onClick={() => void handleClick("clear")}
            data-testid="experience-report-clear"
          >
            {t("experience_report_clear")}
          </button>
        </div>
      </div>

      {error && (
        <p
          className="font-ui text-[calc(var(--ui-fs)-3px)] leading-relaxed text-danger-text"
          role="alert"
          data-testid="experience-report-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}

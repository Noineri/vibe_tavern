import { useMemo } from "react";
import { buildLineDiff, type TextDiffSummary } from "../../../shared/TextDiffPreview.js";
import { allHunkIds, groupHunks, mergeSelectedBody, type DiffHunk } from "../../../../lib/coauthor-hunk-merge.js";
import { CodeEditor } from "../../../shared/CodeEditor.js";
import { computeDiffDecorationSpecs, copilotDiffExtensions } from "./CopilotDiffDecorations.js";
import { cn } from "../../../../lib/cn.js";
import { useT } from "../../../../i18n/context.js";

/**
 * CD-6: the copilot editor pane's content area in review mode — the inline-diff
 * document (green hunks + accept buttons, CD-5) plus the review bar
 * («принять все / N ханков / отменить изменения»).
 *
 * The panel is PROPS-DRIVEN and stateless by design: the accept-selection
 * state lives in the shell (it must survive buffer-tab switches, which remount
 * this panel). While a review is active the document shows the PROPOSED text
 * and is read-only — the review surface is the accept flow, not an editing
 * surface (hand-editing during review is the conflict path, CD-8); the editor
 * is likewise frozen while the model generates (CD-3).
 */
export interface CopilotBufferReview {
  /** Unaccepted hunk count (1 in the tooLarge whole-buffer fallback). */
  pendingCount: number;
  /** The aggregated proposed text for this buffer (the review document). */
  proposed: string;
  /** The turn-start snapshot text (the diff's "before" side). */
  base: string;
  /** Line diff base→proposed; null when tooLarge (no hunk UI — accept-all only). */
  diff: TextDiffSummary | null;
  /** Grouped hunks of `diff` (empty for the tooLarge fallback). */
  hunks: DiffHunk[];
}

/** Derive the per-buffer review from the proposal + snapshot + accepted set.
 *  Pure. Returns null when there is nothing to review (no pending proposal for
 *  this buffer, everything accepted, or generation in flight). */
export function buildBufferReview(
  base: string | undefined,
  proposed: string | undefined,
  acceptedHunkIds: ReadonlySet<number>,
  enabled: boolean,
): CopilotBufferReview | null {
  if (!enabled || base === undefined || proposed === undefined) return null;
  const diff = buildLineDiff(base, proposed);
  if (diff.tooLarge) {
    // The whole-buffer fallback: no hunk decomposition (the diff engine's line
    // budget gave up), so the review bar offers wholesale accept-all only —
    // the buffer is never left without an explicit resolution path.
    return { pendingCount: 1, proposed, base, diff: null, hunks: [] };
  }
  const hunks = groupHunks(diff);
  const pending = hunks.filter((h) => !acceptedHunkIds.has(h.id)).length;
  if (pending === 0) return null;
  return { pendingCount: pending, proposed, base, diff, hunks };
}

/** The buffer text an accept produces for the given selection: the merged
 *  hybrid (accepted hunks applied over the base), or the wholesale proposal in
 *  the tooLarge fallback. Pure. */
export function mergedReviewText(review: CopilotBufferReview, acceptedHunkIds: ReadonlySet<number>): string {
  if (review.diff === null) return review.proposed;
  return mergeSelectedBody(review.diff, acceptedHunkIds);
}

/** Every hunk id of the review (the accept-all selection). Pure. */
export function allReviewHunkIds(review: CopilotBufferReview): Set<number> {
  return allHunkIds(review.hunks);
}

export interface ExperienceCopilotEditorPanelProps {
  /** The draft buffer text (the free-mode document). */
  value: string;
  onChange: (value: string) => void;
  /** True while the model generates (freeze, CD-3). */
  isSending: boolean;
  /** The pending review for THIS buffer, or null in free mode. */
  review: CopilotBufferReview | null;
  /** Hunk ids already accepted this review. */
  acceptedHunkIds: ReadonlySet<number>;
  onAcceptHunk: (hunkId: number) => void;
  onAcceptAll: () => void;
  /** Draft-level revert (turn-start snapshot), shared across buffers. */
  onRevert: () => void;
  canRevert: boolean;
}

export function ExperienceCopilotEditorPanel({
  value,
  onChange,
  isSending,
  review,
  acceptedHunkIds,
  onAcceptHunk,
  onAcceptAll,
  onRevert,
  canRevert,
}: ExperienceCopilotEditorPanelProps) {
  const { t } = useT();

  const specs = useMemo(
    () =>
      review?.diff
        ? computeDiffDecorationSpecs(review.diff, review.hunks, acceptedHunkIds)
        : [],
    [review, acceptedHunkIds],
  );
  // Fresh identity per (specs, accepted) change so CodeEditor's compartment
  // (CD-4) reconfigures — the only way an accept repaints without a doc change.
  const extensions = useMemo(
    () =>
      review !== null && specs.length > 0
        ? copilotDiffExtensions({
            specs,
            buttonLabel: t("copilot_review_accept_hunk"),
            buttonAriaLabel: t("copilot_review_accept_hunk"),
            onAcceptHunk,
          })
        : [],
    [review, specs, acceptedHunkIds, onAcceptHunk, t],
  );

  const docValue = review !== null ? review.proposed : value;
  const readOnly = isSending || review !== null;

  return (
    <>
      {review !== null && (
        <div
          data-testid="copilot-review-bar"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1.5"
        >
          <span
            data-testid="copilot-review-count"
            className="font-ui text-xs text-t2"
          >
            {t("copilot_review_hunks_count", { n: review.pendingCount })}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              data-testid="copilot-accept-all"
              onClick={onAcceptAll}
              className="min-h-9 cursor-pointer rounded-[5px] bg-accent px-3 font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110"
            >
              {t("copilot_review_accept_all")}
            </button>
            {canRevert && (
              <button
                type="button"
                data-testid="copilot-review-revert"
                onClick={onRevert}
                className="min-h-9 cursor-pointer rounded-[5px] border border-border bg-s2 px-3 font-ui text-xs font-medium text-t2 transition-colors duration-100 hover:text-t1"
              >
                {t("copilot_review_revert")}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* CD-3: frozen (read-only + dimmed + badge) while the model works. */}
        <div
          data-testid="copilot-editor-frame"
          className={cn(
            "relative h-full min-h-0 rounded-md border border-border bg-bg transition-opacity duration-150",
            isSending && "opacity-60",
          )}
        >
          <CodeEditor
            className="h-full"
            value={docValue}
            onChange={onChange}
            minHeight="300px"
            scrollMode="inner"
            readOnly={readOnly}
            extensions={extensions}
          />
          {isSending && (
            <div
              data-testid="copilot-editor-frozen"
              className="pointer-events-none absolute left-2 top-2 z-10 rounded-full bg-s3 px-2 py-0.5 font-ui text-[11px] text-t2"
            >
              {t("copilot_review_model_editing")}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

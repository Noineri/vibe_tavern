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

/** Sentinel hunk id for the tooLarge whole-buffer fallback (RV-1): the
 *  review has no hunk decomposition, so the single wholesale action resolves
 *  this id. -1 can never collide with real hunk ids (diff line indices ≥ 0). */
export const WHOLE_BUFFER_HUNK_ID = -1;

/** Derive the per-buffer review from the proposal + snapshot + accepted set.
 *  Pure. Returns null when there is nothing to review (no pending proposal for
 *  this buffer, everything accepted, or generation in flight). */
export function buildBufferReview(
  base: string | undefined,
  proposed: string | undefined,
  acceptedHunkIds: ReadonlySet<number>,
  enabled: boolean,
  dismissedHunkIds: ReadonlySet<number> = new Set(),
): CopilotBufferReview | null {
  if (!enabled || base === undefined || proposed === undefined) return null;
  const diff = buildLineDiff(base, proposed);
  if (diff.tooLarge) {
    // The whole-buffer fallback: no hunk decomposition (the diff engine's line
    // budget gave up), so the review bar offers wholesale accept-all only —
    // the buffer is never left without an explicit resolution path. The
    // sentinel id resolves the round (RV-1): before it, accept-all was a NO-OP
    // (the empty hunk set yields no ids) and the round never resolved.
    if (acceptedHunkIds.has(WHOLE_BUFFER_HUNK_ID) || dismissedHunkIds.has(WHOLE_BUFFER_HUNK_ID)) {
      return null;
    }
    return { pendingCount: 1, proposed, base, diff: null, hunks: [] };
  }
  const hunks = groupHunks(diff);
  const pending = hunks.filter((h) => !acceptedHunkIds.has(h.id) && !dismissedHunkIds.has(h.id)).length;
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

/** Every hunk id of the review (the accept-all selection). The tooLarge
 *  fallback resolves the single sentinel id (RV-1). Pure. */
export function allReviewHunkIds(review: CopilotBufferReview): Set<number> {
  if (review.diff === null) return new Set([WHOLE_BUFFER_HUNK_ID]);
  return allHunkIds(review.hunks);
}

/** Result of applying hunks onto a drifted buffer (the conflict path). */
export interface HunkSpliceResult {
  /** The buffer with every CLEANLY anchored hunk applied. */
  text: string;
  /** Hunks that no longer anchor onto the buffer (skipped, still pending). */
  skippedHunkIds: number[];
}

/**
 * CD-8 conflict path: apply the selected hunks onto the CURRENT buffer text
 * (not the snapshot base) by locating each hunk's removed-line block verbatim
 * and splicing in its added lines. A hunk whose removed lines no longer appear
 * contiguously in the buffer (the text changed under it — an external edit
 * during review) is CONFLICTING: it is skipped and stays pending, and it never
 * blocks the remaining hunks. No silent rebase: what cannot be anchored is
 * reported (`skippedHunkIds` → the shell's «N hunks skipped» toast), never
 * guessed into position. Pure insertion hunks (nothing removed → no anchor)
 * are treated as conflicting by the same rule.
 *
 * Only called when the buffer has drifted from the accept flow's expected
 * hybrid; the clean path (`mergeSelectedBody`) rebuilds from the snapshot.
 */
export function applyHunksToBuffer(
  buffer: string,
  diff: TextDiffSummary,
  hunks: readonly DiffHunk[],
  selectedHunkIds: ReadonlySet<number>,
): HunkSpliceResult {
  const lines = buffer.split("\n");
  const skippedHunkIds: number[] = [];
  const byId = new Map(hunks.map((h) => [h.id, h]));
  for (const id of selectedHunkIds) {
    const hunk = byId.get(id);
    if (!hunk) continue;
    const removedTexts: string[] = [];
    const addedTexts: string[] = [];
    for (let k = hunk.start; k < hunk.end; k++) {
      const line = diff.lines[k]!;
      if (line.kind === "remove") removedTexts.push(line.text);
      else if (line.kind === "add") addedTexts.push(line.text);
    }
    // Anchor = the hunk's removed lines as a contiguous whole-line run.
    // indexOf on a joined needle would match MID-LINE, so scan line runs.
    let at = -1;
    if (removedTexts.length > 0) {
      outer: for (let i = 0; i + removedTexts.length <= lines.length; i++) {
        for (let k = 0; k < removedTexts.length; k++) {
          if (lines[i + k] !== removedTexts[k]) continue outer;
        }
        at = i;
        break;
      }
    }
    if (at < 0) {
      skippedHunkIds.push(id); // pure insertion (no anchor) or text changed under it
      continue;
    }
    lines.splice(at, removedTexts.length, ...addedTexts);
  }
  return { text: lines.join("\n"), skippedHunkIds };
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
  /** Hunk ids dismissed this review (RV-2) — no decoration, not pending. */
  dismissedHunkIds: ReadonlySet<number>;
  onAcceptHunk: (hunkId: number) => void;
  onAcceptAll: () => void;
  /** RV-2: dismiss a single hunk (✕) — excluded from the round, buffer untouched. */
  onDismissHunk: (hunkId: number) => void;
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
  dismissedHunkIds,
  onAcceptHunk,
  onAcceptAll,
  onDismissHunk,
  onRevert,
  canRevert,
}: ExperienceCopilotEditorPanelProps) {
  const { t } = useT();

  // Dismissed hunks decorate like accepted ones (nothing) — the resolved set
  // drives the decoration engine (RV-2).
  const resolvedHunkIds = useMemo(() => {
    const resolved = new Set(acceptedHunkIds);
    for (const id of dismissedHunkIds) resolved.add(id);
    return resolved;
  }, [acceptedHunkIds, dismissedHunkIds]);

  const specs = useMemo(
    () =>
      review?.diff
        ? computeDiffDecorationSpecs(review.diff, review.hunks, resolvedHunkIds)
        : [],
    [review, resolvedHunkIds],
  );
  // Fresh identity per (specs, resolved) change so CodeEditor's compartment
  // (CD-4) reconfigures — the only way an accept/dismiss repaints without a
  // doc change.
  const extensions = useMemo(
    () =>
      review !== null && specs.length > 0
        ? copilotDiffExtensions({
            specs,
            buttonLabel: t("copilot_review_accept_hunk"),
            buttonAriaLabel: t("copilot_review_accept_hunk"),
            onAcceptHunk,
            dismissLabel: t("copilot_review_dismiss_hunk"),
            dismissAriaLabel: t("copilot_review_dismiss_hunk"),
            onDismissHunk,
          })
        : [],
    [review, specs, resolvedHunkIds, onAcceptHunk, onDismissHunk, t],
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

/**
 * ExperienceCopilotEditorPanel — the review-mode editor surface (CD-6).
 *
 * Pins the panel contract: the review bar (count + accept-all + revert), the
 * document switching to the proposed text in review mode (read-only), the
 * inline hunk accept through the REAL CodeMirror widget buttons, and the pure
 * helpers (buildBufferReview / mergedReviewText / allReviewHunkIds) at the
 * mergeSelectedBody boundary.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";
import {
  allReviewHunkIds,
  applyHunksToBuffer,
  buildBufferReview,
  ExperienceCopilotEditorPanel,
  mergedReviewText,
  WHOLE_BUFFER_HUNK_ID,
  type CopilotBufferReview,
} from "./ExperienceCopilotEditorPanel.js";
import { buildLineDiff } from "../../../shared/TextDiffPreview.js";
import { groupHunks } from "../../../../lib/coauthor-hunk-merge.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
});

const BASE = "a\nb\nc";
const PROPOSED = "a\nB\nc";

function oneHunkReview(): CopilotBufferReview {
  const diff = buildLineDiff(BASE, PROPOSED);
  return {
    pendingCount: 1,
    proposed: PROPOSED,
    base: BASE,
    diff,
    hunks: groupHunks(diff),
  };
}

function renderPanel(over: Partial<Parameters<typeof ExperienceCopilotEditorPanel>[0]> = {}) {
  const props = {
    value: BASE,
    onChange: mock(),
    isSending: false,
    review: oneHunkReview(),
    acceptedHunkIds: new Set<number>(),
    onAcceptHunk: mock(),
    onAcceptAll: mock(),
    onRevert: mock(),
    canRevert: true,
    ...over,
  };
  return render(<ExperienceCopilotEditorPanel {...props} />);
}

describe("buildBufferReview (pure)", () => {
  it("derives the pending count and hunks from the diff", () => {
    // Three separated changes → three hunks (adjacent changes with no shared
    // context line collapse into ONE hunk — the groupHunks contract).
    const review = buildBufferReview("a\nb\nc\nd\ne", "A\nb\nC\nd\nE", new Set(), true);
    expect(review).not.toBeNull();
    expect(review!.pendingCount).toBe(3);
    expect(review!.hunks).toHaveLength(3);
    expect(review!.diff?.tooLarge).toBe(false);
  });

  it("returns null without a proposal, while sending, or when everything is accepted", () => {
    expect(buildBufferReview(undefined, PROPOSED, new Set(), true)).toBeNull();
    expect(buildBufferReview(BASE, undefined, new Set(), true)).toBeNull();
    expect(buildBufferReview(BASE, PROPOSED, new Set(), false)).toBeNull();
    const diff = buildLineDiff(BASE, PROPOSED);
    const all = new Set(groupHunks(diff).map((h) => h.id));
    expect(buildBufferReview(BASE, PROPOSED, all, true)).toBeNull();
  });

  it("falls back to a whole-buffer review (accept-all only) for a tooLarge diff", () => {
    // Force tooLarge: exceed the line budget (1600 combined).
    const big = Array.from({ length: 900 }, (_, i) => `line-${i}`).join("\n");
    const other = Array.from({ length: 900 }, (_, i) => `other-${i}`).join("\n");
    const review = buildBufferReview(big, other, new Set(), true);
    expect(review).not.toBeNull();
    expect(review!.diff).toBeNull();
    expect(review!.hunks).toEqual([]);
    expect(review!.pendingCount).toBe(1);
    // mergedReviewText in the fallback is the wholesale proposal.
    expect(mergedReviewText(review!, new Set())).toBe(other);
  });

  it("the tooLarge fallback resolves via the WHOLE_BUFFER_HUNK_ID sentinel (RV-1)", () => {
    const big = Array.from({ length: 900 }, (_, i) => `line-${i}`).join("\n");
    const other = Array.from({ length: 900 }, (_, i) => `other-${i}`).join("\n");

    // The fallback's accept-all selection is the single sentinel id — not an
    // empty set (the old shape made accept-all a silent no-op).
    const review = buildBufferReview(big, other, new Set(), true)!;
    const ids = allReviewHunkIds(review);
    expect([...ids]).toEqual([WHOLE_BUFFER_HUNK_ID]);

    // Accepting (or dismissing) the sentinel resolves the round: no more bar.
    expect(buildBufferReview(big, other, new Set([WHOLE_BUFFER_HUNK_ID]), true)).toBeNull();
    expect(buildBufferReview(big, other, new Set(), true, new Set([WHOLE_BUFFER_HUNK_ID]))).toBeNull();
  });
});

describe("mergedReviewText (pure)", () => {
  it("partial selection applies only the accepted hunks (the mergeSelectedBody boundary)", () => {
    const diff = buildLineDiff("a\nb\nc\nd", "A\nb\nC\nd");
    const review: CopilotBufferReview = {
      pendingCount: 2,
      proposed: "A\nb\nC\nd",
      base: "a\nb\nc\nd",
      diff,
      hunks: groupHunks(diff),
    };
    // Accept ONLY hunk 0 (the `a→A` change): the `c→C` hunk stays out.
    expect(mergedReviewText(review, new Set([0]))).toBe("A\nb\nc\nd");
    expect(mergedReviewText(review, allReviewHunkIds(review))).toBe("A\nb\nC\nd");
    expect(mergedReviewText(review, new Set())).toBe("a\nb\nc\nd");
  });
});

describe("ExperienceCopilotEditorPanel", () => {
  it("renders the review bar with the pending count and switches the document to the proposal", () => {
    const { getByTestId, container } = renderPanel();
    expect(getByTestId("copilot-review-count").textContent).toContain("copilot_review_hunks_count");
    expect(getByTestId("copilot-accept-all")).toBeDefined();
    expect(getByTestId("copilot-review-revert")).toBeDefined();
    // The document is the PROPOSED text, and the add line is green-marked.
    const cmEl = container.querySelector<HTMLElement>(".cm-editor");
    expect(cmEl).not.toBeNull();
    expect(cmEl!.textContent).toContain("B");
    expect(container.querySelectorAll(".cm-copilotDiffAdd").length).toBe(1);
  });

  it("is read-only in review mode and free (writable) without a review", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");

    const { container, rerender } = renderPanel();
    let view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
    expect(view!.state.facet(EditorState.readOnly)).toBe(true);

    // Review resolved → free mode, writable, value = merged buffer.
    rerender(
      <ExperienceCopilotEditorPanel
        value={"a\nB\nc"}
        onChange={() => {}}
        isSending={false}
        review={null}
        acceptedHunkIds={new Set<number>()}
        onAcceptHunk={() => {}}
        onAcceptAll={() => {}}
        onRevert={() => {}}
        canRevert={false}
      />,
    );
    view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
    expect(view!.state.doc.toString()).toBe("a\nB\nc");
    expect(view!.state.facet(EditorState.readOnly)).toBe(false);
  });

  it("accepts a single hunk through the real CodeMirror widget button", () => {
    const onAcceptHunk = mock();
    const { container } = renderPanel({ onAcceptHunk });
    const btn = container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept");
    expect(btn).not.toBeNull();
    expect(btn!.dataset.hunkId).toBe("0");
    fireEvent.click(btn!);
    expect(onAcceptHunk).toHaveBeenCalledWith(0);
  });

  it("accept-all routes to the handler and revert button fires onRevert", () => {
    const onAcceptAll = mock();
    const onRevert = mock();
    const { getByTestId } = renderPanel({ onAcceptAll, onRevert });
    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onAcceptAll).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("copilot-review-revert"));
    expect(onRevert).toHaveBeenCalledTimes(1);
  });
});

describe("applyHunksToBuffer (pure, CD-8 conflict path)", () => {
  // Drifted buffer: the second line was hand-edited after the diff was built.
  const base = "a\nb\nc\nd";
  const proposed = "a\nB\nc\nD";
  const diff = buildLineDiff(base, proposed);
  const hunks = groupHunks(diff);

  it("splices cleanly-anchored hunks onto the drifted buffer", () => {
    // Line "d" is untouched by the drift → hunk 1 anchors; "b" was replaced by
    // hand with "x" → hunk 0 cannot anchor and is skipped.
    const drifted = "a\nx\nc\nd";
    const result = applyHunksToBuffer(drifted, diff, hunks, new Set(hunks.map((h) => h.id)));
    expect(result.text).toBe("a\nx\nc\nD");
    expect(result.skippedHunkIds).toEqual([0]);
  });

  it("a skipped hunk never blocks the remaining hunks", () => {
    const result = applyHunksToBuffer("a\nx\nc\nd", diff, hunks, new Set([0, 1]));
    expect(result.skippedHunkIds).toEqual([0]);
    expect(result.text).toContain("D");
  });

  it("an anchor never matches mid-line", () => {
    // "b" appears only INSIDE the word "abc" — that is not a whole-line run,
    // so the hunk is conflicting, not spliced into the middle of "abc".
    const result = applyHunksToBuffer("abc\nc\nd", diff, hunks, new Set([0]));
    expect(result.skippedHunkIds).toEqual([0]);
    expect(result.text).toBe("abc\nc\nd");
  });

  it("pure-insertion hunks have no anchor and are always skipped", () => {
    const insDiff = buildLineDiff("a\nb", "a\nNEW\nb");
    const insHunks = groupHunks(insDiff);
    const result = applyHunksToBuffer("a\nb", insDiff, insHunks, new Set(insHunks.map((h) => h.id)));
    expect(result.skippedHunkIds).toEqual(insHunks.map((h) => h.id));
    expect(result.text).toBe("a\nb");
  });
});

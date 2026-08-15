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
  buildBufferReview,
  ExperienceCopilotEditorPanel,
  mergedReviewText,
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

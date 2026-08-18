/**
 * ExperienceCopilotEditorPanel — the review-mode editor surface (CD-6).
 *
 * Pins the panel contract: the review bar (count + accept-all + revert), the
 * document switching to the proposed text in review mode (read-only), the
 * inline hunk accept through the REAL CodeMirror widget buttons, and the pure
 * helpers (buildBufferReview / mergedReviewText / allReviewHunkIds) at the
 * mergeSelectedBody boundary.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";
import {
  allReviewHunkIds,
  applyHunksToBuffer,
  buildBufferReview,
  ExperienceCopilotEditorPanel,
  mergedReviewText,
  revertHunksFromBuffer,
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
    dismissedHunkIds: new Set<number>(),
    onAcceptHunk: mock(),
    onAcceptAll: mock(),
    onDismissHunk: mock(),
    onDismissPending: mock(),
    onCancelRound: mock(),
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
    const { getByTestId, queryByTestId, container } = renderPanel();
    expect(getByTestId("copilot-review-count").textContent).toContain("copilot_review_hunks_count");
    expect(getByTestId("copilot-accept-all")).toBeDefined();
    expect(getByTestId("copilot-dismiss-pending")).toBeDefined();
    expect(getByTestId("copilot-cancel-all")).toBeDefined();
    // The draft-level revert no longer lives in the review bar (RV-3) — it is
    // the toolbar's whole-turn revert (CD-3), not a per-tab action.
    expect(queryByTestId("copilot-review-revert")).toBeNull();
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
        dismissedHunkIds={new Set<number>()}
        onAcceptHunk={() => {}}
        onAcceptAll={() => {}}
        onDismissHunk={() => {}}
        onDismissPending={() => {}}
        onCancelRound={() => {}}
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

  it("dismisses a single hunk through the real CodeMirror widget button (RV-2)", () => {
    const onDismissHunk = mock();
    const { container } = renderPanel({ onDismissHunk });
    const btn = container.querySelector<HTMLButtonElement>(".cm-copilotDiffDismiss");
    expect(btn).not.toBeNull();
    expect(btn!.dataset.hunkId).toBe("0");
    fireEvent.click(btn!);
    expect(onDismissHunk).toHaveBeenCalledWith(0);
  });

  it("accept-all routes to the handler and the cancel buttons fire their handlers (RV-3)", () => {
    const onAcceptAll = mock();
    const onDismissPending = mock();
    const onCancelRound = mock();
    const { getByTestId, queryByTestId } = renderPanel({ onAcceptAll, onDismissPending, onCancelRound });
    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onAcceptAll).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("copilot-dismiss-pending"));
    expect(onDismissPending).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("copilot-cancel-all"));
    expect(onCancelRound).toHaveBeenCalledTimes(1);
    // The draft-level revert button is gone from the review bar.
    expect(queryByTestId("copilot-review-revert")).toBeNull();
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

describe("revertHunksFromBuffer (pure, RV-3 rollback path)", () => {
  // The accepted buffer for `a\nb\nc\nd` → `a\nB\nc\nD`: hunk 0 replaced `b`
  // with `B`, hunk 1 replaced `d` with `D`. Reverting splices the added lines
  // back to their removed (original) lines.
  const base = "a\nb\nc\nd";
  const proposed = "a\nB\nc\nD";
  const diff = buildLineDiff(base, proposed);
  const hunks = groupHunks(diff);

  it("replaces a cleanly-anchored added block with its removed lines", () => {
    // The ACCEPTED buffer (both hunks applied).
    const result = revertHunksFromBuffer(proposed, diff, hunks, new Set(hunks.map((h) => h.id)));
    expect(result.text).toBe(base);
    expect(result.skippedHunkIds).toEqual([]);
  });

  it("a hunk whose added lines drifted is skipped; the rest still revert", () => {
    // Hunk 1 (D) drifted to "Z" by an external edit; hunk 0 (B) is intact.
    const drifted = "a\nB\nc\nZ";
    const result = revertHunksFromBuffer(drifted, diff, hunks, new Set(hunks.map((h) => h.id)));
    expect(result.skippedHunkIds).toEqual([1]);
    expect(result.text).toBe("a\nb\nc\nZ");
  });

  it("an added-block anchor never matches mid-line", () => {
    // "B" appears only INSIDE "aB" — not a whole-line run, so the hunk is
    // skipped rather than spliced into the middle of the word.
    const result = revertHunksFromBuffer("aB\nc\nD", diff, hunks, new Set([0]));
    expect(result.skippedHunkIds).toEqual([0]);
    expect(result.text).toBe("aB\nc\nD");
  });

  it("pure-deletion hunks have no added anchor and are always skipped", () => {
    const delDiff = buildLineDiff("a\nGONE\nb", "a\nb");
    const delHunks = groupHunks(delDiff);
    const result = revertHunksFromBuffer("a\nb", delDiff, delHunks, new Set(delHunks.map((h) => h.id)));
    expect(result.skippedHunkIds).toEqual(delHunks.map((h) => h.id));
    expect(result.text).toBe("a\nb");
  });
});

// ── Mobile (4a follow-up): page-scroll editor + fullscreen expansion ─────────
// The shared MobileExpandCodeEditor mirrors MobileExpandTextarea's chrome; these
// pins hold at the panel boundary: viewport-driven CodeMirror scroll mode, the
// growing frame, and the expand → fullscreen session.
let mobileOverride = false;
const realMobile = await import("../../../../hooks/use-mobile.js");
mock.module("../../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

describe("ExperienceCopilotEditorPanel — mobile editor surface", () => {
  beforeEach(() => { mobileOverride = false; });

  it("desktop: inner scroll, fixed-fill frame, no expand button", () => {
    const { container, queryByTestId } = renderPanel({ fullscreenLabel: "rules" });
    const frame = container.querySelector('[data-testid="copilot-editor-frame"]');
    if (!(frame instanceof HTMLElement)) throw new Error("frame missing");
    expect(frame.classList.contains("max-md:h-auto")).toBe(true); // inert below md
    expect(frame.classList.contains("h-full")).toBe(true);
    expect(queryByTestId("mobile-expand-code-btn")).toBeNull();
    // Inner scroll mode: CodeEditor's container clips (overflow auto).
    const editorHost = frame.querySelector(".cm-editor")?.parentElement;
    if (!(editorHost instanceof HTMLElement)) throw new Error("editor host missing");
    expect(editorHost.style.overflow).toBe("auto");
  });

  it("mobile: page-scroll CodeMirror (grows to content) inside the frame", () => {
    mobileOverride = true;
    const { container } = renderPanel();
    const editorHost = container.querySelector('.cm-editor')?.parentElement;
    if (!(editorHost instanceof HTMLElement)) throw new Error("editor host missing");
    // page mode: the host lets the document flow (overflow visible) — the
    // pane scrolls, not the editor.
    expect(editorHost.style.overflow).toBe("visible");
    expect(editorHost.classList.contains("max-md:h-auto")).toBe(true);

    // 4a follow-up round 2: the panel's own scroll container takes its
    // NATURAL height on mobile (flex-none, no inner scroll) so the shell's
    // pane root becomes the single scroll document. Desktop keeps the
    // flex-1 inner-scroll remainder (asserted in the desktop case above via
    // overflow auto; the flex classes stay unpinned there by design).
    const scrollHost = editorHost.closest(".p-3");
    if (!(scrollHost instanceof HTMLElement)) throw new Error("scroll container missing");
    expect(scrollHost.classList.contains("max-md:flex-none")).toBe(true);
    expect(scrollHost.classList.contains("max-md:overflow-y-visible")).toBe(true);
    expect(scrollHost.classList.contains("overflow-y-auto")).toBe(true); // desktop unchanged
  });

  it("mobile: expand opens a fullscreen CodeMirror session with the label; Готово closes", () => {
    mobileOverride = true;
    const onChange = mock();
    const { container, getByTestId } = renderPanel({ onChange, fullscreenLabel: "visual-lbl" });
    fireEvent.click(getByTestId("mobile-expand-code-btn"));
    const overlay = getByTestId("mobile-code-fullscreen");
    // Header carries the passed label + the Done button.
    expect(overlay.textContent?.includes("visual-lbl")).toBe(true);
    expect(overlay.textContent?.includes("done_btn")).toBe(true);
    // The fullscreen session mounts its OWN CodeMirror inside the overlay.
    expect(overlay.querySelectorAll(".cm-editor").length).toBe(1);
    // Готово closes the overlay; the inline editor stays mounted.
    const done = [...overlay.querySelectorAll("div")].find(
      (d) => (d.textContent ?? "").trim() === "done_btn",
    );
    if (!(done instanceof HTMLElement)) throw new Error("done button missing");
    fireEvent.click(done);
    expect(() => getByTestId("mobile-code-fullscreen")).toThrow();
    expect(container.querySelectorAll(".cm-editor").length).toBe(1);
  });
});

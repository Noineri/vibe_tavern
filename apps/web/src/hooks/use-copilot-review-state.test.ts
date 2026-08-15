/**
 * useCopilotReviewState — the editor review state hook (CD-2).
 *
 * Pins the hook's contract: a snapshot is taken on the isSending rising edge
 * (one per turn, buffers unchanged between turns stack up), revert restores the
 * last snapshot's texts + dismisses the live turn's activities, canRevert is
 * derived from buffer drift, and the conflict flags fire only when the
 * corresponding buffer has a pending proposal AND drifted from the snapshot.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { useCopilotReviewState, type UseCopilotReviewStateArgs } from "./use-copilot-review-state.js";
import { useExperienceCopilotTurnStore } from "../stores/experience-copilot-turn-store.js";
import { useCopilotReviewRoundStore } from "../stores/experience-copilot-review-store.js";

useDomEnv();

// RTL MUST be imported dynamically BELOW useDomEnv() (the dom-env contract):
// bun does not evaluate static imports in source order, so a static
// `import { renderHook }` can evaluate @testing-library/react before the
// global happy-dom window registers. In the per-file runner that is harmless
// (one file per process), but in a shared-process combined run it breaks the
// NEXT file's fireEvent-driven updates (reproduced: this file + InputArea's
// test in one process — InputArea's send-button tests fail). Mirrors the
// load-bearing ordering inside dom-env.ts itself.
const { act, renderHook } = await import("@testing-library/react");

function baseArgs(over: Partial<UseCopilotReviewStateArgs> = {}): UseCopilotReviewStateArgs {
  return {
    threadId: "thread-1",
    isSending: false,
    rulesCode: "RULES v1",
    visualSource: "VISUAL v1",
    activities: [],
    onRevert: mock(),
    ...over,
  };
}

/** rerender helper preserving props identity where it does not matter. */
function setup(over: Partial<UseCopilotReviewStateArgs> = {}) {
  const initial = baseArgs(over);
  const rendered = renderHook((props: UseCopilotReviewStateArgs) => useCopilotReviewState(props), {
    initialProps: initial,
  });
  return rendered;
}

beforeEach(() => {
  useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
  useCopilotReviewRoundStore.setState({ roundsByThread: {} });
});

describe("useCopilotReviewState", () => {
  it("takes no snapshot before the first turn", () => {
    const { result } = setup();
    expect(result.current.snapshots).toEqual([]);
    expect(result.current.lastSnapshot).toBeNull();
    expect(result.current.canRevert).toBe(false);
    expect(result.current.proposalBase).toBeNull();
  });

  it("snapshots the buffers on the isSending rising edge, once per turn", () => {
    const { result, rerender } = setup();
    // Turn 1 starts against the v1 buffers.
    act(() => rerender(baseArgs({ isSending: true })));
    expect(result.current.snapshots).toHaveLength(1);
    expect(result.current.lastSnapshot).toMatchObject({ id: 1, rules: "RULES v1", visual: "VISUAL v1" });
    // Staying in the sending state (stream ticks) must not re-snapshot.
    act(() => rerender(baseArgs({ isSending: true })));
    expect(result.current.snapshots).toHaveLength(1);
    // Turn settles; buffers changed by the accept flow.
    act(() => rerender(baseArgs({ isSending: false, rulesCode: "RULES v2" })));
    expect(result.current.snapshots).toHaveLength(1);
    // Turn 2 starts against the v2 buffers → a second snapshot.
    act(() => rerender(baseArgs({ isSending: true, rulesCode: "RULES v2" })));
    expect(result.current.snapshots).toHaveLength(2);
    expect(result.current.lastSnapshot).toMatchObject({ id: 2, rules: "RULES v2" });
  });

  it("canRevert tracks drift from the last snapshot", () => {
    const { result, rerender } = setup();
    act(() => rerender(baseArgs({ isSending: true })));
    act(() => rerender(baseArgs({ isSending: false })));
    // Buffers equal the snapshot → nothing to revert.
    expect(result.current.canRevert).toBe(false);
    act(() => rerender(baseArgs({ isSending: false, rulesCode: "RULES v2" })));
    expect(result.current.canRevert).toBe(true);
  });

  it("revertLastTurn restores the snapshot texts, pops it and dismisses the live turn", () => {
    const onRevert = mock();
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "c1", toolName: "write_buffer", status: "done", target: "rules", proposed: "RULES v2" },
        ],
      },
    });
    const { result, rerender } = setup({ onRevert });
    act(() => rerender(baseArgs({ isSending: true, onRevert })));
    act(() => rerender(baseArgs({ isSending: false, rulesCode: "RULES v2", onRevert })));
    expect(result.current.canRevert).toBe(true);

    act(() => result.current.revertLastTurn());
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onRevert).toHaveBeenCalledWith({ rules: "RULES v1", visual: "VISUAL v1" });
    // The snapshot is consumed and the live turn's activities are dismissed.
    expect(result.current.snapshots).toEqual([]);
    expect(useExperienceCopilotTurnStore.getState().turnsByThread["thread-1"]).toBeUndefined();
  });

  it("revertLastTurn is a no-op without a snapshot", () => {
    const onRevert = mock();
    const { result } = setup({ onRevert });
    act(() => result.current.revertLastTurn());
    expect(onRevert).not.toHaveBeenCalled();
  });

  it("aggregates the proposal from the live activities (last-wins per buffer)", () => {
    const activities = [
      { toolCallId: "c1", toolName: "write_buffer", status: "done" as const, target: "rules" as const, proposed: "RULES v2" },
      { toolCallId: "c2", toolName: "write_buffer", status: "done" as const, target: "rules" as const, proposed: "RULES v3" },
    ];
    const { result } = setup({ activities });
    expect(result.current.proposal.hasProposal).toBe(true);
    expect(result.current.proposal.proposedRules).toBe("RULES v3");
    expect(result.current.proposal.proposedVisual).toBeUndefined();
  });

  it("flags a conflict only for proposed buffers that drifted from the snapshot", () => {
    const activities = [
      { toolCallId: "c1", toolName: "write_buffer", status: "done" as const, target: "rules" as const, proposed: "RULES v2" },
      { toolCallId: "c2", toolName: "edit_buffer", status: "done" as const, target: "visual" as const, proposed: "VISUAL v2" },
    ];
    const { result, rerender } = setup({ activities });
    act(() => rerender(baseArgs({ activities, isSending: true })));
    act(() => rerender(baseArgs({ activities, isSending: false })));
    // No drift: no conflicts, and proposalBase mirrors the snapshot.
    expect(result.current.rulesConflict).toBe(false);
    expect(result.current.visualConflict).toBe(false);
    expect(result.current.proposalBase).toEqual({ rules: "RULES v1", visual: "VISUAL v1" });
    // The user hand-edits ONLY the rules buffer during review.
    act(() => rerender(baseArgs({ activities, isSending: false, rulesCode: "RULES hand-edited" })));
    expect(result.current.rulesConflict).toBe(true);
    expect(result.current.visualConflict).toBe(false);
  });

  it("keeps the snapshot stack across unmount/remount — the round store owns it", () => {
    // The whole point of the store refactor: a hanging review must survive the
    // shell unmounting (user navigates to prompt tracing / the tester and
    // returns). The first mount takes a snapshot; the remount reads it back.
    const first = renderHook((props: UseCopilotReviewStateArgs) => useCopilotReviewState(props), {
      initialProps: baseArgs(),
    });
    act(() => first.rerender(baseArgs({ isSending: true })));
    act(() => first.rerender(baseArgs({ isSending: false })));
    expect(first.result.current.snapshots).toHaveLength(1);
    first.unmount();

    const second = renderHook((props: UseCopilotReviewStateArgs) => useCopilotReviewState(props), {
      initialProps: baseArgs(),
    });
    expect(second.result.current.snapshots).toHaveLength(1);
    expect(second.result.current.lastSnapshot).toMatchObject({ id: 1, rules: "RULES v1", visual: "VISUAL v1" });
    expect(second.result.current.proposalBase).toEqual({ rules: "RULES v1", visual: "VISUAL v1" });
    // canRevert is derived from the restored snapshot against the CURRENT
    // buffers — the review bar reappears exactly as it was.
    act(() => second.rerender(baseArgs({ rulesCode: "RULES accepted-hybrid" })));
    expect(second.result.current.canRevert).toBe(true);
  });

  it("switching threadId reads the OTHER thread's slice (per-thread keying, no script reset)", () => {
    const { result, rerender } = setup();
    act(() => rerender(baseArgs({ isSending: true })));
    expect(result.current.snapshots).toHaveLength(1);

    // A different thread is a different (empty) round — and going back does
    // not wipe it: per-thread slices replaced the old resetKey (script) reset,
    // which would have destroyed the restored round on the "" → threadId
    // mount transition.
    act(() => rerender(baseArgs({ threadId: "thread-2", isSending: false })));
    expect(result.current.snapshots).toEqual([]);
    act(() => rerender(baseArgs({ threadId: "thread-1", isSending: false })));
    expect(result.current.snapshots).toHaveLength(1);
  });
});

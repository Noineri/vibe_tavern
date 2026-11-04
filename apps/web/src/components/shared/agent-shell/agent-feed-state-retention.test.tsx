import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installAgentMessageMarkdownSeam } from "../../../../test/agent-message-markdown-seam.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { AgentMessageAction } from "../../../lib/agent-host-registry.js";

useDomEnv();

// AFP-4 (AGENT_FEED_PERFORMANCE_PLAN, Wave 1 step 5): the row-UI-state
// consumer pins. The AFP-3 session store (`agent-feed-ui-state.tsx`) keeps
// disclosures and dirty inline edit drafts keyed by the row's STABLE unit id,
// so they survive an ACTUAL unmount/remount (virtualization, AFP-6) WITHOUT
// hidden DOM. The provider stays mounted for the whole session (the shell
// owns it — AFP-6); every pin below unmounts only the ROW (the `<RowSlot>`
// harness) and asserts the row left the container before remounting it.
// The busy/discard clearing rules and the RP reasoning defaults are pinned
// as unchanged in the same file.

// CO-LOAD CONTRACT (i18n-context-seam family): provider-less pins echo raw
// keys — the identity spec, same registration as the characterization suite.
installI18nContextSeam();

// CO-LOAD CONTRACT (react-markdown-seam discipline): the shared agent
// markdown seam — same registration as AgentMessageList.test.tsx / the
// characterization suite, so co-loaded runs render the real variant classes.
installAgentMessageMarkdownSeam();

// CustomTooltip (Radix) never anchors under happy-dom — the message action
// row wraps its buttons in it. Same `...real`-spread mock as the sibling
// suites (R4 shape).
const realTooltip = await import("../Tooltip.js");
mock.module("../Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let AgentFeedUiStateProvider: typeof import("./agent-feed-ui-state.js").AgentFeedUiStateProvider;
let AgentTimelineSeparator: typeof import("./AgentTimelineSeparator.js").AgentTimelineSeparator;
let AgentMessageBlock: typeof import("./AgentMessageBlock.js").AgentMessageBlock;
let AgentToolAccordion: typeof import("./AgentToolAccordion.js").AgentToolAccordion;
let AgentHostCaption: typeof import("./AgentHostCaption.js").AgentHostCaption;
let MessageReasoning: typeof import("../../chat/MessageReasoning.js").MessageReasoning;
let Icons: typeof import("../icons.js").Icons;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ AgentFeedUiStateProvider } = await import("./agent-feed-ui-state.js"));
  ({ AgentTimelineSeparator } = await import("./AgentTimelineSeparator.js"));
  ({ AgentMessageBlock } = await import("./AgentMessageBlock.js"));
  ({ AgentToolAccordion } = await import("./AgentToolAccordion.js"));
  ({ AgentHostCaption } = await import("./AgentHostCaption.js"));
  ({ MessageReasoning } = await import("../../chat/MessageReasoning.js"));
  ({ Icons } = await import("../icons.js"));
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "user",
    content: "hello world",
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
    ...over,
  };
}

function rpSyncEvent(id: string): AgentThreadEventWire {
  return {
    id,
    kind: "rp_sync",
    beforeMessageId: null,
    payload: {
      fromPosition: 0,
      toPosition: 1,
      messages: [
        { id: "rp1", position: 0, role: "user", authorName: null, variantId: null, model: null, preset: null, text: "frozen rp text" },
      ],
    },
  };
}

function activity(id: string) {
  return {
    toolCallId: id,
    toolName: "run_test",
    status: "done",
    summary: `${id} passed`,
  } as const;
}

/** A minimal non-empty turn-action row so the block renders its action row
 *  (the «edit» opener requires a turn row to ride — the builder's gate). */
function turnActionRow(onSelect: () => void = () => {}): AgentMessageAction[] {
  return [{
    labelKey: "copy",
    icon: Icons.Copy,
    onSelect,
    testId: "turn-copy",
  }];
}

/** The unmount/remount harness: `show=false` unmounts the ROW (exactly what
 *  virtualization does) while the provider — the session's store owner —
 *  stays mounted. A fresh `render()` here would create a fresh provider
 *  store, which is a SESSION reset, not a row remount. */
function RowSlot({ show, children }: { show: boolean; children: ReactNode }) {
  return <>{show ? children : null}</>;
}

function inSession(sessionKey: string, show: boolean, row: ReactNode) {
  return (
    <AgentFeedUiStateProvider sessionKey={sessionKey}>
      <RowSlot show={show}>{row}</RowSlot>
    </AgentFeedUiStateProvider>
  );
}

// ─── Disclosures survive ACTUAL row unmount/remount ─────────────────────────

describe("agent feed row UI-state retention (AFP-4)", () => {
  it("an expanded event separator reopens after row unmount/remount; nothing stays in the DOM", async () => {
    const row = <AgentTimelineSeparator event={rpSyncEvent("e1")} />;
    const view = render(inSession("s1", true, row));

    // Default collapsed — the pre-AFP-4 default, unchanged.
    expect(view.queryByText("frozen rp text")).toBeNull();
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    expect(view.getByText("frozen rp text")).toBeTruthy();

    // ACTUAL row unmount: the separator (and its expanded body) leaves the
    // DOM — no hidden DOM is kept alive to retain the state.
    view.rerender(inSession("s1", false, row));
    expect(view.container.querySelector('[data-testid="timeline-separator"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="timeline-separator-body"]')).toBeNull();

    // Row remount: the retained disclosure restores the open body.
    view.rerender(inSession("s1", true, row));
    await waitFor(() => expect(view.getByText("frozen rp text")).toBeTruthy());
  });

  it("an expanded compaction digest reopens after row unmount/remount", async () => {
    const row = (
      <AgentMessageBlock
        message={message({ id: "d1", role: "digest", content: "compaction summary text" })}
        messageMarkup="plain"
        coveredCount={3}
      />
    );
    const view = render(inSession("s1", true, row));

    expect(view.queryByText("compaction summary text")).toBeNull();
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    expect(view.getByText("compaction summary text")).toBeTruthy();

    view.rerender(inSession("s1", false, row));
    expect(view.container.querySelector('[data-testid="timeline-separator"]')).toBeNull();

    view.rerender(inSession("s1", true, row));
    await waitFor(() =>
      expect(view.getByTestId("timeline-separator-toggle").getAttribute("aria-expanded")).toBe("true"),
    );
  });

  it("a user-opened historical tool accordion stays open across remount (mount-time effect does not close it)", async () => {
    const row = <AgentToolAccordion activities={[activity("tc1"), activity("tc2")]} kind="experience" isSending={false} />;
    const view = render(inSession("s1", true, row));

    // Settled default: collapsed (unchanged).
    expect(view.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(view.getByTestId("copilot-tool-accordion-toggle"));
    expect(view.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("true");

    view.rerender(inSession("s1", false, row));
    expect(view.container.querySelector('[data-testid="copilot-tool-accordion"]')).toBeNull();

    // Row remount while settled: the restored open state must WIN over the
    // mount-time isSending sync (a remount is not a live→settled transition).
    view.rerender(inSession("s1", true, row));
    await waitFor(() =>
      expect(view.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("true"),
    );
  });

  it("a real sending→settled transition still compacts the accordion (open or user-collapsed)", () => {
    const rowA = <AgentToolAccordion activities={[activity("tc1")]} kind="experience" isSending />;
    const rowSettled = <AgentToolAccordion activities={[activity("tc1")]} kind="experience" isSending={false} />;

    // Live default open, settle compacts it.
    const live = render(inSession("s1", true, rowA));
    expect(live.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("true");
    live.rerender(inSession("s1", true, rowSettled));
    expect(live.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("false");
    live.unmount();

    // The user collapses during the live turn; settling keeps it collapsed
    // (the settle sync writes the same value — today's rule, unchanged).
    const live2 = render(inSession("s2", true, rowA));
    fireEvent.click(live2.getByTestId("copilot-tool-accordion-toggle"));
    expect(live2.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("false");
    live2.rerender(inSession("s2", true, rowSettled));
    expect(live2.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("a keyed caption's reasoning disclosure survives remount; an unkeyed caption stays component-local", async () => {
    const keyedRow = <AgentHostCaption title="Host" reasoning="deep thought" stateKey="caption:m1" />;
    const keyed = render(inSession("s1", true, keyedRow));
    expect(keyed.queryByText("deep thought")).toBeNull();
    fireEvent.click(keyed.getByText("reasoning"));
    expect(keyed.getByText("deep thought")).toBeTruthy();
    keyed.rerender(inSession("s1", false, keyedRow));
    expect(keyed.container.querySelector('[data-testid="copilot-host-caption"]')).toBeNull();
    keyed.rerender(inSession("s1", true, keyedRow));
    await waitFor(() => expect(keyed.getByText("deep thought")).toBeTruthy());
    keyed.unmount();

    // Unkeyed (today's call sites): local state only — a remount collapses.
    const unkeyedRow = <AgentHostCaption title="Host" reasoning="deep thought" />;
    const unkeyed = render(inSession("s1", true, unkeyedRow));
    fireEvent.click(unkeyed.getByText("reasoning"));
    expect(unkeyed.getByText("deep thought")).toBeTruthy();
    unkeyed.rerender(inSession("s1", false, unkeyedRow));
    unkeyed.rerender(inSession("s1", true, unkeyedRow));
    await waitFor(() => expect(unkeyed.getByText("reasoning")).toBeTruthy());
    expect(unkeyed.queryByText("deep thought")).toBeNull();
  });

  it("MessageReasoning stays uncontrolled without open/onOpenChange (RP/co-author path) and honors them when passed", () => {
    // RP default: collapsed by default, toggles locally (byte-identical to
    // the pre-AFP-4 component — no provider involved).
    const rp = render(<MessageReasoning reasoning="rp chain" variant="minimal" />);
    expect(rp.queryByText("rp chain")).toBeNull();
    fireEvent.click(rp.getByText("reasoning"));
    expect(rp.getByText("rp chain")).toBeTruthy();
    rp.unmount();

    // Controlled: renders the GIVEN state and reports toggles upward only —
    // the body never opens by itself.
    let reported: boolean | undefined;
    const controlled = render(
      <MessageReasoning reasoning="feed chain" variant="inline" open={false} onOpenChange={(open) => { reported = open; }} />,
    );
    expect(controlled.queryByText("feed chain")).toBeNull();
    fireEvent.click(controlled.getByText("reasoning"));
    expect(reported).toBe(true);
    expect(controlled.queryByText("feed chain")).toBeNull(); // still closed — state is the caller's
  });

  // ─── Dirty inline edit drafts ─────────────────────────────────────────────

  it("a dirty user edit draft survives unmount/remount and is not replaced by refreshed server text", () => {
    const rowFor = (content: string) => (
      <AgentMessageBlock
        message={message({ id: "mu1", role: "user", content })}
        messageMarkup="plain"
        canEditLast
        onEditLast={() => {}}
        turnActions={turnActionRow()}
      />
    );

    const view = render(inSession("s1", true, rowFor("hello world")));
    fireEvent.click(view.getByTestId("copilot-turn-edit"));
    const textarea = view.container.querySelector("textarea")!;
    expect(textarea.value).toBe("hello world");
    fireEvent.change(textarea, { target: { value: "dirty draft" } });

    // Row unmount: the editor leaves the DOM (no hidden textarea).
    view.rerender(inSession("s1", false, rowFor("hello world")));
    expect(view.container.querySelector('[data-testid="copilot-edit-message"]')).toBeNull();

    // Row remount: the editor REOPENS with the retained dirty draft.
    view.rerender(inSession("s1", true, rowFor("hello world")));
    expect(view.container.querySelector("textarea")!.value).toBe("dirty draft");

    // A settle-refetch-shaped content change never replaces the dirty draft.
    view.rerender(inSession("s1", true, rowFor("server refreshed text")));
    expect(view.container.querySelector("textarea")!.value).toBe("dirty draft");
  });

  it("busy closes an open editor and drops the retained draft (a remount does not resurrect it)", async () => {
    const rowFor = (isBusy: boolean) => (
      <AgentMessageBlock
        message={message({ id: "mu2", role: "user", content: "keep" })}
        messageMarkup="plain"
        canEditLast
        onEditLast={() => {}}
        turnActions={turnActionRow()}
        isBusy={isBusy}
      />
    );

    const view = render(inSession("s1", true, rowFor(false)));
    fireEvent.click(view.getByTestId("copilot-turn-edit"));
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "half-typed" } });
    view.rerender(inSession("s1", true, rowFor(true)));
    await waitFor(() => expect(view.container.querySelector('[data-testid="copilot-edit-message"]')).toBeNull());

    // Remount after the busy clear: the dropped draft does not resurrect.
    view.rerender(inSession("s1", false, rowFor(false)));
    view.rerender(inSession("s1", true, rowFor(false)));
    expect(view.container.querySelector('[data-testid="copilot-edit-message"]')).toBeNull();
  });

  it("explicit cancel discards the draft (a remount does not resurrect it)", () => {
    const row = (
      <AgentMessageBlock
        message={message({ id: "mu3", role: "user", content: "keep" })}
        messageMarkup="plain"
        canEditLast
        onEditLast={() => {}}
        turnActions={turnActionRow()}
      />
    );

    const view = render(inSession("s1", true, row));
    fireEvent.click(view.getByTestId("copilot-turn-edit"));
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "throwaway" } });
    fireEvent.click(view.getByTestId("copilot-edit-cancel"));
    expect(view.container.querySelector('[data-testid="copilot-edit-message"]')).toBeNull();

    view.rerender(inSession("s1", false, row));
    view.rerender(inSession("s1", true, row));
    expect(view.container.querySelector('[data-testid="copilot-edit-message"]')).toBeNull();
  });

  it("assistant in-place edit: a failed save keeps the retained draft; a successful save closes it", async () => {
    const rowFor = (onEditAssistant: (id: string, content: string) => Promise<boolean>) => (
      <AgentMessageBlock
        message={message({ id: "ma1", role: "assistant", content: "original text" })}
        messageMarkup="plain"
        canEditAssistant
        onEditAssistant={onEditAssistant}
        turnActions={turnActionRow()}
      />
    );

    // Failure (AP-31 guard): the editor stays open with the typed draft.
    const view = render(inSession("s1", true, rowFor(async () => false)));
    fireEvent.click(view.getByTestId("copilot-assistant-edit"));
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "edited but rejected" } });
    fireEvent.click(view.getByTestId("copilot-edit-send"));
    await waitFor(() => expect(view.getByTestId("copilot-edit-message")).toBeTruthy());
    expect(view.container.querySelector("textarea")!.value).toBe("edited but rejected");

    // Success: the editor closes and the retained draft is gone.
    view.rerender(inSession("s1", true, rowFor(async () => true)));
    fireEvent.click(view.getByTestId("copilot-edit-send"));
    await waitFor(() => expect(view.container.querySelector('[data-testid="copilot-edit-message"]')).toBeNull());

    // Remount after the successful save: nothing resurrects.
    view.rerender(inSession("s1", false, rowFor(async () => true)));
    view.rerender(inSession("s1", true, rowFor(async () => true)));
    expect(view.container.querySelector('[data-testid="copilot-edit-message"]')).toBeNull();
  });

  it("a real session change clears every retained row state", async () => {
    const row = <AgentTimelineSeparator event={rpSyncEvent("e2")} />;
    const view = render(inSession("session-a", true, row));
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    expect(view.getByText("frozen rp text")).toBeTruthy();

    // Same tree, REAL session switch: the fresh store starts collapsed.
    view.rerender(inSession("session-b", true, row));
    await waitFor(() => expect(view.queryByText("frozen rp text")).toBeNull());

    // Back to the first session: its store was dropped with the switch —
    // nothing resurrects (the plan's session-reset rule).
    view.rerender(inSession("session-a", true, row));
    await waitFor(() => expect(view.queryByText("frozen rp text")).toBeNull());
  });
});

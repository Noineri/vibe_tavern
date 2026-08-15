/**
 * ExperienceCopilotMessageBlock digest-card tests (CM-9) — pins the collapsed
 * compaction-digest card: collapsed by default, expands on click, and derives
 * its caption count from `coveredCount`. The user/assistant bubble path is
 * covered by the message-list test; this file isolates the role-dispatch.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";

useDomEnv();

// Markdown is heavy and pinned elsewhere; the digest card renders the raw
// summary text (not through Markdown), but the block still imports it — stub it
// so the digest path has a deterministic DOM.
const realMarkdown = await import("../../../../lib/markdown.js");
mock.module("../../../../lib/markdown.js", () => ({
  ...realMarkdown,
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ExperienceCopilotMessageBlock: typeof import("./ExperienceCopilotMessageBlock.js").ExperienceCopilotMessageBlock;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ExperienceCopilotMessageBlock } = await import("./ExperienceCopilotMessageBlock.js"));
});

function digestMsg(over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return {
    id: "d1",
    threadId: "thread-1",
    role: "digest",
    content: "Earlier context was compacted: the rules buffer gained a `score` action.",
    toolCallsJson: null,
    toolCallId: "u3",
    createdAt: "2026-08-15T10:00:00.000Z",
    ...over,
  };
}

describe("ExperienceCopilotMessageBlock — digest card (CM-9)", () => {
  it("renders a collapsed digest card by default (summary hidden)", () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <ExperienceCopilotMessageBlock message={digestMsg()} coveredCount={3} />,
    );

    expect(getByTestId("copilot-digest-card")).toBeDefined();
    expect(getByText("copilot_context_digest_title")).toBeDefined();
    // Collapsed → summary body absent.
    expect(queryByTestId("copilot-digest-card-body")).toBeNull();
  });

  it("expands on click to reveal the summary text and collapses again", () => {
    const { getByTestId, queryByTestId } = render(
      <ExperienceCopilotMessageBlock message={digestMsg()} coveredCount={3} />,
    );

    fireEvent.click(getByTestId("copilot-digest-card-toggle"));
    expect(queryByTestId("copilot-digest-card-body")).not.toBeNull();
    expect(getByTestId("copilot-digest-card-body").textContent).toContain("rules buffer");

    fireEvent.click(getByTestId("copilot-digest-card-toggle"));
    expect(queryByTestId("copilot-digest-card-body")).toBeNull();
  });

  it("carries the covered count on the card for the caption", () => {
    const { getByTestId } = render(
      <ExperienceCopilotMessageBlock message={digestMsg()} coveredCount={12} />,
    );

    expect(getByTestId("copilot-digest-card-toggle").getAttribute("data-covered-count")).toBe("12");
  });

  it("renders an assistant bubble for a normal assistant message (no digest chrome)", () => {
    const { queryByTestId, getByText } = render(
      <ExperienceCopilotMessageBlock
        message={{ ...digestMsg(), id: "a1", role: "assistant", toolCallId: null }}
      />,
    );

    expect(queryByTestId("copilot-digest-card")).toBeNull();
    expect(getByText("Earlier context was compacted: the rules buffer gained a `score` action.")).toBeDefined();
  });

  it("returns nothing for an empty assistant tool-call carrier turn", () => {
    const { container } = render(
      <ExperienceCopilotMessageBlock
        message={{ ...digestMsg(), id: "a2", role: "assistant", content: "" }}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});

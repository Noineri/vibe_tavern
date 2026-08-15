import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let ExperienceCopilotMessageList: typeof import("./ExperienceCopilotMessageList.js").ExperienceCopilotMessageList;

// Mock the two heavy/boundary leaves so the list test pins the LIST contract
// (message/pending/turn-shell rendering), not markdown or the turn shell's
// internal diff chrome (each pinned in its own test).
const realMarkdown = await import("../../../../lib/markdown.js");
mock.module("../../../../lib/markdown.js", () => ({
  ...realMarkdown,
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

const realTurnShell = await import("./ExperienceCopilotTurnShell.js");
mock.module("./ExperienceCopilotTurnShell.js", () => ({
  ...realTurnShell,
  ExperienceCopilotTurnShell: ({ activities }: { activities: unknown[] }) => (
    <div data-testid="copilot-turn-shell">{activities.length} activities</div>
  ),
}));

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ ExperienceCopilotMessageList } = await import("./ExperienceCopilotMessageList.js"));
});

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "",
    ...over,
  };
}

beforeEach(() => {
  useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
});

describe("ExperienceCopilotMessageList", () => {
  it("renders each persisted user/assistant message", () => {
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "Make it scarier" }),
          message({ id: "a1", role: "assistant", content: "Here are the rules" }),
        ]}
        pendingText=""
        pendingUserContent=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByText("Make it scarier")).toBeDefined();
    expect(getByText("Here are the rules")).toBeDefined();
  });

  it("shows the live pendingText assistant bubble when non-empty", () => {
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText="streaming reply…"
        pendingUserContent=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByText("streaming reply…")).toBeDefined();
  });

  it("shows the optimistic user bubble while pendingUserContent is non-empty", () => {
    // The user's just-sent message must render immediately (before the model
    // replies) — not only after the turn settles and the persisted row is
    // refetched. This pins the fix for 'I don't see my message while it generates'.
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingUserContent="make the visual darker"
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByText("make the visual darker")).toBeDefined();
  });

  it("reads the current turn's activities from the store and renders the turn shell", () => {
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "a1", toolName: "run_test", status: "done", summary: "ok" },
          { toolCallId: "a2", toolName: "read_skill_file", status: "done", readPath: "/f" },
        ],
      },
    });

    const { getByTestId } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingUserContent=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByTestId("copilot-turn-shell").textContent).toBe("2 activities");
  });

  it("persists historical turns' tool audit cards at their turns' positions (CD-1)", () => {
    const { container, getAllByTestId } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "first request" }),
          message({
            id: "carrier1",
            role: "assistant",
            content: "",
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
            ]),
          }),
          message({
            id: "tool1",
            role: "tool",
            toolCallId: "c1",
            content: JSON.stringify({
              toolName: "write_buffer",
              output: { target: "rules", proposed: "# R1", summary: "first pass" },
            }),
          }),
          message({ id: "a1", role: "assistant", content: "first reply" }),
          message({ id: "u2", role: "user", content: "second request" }),
          message({
            id: "tool2",
            role: "tool",
            toolCallId: "c2",
            content: JSON.stringify({
              toolName: "edit_buffer",
              output: { target: "visual", proposed: "# V2", summary: "second pass" },
            }),
          }),
          message({ id: "a2", role: "assistant", content: "second reply" }),
        ]}
        pendingText=""
        pendingUserContent=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    // Two persisted turns with tools → two audit blocks, one per turn.
    const blocks = getAllByTestId("copilot-history-cards");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.getAttribute("data-anchor")).toBe("a1");
    expect(blocks[1]!.getAttribute("data-anchor")).toBe("a2");
    // Each card carries the tool name + summary as glanceable audit.
    expect(getAllByTestId("copilot-history-activity").map((el) => el.getAttribute("data-tool"))).toEqual([
      "write_buffer",
      "edit_buffer",
    ]);
    expect(blocks[0]!.textContent).toContain("first pass");
    expect(blocks[1]!.textContent).toContain("second pass");
    // Order in the flow: the audit block renders ABOVE its turn's final reply.
    const order = Array.from(container.querySelectorAll("[data-testid='copilot-history-cards'], [data-role='user'], [data-role='assistant']"));
    expect(order.map((el) => el.getAttribute("data-anchor") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "a1",
      "assistant",
      "user",
      "a2",
      "assistant",
    ]);
  });

  it("dedupes the latest turn's history cards against the live turn store (CD-1)", () => {
    // After settle+refetch the latest turn exists BOTH in the persisted history
    // and in the ephemeral live store (which renders it as the turn shell below
    // the list). The live block owns those toolCallIds — history must not
    // duplicate them.
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [{ toolCallId: "c2", toolName: "edit_buffer", status: "done", target: "visual" }],
      },
    });

    const { getAllByTestId, getByTestId } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "first request" }),
          message({
            id: "tool1",
            role: "tool",
            toolCallId: "c1",
            content: JSON.stringify({
              toolName: "write_buffer",
              output: { target: "rules", proposed: "# R1", summary: "first pass" },
            }),
          }),
          message({ id: "a1", role: "assistant", content: "first reply" }),
          message({ id: "u2", role: "user", content: "second request" }),
          message({
            id: "tool2",
            role: "tool",
            toolCallId: "c2",
            content: JSON.stringify({
              toolName: "edit_buffer",
              output: { target: "visual", proposed: "# V2", summary: "second pass" },
            }),
          }),
          message({ id: "a2", role: "assistant", content: "second reply" }),
        ]}
        pendingText=""
        pendingUserContent=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    // Only turn 1's cards come from history; turn 2 stays in the live shell.
    const blocks = getAllByTestId("copilot-history-cards");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.getAttribute("data-anchor")).toBe("a1");
    expect(getByTestId("copilot-turn-shell").textContent).toBe("1 activities");
  });

  it("renders the empty state when there is nothing to show", () => {
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingUserContent=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByText("experience_copilot_title")).toBeDefined();
  });

  it("places a compaction digest card immediately before its anchor message (CM-9)", () => {
    const { container } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "First question" }),
          message({ id: "a1", role: "assistant", content: "First answer" }),
          message({ id: "u2", role: "user", content: "Second question" }),
          message({ id: "a2", role: "assistant", content: "Second answer" }),
          message({ id: "d1", role: "digest", content: "summarized", toolCallId: "u2" }),
        ]}
        pendingText=""
        pendingUserContent=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    // The rendered order of roles (user/assistant/digest) must be:
    // user → assistant → DIGEST → user → assistant (digest moved before its anchor u2).
    const roles = Array.from(container.querySelectorAll("[data-role]"));
    expect(roles.map((el) => el.getAttribute("data-role"))).toEqual([
      "user",
      "assistant",
      "digest",
      "user",
      "assistant",
    ]);
  });
});

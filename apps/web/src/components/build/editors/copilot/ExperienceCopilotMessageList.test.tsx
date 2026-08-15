import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let ExperienceCopilotMessageList: typeof import("./ExperienceCopilotMessageList.js").ExperienceCopilotMessageList;

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
  useExperienceCopilotTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
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
      />,
    );

    expect(getByText("make the visual darker")).toBeDefined();
  });

  it("renders the current turn's activity refs from the feed as cards", () => {
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "a1", toolName: "run_test", status: "done", summary: "ok" },
          { toolCallId: "a2", toolName: "read_skill_file", status: "done", readPath: "/f" },
        ],
      },
      feedByThread: {
        "thread-1": [
          { kind: "activity", id: "a1" },
          { kind: "activity", id: "a2" },
        ],
      },
    });

    const { getAllByTestId } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingUserContent=""
      />,
    );

    expect(getAllByTestId("copilot-activity-card").map((c) => c.getAttribute("data-tool"))).toEqual([
      "run_test",
      "read_skill_file",
    ]);
  });

  it("persists historical turns' tool cards at their chronological positions (CD-1)", () => {
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
      />,
    );

    // Each tool row renders as an inline card immediately before the flow
    // message that follows it (the carrier bubble renders nothing).
    const order = Array.from(container.querySelectorAll("[data-testid='copilot-activity-card'], [data-role]"));
    expect(order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "write_buffer",
      "assistant",
      "user",
      "edit_buffer",
      "assistant",
    ]);
    // Each card carries the tool name + summary as glanceable audit.
    const cards = getAllByTestId("copilot-activity-card");
    expect(cards.map((el) => el.getAttribute("data-tool"))).toEqual(["write_buffer", "edit_buffer"]);
    expect(cards[0]!.textContent).toContain("first pass");
    expect(cards[1]!.textContent).toContain("second pass");
  });

  it("dedupes the latest turn's history cards against the live feed (CD-1)", () => {
    // After settle+refetch the latest turn exists BOTH in the persisted history
    // and in the ephemeral live store (which renders it from the feed below the
    // list). The live feed owns those toolCallIds — history must not duplicate.
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [{ toolCallId: "c2", toolName: "edit_buffer", status: "done", target: "visual" }],
      },
      feedByThread: {
        "thread-1": [{ kind: "activity", id: "c2" }],
      },
    });

    const { getAllByTestId } = render(
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
      />,
    );

    // Only turn 1's card comes from history; turn 2's c2 stays in the live feed.
    expect(getAllByTestId("copilot-activity-card").map((c) => c.getAttribute("data-tool"))).toEqual([
      "write_buffer",
      "edit_buffer",
    ]);
  });

  it("live feed interleaves text segments and cards in arrival order", () => {
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "t1", toolName: "write_buffer", status: "done", target: "rules", proposed: "v2", summary: "wrote" },
        ],
      },
      feedByThread: {
        "thread-1": [
          { kind: "text", id: "text-1", text: "I'll edit the rules", closed: true },
          { kind: "activity", id: "t1" },
          { kind: "text", id: "text-2", text: "Done", closed: false },
        ],
      },
    });

    const { container } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText="I'll edit the rulesDone"
        pendingUserContent="go"
      />,
    );

    const order = Array.from(container.querySelectorAll("[data-testid='copilot-activity-card'], [data-role]"));
    expect(order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "assistant",
      "write_buffer",
      "assistant",
    ]);
    expect(container.textContent).toContain("I'll edit the rules");
    expect(container.textContent).toContain("Done");
  });

  it("text-only turn renders one pending bubble (no cards)", () => {
    useExperienceCopilotTurnStore.setState({
      feedByThread: {
        "thread-1": [{ kind: "text", id: "text-1", text: "Hello", closed: false }],
      },
    });

    const { getByText, queryAllByTestId } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText="Hello"
        pendingUserContent=""
      />,
    );

    expect(getByText("Hello")).toBeDefined();
    expect(queryAllByTestId("copilot-activity-card")).toHaveLength(0);
  });

  it("post-settle: empty pendingText suppresses feed text while cards stay", () => {
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "t1", toolName: "write_buffer", status: "done", target: "rules", proposed: "v2", summary: "wrote" },
        ],
      },
      feedByThread: {
        "thread-1": [
          { kind: "text", id: "text-1", text: "I'll edit the rules", closed: true },
          { kind: "activity", id: "t1" },
          { kind: "text", id: "text-2", text: "Done", closed: false },
        ],
      },
    });

    const { queryByText, getAllByTestId } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingUserContent=""
      />,
    );

    expect(queryByText("I'll edit the rules")).toBeNull();
    expect(queryByText("Done")).toBeNull();
    expect(getAllByTestId("copilot-activity-card").map((c) => c.getAttribute("data-tool"))).toEqual([
      "write_buffer",
    ]);
  });

  it("tool rows without a following flow message trail at the list end", () => {
    const { container } = render(
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
        ]}
        pendingText=""
        pendingUserContent=""
      />,
    );

    const order = Array.from(container.querySelectorAll("[data-testid='copilot-activity-card'], [data-role]"));
    expect(order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "write_buffer",
    ]);
  });

  it("renders the empty state when there is nothing to show", () => {
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingUserContent=""
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

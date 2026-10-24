/**
 * ExperienceCopilotMessageList — permission card (SC-23f): the awaiting
 * `read_message_prompt` marker renders IN PLACE as the interactive gate
 * (never inside the turn's tool accordion), each button sends its decision
 * through the shared answer path, and the resolved states read the rewritten
 * row. The ask card's boundary is pinned untouched (coexistence case).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";

useDomEnv();

// Same mocks as the ask/list suites: Radix tooltips never anchor under
// happy-dom — render children inline; this test pins the feed wiring, not
// tooltip internals.
mock.module("../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentMessageList: typeof import("./AgentMessageList.js").AgentMessageList;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  await import("../../build/editors/copilot/experience-agent-host.js");
  ({ AgentMessageList } = await import("./AgentMessageList.js"));
});

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
    ...over,
  };
}

const PERM_ARGS = { position: 7, variant: 2 };

function permCarrier(id: string): ExperienceCopilotMessageWire {
  return message({
    id,
    role: "assistant",
    content: "",
    toolCallsJson: JSON.stringify([
      { type: "tool-call", toolCallId: "tc-perm", toolName: "read_message_prompt", input: PERM_ARGS },
    ]),
  });
}

const MARKER = {
  status: "awaiting_permission",
  position: 7,
  variantNumber: 2,
  replyFirstLine: "First line of the swipe",
  promptTokens: 1234,
  presetName: "Preset",
};

function permToolRow(output: unknown): ExperienceCopilotMessageWire {
  return message({
    id: `row-${Math.random().toString(36).slice(2)}`,
    role: "tool",
    content: JSON.stringify({ toolName: "read_message_prompt", output }),
    toolCallId: "tc-perm",
  });
}

beforeEach(() => {
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
});

describe("ExperienceCopilotMessageList — permission card (SC-23f)", () => {
  it("renders a persisted awaiting permission marker as the interactive card, outside any accordion", () => {
    const answers: [string, unknown][] = [];
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" }), permCarrier("a1"), permToolRow(MARKER)]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={(id, a) => answers.push([id, a])}
      />,
    );

    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    // The marker's fields render with no second fetch.
    expect(card.textContent).toContain("First line of the swipe");
    // A lone permission request owns no tool group.
    expect(queryByTestId("copilot-tool-accordion")).toBeNull();
    fireEvent.click(getByTestId("copilot-permission-allow"));
    expect(answers).toEqual([["tc-perm", { decision: "allow" }]]);
  });

  it("Deny sends the deny decision through the same answer path", () => {
    const answers: [string, unknown][] = [];
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" }), permCarrier("a1"), permToolRow(MARKER)]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={(id, a) => answers.push([id, a])}
      />,
    );

    fireEvent.click(getByTestId("copilot-permission-deny"));
    expect(answers).toEqual([["tc-perm", { decision: "deny" }]]);
  });

  it("a permission request stays out of the accordion when the turn has other tools", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "which prompt wrote this?" }),
          message({
            id: "a1",
            role: "assistant",
            content: "",
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "tc-perm", toolName: "read_message_prompt", input: PERM_ARGS },
              { type: "tool-call", toolCallId: "tc-test", toolName: "run_test", input: {} },
            ]),
          }),
          message({
            id: "t-test",
            role: "tool",
            content: JSON.stringify({ toolName: "run_test", output: { ok: true } }),
            toolCallId: "tc-test",
          }),
          // The turn stops on the permission marker — the request row is
          // the turn's last tool row, so the card stays interactive.
          permToolRow(MARKER),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    // Both render: the turn's single accordion (the run_test row) AND the
    // permission card in place — the card is never inside the group.
    expect(getByTestId("copilot-tool-accordion")).toBeDefined();
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("awaiting");
  });

  it("a later turn's activity expires the undecided request (read-only)", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "which prompt wrote this?" }),
          permCarrier("a1"),
          permToolRow(MARKER),
          message({ id: "u2", role: "user", content: "never mind" }),
          message({
            id: "a2",
            role: "assistant",
            content: "",
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "tc-todo", toolName: "todo", input: [{ title: "step", status: "active" }] },
            ]),
          }),
          message({
            id: "t2",
            role: "tool",
            content: JSON.stringify({
              toolName: "todo",
              output: { ok: true, items: [{ title: "step", status: "active" }], remaining: 1, activeTitle: "step" },
            }),
            toolCallId: "tc-todo",
          }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("expired");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
  });

  it("isSending blocks interactivity (no decision during the continuation stream)", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" }), permCarrier("a1"), permToolRow(MARKER)]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        isSending
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("expired");
  });

  it("the optimistic pendingPermissionAnswer override flips an awaiting card immediately", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" }), permCarrier("a1"), permToolRow(MARKER)]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        pendingPermissionAnswer={{ toolCallId: "tc-perm", decision: "allow" }}
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("allowed");
  });

  it("a denied rewrite renders the Denied label (the card reads the row)", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" }), permCarrier("a1"), permToolRow({ status: "denied" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("denied");
    expect(queryByTestId("copilot-permission-allow")).toBeNull();
  });

  it("a granted rewrite renders the Allowed label (the prompt text is never shown)", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" }), permCarrier("a1"), permToolRow({ status: "granted", prompt: "<rp_prompt/>", promptTokens: 9, position: 7, variantNumber: 2, presetName: "Preset" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("allowed");
    expect(card.textContent).not.toContain("<rp_prompt/>");
  });

  it("renders a live-feed awaiting permission as the interactive card", () => {
    useAgentTurnStore.getState().upsertActivity("experience", "thread-1", {
      toolCallId: "tc-live",
      toolName: "read_message_prompt",
      status: "done",
      permission: { status: "awaiting_permission", position: 3, variantNumber: 1, replyFirstLine: "Live swipe line", promptTokens: 42 },
    });
    useAgentTurnStore.getState().appendActivityRef("experience", "thread-1", "tc-live");

    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("awaiting");
    expect(getByTestId("copilot-permission-card").textContent).toContain("Live swipe line");
  });

  it("an ask and a permission request coexist — each keeps its own card and interactivity", () => {
    const answers: [string, unknown][] = [];
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it and check the swipe" }),
          message({
            id: "a1",
            role: "assistant",
            content: "",
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "tc-ask", toolName: "ask_user", input: { question: "Which buffer?" } },
              { type: "tool-call", toolCallId: "tc-perm", toolName: "read_message_prompt", input: PERM_ARGS },
            ]),
          }),
          message({
            id: "row-ask",
            role: "tool",
            content: JSON.stringify({ toolName: "ask_user", output: { status: "awaiting_answer", question: "Which buffer?" } }),
            toolCallId: "tc-ask",
          }),
          permToolRow(MARKER),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={(id, a) => answers.push([id, a])}
      />,
    );

    // The permission request is last → interactive; the earlier ask expired.
    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("awaiting");
    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("expired");
    fireEvent.click(getByTestId("copilot-permission-deny"));
    expect(answers).toEqual([["tc-perm", { decision: "deny" }]]);
  });
});

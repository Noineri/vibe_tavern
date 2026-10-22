import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire, RecordProposal } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";

useDomEnv();

// CustomTooltip (Radix) never anchors under happy-dom — the ask card's
// recommended chip is wrapped in it. Render children inline; this test pins
// the feed wiring, not tooltip internals (same mock as the card/panel tests).
mock.module("../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentMessageList: typeof import("./AgentMessageList.js").AgentMessageList;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  // Tool cards resolve target labels through the registered host
  // descriptor — the real experience host registers kind "experience"
  // (same side-effect pattern as AgentProfileModal.test.tsx).
  await import("../../build/editors/copilot/experience-agent-host.js");
  // SC-13a: the proposal fixture host — the only host with a registered
  // record renderer (`test-widget`); both built-ins register none (the
  // fallback owns every recordType there). Never unregistered — the worker
  // isolates the module registry (same pattern as the real hosts above).
  const { getAgentHost, registerAgentHost } = await import("../../../lib/agent-host-registry.js");
  registerAgentHost({
    kind: "sc13a-proposal-host",
    i18n: {
      title: "agent_title",
      placeholder: "agent_input_placeholder",
      loading: "agent_loading",
      emptyTitle: "agent_title",
    },
    toolKeys: [],
    profileAssignment: { target: "chat" },
    // AP-2: required on every descriptor (a missing markup is a compile break).
    messageMarkup: "plain",
    bufferSpecs: [],
    transport: getAgentHost("experience").transport,
    buildSendOptions: () => ({}),
    recordProposalRenderers: { "test-widget": TestWidgetCard },
  });
  // AP-2: the rp-colors pass-through fixture — the only host under test
  // with the sidechat's markup (the real sidechat host is pinned by its
  // own registration test; importing it here would drag the chat stores
  // into this file's module graph).
  registerAgentHost({
    kind: "ap2-rp-host",
    i18n: {
      title: "agent_title",
      placeholder: "agent_input_placeholder",
      loading: "agent_loading",
      emptyTitle: "agent_title",
    },
    toolKeys: [],
    profileAssignment: { target: "chat" },
    messageMarkup: "rp-colors",
    bufferSpecs: [],
    transport: getAgentHost("experience").transport,
    buildSendOptions: () => ({}),
    recordProposalRenderers: {},
  });
  ({ AgentMessageList } = await import("./AgentMessageList.js"));
});

// SC-13a: the registered renderer for the `test-widget` record type — pins
// the renderer-map seam (the card receives the proposal AND the thread id).
function TestWidgetCard({ proposal, threadId }: { proposal: RecordProposal; threadId: string }) {
  return (
    <div data-testid="record-proposal-test-card" data-record-type={proposal.recordType} data-thread-id={threadId}>
      {JSON.stringify(proposal.payload)}
    </div>
  );
}

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
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
});

describe("ExperienceCopilotMessageList", () => {
  it("renders each persisted user/assistant message", () => {
    const { getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "Make it scarier" }),
          message({ id: "a1", role: "assistant", content: "Here are the rules" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(getByText("Make it scarier")).toBeDefined();
    expect(getByText("Here are the rules")).toBeDefined();
  });

  it("shows the live reasoning block in the co-author pattern when pendingReasoning is non-empty (UX 2026-08-16 remark 4)", () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(queryByTestId("copilot-pending-reasoning-row")).toBeNull();

    rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning="thinking about the rules"
        pendingUserContent=""
      />,
    );

    // The row exists and carries the co-author MessageReasoning minimal body.
    // Body starts collapsed (defaultOpen=false) — expand via the header click.
    const row = getByTestId("copilot-pending-reasoning-row");
    expect(row.getAttribute("data-role")).toBe("assistant");
    fireEvent.click(row.querySelector("button")!);
    expect(row.textContent).toContain("thinking about the rules");
  });

  it("shows the live pendingText assistant bubble when non-empty", () => {
    const { getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText="streaming reply…"
        pendingReasoning=""
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
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent="make the visual darker"
      />,
    );

    expect(getByText("make the visual darker")).toBeDefined();
  });

  it("renders the current turn's activity refs from the feed as cards", () => {
    useAgentTurnStore.setState({
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
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
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
      <AgentMessageList
        kind="experience" threadId="thread-1"
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
        pendingReasoning=""
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
    useAgentTurnStore.setState({
      turnsByThread: {
        "thread-1": [{ toolCallId: "c2", toolName: "edit_buffer", status: "done", target: "visual" }],
      },
      feedByThread: {
        "thread-1": [{ kind: "activity", id: "c2" }],
      },
    });

    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
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
        pendingReasoning=""
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
    useAgentTurnStore.setState({
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
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText="I'll edit the rulesDone"
        pendingReasoning=""
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
    useAgentTurnStore.setState({
      feedByThread: {
        "thread-1": [{ kind: "text", id: "text-1", text: "Hello", closed: false }],
      },
    });

    const { getByText, queryAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText="Hello"
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(getByText("Hello")).toBeDefined();
    expect(queryAllByTestId("copilot-activity-card")).toHaveLength(0);
  });

  it("post-settle: empty pendingText suppresses feed text while cards stay", () => {
    useAgentTurnStore.setState({
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
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
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
      <AgentMessageList
        kind="experience" threadId="thread-1"
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
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const order = Array.from(container.querySelectorAll("[data-testid='copilot-activity-card'], [data-role]"));
    expect(order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "write_buffer",
    ]);
  });

  it("a host without message actions renders no action row (SC-16 — built-ins stay byte-identical)", () => {
    // The experience host declares no `messageActions` — its assistant
    // bubbles render exactly as before (the row owns the `copilot-message-actions`
    // test id, so its absence pins the no-row contract).
    const { queryByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "Make it scarier" }),
          message({ id: "a1", role: "assistant", content: "Here are the rules" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(getByText("Here are the rules")).toBeDefined();
    expect(queryByTestId("copilot-message-actions")).toBeNull();
  });

  it("renders the empty state when there is nothing to show", () => {
    const { getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(getByText("agent_title")).toBeDefined();
  });

  it("renders the agent_title/agent_subtitle keys when no empty-text overrides are passed (AS-8c3a)", () => {
    // Without the new props the empty state is byte-identical to today — the
    // shell passes the host's resolved strings, so the bare list keeps the
    // shared fallback lines for hosts that register no overrides.
    const { getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(getByText("agent_title")).toBeDefined();
    expect(getByText("agent_subtitle")).toBeDefined();
  });

  it("renders passed emptyTitle/emptySub strings instead of the shared keys (AS-8c3a)", () => {
    // AS-8c3a: the shell resolves the host's emptyTitle/emptySub keys and
    // passes the strings down — the script kind's own line replaces the
    // mini-app one without touching this list's fallback behavior.
    const { getByText, queryByText } = render(
      <AgentMessageList
        kind="script" threadId="thread-9"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        emptyTitle="Write me a script"
        emptySub="Ask the assistant to write or fix this script"
      />,
    );

    expect(getByText("Write me a script")).toBeDefined();
    expect(getByText("Ask the assistant to write or fix this script")).toBeDefined();
    expect(queryByText("agent_title")).toBeNull();
    expect(queryByText("agent_subtitle")).toBeNull();
  });

  it("places a compaction digest card immediately before its anchor message (CM-9)", () => {
    const { container } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "First question" }),
          message({ id: "a1", role: "assistant", content: "First answer" }),
          message({ id: "u2", role: "user", content: "Second question" }),
          message({ id: "a2", role: "assistant", content: "Second answer" }),
          message({ id: "d1", role: "digest", content: "summarized", toolCallId: "u2" }),
        ]}
        pendingText=""
        pendingReasoning=""
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

// ─── TAG-9: the ask_user card in the feed ───────────────────────────────────

const ASK_ARGS = { question: "Which buffer owns the counter?", options: ["Rules", "Visual"], recommended: "Rules" };

function askCarrier(id: string): ExperienceCopilotMessageWire {
  return message({
    id,
    role: "assistant",
    content: "",
    toolCallsJson: JSON.stringify([
      { type: "tool-call", toolCallId: "tc-ask", toolName: "ask_user", input: ASK_ARGS },
    ]),
  });
}

function askToolRow(output: unknown): ExperienceCopilotMessageWire {
  return message({
    id: `row-${Math.random().toString(36).slice(2)}`,
    role: "tool",
    content: JSON.stringify({ toolName: "ask_user", output }),
    toolCallId: "tc-ask",
  });
}

describe("ExperienceCopilotMessageList — ask card (TAG-9)", () => {
  const awaitingRow = () => askToolRow({ status: "awaiting_answer", ...ASK_ARGS });

  it("renders a persisted awaiting ask as the interactive card when it is the last activity", () => {
    const answers: [string, unknown][] = [];
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "plan it" }), askCarrier("a1"), awaitingRow()]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={(id, a) => answers.push([id, a])}
      />,
    );

    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    fireEvent.click(getByTestId("copilot-ask-skip"));
    expect(answers).toEqual([["tc-ask", { skipped: true }]]);
  });

  it("a later turn's activity expires the unanswered ask (read-only)", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          askCarrier("a1"),
          awaitingRow(),
          message({ id: "u2", role: "user", content: "never mind, do this" }),
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

    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("expired");
    expect(queryByTestId("copilot-ask-skip")).toBeNull();
  });

  it("a persisted answered ask renders read-only even as the last activity", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          askCarrier("a1"),
          askToolRow({ status: "answered", answer: "Rules" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("answered");
    expect(getByTestId("copilot-ask-answer").textContent).toBe("→ Rules");
    expect(queryByTestId("copilot-ask-input")).toBeNull();
  });

  it("the optimistic pendingAskAnswer override flips an awaiting card immediately", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "plan it" }), askCarrier("a1"), awaitingRow()]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        pendingAskAnswer={{ toolCallId: "tc-ask", status: "answered", answer: "Visual, actually" }}
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("answered");
    expect(getByTestId("copilot-ask-answer").textContent).toBe("→ Visual, actually");
  });

  it("isSending blocks interactivity (no double-answer during the continuation stream)", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "plan it" }), askCarrier("a1"), awaitingRow()]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        isSending
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("expired");
  });

  it("renders a live-feed awaiting ask as the interactive card", () => {
    useAgentTurnStore.getState().upsertActivity("experience", "thread-1", {
      toolCallId: "tc-live",
      toolName: "ask_user",
      status: "done",
      ask: { ...ASK_ARGS, status: "awaiting_answer" },
    });
    useAgentTurnStore.getState().appendActivityRef("experience", "thread-1", "tc-live");

    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "plan it" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("awaiting");
    expect(getByTestId("copilot-ask-question").textContent).toContain("Which buffer");
  });
});

// ─── TA-1: ONE tool accordion per assistant turn (owner ruling 2026-10-12) ──
// A turn's interleaved text must NOT split its tool calls into multiple
// «Инструменты · N» accordions: every non-ask call of the turn collapses
// into a single accordion at the turn's FIRST tool activity slot; ask cards
// stay outside, rendered in place.

describe("ExperienceCopilotMessageList — per-turn tool accordion (TA-1)", () => {
  const writeRow = (id: string, toolCallId: string): ExperienceCopilotMessageWire =>
    message({
      id,
      role: "tool",
      toolCallId,
      content: JSON.stringify({
        toolName: "write_buffer",
        output: { target: "rules", proposed: "# R1", summary: `${toolCallId} pass` },
      }),
    });

  const editRow = (id: string, toolCallId: string): ExperienceCopilotMessageWire =>
    message({
      id,
      role: "tool",
      toolCallId,
      content: JSON.stringify({
        toolName: "edit_buffer",
        output: { target: "visual", proposed: "# V2", summary: `${toolCallId} pass` },
      }),
    });

  it("history: one turn with text between tool calls renders ONE accordion holding all calls, one per turn", () => {
    const { container, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          message({ id: "a1", role: "assistant", content: "intro text" }),
          writeRow("tool1", "c1"),
          message({ id: "a2", role: "assistant", content: "middle text" }),
          editRow("tool2", "c2"),
          writeRow("tool3", "c3"),
          message({ id: "a3", role: "assistant", content: "closing text" }),
          // A second turn gets its OWN accordion (turns split at user rows).
          message({ id: "u2", role: "user", content: "again" }),
          message({
            id: "tool4",
            role: "tool",
            toolCallId: "c4",
            content: JSON.stringify({ toolName: "run_test", output: { ok: true } }),
          }),
          message({ id: "a4", role: "assistant", content: "second reply" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    // ONE accordion per turn — never one per consecutive run.
    const headers = getAllByTestId("copilot-tool-accordion-toggle");
    expect(getAllByTestId("copilot-tool-accordion")).toHaveLength(2);
    // N counts the turn's TOTAL tool calls (c1+c2+c3 in turn 1, c4 in turn 2).
    expect(headers.map((h) => h.getAttribute("data-count"))).toEqual(["3", "1"]);
    // Historical groups render collapsed.
    expect(headers[0]!.getAttribute("aria-expanded")).toBe("false");

    // The accordion sits at the turn's FIRST tool activity slot (between the
    // intro and middle text); the middle text no longer splits the cards.
    const order = Array.from(
      container.querySelectorAll("[data-testid='copilot-activity-card'], [data-role]"),
    );
    expect(order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "assistant",
      "write_buffer",
      "edit_buffer",
      "write_buffer",
      "assistant",
      "assistant",
      "user",
      "run_test",
      "assistant",
    ]);
  });

  it("history: an ask_user between tool calls stays outside the turn's single accordion", () => {
    const { container, getByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          message({ id: "a1", role: "assistant", content: "intro text" }),
          writeRow("tool1", "c1"),
          askCarrier("a2"),
          askToolRow({ status: "answered", answer: "Rules" }),
          editRow("tool2", "c2"),
          message({ id: "a3", role: "assistant", content: "closing text" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    // Still exactly ONE accordion — the ask does not split the turn's tools.
    expect(getAllByTestId("copilot-tool-accordion")).toHaveLength(1);
    expect(getAllByTestId("copilot-tool-accordion-toggle")[0]!.getAttribute("data-count")).toBe("2");
    // The ask card renders OUTSIDE the accordion, between the texts.
    const askCard = getByTestId("copilot-ask-card");
    expect(askCard.getAttribute("data-state")).toBe("answered");
    expect(askCard.closest("[data-testid='copilot-tool-accordion']")).toBeNull();

    const order = Array.from(
      container.querySelectorAll(
        "[data-testid='copilot-activity-card'], [data-testid='copilot-ask-card'], [data-role]",
      ),
    );
    expect(
      order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role") ?? "ask"),
    ).toEqual([
      "user",
      "assistant",
      "write_buffer",
      "edit_buffer",
      "ask",
      "assistant",
    ]);
  });

  it("live feed: interleaved text does not split the turn's accordion", () => {
    useAgentTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "t1", toolName: "write_buffer", status: "done", target: "rules", proposed: "v1", summary: "wrote" },
          { toolCallId: "t2", toolName: "run_test", status: "done", summary: "ok" },
        ],
      },
      feedByThread: {
        "thread-1": [
          { kind: "text", id: "text-1", text: "Step one", closed: true },
          { kind: "activity", id: "t1" },
          { kind: "text", id: "text-2", text: "Step two", closed: true },
          { kind: "activity", id: "t2" },
          { kind: "text", id: "text-3", text: "Done", closed: false },
        ],
      },
    });

    const { container, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText="Step oneStep twoDone"
        pendingReasoning=""
        pendingUserContent="go"
      />,
    );

    // The whole feed is ONE turn → ONE accordion at the first tool activity's
    // slot, N = total tool calls of the turn.
    expect(getAllByTestId("copilot-tool-accordion")).toHaveLength(1);
    const header = getAllByTestId("copilot-tool-accordion-toggle")[0]!;
    expect(header.getAttribute("data-count")).toBe("2");
    // The live group stays expanded while the turn streams.
    expect(header.getAttribute("aria-expanded")).toBe("true");

    const order = Array.from(
      container.querySelectorAll("[data-testid='copilot-activity-card'], [data-role]"),
    );
    expect(order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "assistant",
      "write_buffer",
      "run_test",
      "assistant",
      "assistant",
    ]);
  });

  it("live feed: an ask between tool calls stays outside the single accordion", () => {
    useAgentTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "t1", toolName: "write_buffer", status: "done", target: "rules", proposed: "v1", summary: "wrote" },
          {
            toolCallId: "tc-ask",
            toolName: "ask_user",
            status: "done",
            ask: { ...ASK_ARGS, status: "answered", answer: "Rules" },
          },
          { toolCallId: "t2", toolName: "run_test", status: "done", summary: "ok" },
        ],
      },
      feedByThread: {
        "thread-1": [
          { kind: "text", id: "text-1", text: "Thinking", closed: true },
          { kind: "activity", id: "t1" },
          { kind: "activity", id: "tc-ask" },
          { kind: "activity", id: "t2" },
          { kind: "text", id: "text-2", text: "Done", closed: false },
        ],
      },
    });

    const { container, getByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText="ThinkingDone"
        pendingReasoning=""
        pendingUserContent="go"
      />,
    );

    expect(getAllByTestId("copilot-tool-accordion")).toHaveLength(1);
    expect(getAllByTestId("copilot-tool-accordion-toggle")[0]!.getAttribute("data-count")).toBe("2");
    // The ask card renders in place, AFTER the accordion, outside it.
    const askCard = getByTestId("copilot-ask-card");
    expect(askCard.getAttribute("data-state")).toBe("answered");
    expect(askCard.closest("[data-testid='copilot-tool-accordion']")).toBeNull();

    const order = Array.from(
      container.querySelectorAll(
        "[data-testid='copilot-activity-card'], [data-testid='copilot-ask-card'], [data-role]",
      ),
    );
    expect(
      order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role") ?? "ask"),
    ).toEqual([
      "user",
      "assistant",
      "write_buffer",
      "run_test",
      "ask",
      "assistant",
    ]);
  });
});

// ─── SC-13a: record proposals in the feed (the ask-card precedent) ──────────
// A tool activity whose parsed output passes `isRecordProposal` renders IN
// PLACE, outside the tool accordion — in the live feed and in history alike —
// through the host's `recordProposalRenderers`, falling back to
// `RecordProposalFallbackCard` for an unknown recordType. A proposal inside a
// settled turn's accordion would hide its accept/reject behind a closed list.

const PROPOSAL_ARGS = { payload: { title: "New entry" } };

function proposalCarrier(id: string, toolCallId: string): ExperienceCopilotMessageWire {
  return message({
    id,
    role: "assistant",
    content: "",
    toolCallsJson: JSON.stringify([
      { type: "tool-call", toolCallId, toolName: "propose_record", input: PROPOSAL_ARGS },
    ]),
  });
}

function proposalToolRow(id: string, toolCallId: string, recordType: string): ExperienceCopilotMessageWire {
  return message({
    id,
    role: "tool",
    toolCallId,
    // The real persisted shape: the `{toolName, output}` wrapper written by
    // `persistTurn` (the extractor unwraps it; `parseAgentToolOutput` unwraps
    // it again for the proposal narrow).
    content: JSON.stringify({
      toolName: "propose_record",
      output: {
        kind: "record",
        id: toolCallId,
        recordType,
        op: "create",
        payload: PROPOSAL_ARGS.payload,
        status: "pending",
      },
    }),
  });
}

describe("ExperienceCopilotMessageList — record proposals (SC-13a)", () => {
  it("history: a proposal renders in place outside the turn's single accordion (unknown type → fallback)", () => {
    const { container, getByTestId, getAllByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          message({ id: "a1", role: "assistant", content: "intro text" }),
          message({
            id: "tool1",
            role: "tool",
            toolCallId: "c1",
            content: JSON.stringify({
              toolName: "write_buffer",
              output: { target: "rules", proposed: "# R1", summary: "c1 pass" },
            }),
          }),
          proposalCarrier("pa1", "c-prop"),
          proposalToolRow("ptool1", "c-prop", "never-seen-widget"),
          message({
            id: "tool2",
            role: "tool",
            toolCallId: "c2",
            content: JSON.stringify({
              toolName: "edit_buffer",
              output: { target: "visual", proposed: "# V2", summary: "c2 pass" },
            }),
          }),
          message({ id: "a3", role: "assistant", content: "closing text" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    // Still exactly ONE accordion — the proposal does not split the turn's
    // tools, and its count covers ONLY the non-proposal tools.
    expect(getAllByTestId("copilot-tool-accordion")).toHaveLength(1);
    expect(getAllByTestId("copilot-tool-accordion-toggle")[0]!.getAttribute("data-count")).toBe("2");
    // The unknown recordType renders the fallback card, OUTSIDE the accordion.
    const fallback = getByTestId("record-proposal-fallback-card");
    expect(fallback.getAttribute("data-record-type")).toBe("never-seen-widget");
    expect(fallback.closest("[data-testid='copilot-tool-accordion']")).toBeNull();
    expect(getByTestId("record-proposal-fallback-payload").textContent).toContain("New entry");
    // No registered renderer fired (the fixture host owns `test-widget` only).
    expect(queryByTestId("record-proposal-test-card")).toBeNull();

    const order = Array.from(
      container.querySelectorAll("[data-testid='copilot-activity-card'], [data-role]"),
    );
    expect(order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role"))).toEqual([
      "user",
      "assistant",
      "write_buffer",
      "edit_buffer",
      "assistant",
    ]);
  });

  it("history: a registered recordType renders the host's renderer with the thread id", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="sc13a-proposal-host" threadId="thread-9"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          proposalCarrier("pa1", "c-prop"),
          proposalToolRow("ptool1", "c-prop", "test-widget"),
          message({ id: "a2", role: "assistant", content: "done" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const card = getByTestId("record-proposal-test-card");
    expect(card.getAttribute("data-record-type")).toBe("test-widget");
    expect(card.getAttribute("data-thread-id")).toBe("thread-9");
    expect(card.textContent).toContain("New entry");
    expect(queryByTestId("record-proposal-fallback-card")).toBeNull();
  });

  it("live feed: a proposal renders in place outside the single accordion (unknown type → fallback)", () => {
    useAgentTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "t1", toolName: "write_buffer", status: "done", target: "rules", proposed: "v1", summary: "wrote" },
          {
            toolCallId: "tc-prop",
            toolName: "propose_record",
            status: "done",
            summary: JSON.stringify({
              toolName: "propose_record",
              output: {
                kind: "record",
                id: "tc-prop",
                recordType: "never-seen-widget",
                op: "create",
                payload: PROPOSAL_ARGS.payload,
                status: "pending",
              },
            }),
          },
          { toolCallId: "t2", toolName: "run_test", status: "done", summary: "ok" },
        ],
      },
      feedByThread: {
        "thread-1": [
          { kind: "text", id: "text-1", text: "Thinking", closed: true },
          { kind: "activity", id: "t1" },
          { kind: "activity", id: "tc-prop" },
          { kind: "activity", id: "t2" },
          { kind: "text", id: "text-2", text: "Done", closed: false },
        ],
      },
    });

    const { container, getByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText="ThinkingDone"
        pendingReasoning=""
        pendingUserContent="go"
      />,
    );

    expect(getAllByTestId("copilot-tool-accordion")).toHaveLength(1);
    expect(getAllByTestId("copilot-tool-accordion-toggle")[0]!.getAttribute("data-count")).toBe("2");
    // The proposal card renders in place, AFTER the accordion, outside it.
    const fallback = getByTestId("record-proposal-fallback-card");
    expect(fallback.getAttribute("data-record-type")).toBe("never-seen-widget");
    expect(fallback.closest("[data-testid='copilot-tool-accordion']")).toBeNull();

    const order = Array.from(
      container.querySelectorAll(
        "[data-testid='copilot-activity-card'], [data-testid='record-proposal-fallback-card'], [data-role]",
      ),
    );
    expect(
      order.map((el) => el.getAttribute("data-tool") ?? el.getAttribute("data-role") ?? "proposal"),
    ).toEqual([
      "user",
      "assistant",
      "write_buffer",
      "run_test",
      "proposal",
      "assistant",
    ]);
  });
});

// ─── AP-2: per-host message markup pass-through ─────────────────────────────
// The list resolves the host's `messageMarkup` and the block renders the
// matching REAL Markdown variant (`md-agent-plain` vs `md-agent`) — this
// file uses no Markdown mock, so the variant class pins the whole chain
// (descriptor → list → block → Markdown). The experience host's `plain`
// value is pinned here end-to-end; the sidechat/script values by their own
// registration tests.

describe("ExperienceCopilotMessageList — message markup (AP-2)", () => {
  it("renders the experience host's bubbles with the agent-plain variant", () => {
    const { container } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "Make it scarier" }),
          message({ id: "a1", role: "assistant", content: "Here are the rules" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(container.querySelector(".md-agent-plain")).not.toBeNull();
    expect(container.querySelector(".md-agent")).toBeNull();
  });

  it("passes an rp-colors host's markup through to the agent-rp variant", () => {
    const { container } = render(
      <AgentMessageList
        kind="ap2-rp-host" threadId="thread-1"
        messages={[
          message({ id: "a1", role: "assistant", content: "A shiver runs down her spine" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(container.querySelector(".md-agent")).not.toBeNull();
  });
});

// ─── AP-4: flat assistant captions («✦ {host title}» once per turn) ─────────
// The caption sits above its turn's first VISIBLE text segment (mockup §1):
// a turn opening with hidden tool calls captions its first rendered text; a
// turn with no visible text shows none. Identity i18n renders the experience
// host's title key verbatim, so the caption reads "✦ agent_title" — the
// descriptor's existing title, never a new i18n key.

function captionCarrier(id: string, toolCallId: string): ExperienceCopilotMessageWire {
  return message({
    id,
    role: "assistant",
    content: "",
    toolCallsJson: JSON.stringify([
      { type: "tool-call", toolCallId, toolName: "write_buffer", input: { buffer: "rules" } },
    ]),
  });
}

function captionToolRow(id: string, toolCallId: string): ExperienceCopilotMessageWire {
  return message({
    id,
    role: "tool",
    toolCallId,
    content: JSON.stringify({
      toolName: "write_buffer",
      output: { target: "rules", proposed: "# R1", summary: "wrote" },
    }),
  });
}

describe("ExperienceCopilotMessageList — flat assistant captions (AP-4)", () => {
  it("renders one caption per assistant turn above its first visible text", () => {
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "first" }),
          message({ id: "a1", role: "assistant", content: "first reply" }),
          message({ id: "a2", role: "assistant", content: "second reply" }),
          message({ id: "u2", role: "user", content: "second" }),
          message({ id: "a3", role: "assistant", content: "third reply" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    // Two turns → two captions (the second text of turn 1 earns none).
    const captions = getAllByTestId("copilot-host-caption");
    expect(captions).toHaveLength(2);
    expect(captions[0]!.textContent).toBe("✦ agent_title");
    expect(captions[1]!.textContent).toBe("✦ agent_title");
    // Each caption sits directly above its segment (tight wrapper, not the
    // column gap): the next sibling holds the turn's first text.
    expect(captions[0]!.nextElementSibling!.textContent).toContain("first reply");
    expect(captions[1]!.nextElementSibling!.textContent).toContain("third reply");
  });

  it("a turn starting with hidden tool calls shows the caption above its first rendered text", () => {
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          captionCarrier("c1", "c1"),
          captionToolRow("t1", "c1"),
          message({ id: "a1", role: "assistant", content: "visible reply" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const captions = getAllByTestId("copilot-host-caption");
    expect(captions).toHaveLength(1);
    expect(captions[0]!.nextElementSibling!.textContent).toContain("visible reply");
  });

  it("an assistant turn with no visible text shows no caption", () => {
    const { queryByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          captionCarrier("c1", "c1"),
          captionToolRow("t1", "c1"),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(queryByTestId("copilot-host-caption")).toBeNull();
    // The turn shape itself is intact (its tools still accordion).
    expect(getAllByTestId("copilot-tool-accordion")).toHaveLength(1);
  });

  it("the pending streaming reply carries the caption when the turn has no visible text yet", () => {
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "go" })]}
        pendingText="streaming reply…"
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const captions = getAllByTestId("copilot-host-caption");
    expect(captions).toHaveLength(1);
    expect(captions[0]!.textContent).toBe("✦ agent_title");
    expect(captions[0]!.nextElementSibling!.textContent).toContain("streaming reply…");
  });

  it("no caption on the pending reply when the turn already showed persisted text", () => {
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "earlier reply" }),
        ]}
        pendingText="streaming more…"
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    // The one caption belongs to the persisted turn text; the streaming tail
    // runs bare beneath it.
    const captions = getAllByTestId("copilot-host-caption");
    expect(captions).toHaveLength(1);
    expect(captions[0]!.nextElementSibling!.textContent).toContain("earlier reply");
  });

  it("live feed text segments: caption on the first visible segment only", () => {
    useAgentTurnStore.setState({
      feedByThread: {
        "thread-1": [
          { kind: "text", id: "text-1", text: "Step one", closed: true },
          { kind: "text", id: "text-2", text: "Step two", closed: false },
        ],
      },
    });

    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "go" })]}
        pendingText="Step oneStep two"
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const captions = getAllByTestId("copilot-host-caption");
    expect(captions).toHaveLength(1);
    expect(captions[0]!.nextElementSibling!.textContent).toContain("Step one");
  });
});

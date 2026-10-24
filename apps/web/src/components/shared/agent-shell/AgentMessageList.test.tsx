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
let waitFor: typeof import("@testing-library/react").waitFor;
let AgentMessageList: typeof import("./AgentMessageList.js").AgentMessageList;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
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
      kindLabel: "agent_kind_script",
      placeholder: "agent_input_placeholder",
      loading: "agent_loading",
      emptyTitle: "agent_title",
    },
    // AP-17: required on every descriptor (four keys, tuple-typed).
    starterPromptKeys: [
      "agent_starter_script_explain",
      "agent_starter_script_fix_bugs",
      "agent_starter_script_comment",
      "agent_starter_script_simplify",
    ],
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
      kindLabel: "agent_kind_sidechat",
      placeholder: "agent_input_placeholder",
      loading: "agent_loading",
      emptyTitle: "agent_title",
    },
    // AP-17: required on every descriptor (four keys, tuple-typed).
    starterPromptKeys: [
      "agent_starter_sidechat_recap",
      "agent_starter_sidechat_feelings",
      "agent_starter_sidechat_twists",
      "agent_starter_sidechat_pacing",
    ],
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
    reasoning: null,
    reasoningDurationMs: null,
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

  // ── AP-29: the live block is the inline preset on the live caption line ─
  // WAS (characterized pre-change, UX 2026-08-16 remark 4): a separate
  // `copilot-pending-reasoning-row` (avatar + the co-author's minimal block)
  // rendered above the pending text. NOW (plan §AP-29): the live block uses
  // the SAME inline preset in the SAME place as the persisted one — the
  // toggle sits on the live caption row; at settle it hands over to the
  // persisted caption toggle with no gap and no duplicate.
  it("shows the live reasoning toggle on the live caption row (AP-29 inline preset)", () => {
    const { container, getByText, getByTestId, queryByText, queryByTestId, rerender } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(queryByTestId("copilot-host-caption")).toBeNull();

    rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning="thinking about the rules"
        pendingUserContent=""
      />,
    );

    // The toggle lives ON the caption row (title + reasoning part only),
    // collapsed by default — the old separate pending row is gone.
    const caption = getByTestId("copilot-host-caption");
    expect(caption.textContent).toContain("✦ agent_title");
    expect(caption.textContent).toContain("reasoning");
    expect(queryByTestId("copilot-pending-reasoning-row")).toBeNull();
    expect(queryByText("thinking about the rules")).toBeNull();
    // The live turn streams no duration (pendingReasoning is text-only).
    expect(caption.textContent).not.toContain("(4.2s)");

    // Expanding puts the mono body on its own full-width line under the
    // row, above the turn's text.
    fireEvent.click(getByText("reasoning"));
    const body = getByText("thinking about the rules");
    expect(caption.contains(body)).toBe(true);
    expect(body.closest(".basis-full")).not.toBeNull();
    expect(container.querySelector(".basis-full")!.textContent).toContain("thinking about the rules");
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

  it("a tool-first turn shows the caption above its tool accordion, not between accordion and text", () => {
    // WAS (AP-4): the caption sat above the turn's first visible text, i.e.
    // BELOW the turn's tool accordion — it jumped at settle (the live
    // caption streams above the accordion). NOW (AP-29 follow-up): one
    // caption at the top of the turn, the same place live and persisted.
    const { getByTestId, getByText } = render(
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

    const caption = getByTestId("copilot-host-caption");
    const accordion = getByTestId("copilot-tool-accordion");
    expect(caption.compareDocumentPosition(accordion) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(accordion.compareDocumentPosition(getByText("visible reply")) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(caption.nextElementSibling!.getAttribute("data-testid")).toBe("copilot-tool-accordion");
  });

  it("a turn with neither text nor reasoning shows no caption", () => {
    // The empty carrier renders nothing and earns nothing — the rule for
    // tool-only turns without reasoning, extended to a bare carrier.
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "c1", role: "assistant", content: "" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(queryByTestId("copilot-host-caption")).toBeNull();
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

// ─── AP-29: kept reasoning in the co-author's block (inline preset) ───────
// A persisted assistant turn that carries reasoning shows the SHARED
// MessageReasoning (never a new component) ON the caption line: collapsed,
// the row reads «✦ title · label (4.2s) caret»; expanded, the minimal mono
// body opens full-width under that row, above the turn's text and tool
// rows. WAS (characterized at AP-28): wire fields persisted + served, but
// NOTHING rendered them. NOW: the inline preset below.
describe("ExperienceCopilotMessageList — kept reasoning (AP-29)", () => {
  it("a persisted turn with reasoning shows the toggle on the caption row, collapsed by default", () => {
    const { getByTestId, queryByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "visible reply", reasoning: "kept thought", reasoningDurationMs: 4200 }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const caption = getByTestId("copilot-host-caption");
    expect(caption.textContent).toContain("✦ agent_title");
    expect(caption.textContent).toContain("reasoning");
    expect(caption.textContent).toContain("(4.2s)");
    // Collapsed: the body is absent; the turn text still follows the row.
    expect(queryByText("kept thought")).toBeNull();
    expect(caption.nextElementSibling!.textContent).toContain("visible reply");
  });

  it("expanding puts the body on its own full-width line under the caption row", () => {
    const { getByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "visible reply", reasoning: "kept thought", reasoningDurationMs: 4200 }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    fireEvent.click(getByText("reasoning"));
    const caption = getByTestId("copilot-host-caption");
    const body = getByText("kept thought");
    // The body stays INSIDE the caption row (its own full-width flex line)
    // and the turn's text still follows the row — never pushed elsewhere.
    expect(caption.contains(body)).toBe(true);
    expect(body.closest(".basis-full")).not.toBeNull();
    expect(body.className).toContain("font-mono");
    expect(caption.nextElementSibling!.textContent).toContain("visible reply");
  });

  it("a turn whose first row is a tool carrier shows the carrier's reasoning on the caption", () => {
    const { getByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({
            id: "c1", role: "assistant", content: "", reasoning: "carrier thought", reasoningDurationMs: 1200,
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
            ]),
          }),
          captionToolRow("t1", "c1"),
          message({ id: "a1", role: "assistant", content: "visible reply" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    // AP-28 attaches the pair to the FIRST assistant row (text OR carrier),
    // so the caption above the turn's first visible text carries it.
    const caption = getByTestId("copilot-host-caption");
    expect(caption.textContent).toContain("(1.2s)");
    fireEvent.click(getByText("reasoning"));
    expect(getByText("carrier thought")).toBeDefined();
  });

  it("null reasoning renders no block — the caption stays the bare title", () => {
    const { getByTestId, queryByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "visible reply" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const caption = getByTestId("copilot-host-caption");
    expect(caption.textContent).toBe("✦ agent_title");
    expect(queryByText("reasoning")).toBeNull();
  });

  it("copy forwards the turn text WITHOUT the kept reasoning", () => {
    const turnRow = turnRowCallbacks();
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "visible reply", reasoning: "kept thought", reasoningDurationMs: 4200 }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
      />,
    );

    fireEvent.click(getByTestId("copilot-turn-copy"));
    expect(turnRow.onCopy.mock.calls[0]).toEqual(["visible reply"]);
  });

  it("a finished live turn shows exactly ONE block (the persisted toggle)", () => {
    // Post-settle props: the controller cleared pendingReasoning, the
    // reloaded turn carries its reasoning — one toggle, no live remnant.
    const { queryAllByText, queryByTestId, queryByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "visible reply", reasoning: "kept thought", reasoningDurationMs: 4200 }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(queryAllByText("reasoning")).toHaveLength(1);
    expect(queryByTestId("copilot-pending-reasoning-row")).toBeNull();
    expect(queryByText("kept thought")).toBeNull();
  });

  it("a live continuation joins the turn's caption block — no second caption, no pending row", () => {
    // WAS: the answer-continuation path (no optimistic user row) kept the
    // live toggle in its own `copilot-pending-reasoning-row` until the
    // settle+refetch handover (two toggles mid-turn). NOW (AP-29
    // follow-up): the live reasoning joins the caption block it streams
    // into (the same blank-line join) — one toggle, and the block holds
    // the same text when the turn lands.
    const { getByTestId, getByText, queryByTestId, queryAllByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "earlier reply", reasoning: "kept thought", reasoningDurationMs: 4200 }),
        ]}
        pendingText=""
        pendingReasoning="continuation thought"
        pendingUserContent=""
      />,
    );

    expect(queryAllByText("reasoning")).toHaveLength(1);
    expect(queryByTestId("copilot-pending-reasoning-row")).toBeNull();
    const caption = getByTestId("copilot-host-caption");
    expect(caption.textContent).toContain("(4.2s)");
    fireEvent.click(getByText("reasoning"));
    expect(caption.querySelector("pre")!.textContent).toBe("kept thought\n\ncontinuation thought");
  });

  it("live reasoning joins a bare caption — the toggle appears on the turn it continues", () => {
    // The turn shows persisted text but carries no kept reasoning yet (bare
    // title); the streaming delta still joins that caption's block instead
    // of opening its own row.
    const { getByTestId, getByText, queryByTestId, queryAllByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "earlier reply" }),
        ]}
        pendingText=""
        pendingReasoning="live thought"
        pendingUserContent=""
      />,
    );

    expect(queryAllByText("reasoning")).toHaveLength(1);
    expect(queryByTestId("copilot-pending-reasoning-row")).toBeNull();
    fireEvent.click(getByText("reasoning"));
    expect(getByTestId("copilot-host-caption").querySelector("pre")!.textContent).toBe("live thought");
  });

  it("a turn with two reasoning-carrying rows shows ONE toggle with both texts joined and durations summed", () => {
    // An ask answer starts a new request WITHOUT a user row, so one visible
    // turn holds two reasoning-carrying rows — the caption carries ALL of
    // the turn's reasoning in order, not just the first row's.
    const { getByTestId, getByText, queryAllByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "first reply", reasoning: "first thought", reasoningDurationMs: 3000 }),
          askCarrier("ac1"),
          askToolRow({ status: "answered", answer: "Rules" }),
          message({ id: "a2", role: "assistant", content: "second reply", reasoning: "second thought", reasoningDurationMs: 4000 }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    expect(queryAllByText("reasoning")).toHaveLength(1);
    const caption = getByTestId("copilot-host-caption");
    expect(caption.textContent).toContain("(7.0s)");
    fireEvent.click(getByText("reasoning"));
    expect(caption.querySelector("pre")!.textContent).toBe("first thought\n\nsecond thought");
  });

  it("a tools-only turn with reasoning keeps its caption and toggle above its tool accordion", () => {
    // WAS: a turn with reasoning but no text showed its reasoning only
    // while streaming (the hoisted live caption) and lost it once the turn
    // landed. NOW: the turn earns the caption through its kept reasoning,
    // so the toggle survives the landing, above the turn's tools.
    const { getByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({
            id: "c1", role: "assistant", content: "",
            reasoning: "carrier thought", reasoningDurationMs: 1200,
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
            ]),
          }),
          captionToolRow("t1", "c1"),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    const caption = getByTestId("copilot-host-caption");
    const accordion = getByTestId("copilot-tool-accordion");
    expect(caption.compareDocumentPosition(accordion) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(caption.nextElementSibling!.getAttribute("data-testid")).toBe("copilot-tool-accordion");
    fireEvent.click(getByText("reasoning"));
    expect(getByText("carrier thought")).toBeDefined();
  });

  it("a live tool-first turn shows the caption in the same position as after it lands", () => {
    // The live caption sits above the live tool accordion; once the turn
    // lands, the persisted caption sits above the same accordion — nothing
    // moves at settle.
    useAgentTurnStore.setState({
      turnsByThread: {
        "thread-1": [{ toolCallId: "t1", toolName: "write_buffer", status: "done", target: "rules", proposed: "v1", summary: "wrote" }],
      },
      feedByThread: {
        "thread-1": [{ kind: "activity", id: "t1" }],
      },
    });
    const { getByTestId, rerender } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "go" })]}
        pendingText=""
        pendingReasoning="thinking"
        pendingUserContent=""
      />,
    );

    expect(getByTestId("copilot-host-caption").nextElementSibling!.getAttribute("data-testid")).toBe(
      "copilot-tool-accordion",
    );
    // Land the turn: the persisted caption takes the same site.
    useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
    rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({
            id: "c1", role: "assistant", content: "",
            reasoning: "thinking", reasoningDurationMs: 1200,
            toolCallsJson: JSON.stringify([
              { type: "tool-call", toolCallId: "t1", toolName: "write_buffer", input: { buffer: "rules" } },
            ]),
          }),
          message({
            id: "t1row", role: "tool", toolCallId: "t1",
            content: JSON.stringify({
              toolName: "write_buffer",
              output: { target: "rules", proposed: "# R1", summary: "wrote" },
            }),
          }),
          message({ id: "a1", role: "assistant", content: "visible reply" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );
    expect(getByTestId("copilot-host-caption").nextElementSibling!.getAttribute("data-testid")).toBe(
      "copilot-tool-accordion",
    );
  });
});

// ─── AP-11: turn action rows (copy / regenerate / delete) ─────────────────
// The list merges the pane-wired turn callbacks with its own boundaries
// (last turn, digest cover, streaming) and hands each bubble its row via
// `buildAgentTurnRow` — this pins the per-role matrix at the integration
// seam. WAS (characterized pre-change): no turn rows existed — user bubbles
// never carried actions, assistant bubbles only the host's row. NOW: turn
// rows render per the matrix below (a planned behavior change).

function turnRowCallbacks() {
  return {
    onCopy: mock((_text: string) => {}),
    onRegenerate: mock(() => {}),
    onRequestDelete: mock((_messageId: string, _includeUserMessage: boolean) => {}),
  };
}

function twoTurnThread() {
  return [
    message({ id: "u1", role: "user", content: "first question" }),
    message({ id: "a1", role: "assistant", content: "first answer" }),
    message({ id: "u2", role: "user", content: "second question" }),
    message({ id: "a2", role: "assistant", content: "second answer" }),
  ];
}

describe("ExperienceCopilotMessageList — turn action rows (AP-11)", () => {
  it("without turn callbacks the list renders no rows (exactly as before)", () => {
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
      />,
    );

    expect(queryByTestId("copilot-message-actions")).toBeNull();
  });

  it("last-turn assistant row: copy + regenerate + delete; delete takes the answer only", () => {
    const turnRow = turnRowCallbacks();
    const { getByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
      />,
    );

    // Regenerate exists exactly once — the last turn's assistant row.
    expect(getByTestId("copilot-turn-regenerate")).toBeDefined();
    expect(getAllByTestId("copilot-turn-copy")).toHaveLength(2);
    // Document order: u1, a1, u2, a2 — the LAST delete is a2's.
    const deletes = getAllByTestId("copilot-turn-delete");
    expect(deletes).toHaveLength(4);
    fireEvent.click(deletes[3]!);
    expect(turnRow.onRequestDelete.mock.calls[0]).toEqual(["a2", false]);
  });

  it("earlier-turn assistant row: copy + delete, NO regenerate", () => {
    const turnRow = turnRowCallbacks();
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
      />,
    );

    expect(getAllByTestId("copilot-turn-regenerate")).toHaveLength(1);
    // a1's delete is the second in document order (u1, a1, u2, a2).
    fireEvent.click(getAllByTestId("copilot-turn-delete")[1]!);
    expect(turnRow.onRequestDelete.mock.calls[0]).toEqual(["a1", false]);
  });

  it("user rows request delete WITH the answer", () => {
    const turnRow = turnRowCallbacks();
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
      />,
    );

    fireEvent.click(getAllByTestId("copilot-turn-delete")[0]!);
    expect(turnRow.onRequestDelete.mock.calls[0]).toEqual(["u1", true]);
    fireEvent.click(getAllByTestId("copilot-turn-delete")[2]!);
    expect(turnRow.onRequestDelete.mock.calls[1]).toEqual(["u2", true]);
  });

  it("copy forwards the message text", () => {
    const turnRow = turnRowCallbacks();
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
      />,
    );

    fireEvent.click(getAllByTestId("copilot-turn-copy")[1]!);
    expect(turnRow.onCopy.mock.calls[0]).toEqual(["second answer"]);
  });

  it("streaming hides every row, either role", () => {
    const turnRow = turnRowCallbacks();
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText="streaming…"
        pendingReasoning=""
        pendingUserContent=""
        isSending
        turnRow={turnRow}
      />,
    );

    expect(queryByTestId("copilot-message-actions")).toBeNull();
  });

  it("digest-covered rows: delete hidden, copy kept (the floor is server-side; the UI hides proactively)", () => {
    const turnRow = turnRowCallbacks();
    const { getAllByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "old question" }),
          message({ id: "a1", role: "assistant", content: "old answer" }),
          message({ id: "d1", role: "digest", content: "summary", toolCallId: "u2" }),
          message({ id: "u2", role: "user", content: "new question" }),
          message({ id: "a2", role: "assistant", content: "new answer" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
      />,
    );

    // Deletes: u2 + a2 only (u1/a1 sit at/before the digest anchor).
    const deletes = getAllByTestId("copilot-turn-delete");
    expect(deletes).toHaveLength(2);
    fireEvent.click(deletes[0]!);
    expect(turnRow.onRequestDelete.mock.calls[0]).toEqual(["u2", true]);
    // Copy survives on the covered assistant row.
    expect(getAllByTestId("copilot-turn-copy")).toHaveLength(2);
    expect(queryByTestId("copilot-turn-regenerate")).not.toBeNull();
  });
});

// ─── AP-12: inline edit of the last own message ────────────────────────────
// The list threads the pane's `onEditLast` submit path plus `isBusy` to every
// block; the block renders the «Изменить» opener only where the row builder
// reports `canEditLast` (the LAST user row). WAS (characterized at AP-11):
// no edit affordance existed — user rows were delete-only. NOW: exactly one
// edit opener (the last user row), opening the editor in place and threading
// submit to `onEditLast`.
describe("ExperienceCopilotMessageList — inline edit (AP-12)", () => {
  it("only the last user row carries the edit opener", () => {
    const turnRow = turnRowCallbacks();
    const onEditLast = mock((_content: string) => {});
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
        onEditLast={onEditLast}
      />,
    );

    // u1's row stays delete-only; u2's row gains «Изменить» first.
    expect(getAllByTestId("copilot-turn-edit")).toHaveLength(1);
    expect(getAllByTestId("copilot-turn-delete")).toHaveLength(4);
  });

  it("opening the editor swaps only that bubble; submit threads to onEditLast", () => {
    const turnRow = turnRowCallbacks();
    const seen: string[] = [];
    const { getByTestId, getAllByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRow}
        onEditLast={(content) => seen.push(content)}
      />,
    );

    fireEvent.click(getByTestId("copilot-turn-edit"));
    // The editor holds u2's text; the other three rows keep theirs.
    const box = getByTestId("copilot-edit-message").querySelector("textarea") as HTMLTextAreaElement;
    expect(box.value).toBe("second question");
    expect(getAllByTestId("copilot-turn-regenerate")).toHaveLength(1);
    fireEvent.change(box, { target: { value: "revised second question" } });
    fireEvent.click(getByTestId("copilot-edit-send"));
    expect(seen).toEqual(["revised second question"]);
    expect(queryByTestId("copilot-edit-message")).toBeNull();
  });

  it("no edit opener without onEditLast (no submit path)", () => {
    const { queryByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
      />,
    );

    expect(queryByTestId("copilot-turn-edit")).toBeNull();
    expect(getAllByTestId("copilot-turn-delete")).toHaveLength(4);
  });

  it("streaming: no edit opener on any row", () => {
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText="streaming…"
        pendingReasoning=""
        pendingUserContent=""
        isSending
        turnRow={turnRowCallbacks()}
        onEditLast={mock((_content: string) => {})}
      />,
    );

    expect(queryByTestId("copilot-turn-edit")).toBeNull();
  });
});

describe("ExperienceCopilotMessageList — error card (AP-13)", () => {
  it("live failure: loud card at the feed end (after the last entry), retry calls onRetryTurn", () => {
    const onRetryTurn = mock(() => {});
    const { getByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnFailure={{ category: "rate_limit" }}
        onRetryTurn={onRetryTurn}
      />,
    );

    const card = getByTestId("copilot-error-card");
    expect(card.getAttribute("data-variant")).toBe("failed");
    // The card reuses the toast's category description (one derivation).
    expect(getByTestId("copilot-error-card-description").textContent).toBe(
      "provider_error_transient_desc",
    );
    // Placement: the card FOLLOWS the last persisted entry (the feed end,
    // where the pending block lives — a failed turn has neither).
    const lastBubble = getByText("second answer");
    expect(lastBubble.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    fireEvent.click(getByTestId("copilot-error-card-retry") as HTMLButtonElement);
    expect(onRetryTurn).toHaveBeenCalledTimes(1);
  });

  it("after-reload derivation: last row is an unanswered user message → quiet card + retry", () => {
    const onRetryTurn = mock(() => {});
    const { getByTestId, getByText, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "stuck question" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onRetryTurn={onRetryTurn}
      />,
    );

    const card = getByTestId("copilot-error-card");
    expect(card.getAttribute("data-variant")).toBe("unanswered");
    expect(getByText("copilot_turn_error_unanswered_title")).toBeDefined();
    // The category is unknown after a reload — no description.
    expect(queryByTestId("copilot-error-card-description")).toBeNull();
    const lastBubble = getByText("stuck question");
    expect(lastBubble.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    fireEvent.click(getByTestId("copilot-error-card-retry") as HTMLButtonElement);
    expect(onRetryTurn).toHaveBeenCalledTimes(1);
  });

  it("live failure wins over the quiet derivation (the retry's failure replaces the content)", () => {
    const { getByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "stuck question" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnFailure={{ category: "authentication" }}
        onRetryTurn={mock(() => {})}
      />,
    );

    expect(getByTestId("copilot-error-card").getAttribute("data-variant")).toBe("failed");
    expect(getByText("copilot_turn_error_title")).toBeDefined();
    expect(getByTestId("copilot-error-card-description").textContent).toBe(
      "provider_error_auth_desc",
    );
  });

  it("no card while streaming (the turn is in flight, not failed)", () => {
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "stuck question" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent="stuck question"
        isSending
        onRetryTurn={mock(() => {})}
      />,
    );

    expect(queryByTestId("copilot-error-card")).toBeNull();
  });

  it("no card for an answered thread (last row is the assistant's)", () => {
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onRetryTurn={mock(() => {})}
      />,
    );

    expect(queryByTestId("copilot-error-card")).toBeNull();
  });

  it("no card for an empty thread (the empty state owns that)", () => {
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onRetryTurn={mock(() => {})}
      />,
    );

    expect(queryByTestId("copilot-error-card")).toBeNull();
  });

  it("no card without a retry target (the card's retry needs a handler)", () => {
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "stuck question" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnFailure={{ category: "timeout" }}
      />,
    );

    expect(queryByTestId("copilot-error-card")).toBeNull();
  });
});

// ─── AP-18: starter prompts in the empty session ────────────────────────────
// The empty session (mockup §3) lists the host's four starters as full-width
// secondary buttons BELOW the title/subtitle; a click hands the TRANSLATED
// text to `onStarterPick` (the pane prefills the composer and focuses it —
// never sent). WAS (characterized pre-change): the empty state rendered the
// title/subtitle only (pinned by the AS-8c3a tests above) — no starters.

describe("ExperienceCopilotMessageList — starter prompts (AP-18)", () => {
  const EXPERIENCE_STARTERS = [
    "agent_starter_experience_game",
    "agent_starter_experience_explain_rules",
    "agent_starter_experience_find_bugs",
    "agent_starter_experience_polish_visual",
  ];

  function renderEmpty(over: { onStarterPick?: (text: string) => void } = {}) {
    return render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onStarterPick={over.onStarterPick}
      />,
    );
  }

  it("renders the host's four starters in descriptor-tuple order with translated text", () => {
    const { getByTestId } = renderEmpty({ onStarterPick: mock((_text: string) => {}) });

    // Identity i18n renders each key verbatim — order = the descriptor tuple.
    const buttons = [0, 1, 2, 3].map((index) => getByTestId(`agent-starter-${index}`));
    expect(buttons.map((button) => button.textContent)).toEqual(EXPERIENCE_STARTERS);
  });

  it("starters are full-width left-aligned buttons below the subtitle", () => {
    const { getByTestId, getByText } = renderEmpty({ onStarterPick: mock((_text: string) => {}) });

    const first = getByTestId("agent-starter-0");
    expect(first.tagName).toBe("BUTTON");
    expect(first.getAttribute("type")).toBe("button");
    expect(first.className).toContain("w-full");
    expect(first.className).toContain("text-left");
    // Document order: title → subtitle → starters (mockup §3).
    const title = getByText("agent_title");
    const sub = getByText("agent_subtitle");
    expect(title.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(sub.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("click calls onStarterPick with the starter text (never sent)", () => {
    const seen: string[] = [];
    const { getByTestId } = renderEmpty({ onStarterPick: (text: string) => seen.push(text) });

    fireEvent.click(getByTestId("agent-starter-2"));

    expect(seen).toEqual([EXPERIENCE_STARTERS[2]]);
  });

  it("no starters without the callback (a button without an action is a defect)", () => {
    const { queryByTestId, getByText } = renderEmpty();

    expect(getByText("agent_title")).toBeDefined();
    expect(queryByTestId("agent-starter-0")).toBeNull();
  });

  it("no starters once messages exist (the empty state owns them)", () => {
    const { queryByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "go" })]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onStarterPick={mock((_text: string) => {})}
      />,
    );

    expect(getByText("go")).toBeDefined();
    expect(queryByTestId("agent-starter-0")).toBeNull();
  });

  it("unknown kind renders the bare empty state (never a throw)", () => {
    const { queryByTestId, getByText } = render(
      <AgentMessageList
        kind="unknown-kind" threadId="thread-1"
        messages={[]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        onStarterPick={mock((_text: string) => {})}
      />,
    );

    expect(getByText("agent_title")).toBeDefined();
    expect(queryByTestId("agent-starter-0")).toBeNull();
  });
});

// ─── AP-29 follow-up 2: regenerate shows only the new turn; no avatar ───
// WAS (characterized at fb55c477a): a regenerate in flight kept the replaced
// turn visible until the settle refetch — and the live part counted as a
// continuation of that old turn, so the new reasoning streamed appended to
// the OLD turn's caption block with the new text under the old turn. NOW:
// the replaced turn hides the moment the regenerate starts and the new turn
// streams as a fresh turn with its own caption and only its own reasoning.
// A refused/failed regenerate shows the stored truth again (the old turn +
// the error card) once the flag clears. The ask-answer continuation path is
// unchanged (it still joins its turn's caption). The fallback row (no host
// title) keeps the live toggle but loses the avatar circle (AP-4).
describe("ExperienceCopilotMessageList — regenerate in flight (AP-29 follow-up 2)", () => {
  function oldTurnThread() {
    return [
      message({ id: "u0", role: "user", content: "earlier question" }),
      message({ id: "a0", role: "assistant", content: "earlier answer" }),
      message({ id: "u1", role: "user", content: "go" }),
      message({
        id: "c1", role: "assistant", content: "", reasoning: "old thought", reasoningDurationMs: 1200,
        toolCallsJson: JSON.stringify([
          { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
        ]),
      }),
      captionToolRow("t1", "c1"),
      message({ id: "a1", role: "assistant", content: "old reply" }),
    ];
  }

  it("hides the replaced turn and streams the new turn as a fresh caption with only the live reasoning", () => {
    const { getByText, queryByText, queryByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={oldTurnThread()}
        pendingText="new reply"
        pendingReasoning="new thought"
        pendingUserContent=""
        isSending
        isRegenerating
      />,
    );

    // The regenerated turn's user row stays; everything after it hides —
    // the old text, its tool accordion, and its caption with old reasoning.
    expect(getByText("go")).toBeDefined();
    expect(getByText("earlier question")).toBeDefined();
    expect(getByText("earlier answer")).toBeDefined();
    expect(queryByText("old reply")).toBeNull();
    expect(queryByTestId("copilot-tool-accordion")).toBeNull();
    // Two captions: the earlier turn's own plus the new turn's fresh one —
    // the fresh caption sits directly above the streaming reply.
    const captions = getAllByTestId("copilot-host-caption");
    expect(captions).toHaveLength(2);
    expect(captions[0]!.nextElementSibling!.textContent).toContain("earlier answer");
    expect(captions[1]!.nextElementSibling!.textContent).toContain("new reply");
    // The fresh caption carries ONLY the live reasoning — never joined to
    // the replaced turn's block.
    fireEvent.click(captions[1]!.querySelector("button")!);
    expect(captions[1]!.querySelector("pre")!.textContent).toBe("new thought");
    expect(queryByText("old thought")).toBeNull();
  });

  it("keeps the digest card and everything before the replaced turn", () => {
    const { container, getByText, queryByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "old question" }),
          message({ id: "a1", role: "assistant", content: "old answer" }),
          message({ id: "u2", role: "user", content: "second question" }),
          message({ id: "a2", role: "assistant", content: "second answer" }),
          message({ id: "d1", role: "digest", content: "summary", toolCallId: "u2" }),
        ]}
        pendingText="new reply"
        pendingReasoning="new thought"
        pendingUserContent=""
        isSending
        isRegenerating
      />,
    );

    // The digest moves before its anchor (u2) and stays; the replaced
    // assistant row hides while its user row stays.
    expect(getByText("second question")).toBeDefined();
    expect(getByText("old question")).toBeDefined();
    expect(queryByText("second answer")).toBeNull();
    expect(container.querySelectorAll('[data-role="digest"]')).toHaveLength(1);
  });

  it("a refused/failed regenerate shows the stored truth again: the old turn plus the error card", () => {
    // Post-settle props: the flag cleared, the refetch returned the old
    // turn (the server never replaced it), the failure owns the card.
    const onRetryTurn = mock(() => {});
    const { getByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnFailure={{ category: "rate_limit" }}
        onRetryTurn={onRetryTurn}
      />,
    );

    expect(getByText("first answer")).toBeDefined();
    expect(getByText("second answer")).toBeDefined();
    expect(getByTestId("copilot-error-card").getAttribute("data-variant")).toBe("failed");
  });

  it("without the flag a continuation still joins its turn's caption (unchanged)", () => {
    // The same props as the fresh-turn test but WITHOUT isRegenerating —
    // the ask-answer shape: the old turn stays and the live reasoning
    // folds into its caption block (the fb55c477a behavior, unchanged).
    const { getByTestId, getByText, queryAllByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a1", role: "assistant", content: "old reply", reasoning: "old thought", reasoningDurationMs: 4200 }),
        ]}
        pendingText="more"
        pendingReasoning="new thought"
        pendingUserContent=""
        isSending
      />,
    );

    expect(getByText("old reply")).toBeDefined();
    expect(queryAllByText("reasoning")).toHaveLength(1);
    fireEvent.click(getByText("reasoning"));
    expect(getByTestId("copilot-host-caption").querySelector("pre")!.textContent).toBe(
      "old thought\n\nnew thought",
    );
  });

  it("the fallback row (no host title) renders the live toggle with no avatar", () => {
    const { getByTestId, getByText, queryByText } = render(
      <AgentMessageList
        kind="unknown-kind" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "go" })]}
        pendingText=""
        pendingReasoning="live thought"
        pendingUserContent=""
        isSending
      />,
    );

    // The fallback keeps the live reasoning toggle (collapsed by default)
    // but carries no avatar circle anywhere in the row.
    const row = getByTestId("copilot-pending-reasoning-row");
    expect(row.querySelector(".rounded-full")).toBeNull();
    expect(queryByText("live thought")).toBeNull();
    fireEvent.click(getByText("reasoning"));
    expect(getByText("live thought")).toBeDefined();
  });
});

// ─── AP-29 follow-up 3: no flash of the replaced turn after a successful regenerate ───
// WAS (characterized at 216edbcda): `isRegenerating` dropped at the settle on
// success while `messages` still held the pre-regenerate rows — the replaced
// turn rendered again until the settle refetch landed. NOW: the controller
// records the replaced rows' ids at regenerate start (`hiddenRegeneratedIds`)
// and the list hides exactly those ids past the settle; the set empties when a
// `messages` array arrives without them (the refetch landing the new turn).
// Refusal / failure / cancel drop the set at once, so the old turn renders
// right after the settle with the error card. The in-flight flag path above
// is unchanged (positional hide while the stream runs).
describe("ExperienceCopilotMessageList — replaced turn stays hidden past the settle (AP-29 follow-up 3)", () => {
  function oldTurnThread() {
    return [
      message({ id: "u0", role: "user", content: "earlier question" }),
      message({ id: "a0", role: "assistant", content: "earlier answer" }),
      message({ id: "u1", role: "user", content: "go" }),
      message({
        id: "c1", role: "assistant", content: "", reasoning: "old thought", reasoningDurationMs: 1200,
        toolCallsJson: JSON.stringify([
          { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
        ]),
      }),
      captionToolRow("t1", "c1"),
      message({ id: "a1", role: "assistant", content: "old reply" }),
    ];
  }

  it("after the settle and before the refetch the replaced turn is not rendered", () => {
    // Post-settle props on success: the flag cleared, the live text cleared
    // exactly as for a normal send, the id set holds the replaced rows, and
    // `messages` still holds the pre-regenerate rows (the refetch is in flight).
    const { getByText, queryByText, queryByTestId, getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={oldTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        hiddenRegeneratedIds={["c1", "a1"]}
      />,
    );

    // The replaced turn's rows hide whole — text, tool accordion, caption —
    // while the last user row and everything before it stay visible.
    expect(getByText("go")).toBeDefined();
    expect(getByText("earlier question")).toBeDefined();
    expect(getByText("earlier answer")).toBeDefined();
    expect(queryByText("old reply")).toBeNull();
    expect(queryByTestId("copilot-tool-accordion")).toBeNull();
    expect(queryByText("old thought")).toBeNull();
    // Only the earlier turn's caption remains (the replaced turn's own hid
    // with its rows; no live content earns a fresh one here).
    expect(getAllByTestId("copilot-host-caption")).toHaveLength(1);
  });

  it("after the refetch (rows gone) a stale set hides nothing — the new turn shows on that render", () => {
    // The same render that lands the refetch: the new rows' ids were never
    // recorded, so intersecting the stale set with the current rows empties
    // it — no one-frame blank of the new turn while the hook's effect drops
    // the stored set on the next pass.
    const { getByText, queryByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u0", role: "user", content: "earlier question" }),
          message({ id: "a0", role: "assistant", content: "earlier answer" }),
          message({ id: "u1", role: "user", content: "go" }),
          message({ id: "a9", role: "assistant", content: "new reply" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        hiddenRegeneratedIds={["c1", "a1"]}
      />,
    );

    expect(getByText("new reply")).toBeDefined();
    expect(queryByText("old reply")).toBeNull();
  });

  it("failure: with no hide set the old turn renders right after the settle, with the error card", () => {
    // Post-settle props on failure: the set dropped at once (as the flag did
    // before), the refetch returns the stored old turn, the failure owns the
    // card — the feed shows the old turn plus the card, never a blank.
    const onRetryTurn = mock(() => {});
    const { getByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        hiddenRegeneratedIds={null}
        turnFailure={{ category: "rate_limit" }}
        onRetryTurn={onRetryTurn}
      />,
    );

    expect(getByText("first answer")).toBeDefined();
    expect(getByText("second answer")).toBeDefined();
    expect(getByTestId("copilot-error-card").getAttribute("data-variant")).toBe("failed");
  });

  it("the id hide never touches other turns, user rows, or digest cards", () => {
    const { container, getByText, queryByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "old question" }),
          message({ id: "a1", role: "assistant", content: "old answer" }),
          message({ id: "u2", role: "user", content: "second question" }),
          message({ id: "a2", role: "assistant", content: "second answer" }),
          message({ id: "d1", role: "digest", content: "summary", toolCallId: "u2" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        hiddenRegeneratedIds={["a2"]}
      />,
    );

    expect(getByText("old question")).toBeDefined();
    expect(getByText("old answer")).toBeDefined();
    expect(getByText("second question")).toBeDefined();
    expect(queryByText("second answer")).toBeNull();
    expect(container.querySelectorAll('[data-role="digest"]')).toHaveLength(1);
  });
});

// ─── AP-32: «Изменить» on the assistant's text rows ─────────────────────────
// WAS (characterized at AP-12, basis: the inline-edit describe above): the
// list threaded `onEditLast` only — assistant rows had copy / regenerate /
// delete and no edit affordance. NOW: the list threads AP-31's
// `onEditAssistant` (messageId, content) => Promise<boolean> to every block
// alongside the builder's per-row `canEditAssistant` (the AP-30 rule, ONE
// derivation in `buildAgentTurnRow`); folded rows and tool-call carriers
// show no opener. Save closes on true (the settle refetch shows the stored
// text); failure keeps the draft open. The caption, the reasoning toggle
// and the turn's anchored cards live outside the block — they stay put.
describe("ExperienceCopilotMessageList — assistant edit (AP-32)", () => {
  function editStubs(ok: boolean) {
    const seen: Array<{ messageId: string; content: string }> = [];
    return {
      seen,
      onEditAssistant: async (messageId: string, content: string): Promise<boolean> => {
        seen.push({ messageId, content });
        return ok;
      },
    };
  }

  it("every editable assistant text row carries the opener", () => {
    const stubs = editStubs(true);
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditLast={mock((_content: string) => {})}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    // Both assistant answers (a1, a2) — edit is not last-turn-only.
    expect(getAllByTestId("copilot-assistant-edit")).toHaveLength(2);
  });

  it("no opener without onEditAssistant (no submit path)", () => {
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditLast={mock((_content: string) => {})}
      />,
    );

    expect(queryByTestId("copilot-assistant-edit")).toBeNull();
  });

  it("folded assistant rows show no opener (only the kept tail does)", () => {
    const stubs = editStubs(true);
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "old question" }),
          message({ id: "a1", role: "assistant", content: "old answer" }),
          message({ id: "d1", role: "digest", content: "summary", toolCallId: "u2" }),
          message({ id: "u2", role: "user", content: "new question" }),
          message({ id: "a2", role: "assistant", content: "new answer" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    // a1 sits at/before the digest anchor (folded); a2 stays editable.
    expect(getAllByTestId("copilot-assistant-edit")).toHaveLength(1);
  });

  it("tool-call carriers show no opener (only text rows do)", () => {
    const stubs = editStubs(true);
    const { getAllByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          message({
            id: "c1",
            role: "assistant",
            content: "",
            toolCallsJson: JSON.stringify([{ id: "tc-1", name: "plan", arguments: {} }]),
            toolCallId: "tc-1",
          }),
          message({ id: "a1", role: "assistant", content: "the answer" }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    expect(getAllByTestId("copilot-assistant-edit")).toHaveLength(1);
  });

  it("edit → save calls onEditAssistant with (messageId, newText) and closes on success", async () => {
    const stubs = editStubs(true);
    const { getAllByTestId, getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    // a1's opener is the first in document order (u1, a1, u2, a2).
    fireEvent.click(getAllByTestId("copilot-assistant-edit")[0]!);
    const box = getByTestId("copilot-edit-message").querySelector("textarea") as HTMLTextAreaElement;
    expect(box.value).toBe("first answer");
    fireEvent.change(box, { target: { value: "fixed first answer" } });
    fireEvent.click(getByTestId("copilot-edit-send"));
    await waitFor(() => expect(queryByTestId("copilot-edit-message")).toBeNull());
    expect(stubs.seen).toEqual([{ messageId: "a1", content: "fixed first answer" }]);
  });

  it("a failed save keeps the editor open with the typed text", async () => {
    const stubs = editStubs(false);
    const { getAllByTestId, getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    fireEvent.click(getAllByTestId("copilot-assistant-edit")[0]!);
    fireEvent.change(getByTestId("copilot-edit-message").querySelector("textarea")!, { target: { value: "fixed first answer" } });
    fireEvent.click(getByTestId("copilot-edit-send"));
    await waitFor(() => expect(stubs.seen).toEqual([{ messageId: "a1", content: "fixed first answer" }]));
    expect(getByTestId("copilot-edit-message")).toBeDefined();
    expect((getByTestId("copilot-edit-message").querySelector("textarea") as HTMLTextAreaElement).value)
      .toBe("fixed first answer");
  });

  it("cancel restores the row without submitting", () => {
    const stubs = editStubs(true);
    const { getAllByTestId, getByTestId, queryByTestId, getByText } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    fireEvent.click(getAllByTestId("copilot-assistant-edit")[0]!);
    fireEvent.change(getByTestId("copilot-edit-message").querySelector("textarea")!, { target: { value: "changed my mind" } });
    fireEvent.click(getByTestId("copilot-edit-cancel"));
    expect(stubs.seen).toEqual([]);
    expect(queryByTestId("copilot-edit-message")).toBeNull();
    expect(getByText("first answer")).toBeDefined();
  });

  it("the reasoning toggle survives opening and saving an edit", async () => {
    const stubs = editStubs(true);
    const { getAllByTestId, getByTestId, getByText, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "plan it" }),
          message({
            id: "a1",
            role: "assistant",
            content: "the answer",
            reasoning: "kept thought",
            reasoningDurationMs: 4200,
          }),
        ]}
        pendingText=""
        pendingReasoning=""
        pendingUserContent=""
        turnRow={turnRowCallbacks()}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    // The caption toggle (the AP-29 inline preset) is up before the edit.
    expect(getByText("reasoning")).toBeDefined();
    fireEvent.click(getAllByTestId("copilot-assistant-edit")[0]!);
    // Still there while editing (it lives on the caption row, outside the block).
    expect(getByText("reasoning")).toBeDefined();
    fireEvent.change(getByTestId("copilot-edit-message").querySelector("textarea")!, { target: { value: "fixed answer" } });
    fireEvent.click(getByTestId("copilot-edit-send"));
    await waitFor(() => expect(queryByTestId("copilot-edit-message")).toBeNull());
    expect(stubs.seen).toEqual([{ messageId: "a1", content: "fixed answer" }]);
    expect(getByText("reasoning")).toBeDefined();
  });

  it("streaming: no assistant edit opener on any row", () => {
    const stubs = editStubs(true);
    const { queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={twoTurnThread()}
        pendingText="streaming…"
        pendingReasoning=""
        pendingUserContent=""
        isSending
        turnRow={turnRowCallbacks()}
        onEditAssistant={stubs.onEditAssistant}
      />,
    );

    expect(queryByTestId("copilot-assistant-edit")).toBeNull();
  });
});

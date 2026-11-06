/**
 * ExperienceCopilotMessageList — permission card (SC-23f): the awaiting
 * `read_message_prompt` marker renders IN PLACE as the interactive gate
 * (never inside the turn's tool accordion), each button sends its decision
 * through the shared answer path, and the resolved states read the rewritten
 * row. The ask card's boundary is pinned untouched (coexistence case).
 * DMT-32 — the `request_message_swipe` family rides the SAME chronological
 * slot and eligibility rules: the instruction is editable inline, the draft
 * survives feed virtualization/remounts, an old request renders
 * non-interactive, the optimistic override flips and rolls back (the draft
 * kept), a deleted request's draft is pruned, and the exact edited text
 * rides the allow answer while deny sends only the decision.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useDirectorSwipeDraftStore } from "../../../stores/director-swipe-draft-store.js";

useDomEnv();

// Same mocks as the ask/list suites: Radix tooltips never anchor under
// happy-dom — render children inline; this test pins the feed wiring, not
// tooltip internals.
const realTooltip = await import("../../../components/shared/Tooltip.js");
// Spread `...real` (R4): the loaded graph also pulls `TooltipProvider`
// (AttachmentGrid → sent-file-attachment, since CA-4f) — a factory without
// the spread would break unrelated importers sharing this worker.
mock.module("../../../components/shared/Tooltip.js", () => ({
  ...realTooltip,
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
  useDirectorSwipeDraftStore.setState({ draftsByThread: {} });
});

describe("ExperienceCopilotMessageList — permission card (SC-23f)", () => {
  it("renders a persisted awaiting permission marker as the interactive card, outside any accordion", () => {
    const answers: [string, unknown][] = [];
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "which prompt wrote this?" }), permCarrier("a1"), permToolRow(MARKER)]}
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

// ─── Director swipe requests (DMT-32, DIRECTOR_MESSAGE_TOOLS_PLAN) ───────
// The `request_message_swipe` family rides the SAME chronological permission
// slot and interactive eligibility rules; the card additionally exposes the
// editable instruction whose unsubmitted edit lives in the draft store.
const SWIPE_ARGS = { messageId: "msg-1", variantId: "var-2", position: 7 };

function swipeCarrier(id: string): ExperienceCopilotMessageWire {
  return message({
    id,
    role: "assistant",
    content: "",
    toolCallsJson: JSON.stringify([
      { type: "tool-call", toolCallId: "tc-swipe", toolName: "request_message_swipe", input: SWIPE_ARGS },
    ]),
  });
}

const SWIPE_MARKER = {
  status: "awaiting_permission",
  messageId: "msg-1",
  variantId: "var-2",
  position: 7,
  variantNumber: 2,
  replyFirstLine: "First line of the swipe",
  instruction: "Rewrite it spicier",
};

function swipeToolRow(output: unknown): ExperienceCopilotMessageWire {
  return message({
    id: `row-swipe-${Math.random().toString(36).slice(2)}`,
    role: "tool",
    content: JSON.stringify({ toolName: "request_message_swipe", output }),
    toolCallId: "tc-swipe",
  });
}

describe("ExperienceCopilotMessageList — director swipe permission (DMT-32)", () => {
  it("renders a persisted awaiting swipe request as the interactive card at its chronological slot, outside any accordion", () => {
    const answers: [string, unknown][] = [];
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={(id, a) => answers.push([id, a])}
      />,
    );

    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    expect(card.textContent).toContain("copilot_permission_swipe_title");
    expect(card.textContent).toContain("First line of the swipe");
    expect(queryByTestId("copilot-tool-accordion")).toBeNull();
    // The full instruction is editable INLINE; the exact edited text rides
    // the SAME answer path as every other permission decision.
    const field = getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement;
    expect(field.value).toBe("Rewrite it spicier");
    fireEvent.change(field, { target: { value: "Make it spicier, keep the accent" } });
    fireEvent.click(getByTestId("copilot-permission-swipe-allow"));
    expect(answers).toEqual([["tc-swipe", { decision: "allow", instruction: "Make it spicier, keep the accent" }]]);
  });

  it("deny sends ONLY the decision — no instruction rides it", () => {
    const answers: [string, unknown][] = [];
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={(id, a) => answers.push([id, a])}
      />,
    );

    fireEvent.change(getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "an edit that must not be saved" },
    });
    fireEvent.click(getByTestId("copilot-permission-swipe-reject"));
    expect(answers).toEqual([["tc-swipe", { decision: "deny" }]]);
  });

  it("the unsubmitted edit survives a remount (feed virtualization)", () => {
    const first = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    fireEvent.change(first.getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "my half-typed correction" },
    });
    first.unmount();
    // The feed remounts (thread switch back / virtualization): the card
    // re-reads the retained edit from the draft store.
    const second = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    expect((second.getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement).value).toBe(
      "my half-typed correction",
    );
  });

  it("a real thread switch keeps drafts namespaced (the other thread's draft is untouched)", () => {
    useDirectorSwipeDraftStore.setState({
      draftsByThread: { "thread-2": { "tc-swipe": "the other thread's edit" } },
    });
    const view = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    fireEvent.change(view.getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "thread-1 edit" },
    });
    expect(useDirectorSwipeDraftStore.getState().draftsByThread).toEqual({
      "thread-1": { "tc-swipe": "thread-1 edit" },
      "thread-2": { "tc-swipe": "the other thread's edit" },
    });
  });

  it("a later turn's activity expires the undecided swipe request (read-only, no field)", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "make it spicier" }),
          swipeCarrier("a1"),
          swipeToolRow(SWIPE_MARKER),
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
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("expired");
    expect(card.textContent).toContain("copilot_permission_swipe_expired");
    expect(queryByTestId("copilot-permission-swipe-instruction")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-reject")).toBeNull();
  });

  it("the optimistic override flips the swipe card, and its rollback returns the awaiting card with the send-failed line and the kept draft", () => {
    const view = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    fireEvent.change(view.getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "my kept edit" },
    });
    // The user decides (the controller would now start the flight).
    fireEvent.click(view.getByTestId("copilot-permission-swipe-allow"));
    // The optimistic flight arrives through the anchor's override: the card
    // flips to the granted receipt.
    view.rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        pendingPermissionAnswer={{ toolCallId: "tc-swipe", decision: "allow" }}
        onAnswer={() => {}}
      />,
    );
    expect(view.getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("allowed");
    // The refusal: the override rolls back — awaiting again, the draft kept.
    view.rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    const card = view.getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    expect(view.getByTestId("copilot-permission-swipe-send-failed").textContent).toBe(
      "copilot_permission_swipe_send_failed",
    );
    expect((view.getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement).value).toBe(
      "my kept edit",
    );
    // The card is actionable again: the retry re-sends the kept edit.
    fireEvent.click(view.getByTestId("copilot-permission-swipe-allow"));
    expect(view.getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("awaiting");
  });

  it("deleting the request prunes its transient draft", () => {
    const view = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" }), swipeCarrier("a1"), swipeToolRow(SWIPE_MARKER)]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    fireEvent.change(view.getByTestId("copilot-permission-swipe-instruction"), {
      target: { value: "an edit on a living request" },
    });
    expect(useDirectorSwipeDraftStore.getState().draftsByThread["thread-1"]?.["tc-swipe"]).toBe(
      "an edit on a living request",
    );
    // The request is deleted (its carrier/tool rows leave the feed).
    view.rerender(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" })]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    expect(useDirectorSwipeDraftStore.getState().draftsByThread["thread-1"]).toBeUndefined();
  });

  it("a granted swipe rewrite renders the approved-text receipt (the final text, never the reset draft)", () => {
    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "make it spicier" }),
          swipeCarrier("a1"),
          swipeToolRow({
            status: "granted",
            messageId: "msg-1",
            variantId: "var-2",
            position: 7,
            variantNumber: 2,
            replyFirstLine: "First line of the swipe",
            instruction: "the final approved text",
          }),
        ]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );
    const card = getByTestId("copilot-permission-card");
    expect(card.getAttribute("data-state")).toBe("allowed");
    expect(getByTestId("copilot-permission-swipe-approved-text").textContent).toBe("the final approved text");
    expect(card.textContent).toContain("copilot_permission_swipe_allowed_receipt");
  });

  it("renders a live-feed awaiting swipe request as the interactive card", () => {
    useAgentTurnStore.getState().upsertActivity("experience", "thread-1", {
      toolCallId: "tc-live-swipe",
      toolName: "request_message_swipe",
      status: "done",
      permission: {
        status: "awaiting_permission",
        kind: "swipe",
        position: 3,
        variantNumber: 1,
        replyFirstLine: "Live swipe line",
        messageId: "msg-9",
        variantId: "var-1",
        instruction: "Live instruction",
      },
    });
    useAgentTurnStore.getState().appendActivityRef("experience", "thread-1", "tc-live-swipe");

    const { getByTestId } = render(
      <AgentMessageList
        kind="experience" threadId="thread-1"
        messages={[message({ id: "u1", role: "user", content: "make it spicier" })]}
        pendingUserContent=""
        onAnswer={() => {}}
      />,
    );

    expect(getByTestId("copilot-permission-card").getAttribute("data-state")).toBe("awaiting");
    expect((getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement).value).toBe(
      "Live instruction",
    );
  });
});

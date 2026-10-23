/**
 * AgentChatPane (AP-5) — the composer answers the live ask: while the
 * thread's live awaiting `ask_user` exists (the ONE derivation in
 * stores/agent-live-ask.ts — the same source the ask card's interactive rule
 * reads), a composer send routes to `ctrl.handleAnswer(toolCallId, { text })`
 * instead of a new message. Both composer arms (desktop AgentInputArea /
 * mobile AgentMobileInputArea) share the routing — responsive dual-mode.
 *
 * The pane mounts with its REAL children (header, meter, list, composers);
 * only the Radix substrate that happy-dom cannot lay out is stubbed (the
 * AgentInputArea.test.tsx trio, `...real` spread), so the send click drives
 * the real textarea/send-button wiring and the real routing decision.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import type { AgentController } from "./use-agent-controller.js";
import type { CopilotContextController } from "../../../hooks/use-copilot-context.js";

useDomEnv();

// ── SAFE mock.module stubs (capture real first, spread `...real`) — the
// same trio as AgentInputArea.test.tsx: Radix Tooltip/Select/Popover content
// never mounts under happy-dom (no layout).

const realTooltip = await import("../Tooltip.js");
mock.module("../Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

interface FakeToolbarSelectProps {
  mobile?: boolean;
  trigger: ReactElement;
  triggerTooltip?: string;
  itemTestId?: (value: string) => string;
  title: ReactNode;
  items: Array<{ value: string; label: string }>;
  value: string | null;
  onSelect: (value: string) => void;
  emptyText?: ReactNode;
  contentWidth?: number;
}

function FakeToolbarSelect(props: FakeToolbarSelectProps) {
  return (
    <div>
      {props.trigger}
      {props.items.map((item) => (
        <button
          key={item.value}
          type="button"
          data-testid={props.itemTestId?.(item.value) ?? item.value}
          onClick={() => props.onSelect(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const realToolbarSelect = await import("../ToolbarSelect.js");
mock.module("../ToolbarSelect.js", () => ({
  ...realToolbarSelect,
  ToolbarSelect: FakeToolbarSelect,
}));

interface FakeDropdownSelectProps {
  value: string;
  options: Array<{ id: string; label: string }>;
  groups?: Array<{ id: string; label?: string; options: Array<{ id: string; label: string; trailing?: ReactNode }> }>;
  placeholder?: string;
  triggerTestId?: string;
  triggerClassName?: string;
  contentWidth?: number;
  triggerLeading?: ReactNode;
  onChange: (value: string) => void;
}

function FakeDropdownSelect(props: FakeDropdownSelectProps) {
  return (
    <div>
      <button type="button" data-testid={props.triggerTestId} className={props.triggerClassName} onClick={() => {}}>
        {props.triggerLeading}
        {props.options.find((o) => o.id === props.value)?.label ?? props.placeholder}
      </button>
      {(props.groups ?? []).map((g) => (
        <div key={g.id} data-testid={`dropdown-group-${g.id}`}>
          {g.options.map((o) => (
            <div key={o.id} data-testid={`dropdown-option-${o.id}`} onClick={() => props.onChange(o.id)}>
              {o.label}
              {o.trailing}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const realDropdownSelect = await import("../DropdownSelect.js");
mock.module("../DropdownSelect.js", () => ({
  ...realDropdownSelect,
  DropdownSelect: FakeDropdownSelect,
}));

// AP-11: the real DestructiveConfirmModal mounts a Radix Modal (overlay +
// portal + focus trap) that happy-dom cannot lay out — render its contract
// (title / body / confirm / cancel) inline instead. The `...real` spread
// keeps every other export intact; no existing test in this file opens the
// modal, so the stub is inert for them (same trio pattern as above).
const realDestructiveConfirmModal = await import("../destructive-confirm-modal.js");
mock.module("../destructive-confirm-modal.js", () => ({
  ...realDestructiveConfirmModal,
  DestructiveConfirmModal: ({ title, body, confirmLabel, onConfirm, onCancel }: {
    title: ReactNode;
    body: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="turn-delete-confirm">
      <div data-testid="turn-delete-title">{title}</div>
      <div data-testid="turn-delete-body">{body}</div>
      <button type="button" data-testid="turn-delete-confirm-btn" onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button type="button" data-testid="turn-delete-cancel-btn" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentChatPane: typeof import("./AgentChatPane.js").AgentChatPane;
let getAgentHost: typeof import("../../../lib/agent-host-registry.js").getAgentHost;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  // The real experience host registers kind "experience" (same side-effect
  // pattern as the list tests) — the pane reads its descriptor for i18n keys.
  await import("../../build/editors/copilot/experience-agent-host.js");
  ({ getAgentHost } = await import("../../../lib/agent-host-registry.js"));
  ({ AgentChatPane } = await import("./AgentChatPane.js"));
});

const THREAD = "thread-1";

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim). Silences react-i18next's NO_I18NEXT_INSTANCE warning WITHOUT
// touching the process-global i18n singleton (R13) — the AgentInputArea
// test's pattern.
function makeIsolatedI18n() {
  const instance = createInstance();
  void instance.init({
    lng: "en",
    fallbackLng: "en",
    resources: {},
    ns: ["translation"],
    defaultNS: "translation",
    keySeparator: false,
    nsSeparator: false,
    interpolation: { prefix: "{", suffix: "}", escapeValue: false },
  });
  return instance;
}

function makeCtrl(over: Partial<AgentController> = {}): AgentController {
  return {
    isSending: false,
    pendingText: "",
    pendingReasoning: "",
    pendingUserContent: "",
    pendingAskAnswer: null,
    pendingPermissionAnswer: null,
    handleSend: mock(),
    handleAnswer: mock(),
    // AP-10: the turn actions are required on the controller (a stub that
    // forgets them is a compile break); the pane tests never invoke them.
    handleRegenerate: mock(),
    handleDeleteTurn: mock(),
    handleEditLast: mock(),
    // AP-11: the delete-confirm state the pane's modal reads (same rule).
    // AP-13: the live turn failure the error card reads (same rule).
    turnFailure: null,
    pendingDelete: null,
    requestDeleteTurn: mock(),
    confirmDeleteTurn: mock(),
    cancelDeleteTurn: mock(),
    handleCancel: () => {},
    ...over,
  };
}

const COPILOT_CONTEXT: CopilotContextController = {
  metrics: null,
  autoCompact: false,
  isCompacting: false,
  applyMetrics: () => {},
  compact: async () => {},
  setAutoCompact: async () => {},
};

const EMPTY_OPTIONS = {};

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: THREAD,
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "",
    ...over,
  };
}

function renderPane(over: {
  ctrl?: AgentController;
  messages?: ExperienceCopilotMessageWire[];
  isMobile?: boolean;
} = {}) {
  const ctrl = over.ctrl ?? makeCtrl();
  const utils = render(
    <I18nextProvider i18n={makeIsolatedI18n()}>
      <AgentChatPane
        kind="experience"
        isMobile={over.isMobile ?? false}
        host={getAgentHost("experience")}
        hostCtx={{
          owner: { kind: "chat", chatId: "chat-1", branchId: "b1", agentKind: "sidechat" },
          threadId: THREAD,
          isSending: false,
          bridge: { session: null, setInputPrefill: () => {} },
        }}
        sessionLoading={false}
        sessionError={null}
        threadId={THREAD}
        loadSession={async () => {}}
        sessions={[]}
        messages={over.messages ?? [message({ id: "u1", role: "user", content: "plan it" })]}
        events={[]}
        handleActivate={async () => {}}
        handleNewSession={async () => {}}
        handleRenameSession={async () => {}}
        setProfileModalOpen={() => {}}
        copilotContext={COPILOT_CONTEXT}
        ctrl={over.ctrl ?? ctrl}
        sendWithOptions={(dispatch) => dispatch(EMPTY_OPTIONS)}
        planOwner={undefined}
        inputPrefill={null}
        providerProfileId={null}
        model={undefined}
        handleProviderChange={() => {}}
        catalog={[]}
        pinnedContext={[]}
        handlePinContext={() => {}}
        handleUnpinContext={() => {}}
        composerTopSlot={null}
      />
    </I18nextProvider>,
  );
  return { ...utils, ctrl };
}

/** Seed the live turn store with an awaiting ask (the live-feed source). */
function seedLiveAsk() {
  useAgentTurnStore.getState().upsertActivity("experience", THREAD, {
    toolCallId: "tc-live",
    toolName: "ask_user",
    status: "done",
    ask: {
      question: "Which buffer owns the counter?",
      options: ["Rules", "Visual"],
      recommended: "Rules",
      status: "awaiting_answer",
    },
  });
  useAgentTurnStore.getState().appendActivityRef("experience", THREAD, "tc-live");
}

/** Type into the composer and press send (the real textarea + send button). */
function submitComposer(utils: { getByTestId: (id: string) => HTMLElement }, text: string) {
  fireEvent.change(utils.getByTestId("copilot-chat-input"), { target: { value: text } });
  fireEvent.click(utils.getByTestId("copilot-send-btn"));
}

beforeEach(() => {
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
});

describe("AgentChatPane — the composer answers the live ask (AP-5)", () => {
  it("a send with no live ask is a normal message (handleSend, never handleAnswer)", () => {
    const { ctrl, getByTestId } = renderPane();

    submitComposer({ getByTestId }, "just a message");

    expect(ctrl.handleSend).toHaveBeenCalledTimes(1);
    expect(ctrl.handleSend).toHaveBeenCalledWith("just a message", EMPTY_OPTIONS);
    expect(ctrl.handleAnswer).not.toHaveBeenCalled();
  });

  it("a live awaiting ask routes the composer send to handleAnswer with the draft as the answer", () => {
    seedLiveAsk();
    const { ctrl, getByTestId } = renderPane();

    // Coherence: the ask the composer answers is the card the list renders
    // interactive — the SAME selector feeds both.
    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("awaiting");

    submitComposer({ getByTestId }, "Rules, please");

    expect(ctrl.handleAnswer).toHaveBeenCalledTimes(1);
    expect(ctrl.handleAnswer).toHaveBeenCalledWith("tc-live", { text: "Rules, please" }, EMPTY_OPTIONS);
    expect(ctrl.handleSend).not.toHaveBeenCalled();
  });

  it("the optimistic override (a chip click just happened) turns the send back into a normal message", () => {
    seedLiveAsk();
    const ctrl = makeCtrl({ pendingAskAnswer: { toolCallId: "tc-live", status: "answered", answer: "Rules" } });
    const { getByTestId } = renderPane({ ctrl });

    submitComposer({ getByTestId }, "one more thing");

    expect(ctrl.handleSend).toHaveBeenCalledTimes(1);
    expect(ctrl.handleSend).toHaveBeenCalledWith("one more thing", EMPTY_OPTIONS);
    expect(ctrl.handleAnswer).not.toHaveBeenCalled();
  });

  it("a waiting permission card never routes the composer — the send stays a normal message", () => {
    useAgentTurnStore.getState().upsertActivity("experience", THREAD, {
      toolCallId: "tc-perm",
      toolName: "read_message_prompt",
      status: "done",
      permission: {
        status: "awaiting_permission",
        variantNumber: 2,
        replyFirstLine: "First line of the swipe",
        promptTokens: 1234,
      },
    });
    useAgentTurnStore.getState().appendActivityRef("experience", THREAD, "tc-perm");
    const { ctrl, getByTestId } = renderPane();

    submitComposer({ getByTestId }, "meanwhile, a message");

    expect(ctrl.handleSend).toHaveBeenCalledTimes(1);
    expect(ctrl.handleAnswer).not.toHaveBeenCalled();
  });

  it("a persisted awaiting ask (reload / thread switch) routes the composer too — the history source", () => {
    const { ctrl, getByTestId } = renderPane({
      messages: [
        message({ id: "u1", role: "user", content: "plan it" }),
        message({
          id: "carrier-ask",
          role: "assistant",
          content: "",
          toolCallsJson: JSON.stringify([
            { type: "tool-call", toolCallId: "tc-ask", toolName: "ask_user", input: { question: "Which buffer?" } },
          ]),
        }),
        message({
          id: "row-ask",
          role: "tool",
          toolCallId: "tc-ask",
          content: JSON.stringify({
            toolName: "ask_user",
            output: { status: "awaiting_answer", question: "Which buffer?" },
          }),
        }),
      ],
    });

    submitComposer({ getByTestId }, "Visual, actually");

    expect(ctrl.handleAnswer).toHaveBeenCalledTimes(1);
    expect(ctrl.handleAnswer).toHaveBeenCalledWith("tc-ask", { text: "Visual, actually" }, EMPTY_OPTIONS);
    expect(ctrl.handleSend).not.toHaveBeenCalled();
  });

  it("the mobile composer routes the same way (responsive dual-mode)", () => {
    seedLiveAsk();
    const { ctrl, getByTestId } = renderPane({ isMobile: true });

    submitComposer({ getByTestId }, "Rules, please");

    expect(ctrl.handleAnswer).toHaveBeenCalledTimes(1);
    expect(ctrl.handleAnswer).toHaveBeenCalledWith("tc-live", { text: "Rules, please" }, EMPTY_OPTIONS);
    expect(ctrl.handleSend).not.toHaveBeenCalled();
  });
});

describe("AgentChatPane — answeringAsk visual state (AP-6)", () => {
  it("a live awaiting ask flags the desktop composer answering (accent card + answering placeholder)", () => {
    seedLiveAsk();
    const { getByTestId, getByPlaceholderText, queryByPlaceholderText } = renderPane();

    // The SAME selector that routes the send (AP-5) drives the visual flag —
    // no hand-rolled rule in the pane.
    expect(getByPlaceholderText("agent_input_answering_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_placeholder")).toBeNull();
    const card = (getByTestId("copilot-chat-input") as HTMLTextAreaElement).closest("div.rounded-lg");
    expect(card?.className).toContain("border-accent");
  });

  it("no live ask leaves the desktop composer ordinary", () => {
    const { getByTestId, getByPlaceholderText, queryByPlaceholderText } = renderPane();

    expect(getByPlaceholderText("agent_input_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_answering_placeholder")).toBeNull();
    const card = (getByTestId("copilot-chat-input") as HTMLTextAreaElement).closest("div.rounded-lg");
    expect(card?.className).toContain("border-border");
    expect(card?.className).not.toContain("border-accent");
  });

  it("the optimistic override clears the answering state (the send is ordinary again)", () => {
    seedLiveAsk();
    const ctrl = makeCtrl({ pendingAskAnswer: { toolCallId: "tc-live", status: "answered", answer: "Rules" } });
    const { getByPlaceholderText, queryByPlaceholderText } = renderPane({ ctrl });

    expect(getByPlaceholderText("agent_input_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_answering_placeholder")).toBeNull();
  });

  it("the mobile composer answers the same way (responsive dual-mode)", () => {
    seedLiveAsk();
    const { getByTestId, getByPlaceholderText, queryByPlaceholderText } = renderPane({ isMobile: true });

    expect(getByPlaceholderText("agent_input_answering_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_placeholder")).toBeNull();
    const card = (getByTestId("copilot-chat-input") as HTMLTextAreaElement).closest("div.rounded-xl");
    expect(card?.className).toContain("border-accent");
  });
});

// ─── AP-11: the staged delete renders the confirm (mockup §3 texts) ───────
// The hook owns WHICH delete awaits confirmation (`pendingDelete`); the
// pane renders the modal from it. The isolated i18n echoes keys, so the
// modal texts assert as keys (matching every other label query in this file).

describe("AgentChatPane — turn delete confirm (AP-11)", () => {
  it("no staged delete renders no confirm", () => {
    const { queryByTestId } = renderPane();

    expect(queryByTestId("turn-delete-confirm")).toBeNull();
  });

  it("user-row delete confirms with the §3 texts; confirm runs it", () => {
    const ctrl = makeCtrl({ pendingDelete: { messageId: "u1", includeUserMessage: true } });
    const { getByTestId } = renderPane({ ctrl });

    expect(getByTestId("turn-delete-title").textContent).toBe("copilot_turn_delete_title");
    expect(getByTestId("turn-delete-body").textContent).toBe("copilot_turn_delete_body");
    expect(getByTestId("turn-delete-confirm-btn").textContent).toBe("delete");
    fireEvent.click(getByTestId("turn-delete-confirm-btn"));
    expect(ctrl.confirmDeleteTurn).toHaveBeenCalledTimes(1);
    expect(ctrl.cancelDeleteTurn).not.toHaveBeenCalled();
  });

  it("assistant-row delete uses the assistant body; cancel aborts", () => {
    const ctrl = makeCtrl({ pendingDelete: { messageId: "a2", includeUserMessage: false } });
    const { getByTestId } = renderPane({ ctrl });

    expect(getByTestId("turn-delete-title").textContent).toBe("copilot_turn_delete_title");
    expect(getByTestId("turn-delete-body").textContent).toBe("copilot_turn_delete_assistant_body");
    fireEvent.click(getByTestId("turn-delete-cancel-btn"));
    expect(ctrl.cancelDeleteTurn).toHaveBeenCalledTimes(1);
    expect(ctrl.confirmDeleteTurn).not.toHaveBeenCalled();
  });

  it("the confirm renders on mobile too (responsive dual-mode — never a desktop-only gate)", () => {
    const ctrl = makeCtrl({ pendingDelete: { messageId: "u1", includeUserMessage: true } });
    const { getByTestId } = renderPane({ ctrl, isMobile: true });

    expect(getByTestId("turn-delete-confirm")).toBeDefined();
    expect(getByTestId("turn-delete-title").textContent).toBe("copilot_turn_delete_title");
  });
});

describe("AgentChatPane — error card wiring (AP-13)", () => {
  it("a live turn failure renders the loud card; its retry calls handleRegenerate", () => {
    const ctrl = makeCtrl({ turnFailure: { category: "timeout" } });
    const { getByTestId, getByText } = renderPane({ ctrl });

    // The isolated i18n has empty resources — t() echoes keys (the AP-11
    // confirm pattern above).
    expect(getByTestId("copilot-error-card").getAttribute("data-variant")).toBe("failed");
    expect(getByText("copilot_turn_error_title")).toBeDefined();
    expect(getByTestId("copilot-error-card-description").textContent).toBe(
      "provider_error_transient_desc",
    );
    fireEvent.click(getByTestId("copilot-error-card-retry"));
    expect(ctrl.handleRegenerate).toHaveBeenCalledTimes(1);
  });

  it("no live failure on an unanswered thread renders the quiet card; retry still regenerates", () => {
    const ctrl = makeCtrl();
    const { getByTestId, getByText, queryByTestId } = renderPane({ ctrl });

    // WAS (characterized before AP-13 existed): an unanswered thread
    // rendered NOTHING at the feed end. NOW: the quiet after-reload card.
    expect(getByTestId("copilot-error-card").getAttribute("data-variant")).toBe("unanswered");
    expect(getByText("copilot_turn_error_unanswered_title")).toBeDefined();
    expect(queryByTestId("copilot-error-card-description")).toBeNull();
    fireEvent.click(getByTestId("copilot-error-card-retry"));
    // Retry = regenerate (no new server surface), never a fresh send.
    expect(ctrl.handleRegenerate).toHaveBeenCalledTimes(1);
    expect(ctrl.handleSend).not.toHaveBeenCalled();
  });

  it("a settled thread (the assistant answered) renders no card", () => {
    const { queryByTestId } = renderPane({
      messages: [
        message({ id: "u1", role: "user", content: "plan it" }),
        message({ id: "a1", role: "assistant", content: "done" }),
      ],
    });

    expect(queryByTestId("copilot-error-card")).toBeNull();
  });

  it("the card renders on mobile too (mockup §3 is viewport-agnostic)", () => {
    const ctrl = makeCtrl({ turnFailure: { category: "server_error" } });
    const { getByTestId } = renderPane({ ctrl, isMobile: true });

    expect(getByTestId("copilot-error-card").getAttribute("data-variant")).toBe("failed");
  });
});

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
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentPendingReviewStore } from "../../../stores/agent-pending-review-store.js";
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
    pendingUserAttachments: [],
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
    // AP-29 follow-up 2: the regenerate flight flag the list reads (same rule).
    isRegenerating: false,
    // AP-29 follow-up 3: the recorded replaced-row ids the list reads (same rule).
    hiddenRegeneratedIds: null,
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
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
    ...over,
  };
}

function renderPane(over: {
  ctrl?: AgentController;
  messages?: ExperienceCopilotMessageWire[];
  isMobile?: boolean;
  copilotContext?: CopilotContextController;
  onStarterPick?: (text: string) => void;
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
        setSettingsModalOpen={() => {}}
        copilotContext={over.copilotContext ?? COPILOT_CONTEXT}
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
        onStarterPick={over.onStarterPick}
        refreshMessages={() => {}}
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
  useAgentPendingReviewStore.setState({ summariesByThread: {} });
});

// AP-16: the pane seeds the pending-review store in its strip tests — clear
// after the file so no entry leaks to later files sharing the worker.
afterAll(() => useAgentPendingReviewStore.setState({ summariesByThread: {} }));

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

describe("AgentChatPane — meter row moved into the header ring (AP-14)", () => {
  function meteredContext() {
    return {
      ...COPILOT_CONTEXT,
      metrics: {
        systemTokens: 2500,
        digestTokens: 1000,
        historyTokens: 500,
        attachedTokens: 0,
        totalTokens: 4000,
        budgetTokens: 10000,
        reserveTokens: 1000,
        source: "estimate" as const,
        measuredAt: "2026-08-15T00:00:00.000Z",
      },
    };
  }

  it("WAS: the meter lived as a permanent row below the header. NOW: the row is gone; the header holds the idle slot", () => {
    // Default COPILOT_CONTEXT carries metrics: null (before the first answer).
    const { queryByTestId, getByTestId } = renderPane();

    expect(queryByTestId("copilot-context-meter")).toBeNull();
    expect(getByTestId("copilot-context-ring-idle").textContent).toBe("copilot_context_no_metrics");
    expect(queryByTestId("copilot-context-ring")).toBeNull();
  });

  it("metered metrics render the ring between the switcher and the gear; the body mounts only on open", () => {
    const { getByTestId, queryByTestId } = renderPane({ copilotContext: meteredContext() });

    const ring = getByTestId("copilot-context-ring");
    expect(ring.textContent).toContain("40%");
    // The popover is closed — the meter body is NOT in the DOM (no permanent row).
    expect(queryByTestId("copilot-context-meter")).toBeNull();

    // Header slot order: switcher trigger < ring < gear.
    const header = getByTestId("copilot-profile-gear-btn").parentElement as HTMLElement;
    expect(header.contains(getByTestId("copilot-session-switcher-trigger"))).toBe(true);
    expect(header.contains(ring)).toBe(true);
    // Radix Root/Trigger render asChild (no wrapper DOM), so the switcher
    // trigger, the ring trigger, and the gear are DIRECT header children.
    const order = Array.from(header.children);
    expect(order.indexOf(getByTestId("copilot-session-switcher-trigger"))).toBeLessThan(
      order.indexOf(ring),
    );
    expect(order.indexOf(ring)).toBeLessThan(
      order.indexOf(getByTestId("copilot-profile-gear-btn")),
    );
  });

  it("the ring renders on mobile too (responsive dual-mode — never a desktop-only gate)", () => {
    const { getByTestId, queryByTestId } = renderPane({
      isMobile: true,
      copilotContext: meteredContext(),
    });

    expect(getByTestId("copilot-context-ring").textContent).toContain("40%");
    expect(queryByTestId("copilot-context-meter")).toBeNull();
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

// ─── AP-16: the pending-changes strip mounts above the composer ─────────
// Seeded through the REAL pending-review store (the AP-15 seam); the
// isolated i18n echoes keys, so chips assert as strip display keys (the
// same key-echo pattern as the AP-11 confirm above). The strip's own file
// pins the mapping, the actions, and the sidechat hide; here only the
// pane contract: mounts above the composer when THIS thread has an entry,
// absent otherwise, on both viewports.

describe("AgentChatPane — pending-changes strip (AP-16)", () => {
  function seedPending() {
    useAgentPendingReviewStore.getState().publish("experience", THREAD, {
      buffers: [
        { labelKey: "agent_rules", pending: 3 },
        { labelKey: "agent_visual", pending: 5 },
      ],
      acceptAll: mock(),
      open: mock(),
    });
  }

  it("absent with an empty store (nothing pending)", () => {
    const { queryByTestId } = renderPane();

    expect(queryByTestId("copilot-pending-changes-strip")).toBeNull();
  });

  it("mounts above the composer when the store has this thread's entry", () => {
    seedPending();
    const { getByTestId } = renderPane();

    const strip = getByTestId("copilot-pending-changes-strip");
    expect(getByTestId("copilot-pending-chip-agent_rules").textContent).toBe("agent_pending_rules · 3");
    expect(getByTestId("copilot-pending-chip-agent_visual").textContent).toBe("agent_pending_appearance · 5");
    // Above the composer: the strip precedes the input in document order.
    const input = getByTestId("copilot-chat-input");
    expect((strip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  it("the strip's actions reach the published callables through the pane", () => {
    const acceptAll = mock();
    const open = mock();
    useAgentPendingReviewStore.getState().publish("experience", THREAD, {
      buffers: [{ labelKey: "agent_rules", pending: 1 }],
      acceptAll,
      open,
    });
    const { getByTestId } = renderPane();

    fireEvent.click(getByTestId("copilot-pending-open"));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("copilot-pending-accept-all"));
    expect(acceptAll).toHaveBeenCalledTimes(1);
  });

  it("mounts on mobile too (mockup §1 is viewport-agnostic)", () => {
    seedPending();
    const { getByTestId } = renderPane({ isMobile: true });

    const strip = getByTestId("copilot-pending-changes-strip");
    expect(getByTestId("copilot-pending-chip-agent_rules")).toBeDefined();
    const input = getByTestId("copilot-chat-input");
    expect((strip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });
});

// ─── AP-18: starter prompts in the empty session ────────────────────────────
// A starter click hands the TRANSLATED text to `onStarterPick` (the shell
// turns it into a composer prefill — never sent) and focuses the composer so
// typing continues in the prefilled draft. Focus lives in the pane (it owns
// the composer DOM); the shell owns the prefill state.

describe("AgentChatPane — starter prompts (AP-18)", () => {
  it("clicking a starter calls onStarterPick with the text and focuses the composer (never sent)", () => {
    const seen: string[] = [];
    const utils = renderPane({ messages: [], onStarterPick: (text) => seen.push(text) });

    // The empty session shows the experience host's starters (isolated i18n
    // renders keys verbatim — order = the descriptor tuple).
    const starter = utils.getByTestId("agent-starter-1");
    expect(starter.textContent).toBe("agent_starter_experience_explain_rules");
    fireEvent.click(starter);

    expect(seen).toEqual(["agent_starter_experience_explain_rules"]);
    // Focus lands in the composer so typing continues in the prefilled draft.
    expect(document.activeElement?.getAttribute("data-testid")).toBe("copilot-chat-input");
    // Nothing was sent — the click only prefills.
    expect(utils.ctrl.handleSend).not.toHaveBeenCalled();
    expect(utils.ctrl.handleAnswer).not.toHaveBeenCalled();
  });

  it("no starters when the pane is not wired (the shell owns the prefill)", () => {
    const utils = renderPane({ messages: [] });

    expect(utils.queryByTestId("agent-starter-0")).toBeNull();
    // The empty title/subtitle still render (AS-8c3a, untouched).
    expect(utils.getByText("agent_title")).toBeDefined();
  });
});

// ─── AP-29 follow-up 3: the pane forwards the recorded hide set to the list ───
// WAS (216edbcda): the pane passed only the in-flight flag — after a
// successful settle the replaced turn flashed back until the refetch. NOW:
// the controller's `hiddenRegeneratedIds` rides the same seam, so the
// settle → refetch window hides exactly the recorded rows.
describe("AgentChatPane — regenerate hide-set wiring (AP-29 follow-up 3)", () => {
  it("forwards hiddenRegeneratedIds: the recorded rows stay hidden past the settle", () => {
    const ctrl = makeCtrl({ hiddenRegeneratedIds: ["a2"] });
    const { getByText, queryByText } = renderPane({
      ctrl,
      messages: [
        message({ id: "u1", role: "user", content: "first question" }),
        message({ id: "a1", role: "assistant", content: "first answer" }),
        message({ id: "u2", role: "user", content: "second question" }),
        message({ id: "a2", role: "assistant", content: "second answer" }),
      ],
    });

    expect(getByText("first answer")).toBeDefined();
    expect(getByText("second question")).toBeDefined();
    expect(queryByText("second answer")).toBeNull();
  });
});

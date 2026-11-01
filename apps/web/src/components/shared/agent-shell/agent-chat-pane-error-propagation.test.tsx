/**
 * AgentChatPane — LAG-5 companion pin: a NON-DOM render error thrown inside
 * the message list still PROPAGATES (AGENT_SHELL_RENDER_LAG_REPORT step 6
 * invariant — the boundary re-throws what it does not recognize as translate
 * corruption, so a real bug is never swallowed by the translate guard).
 *
 * OWN FILE by design: the throwing probe replaces AgentMessageBlock through
 * mock.module (process-global for the file), and a module-scope probe in the
 * recovery file distorted React's post-recovery reconciliation there — the
 * translate-recovery scenario must run against the REAL block (the R4/R15
 * mock-module hazard, observed live during LAG-5: with the probe registered
 * the recovered subtree stopped applying store writes; without it, clean).
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
// same trio as AgentChatPane.test.tsx: Radix Tooltip/Select/Dropdown content
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
  emptyText?: string;
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
  groups?: Array<{ id: string; label?: string; options: Array<{ id: string; label?: string; trailing?: ReactNode }> }>;
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

// The throwing probe: a load-time-copy mock (R15) around the REAL block,
// registered BEFORE the pane import so AgentMessageList resolves through it.
// The delegation renders the real memo object as an element (a React.memo
// result is not callable as a function); the flag flips only inside the one
// test below and is restored in afterAll.
const realAgentMessageBlock = { ...(await import("./AgentMessageBlock.js")) };
type RealBlockProps = React.ComponentProps<typeof realAgentMessageBlock.AgentMessageBlock>;
let throwInBlockRender: string | null = null;
mock.module("./AgentMessageBlock.js", () => ({
  ...realAgentMessageBlock,
  AgentMessageBlock: function AgentMessageBlockThrowingProbe(props: RealBlockProps) {
    if (throwInBlockRender !== null) throw new Error(throwInBlockRender);
    return <realAgentMessageBlock.AgentMessageBlock {...props} />;
  },
}));

let render: typeof import("@testing-library/react").render;
let AgentChatPane: typeof import("./AgentChatPane.js").AgentChatPane;
let getAgentHost: typeof import("../../../lib/agent-host-registry.js").getAgentHost;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  await import("../../build/editors/copilot/experience-agent-host.js");
  ({ getAgentHost } = await import("../../../lib/agent-host-registry.js"));
  ({ AgentChatPane } = await import("./AgentChatPane.js"));
});

afterAll(() => {
  throwInBlockRender = null;
});

const THREAD = "thread-1";

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim) — silences react-i18next's NO_I18NEXT_INSTANCE warning without
// touching the process-global i18n singleton (R13; the AgentChatPane test
// pattern).
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
    pendingUserContent: "",
    pendingUserAttachments: [],
    pendingAskAnswer: null,
    pendingPermissionAnswer: null,
    handleSend: mock(),
    handleAnswer: mock(),
    handleRegenerate: mock(),
    handleDeleteTurn: mock(),
    handleEditAssistant: mock(async () => false),
    handleEditLast: mock(),
    isRegenerating: false,
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

function paneElement(messages: ExperienceCopilotMessageWire[]): ReactElement {
  return (
    <I18nextProvider i18n={makeIsolatedI18n()}>
      <AgentChatPane
        kind="experience"
        isMobile={false}
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
        messages={messages}
        events={[]}
        handleActivate={async () => {}}
        handleNewSession={async () => {}}
        handleRenameSession={async () => {}}
        setSettingsModalOpen={() => {}}
        copilotContext={COPILOT_CONTEXT}
        ctrl={makeCtrl()}
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
        refreshMessages={() => {}}
      />
    </I18nextProvider>
  );
}

beforeEach(() => {
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
  useAgentPendingReviewStore.setState({ summariesByThread: {} });
});

afterAll(() => useAgentPendingReviewStore.setState({ summariesByThread: {} }));

describe("AgentChatPane — non-DOM errors propagate out of the list (LAG-5)", () => {
  it("a non-DOM error inside the list still propagates — the boundary re-throws what is not translate corruption", () => {
    const utils = render(paneElement([message({ id: "u1", role: "user", content: "plan it" })]));
    expect(utils.getByText("plan it")).toBeDefined();

    throwInBlockRender = "not a translate error";
    try {
      expect(() =>
        utils.rerender(
          paneElement([
            message({ id: "u1", role: "user", content: "plan it" }),
            message({ id: "u2", role: "user", content: "more" }),
          ]),
        ),
      ).toThrow("not a translate error");
    } finally {
      throwInBlockRender = null;
    }
  });
});

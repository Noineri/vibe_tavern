/**
 * AgentChatPane — translate-safe agent feed (LAG-5, step 6 of
 * AGENT_SHELL_RENDER_LAG_REPORT, owner-reported 2026-10-30): Chrome's page
 * translation wraps text nodes in <font> elements, and the LAG-4 prefix+tail
 * completion REMOVES the completed block's DOM from the tail — React's
 * removeChild then throws NotFoundError and (pre-LAG-5) the whole page died
 * in RootErrorBoundary. The pane wraps ONLY the message list in the existing
 * TranslateErrorBoundary (the MessageScroller precedent — the one boundary
 * class, reused): a recovery remounts the list alone, so the composer's
 * local draft, the header and the open session — pane children outside the
 * boundary — survive it. The live stream survives by construction: LAG-3
 * keeps the live text in agent-live-stream-store, so the remounted list
 * re-renders the current live text and keeps streaming.
 *
 * Runs the REAL markdown pipeline (no agent-message-markdown-seam): the
 * scenario corrupts the real prefix+tail DOM — the seam's stub renderer has
 * no prefix+tail shape to corrupt, and it would make the red case green.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentLiveStreamStore } from "../../../stores/agent-live-stream-store.js";
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

// LAG-5 invariant: a NON-DOM error thrown inside the list must still
// PROPAGATE (the boundary re-throws what it does not recognize as translate
// corruption). A thin throwing wrapper around the REAL block, registered
// BEFORE the pane import so AgentMessageList resolves through it — the R15
// load-time-copy shape (the namespace is captured at load, the component
// BEFORE registration, so the delegation can never re-enter the mock).
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;
let AgentChatPane: typeof import("./AgentChatPane.js").AgentChatPane;
let getAgentHost: typeof import("../../../lib/agent-host-registry.js").getAgentHost;

beforeAll(async () => {
  ({ render, fireEvent, act } = await import("@testing-library/react"));
  // The real experience host registers kind "experience" (same side-effect
  // pattern as the pane/list suites).
  await import("../../build/editors/copilot/experience-agent-host.js");
  ({ getAgentHost } = await import("../../../lib/agent-host-registry.js"));
  ({ AgentChatPane } = await import("./AgentChatPane.js"));
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

const USER_MESSAGE = message({ id: "u1", role: "user", content: "plan it" });

/** The pane element factory — every render AND rerender goes through this
 *  one derivation so the settle rerender changes exactly the props the
 *  controller would change at a real settle (messages, isSending). */
function paneElement(over: {
  ctrl?: AgentController;
  messages?: ExperienceCopilotMessageWire[];
} = {}): ReactElement {
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
        messages={over.messages ?? [USER_MESSAGE]}
        events={[]}
        handleActivate={async () => {}}
        handleNewSession={async () => {}}
        handleRenameSession={async () => {}}
        setSettingsModalOpen={() => {}}
        copilotContext={COPILOT_CONTEXT}
        ctrl={over.ctrl ?? makeCtrl({ isSending: true })}
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

/** One LAG-2 frame flush: the delta lands in the feed entry AND the live
 *  pair — the same-frame two-store write the controller performs (the
 *  stores never disagree). */
function flush(delta: string): void {
  useAgentTurnStore.getState().appendTextDelta("experience", THREAD, delta);
  useAgentLiveStreamStore.getState().appendLiveDeltas("experience", THREAD, { text: delta });
}

/** Chrome-translate emulation at one text node: the parent's child list
 *  swaps the text node for a <font> wrapper while the text itself moves
 *  inside it — exactly `parentNode.replaceChild`, the report's step-6
 *  recipe. */
function wrapInTranslateFont(node: Text): void {
  const parent = node.parentNode;
  if (parent === null) throw new Error("the targeted tail text node is detached");
  const font = document.createElement("font");
  parent.replaceChild(font, node);
  font.appendChild(node);
}

/** The streaming bubble's markdown container whose text matches `text` —
 *  the persisted user bubble above renders through the same Markdown, so
 *  the text itself disambiguates. */
function findStreamingContent(container: HTMLElement, text: string): HTMLElement {
  const match = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="copilot-message-list"] .md-content'),
  ).find((el) => el.textContent === text);
  if (match === undefined) throw new Error(`no streaming .md-content with text ${JSON.stringify(text)}`);
  return match;
}

/** A markdown paragraph whose exact text is `text` — the settled single-
 *  Markdown render splits inline runs across elements, so this matches the
 *  p's textContent (getByText's default matcher skips elements whose text is
 *  broken up by nested elements). */
function findParagraph(container: HTMLElement, text: string): HTMLElement {
  const match = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="copilot-message-list"] p'),
  ).find((el) => el.textContent === text);
  if (match === undefined) throw new Error(`no paragraph with text ${JSON.stringify(text)}`);
  return match;
}

beforeEach(() => {
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
  useAgentLiveStreamStore.setState({ liveByThread: {} });
});

describe("AgentChatPane — translate-safe agent feed (LAG-5)", () => {
  it("a translate-corrupted streaming completion recovers inside the list — composer draft, stream and settle survive", async () => {
    const utils = render(paneElement());

    // Stream the first paragraph in — the open feed entry renders through
    // AgentStreamingMarkdown: empty prefix, tail .md-content > p > inline
    // runs. The paragraph ends with a TEXT run after an inline-code element
    // — p's children are [text, code, text], the shape the completion
    // below reconciles by DELETING the trailing text fiber from the reused
    // p (a single-text paragraph would update in place and never throw).
    act(() => {
      flush("The first paragraph arrives with `inline code` inside.");
    });
    const tail = findStreamingContent(utils.container, "The first paragraph arrives with inline code inside.");
    const paragraph = tail.querySelector("p");
    expect(paragraph).not.toBeNull();
    const textNode = paragraph!.lastChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(textNode?.textContent).toBe(" inside.");

    // Chrome translation wraps the tail's text node in a <font>.
    wrapInTranslateFont(textNode as Text);
    expect((textNode as Text).parentNode).not.toBe(paragraph);

    // The composer holds a local draft — it must survive the recovery
    // untouched (a pane-level remount would lose it).
    fireEvent.change(utils.getByTestId("copilot-chat-input"), { target: { value: "draft that must survive" } });
    expect((utils.getByTestId("copilot-chat-input") as HTMLTextAreaElement).value).toBe("draft that must survive");

    // Stream until the block completes — the completed paragraph moves to
    // the prefix while the SAME p is reused for the next paragraph: p's
    // children shrink [text, code, text] → [text], so React removeChild's
    // the wrapped trailing text fiber — pre-LAG-5 that NotFoundError
    // escaped the list to RootErrorBoundary (the owner's 2026-10-30 crash).
    act(() => {
      flush("\n\nThe second paragraph starts.");
    });

    // The boundary recovered via its rAF remount — drive that frame inside
    // act so the recovery lands before the assertions.
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    // The list shows the completed paragraph again — re-created from the
    // virtual DOM (the corrupted <font> DOM is gone with the old subtree).
    expect(
      findStreamingContent(utils.container, "The first paragraph arrives with inline code inside."),
    ).toBeDefined();

    // The stream continues: the recovered tail keeps streaming (the live
    // text re-rendered from agent-live-stream-store after the remount) —
    // the flush below APPENDS to the tail's open block, exactly as a frame
    // flush would.
    act(() => {
      flush(" streaming more words.");
    });
    expect(utils.getByText("The second paragraph starts. streaming more words.")).toBeDefined();

    // The pane never remounted: the composer draft survived everything.
    expect((utils.getByTestId("copilot-chat-input") as HTMLTextAreaElement).value).toBe("draft that must survive");

    // Settle exactly as the controller does: the segment closes, the live
    // pair clears, the refetched history lands (single-Markdown path — the
    // settled render is unchanged by LAG-5).
    act(() => {
      useAgentTurnStore.getState().closeTextSegment("experience", THREAD);
      useAgentLiveStreamStore.getState().clearLiveStreamText("experience", THREAD);
    });
    utils.rerender(
      paneElement({
        ctrl: makeCtrl({ isSending: false }),
        messages: [
          USER_MESSAGE,
          message({
            id: "a1",
            role: "assistant",
            content: "The first paragraph arrives with `inline code` inside.\n\nThe second paragraph starts. streaming more words.",
          }),
        ],
      }),
    );
    expect(findParagraph(utils.container, "The first paragraph arrives with inline code inside.")).toBeDefined();
    expect(findParagraph(utils.container, "The second paragraph starts. streaming more words.")).toBeDefined();
    expect((utils.getByTestId("copilot-chat-input") as HTMLTextAreaElement).value).toBe("draft that must survive");
  });
});

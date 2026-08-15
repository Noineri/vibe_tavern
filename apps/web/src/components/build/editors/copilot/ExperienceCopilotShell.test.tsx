import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";
import { useBootstrapStore } from "../../../../stores/api-actions/bootstrap-actions.js";
import type { ProviderProfileRecord } from "../../../../api/types.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = false;

// ── SAFE mock.module stubs (capture real first, spread `...real`) ──────────
const getExperienceCopilotActive = mock(
  async (_scriptId: string): Promise<ExperienceCopilotThreadWire | null> => null,
);
const listExperienceCopilotMessages = mock(
  async (_threadId: string): Promise<ExperienceCopilotMessageWire[]> => [],
);
const startExperienceCopilotSession = mock(
  async (_scriptId: string): Promise<ExperienceCopilotThreadWire> => thread("thread-new"),
);
const listExperienceCopilotSessions = mock(
  async (_scriptId: string): Promise<ExperienceCopilotThreadWire[]> => [],
);
const activateExperienceCopilotSession = mock(
  async (_threadId: string): Promise<ExperienceCopilotThreadWire | null> => null,
);
const streamExperienceCopilot = mock(
  async (_threadId: string, _body: unknown, _opts: unknown): Promise<{ finishReason: string }> => ({
    finishReason: "stop",
  }),
);
const getExperienceCopilotContext = mock(
  async (_threadId: string): Promise<{ metrics: null; autoCompact: boolean }> => ({ metrics: null, autoCompact: true }),
);
const patchExperienceCopilotContext = mock(
  async (_threadId: string, _body: { autoCompact: boolean }): Promise<{ metrics: null; autoCompact: boolean }> => ({
    metrics: null,
    autoCompact: _body.autoCompact,
  }),
);
const compactExperienceCopilot = mock(
  async (_threadId: string): Promise<{ digest: ExperienceCopilotMessageWire; metrics: null }> => ({
    digest: {
      id: "digest-1",
      threadId: _threadId,
      role: "digest",
      content: "summary",
      toolCallsJson: null,
      toolCallId: "u1",
      createdAt: "",
    },
    metrics: null,
  }),
);

const realApi = await import("../../../../api/experience-copilot-api.js");
mock.module("../../../../api/experience-copilot-api.js", () => ({
  ...realApi,
  getExperienceCopilotActive,
  listExperienceCopilotMessages,
  startExperienceCopilotSession,
  listExperienceCopilotSessions,
  activateExperienceCopilotSession,
  streamExperienceCopilot,
  getExperienceCopilotContext,
  patchExperienceCopilotContext,
  compactExperienceCopilot,
}));

// Markdown is heavy and its internals are pinned elsewhere; the shell test
// cares only that message text reaches the list.
const realMarkdown = await import("../../../../lib/markdown.js");
mock.module("../../../../lib/markdown.js", () => ({
  ...realMarkdown,
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
const realTooltip = await import("../../../shared/Tooltip.js");
mock.module("../../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The shared Toggle wraps Radix Switch (no happy-dom anchor); the shell test
// renders the REAL meter (so its compact button is clickable) — stub the switch
// to a plain button (Toggle's own behaviour is pinned in Toggle.test.tsx).
const realToggle = await import("../../../shared/Toggle.js");
mock.module("../../../shared/Toggle.js", () => ({
  ...realToggle,
  Toggle: ({
    checked,
    onChange,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid="copilot-context-autocompact-toggle"
      data-checked={checked ? "true" : "false"}
      onClick={() => onChange(!checked)}
    />
  ),
}));

// Radix Select.Content / BottomSheet (vaul) do not mount under happy-dom, and
// this test does not drive provider/model selection — render the trigger only.
function FakeToolbarSelect(props: { trigger: ReactElement }) {
  return <>{props.trigger}</>;
}
const realToolbarSelect = await import("../../../shared/ToolbarSelect.js");
mock.module("../../../shared/ToolbarSelect.js", () => ({
  ...realToolbarSelect,
  ToolbarSelect: FakeToolbarSelect,
}));

// The InteractiveTester (inside the tester modal) drives runExperienceTest;
// the ExperiencePlayground (inside the sandbox modal) drives
// startExperiencePlayground. Both are mocked at the client-function boundary
// so the ER-14 send-to-copilot flow is observable through the REAL shell →
// child → callback → controller → stream wiring. (SAFE: capture real first,
// spread `...real` so every other export stays available.)
const realExperienceApi = await import("../../../../api/experience-api.js");
const runExperienceTest = mock((_body: Record<string, unknown>) =>
  Promise.resolve({
    definition: {
      apiVersion: 1,
      manifest: { id: "round", name: "Round" },
      declaredCapabilities: [{ capability: "participants", reason: "x" }],
      hasChoose: false,
      hasFlavor: false,
    },
    sourceHash: "h",
    initialState: {},
    finalState: {},
    revision: 0,
    status: "active",
    projection: { state: { round: 1 }, actions: [{ type: "score", label: "Score" }] },
    events: [],
    effects: [],
    console: [],
    steps: [],
  } as Awaited<ReturnType<typeof realExperienceApi.runExperienceTest>>),
);
const startExperiencePlayground = mock((_body: Record<string, unknown>) =>
  Promise.resolve({
    playgroundSessionId: "pg-shell-1",
    initialState: {},
    state: { round: 1 },
    projection: { state: { round: 1 }, actions: [{ type: "score", label: "Score" }] },
    events: [],
    effects: [],
    console: [],
    revision: 0,
    status: "active",
    stopReason: "awaiting_human",
  } as Awaited<ReturnType<typeof realExperienceApi.startExperiencePlayground>>),
);
mock.module("../../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  runExperienceTest,
  startExperiencePlayground,
}));

// The shell reads `useIsMobile` (matchMedia). Mock it to a controllable flag.
const realMobile = await import("../../../../hooks/use-mobile.js");
mock.module("../../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

// The copilot profile modal (opened by the session-line gear) is tested in its
// own suite — stub it here so the gear test only pins the gear → modal wiring
// (click sets profileModalOpen → the modal mounts). SAFE: capture real first.
const realCopilotProfileModal = await import("./CopilotProfileModal.js");
mock.module("./CopilotProfileModal.js", () => ({
  ...realCopilotProfileModal,
  CopilotProfileModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="copilot-profile-modal-stub" /> : null),
}));

// Radix Popover.Content never mounts under happy-dom (Popper anchors via a 0x0
// getBoundingClientRect — see LinkBindingPopover.test.tsx). Render it inline so
// the ExperienceSessionSwitcher's session list is clickable here.
mock.module("@radix-ui/react-popover", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Anchor: () => null,
}));

// ExperienceFrame renders a sandboxed iframe served from a blob URL; its
// DOM/CSP/URL lifecycle is pinned in ExperienceFrame.test.tsx. The shell test
// only needs to assert the shell mounts the frame in the preview modal, so
// replace the component with a marker stub (SAFE: capture real first, spread).
const realFrame = await import("../../../experience/ExperienceFrame.js");
mock.module("../../../experience/ExperienceFrame.js", () => ({
  ...realFrame,
  ExperienceFrame: () => <div data-testid="experience-frame-stub" />,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;
let ExperienceCopilotShell: typeof import("./ExperienceCopilotShell.js").ExperienceCopilotShell;
let EditorView: typeof import("@codemirror/view").EditorView;
let EditorState: typeof import("@codemirror/state").EditorState;

beforeAll(async () => {
  ({ render, fireEvent, waitFor, act } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ EditorState } = await import("@codemirror/state"));
  ({ ExperienceCopilotShell } = await import("./ExperienceCopilotShell.js"));
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function thread(id: string): ExperienceCopilotThreadWire {
  return {
    id,
    scriptId: "script-1",
    draftSessionId: null,
    title: "Copilot",
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    metrics: null,
  };
}

function msg(over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
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

// Two profiles; p1 carries one tool-capable cached model so the REAL
// `useProviderModels` hook serves the model list from cache (no fetch).
const PROFILES = [
  {
    id: "p1",
    name: "OpenAI Pro",
    cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }] },
  },
  {
    id: "p2",
    name: "Anthropic",
    cachedModels: { models: [{ id: "m2", label: "Model Two", contextLength: 200000, capabilities: { tools: true } }] },
  },
] as unknown as ProviderProfileRecord[];

function hasHiddenClass(el: HTMLElement): boolean {
  return el.className.split(/\s+/).includes("hidden");
}

beforeEach(() => {
  mobileOverride = false;
  useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
  useProviderDataStore.setState({ profiles: PROFILES });
  // Reset the persisted copilot binding between tests (the shell restores it).
  const current = useBootstrapStore.getState().data;
  if (current) {
    useBootstrapStore.setState({ data: { ...current, uiSettings: { ...current.uiSettings, copilotProviderId: null, copilotModelName: null } } });
  }
  getExperienceCopilotActive.mockReset();
  getExperienceCopilotActive.mockResolvedValue(null);
  listExperienceCopilotMessages.mockReset();
  listExperienceCopilotMessages.mockResolvedValue([]);
  startExperienceCopilotSession.mockReset();
  startExperienceCopilotSession.mockResolvedValue(thread("thread-new"));
  listExperienceCopilotSessions.mockReset();
  listExperienceCopilotSessions.mockResolvedValue([]);
  activateExperienceCopilotSession.mockReset();
  activateExperienceCopilotSession.mockResolvedValue(null);
  streamExperienceCopilot.mockReset();
  streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
  getExperienceCopilotContext.mockReset();
  getExperienceCopilotContext.mockResolvedValue({ metrics: null, autoCompact: true });
  patchExperienceCopilotContext.mockReset();
  patchExperienceCopilotContext.mockImplementation(async (_t, body) => ({ metrics: null, autoCompact: body.autoCompact }));
  compactExperienceCopilot.mockReset();
  compactExperienceCopilot.mockImplementation(async (t) => ({
    digest: {
      id: "digest-1",
      threadId: t,
      role: "digest",
      content: "summary",
      toolCallsJson: null,
      toolCallId: "u1",
      createdAt: "",
    },
    metrics: null,
  }));
  runExperienceTest.mockClear();
  startExperiencePlayground.mockClear();
});

function renderShell(over: Partial<Parameters<typeof ExperienceCopilotShell>[0]> = {}) {
  const props = {
    scriptId: "script-1",
    rulesCode: "// rules buffer",
    visualSource: "// visual buffer",
    onRulesChange: mock(),
    onVisualChange: mock(),
    ...over,
  };
  const utils = render(<ExperienceCopilotShell {...props} />);
  return { ...utils, props };
}

/**
 * Drain the chained async `loadSession` microtasks (and React's scheduler
 * macrotasks) inside `act`, so its `setThreadId`/`setMessages`/`setSessionLoading`
 * updates are captured and do not emit React 19 "not wrapped in act" warnings.
 * Mirrors the bounded drain in `test/dom-env.ts`.
 */
async function flushSessionLoad() {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe("ExperienceCopilotShell — session lifecycle", () => {
  it("loads an ACTIVE session and renders its messages", async () => {
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));
    listExperienceCopilotMessages.mockResolvedValue([
      msg({ id: "u1", role: "user", content: "Make it scarier" }),
      msg({ id: "a1", role: "assistant", content: "Here are the rules" }),
    ]);

    const { getByText, getByTestId } = renderShell();

    await flushSessionLoad();

    expect(getByText("Make it scarier")).toBeDefined();
    expect(getByText("Here are the rules")).toBeDefined();
    expect(getExperienceCopilotActive).toHaveBeenCalledWith("script-1");
    expect(listExperienceCopilotMessages).toHaveBeenCalledWith("thread-1");
    // threadId is set → the chat input area is mounted (only rendered past the
    // loading/error/threadId branch).
    expect(getByTestId("copilot-send-btn")).toBeDefined();
  });

  it("starts a NEW session when none is active", async () => {
    const { getByText } = renderShell();

    await flushSessionLoad();

    // MessageList's empty state (thread exists but no messages/activities).
    expect(getByText("experience_copilot_subtitle")).toBeDefined();
    expect(getExperienceCopilotActive).toHaveBeenCalledWith("script-1");
    expect(startExperienceCopilotSession).toHaveBeenCalledWith("script-1");
    expect(listExperienceCopilotMessages).not.toHaveBeenCalled();
  });
});

describe("ExperienceCopilotShell — context meter + compact flow (CM-7/CM-8)", () => {
  it("mounts the meter once a thread is loaded and compacts on click (POST → refetch)", async () => {
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));
    listExperienceCopilotMessages.mockResolvedValue([
      msg({ id: "u1", role: "user", content: "Make it scarier" }),
    ]);

    const { getByTestId } = renderShell();
    await flushSessionLoad();

    expect(getByTestId("copilot-context-meter")).toBeDefined();
    const callsBefore = listExperienceCopilotMessages.mock.calls.length;

    fireEvent.click(getByTestId("copilot-context-compact-btn"));
    await flushSessionLoad();

    // The compact call forwards the shell's current provider/model selection
    // (restored binding p1/m1 from the persisted uiSettings in this test).
    expect(compactExperienceCopilot).toHaveBeenCalledWith("thread-1", { providerProfileId: "p1", model: "m1" });
    // onCompacted → handleTurnSettled → refetch messages so the digest card appears.
    expect(listExperienceCopilotMessages.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe("ExperienceCopilotShell — session switcher (ER-12b)", () => {
  it("wires the switcher with the fetched sessions + active thread", async () => {
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));
    listExperienceCopilotSessions.mockResolvedValue([
      { ...thread("thread-1"), title: "Active" },
      { ...thread("thread-2"), title: "Older", archivedAt: "2026-08-10T00:00:00Z" },
    ]);

    const { getByTestId } = renderShell();
    await flushSessionLoad();

    const trigger = getByTestId("copilot-session-switcher-trigger");
    expect(trigger).toBeDefined();
    // Idle (not sending) → the switcher is NOT disabled.
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(getByTestId("copilot-session-thread-1").getAttribute("data-active")).toBe("true");
    expect(getByTestId("copilot-session-thread-2").getAttribute("data-active")).toBe("false");
  });

  it("switch happy path: activating an archived session rehydrates messages + refetches sessions", async () => {
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));
    listExperienceCopilotSessions.mockResolvedValue([
      { ...thread("thread-1"), title: "Active" },
      { ...thread("thread-2"), title: "Older", archivedAt: "2026-08-10T00:00:00Z" },
    ]);
    listExperienceCopilotMessages.mockImplementation(async (threadId: string) => {
      if (threadId === "thread-1") {
        return [msg({ id: "m-active", content: "active message", threadId })];
      }
      return [msg({ id: "m-archived", content: "archived message", threadId })];
    });
    activateExperienceCopilotSession.mockResolvedValue({ ...thread("thread-2"), archivedAt: null });

    const { getByTestId, getByText } = renderShell();
    await flushSessionLoad();

    expect(getByText("active message")).toBeDefined();

    fireEvent.click(getByTestId("copilot-session-thread-2"));
    await flushSessionLoad();

    expect(activateExperienceCopilotSession).toHaveBeenCalledWith("thread-2");
    expect(listExperienceCopilotMessages).toHaveBeenCalledWith("thread-2");
    expect(getByText("archived message")).toBeDefined();
    // Fetched once on mount, refetched once after the switch.
    expect(listExperienceCopilotSessions).toHaveBeenCalledTimes(2);
  });

  it("new-session path: archives the current and resets messages", async () => {
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));
    listExperienceCopilotSessions.mockResolvedValue([thread("thread-1")]);
    listExperienceCopilotMessages.mockResolvedValue([msg({ content: "old message", threadId: "thread-1" })]);
    startExperienceCopilotSession.mockResolvedValue(thread("thread-new"));

    const { getByTestId } = renderShell();
    await flushSessionLoad();

    fireEvent.click(getByTestId("copilot-session-new"));
    await flushSessionLoad();

    expect(startExperienceCopilotSession).toHaveBeenCalledWith("script-1");
    // Messages are cleared (no thread rehydration for a brand-new thread).
    expect(listExperienceCopilotMessages).toHaveBeenCalledTimes(1); // only the initial mount fetch
    expect(listExperienceCopilotSessions).toHaveBeenCalledTimes(2); // mount + refetch
  });
});

describe("ExperienceCopilotShell — editor sub-tab binding", () => {
  it("switches the CodeEditor between the Rules and Visual buffers", async () => {
    const onRulesChange = mock();
    const onVisualChange = mock();
    const { container, getByRole } = renderShell({ onRulesChange, onVisualChange });

    // Drain the async `loadSession` so its state updates are captured in act
    // (the editor pane renders regardless of session state).
    await flushSessionLoad();

    const cmEl = container.querySelector<HTMLElement>(".cm-editor");
    expect(cmEl).not.toBeNull();
    const view = EditorView.findFromDOM(cmEl!);
    expect(view).not.toBeNull();
    expect(view!.state.doc.toString()).toBe("// rules buffer");

    // Switch to the Visual buffer.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    // CodeEditor syncs the external value without clobbering the editor.
    expect(view!.state.doc.toString()).toBe("// visual buffer");

    // Editing now routes to onVisualChange (not onRulesChange).
    act(() => {
      view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: "// visual edited" } });
    });

    expect(onVisualChange).toHaveBeenCalledWith("// visual edited");
    expect(onRulesChange).not.toHaveBeenCalled();
  });
});

describe("ExperienceCopilotShell — toolbar buttons + modals (ER-13b′)", () => {
  // Identity i18n (no LocaleProvider mounted): `useT` falls back to the
  // key-as-string default, so the component markers render their i18n keys
  // verbatim — matching the InteractiveTester/ExperienceEditor test pattern.
  it("renders the three toolbar buttons in the editor pane", async () => {
    const { getByTestId } = renderShell();
    await flushSessionLoad();

    expect(getByTestId("copilot-toolbar-tester")).toBeDefined();
    expect(getByTestId("copilot-toolbar-preview")).toBeDefined();
    expect(getByTestId("copilot-toolbar-sandbox")).toBeDefined();
  });

  it("opens the Tester modal containing InteractiveTester", async () => {
    const { getByTestId, getByText } = renderShell();
    await flushSessionLoad();

    fireEvent.click(getByTestId("copilot-toolbar-tester"));

    expect(getByTestId("copilot-tester-modal")).toBeDefined();
    // InteractiveTester renders its content directly (collapsible removed — ER-13 review fix C).
    expect(getByTestId("interactive-tester")).toBeDefined();
  });

  it("opens the Preview modal containing ExperienceFrame", async () => {
    const { getByTestId } = renderShell();
    await flushSessionLoad();

    fireEvent.click(getByTestId("copilot-toolbar-preview"));

    expect(getByTestId("copilot-preview-modal")).toBeDefined();
    expect(getByTestId("experience-frame-stub")).toBeDefined();
  });

  it("opens the Sandbox modal containing ExperiencePlayground", async () => {
    const { getByTestId } = renderShell();
    await flushSessionLoad();

    fireEvent.click(getByTestId("copilot-toolbar-sandbox"));

    expect(getByTestId("copilot-sandbox-modal")).toBeDefined();
    // The shared playground element mounts inside the modal.
    expect(getByTestId("experience-playground")).toBeDefined();
  });
});

describe("ExperienceCopilotShell — copilot profile gear (CP-8)", () => {
  it("opens the profile modal from the session-line gear button", async () => {
    const { getByTestId, queryByTestId } = renderShell();
    await flushSessionLoad();

    // The gear lives on the session line (rendered once a thread exists).
    expect(getByTestId("copilot-profile-gear-btn")).toBeDefined();
    expect(queryByTestId("copilot-profile-modal-stub")).toBeNull();

    fireEvent.click(getByTestId("copilot-profile-gear-btn"));

    expect(getByTestId("copilot-profile-modal-stub")).toBeDefined();
  });
});

describe("ExperienceCopilotShell — mobile tabs", () => {
  it("keeps both panes mounted and toggles visibility on a 2-tab switch", async () => {
    mobileOverride = true;
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));

    const { getByTestId, getByRole, queryByTestId, queryByRole } = renderShell();

    // Wait for session load so the chat pane reaches its thread branch.
    await flushSessionLoad();

    // 2-tab bar + both panes are mounted; the Test tab/pane is gone.
    expect(getByRole("tablist")).toBeDefined();
    expect(queryByRole("tab", { name: "Test" })).toBeNull();
    const chatPane = getByTestId("copilot-pane-chat");
    const editPane = getByTestId("copilot-pane-edit");
    expect(chatPane).toBeDefined();
    expect(editPane).toBeDefined();
    expect(queryByTestId("copilot-pane-test")).toBeNull();

    // Default active tab is chat.
    expect(hasHiddenClass(chatPane)).toBe(false);
    expect(hasHiddenClass(editPane)).toBe(true);

    fireEvent.click(getByRole("tab", { name: "experience_copilot_tab_edit" }));
    expect(hasHiddenClass(chatPane)).toBe(true);
    expect(hasHiddenClass(editPane)).toBe(false);

    // The three toolbar buttons live in the Edit pane toolbar (same as desktop).
    expect(getByTestId("copilot-toolbar-tester")).toBeDefined();
    expect(getByTestId("copilot-toolbar-preview")).toBeDefined();
    expect(getByTestId("copilot-toolbar-sandbox")).toBeDefined();
  });
});

describe("ExperienceCopilotShell — contextual toolbar slots (ER-13c)", () => {
  it("renders rulesToolbar in the Rules buffer and hides it in the Visual buffer", async () => {
    const { getByTestId, queryByTestId, getByRole } = renderShell({
      rulesToolbar: <div data-testid="rules-toolbar-slot">rules toolbar</div>,
    });
    await flushSessionLoad();

    // Default editorBuffer is rules → the rules slot is rendered.
    expect(getByTestId("rules-toolbar-slot")).toBeDefined();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    expect(queryByTestId("rules-toolbar-slot")).toBeNull();
  });

  it("renders visualToolbar in the Visual buffer and hides it in the Rules buffer", async () => {
    const { getByTestId, queryByTestId, getByRole } = renderShell({
      visualToolbar: <div data-testid="visual-toolbar-slot">visual toolbar</div>,
    });
    await flushSessionLoad();

    // Default editorBuffer is rules → the visual slot is absent.
    expect(queryByTestId("visual-toolbar-slot")).toBeNull();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    expect(getByTestId("visual-toolbar-slot")).toBeDefined();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_rules" }));
    expect(queryByTestId("visual-toolbar-slot")).toBeNull();
  });
});

describe("ExperienceCopilotShell — creation mode (ER-13d-1)", () => {
  it("renders a 3-position toggle (rules/visual/sandbox)", async () => {
    const { getByRole } = renderShell({ creationMode: true });
    await flushSessionLoad();

    // Identity i18n: the creation labels resolve through `t` (key-as-string
    // fallback without a LocaleProvider), unlike the non-creation inline labels.
    expect(getByRole("radio", { name: "experience_copilot_rules" })).toBeDefined();
    expect(getByRole("radio", { name: "experience_copilot_visual" })).toBeDefined();
    expect(getByRole("radio", { name: "experience_copilot_sandbox" })).toBeDefined();
  });

  it("sandbox position renders the playground inline and hides the code editor + toolbar buttons", async () => {
    const { container, getByRole, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_sandbox" }));

    // The shared playground element mounts INLINE.
    expect(queryByTestId("experience-playground")).toBeTruthy();
    // The CodeEditor is absent on the sandbox position.
    expect(container.querySelector(".cm-editor")).toBeNull();
    // Toggle only — the tester/preview/sandbox toolbar buttons are hidden.
    expect(queryByTestId("copilot-toolbar-tester")).toBeNull();
    expect(queryByTestId("copilot-toolbar-preview")).toBeNull();
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
  });

  it("does not render the sandbox modal in creation mode", async () => {
    const { getByRole, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_sandbox" }));
    expect(queryByTestId("copilot-sandbox-modal")).toBeNull();
  });

  it("rules position: rules toolbar + code editor + tester/preview present, sandbox button hidden", async () => {
    const { container, getByTestId, queryByTestId } = renderShell({
      creationMode: true,
      rulesToolbar: <div data-testid="rules-toolbar-slot">rules toolbar</div>,
    });
    await flushSessionLoad();

    expect(getByTestId("rules-toolbar-slot")).toBeDefined();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(getByTestId("copilot-toolbar-tester")).toBeDefined();
    expect(getByTestId("copilot-toolbar-preview")).toBeDefined();
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
  });

  it("visual position: visual toolbar + code editor + tester/preview present, sandbox button hidden", async () => {
    const { container, getByRole, getByTestId, queryByTestId } = renderShell({
      creationMode: true,
      visualToolbar: <div data-testid="visual-toolbar-slot">visual toolbar</div>,
    });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    expect(getByTestId("visual-toolbar-slot")).toBeDefined();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(getByTestId("copilot-toolbar-tester")).toBeDefined();
    expect(getByTestId("copilot-toolbar-preview")).toBeDefined();
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
  });

  it("tester + preview toolbar buttons still open their modals", async () => {
    const { getByTestId, getByText } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByTestId("copilot-toolbar-tester"));
    expect(getByTestId("copilot-tester-modal")).toBeDefined();
    expect(getByTestId("interactive-tester")).toBeDefined();

    fireEvent.click(getByTestId("copilot-toolbar-preview"));
    expect(getByTestId("copilot-preview-modal")).toBeDefined();
    expect(getByTestId("experience-frame-stub")).toBeDefined();
  });
});

describe("ExperienceCopilotShell — provider binding persistence", () => {
  /** Seed the persisted uiSettings copilot binding. The bootstrap store starts
   * empty in tests (no bootstrap fetch), so synthesize a minimal data record
   * when needed — the shell only reads `data.uiSettings` from it. */
  function seedBinding(providerId: string | null, modelName: string | null): void {
    const current = useBootstrapStore.getState().data;
    const base = current ?? {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: {
        id: "default",
        theme: "coffee",
        chatFontSize: 15,
        uiFontSize: 14,
        messageWidth: 700,
        language: "en",
        activePromptPresetId: null,
        aiAssistantProviderId: null,
        aiAssistantModelName: null,
        coauthorProviderId: null,
        coauthorModelName: null,
        copilotProviderId: null,
        copilotModelName: null,
        updatedAt: "",
      },
      isArmServer: false,
    };
    useBootstrapStore.setState({
      data: {
        ...base,
        uiSettings: { ...base.uiSettings, copilotProviderId: providerId, copilotModelName: modelName },
      },
    });
  }

  /** Send a message through the REAL controller path and return the stream body. */
  async function sendAndCaptureBody(container: HTMLElement, text: string): Promise<Record<string, unknown>> {
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(getBySendBtn());
    await waitFor(() => expect(streamExperienceCopilot).toHaveBeenCalledTimes(1));
    return streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
  }

  function getBySendBtn(): HTMLElement {
    const btn = document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement | null;
    if (!btn) throw new Error("copilot-send-btn not found");
    return btn;
  }

  it("restores the saved copilot binding (provider + model) instead of defaulting to the first profile", async () => {
    seedBinding("p2", "m2");
    const { container } = renderShell();
    await flushSessionLoad();
    const body = await sendAndCaptureBody(container, "hello from the restored binding");
    expect(body.providerProfileId).toBe("p2");
    expect(body.model).toBe("m2");
  });

  it("a dangling saved profile id falls back to the first available profile", async () => {
    seedBinding("deleted-profile", "m2");
    const { container } = renderShell();
    await flushSessionLoad();
    const body = await sendAndCaptureBody(container, "hello from the dangling fallback");
    expect(body.providerProfileId).toBe("p1");
    expect(body.model).toBe("m1");
  });

  it("no saved binding defaults to the first profile (pre-fix behavior preserved)", async () => {
    seedBinding(null, null);
    const { container } = renderShell();
    await flushSessionLoad();
    const body = await sendAndCaptureBody(container, "hello from the default");
    expect(body.providerProfileId).toBe("p1");
    expect(body.model).toBe("m1");
  });
});

describe("ExperienceCopilotShell — send test feedback to copilot (ER-14)", () => {
  it("tester send: posts a digest into the thread (testFeedback reaches the stream body) and a subsequent manual send carries it", async () => {
    const { getByTestId, getByText, findByText, container } = renderShell();
    await flushSessionLoad();

    // Open the tester modal + run a create-only test.
    fireEvent.click(getByTestId("copilot-toolbar-tester"));
    fireEvent.click(getByText("experience_tester_run"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    // Wait for the result to render (the definition block appears after setResult).
    await findByText("experience_tester_definition");

    // The send-to-copilot button is present after a successful run.
    const sendBtn = await findByText("experience_tester_send_to_copilot");
    fireEvent.click(sendBtn);

    // handleSendToCopilot → ctrl.handleSend → streamExperienceCopilot body carries testFeedback.
    await waitFor(() => expect(streamExperienceCopilot).toHaveBeenCalledTimes(1));
    const firstBody = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect(firstBody.testFeedback).toMatchObject({ ok: true, status: "active" });
    expect(firstBody.step).toBe("test");
    // The digest text was posted as the user message content.
    expect(typeof firstBody.content).toBe("string");
    expect((firstBody.content as string).length).toBeGreaterThan(0);

    // Close the tester modal so the chat input textarea is the only one left.
    fireEvent.click(getByTestId("copilot-toolbar-tester"));

    // A SUBSEQUENT manual send (typed into the chat input) also carries the
    // latest testFeedback (it survives until overwritten).
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "can you fix the rules?" } });
    fireEvent.click(getByTestId("copilot-send-btn"));

    await waitFor(() => expect(streamExperienceCopilot).toHaveBeenCalledTimes(2));
    const secondBody = streamExperienceCopilot.mock.calls[1][1] as Record<string, unknown>;
    expect(secondBody.content).toBe("can you fix the rules?");
    expect(secondBody.testFeedback).toMatchObject({ ok: true, status: "active" });
  });

  it("playground send: the sandbox-modal playground posts a diagnostics digest", async () => {
    const { getByTestId, getByText, findByText } = renderShell();
    await flushSessionLoad();

    // Open the sandbox modal + start a session.
    fireEvent.click(getByTestId("copilot-toolbar-sandbox"));
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    // Wait for the session to render (the turn title appears after setSession).
    await findByText("experience_playground_turn_title");

    // Open the Developer-diagnostics disclosure (the send button lives inside).
    fireEvent.click(getByText("experience_playground_diagnostics"));
    const sendBtn = await findByText("experience_playground_send_diagnostics");
    fireEvent.click(sendBtn);

    await waitFor(() => expect(streamExperienceCopilot).toHaveBeenCalledTimes(1));
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect(body.testFeedback).toMatchObject({ ok: true, status: "active", revision: 0 });
    expect(body.step).toBe("test");
  });
});

describe("ExperienceCopilotShell — CD-3: freeze/unfreeze + revert", () => {
  it("freezes the editor (read-only + badge) while the model is generating and thaws after settle", async () => {
    // Hang the stream so isSending stays true while we assert the frozen state.
    let resolveStream!: (v: { finishReason: string }) => void;
    streamExperienceCopilot.mockImplementationOnce(
      () => new Promise<{ finishReason: string }>((res) => { resolveStream = res; }),
    );

    const { container } = renderShell();
    await flushSessionLoad();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);

    // Frozen: the badge shows and the CM view is read-only.
    await waitFor(() => expect(document.querySelector('[data-testid="copilot-editor-frozen"]')).not.toBeNull());
    const frozenView = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
    expect(frozenView!.state.facet(EditorState.readOnly)).toBe(true);

    // Settle: the badge disappears and the editor becomes writable again.
    await act(async () => { resolveStream({ finishReason: "stop" }); });
    await waitFor(() => expect(document.querySelector('[data-testid="copilot-editor-frozen"]')).toBeNull());
    const thawedView = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
    expect(thawedView!.state.facet(EditorState.readOnly)).toBe(false);
  });

  it("shows the revert button after buffer drift and restores the turn-start snapshot", async () => {
    const onRulesChange = mock();
    const { rerender, getByTestId, queryByTestId } = renderShell({ onRulesChange });

    await flushSessionLoad();
    // No turn yet → no revert affordance.
    expect(queryByTestId("copilot-toolbar-revert")).toBeNull();

    // A full turn against the v1 buffers (the stream mock resolves immediately).
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamExperienceCopilot).toHaveBeenCalledTimes(1));
    // Drain the settle → refetch chain.
    await waitFor(() => expect(listExperienceCopilotMessages).toHaveBeenCalled());

    // Buffers still equal the snapshot → revert stays hidden.
    expect(queryByTestId("copilot-toolbar-revert")).toBeNull();

    // The parent applies a change (e.g. the user accepted a proposal / edited
    // by hand): the buffer drifted from the turn-start snapshot.
    rerender(
      <ExperienceCopilotShell
        scriptId="script-1"
        rulesCode="// rules buffer v2"
        visualSource="// visual buffer"
        onRulesChange={onRulesChange}
        onVisualChange={mock()}
      />,
    );
    expect(getByTestId("copilot-toolbar-revert")).toBeDefined();

    // Revert: the parent receives the snapshot's rules text back.
    fireEvent.click(getByTestId("copilot-toolbar-revert"));
    expect(onRulesChange).toHaveBeenCalledWith("// rules buffer");
  });

  it("keeps the revert button off the sandbox position", async () => {
    const { rerender, getByRole, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "go" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamExperienceCopilot).toHaveBeenCalledTimes(1));

    // Drift the rules buffer while on the rules position: revert visible…
    rerender(
      <ExperienceCopilotShell
        scriptId="script-1"
        rulesCode="// rules buffer v2"
        visualSource="// visual buffer"
        onRulesChange={mock()}
        onVisualChange={mock()}
        creationMode
      />,
    );
    expect(queryByTestId("copilot-toolbar-revert")).not.toBeNull();
    // …but the sandbox position has no code editor / review affordances.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_sandbox" }));
    expect(queryByTestId("copilot-toolbar-revert")).toBeNull();
  });
});

describe("ExperienceCopilotShell — CD-6: inline review flow", () => {
  it("shows the review bar + tab dot after a proposal and accepts all into the buffer", async () => {
    const onRulesChange = mock();
    const { getByTestId, queryByTestId } = renderShell({ onRulesChange });
    await flushSessionLoad();

    // A real turn (snapshot) against the v1 buffers.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamExperienceCopilot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listExperienceCopilotMessages).toHaveBeenCalled());

    // The turn's write_buffer proposal lands in the live store (as the SSE
    // tool-result path would fill it).
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-new": [
          {
            toolCallId: "c1",
            toolName: "write_buffer",
            status: "done",
            target: "rules",
            proposed: "// rules buffer v2",
            summary: "rewrote",
          },
        ],
      },
    });

    // The review bar appears with the pending count and the rules tab dot.
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());
    expect(getByTestId("copilot-review-count").textContent).toContain("copilot_review_hunks_count");
    expect(queryByTestId("copilot-buffer-dot-rules")).not.toBeNull();
    expect(queryByTestId("copilot-buffer-dot-visual")).toBeNull();

    // Accept-all writes the proposed buffer into the rules draft.
    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onRulesChange).toHaveBeenCalledWith("// rules buffer v2");
  });
});

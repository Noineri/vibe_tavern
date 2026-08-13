import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";
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
const streamExperienceCopilot = mock(async (): Promise<void> => {});

const realApi = await import("../../../../api/experience-copilot-api.js");
mock.module("../../../../api/experience-copilot-api.js", () => ({
  ...realApi,
  getExperienceCopilotActive,
  listExperienceCopilotMessages,
  startExperienceCopilotSession,
  listExperienceCopilotSessions,
  activateExperienceCopilotSession,
  streamExperienceCopilot,
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

// The shell reads `useIsMobile` (matchMedia). Mock it to a controllable flag.
const realMobile = await import("../../../../hooks/use-mobile.js");
mock.module("../../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
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

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;
let ExperienceCopilotShell: typeof import("./ExperienceCopilotShell.js").ExperienceCopilotShell;
let EditorView: typeof import("@codemirror/view").EditorView;

beforeAll(async () => {
  ({ render, fireEvent, act } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
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
// `useToolCapableModels` hook serves the model list from cache (no fetch).
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
  streamExperienceCopilot.mockResolvedValue(undefined);
});

function renderShell(over: Partial<Parameters<typeof ExperienceCopilotShell>[0]> = {}) {
  const props = {
    scriptId: "script-1",
    rulesCode: "// rules buffer",
    visualSource: "// visual buffer",
    onRulesChange: mock(),
    onVisualChange: mock(),
    onApply: mock(),
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
    expect(getByText("Ask the copilot to propose rules or visual edits.")).toBeDefined();
    expect(getExperienceCopilotActive).toHaveBeenCalledWith("script-1");
    expect(startExperienceCopilotSession).toHaveBeenCalledWith("script-1");
    expect(listExperienceCopilotMessages).not.toHaveBeenCalled();
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
    fireEvent.click(getByRole("radio", { name: "Visual" }));

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

describe("ExperienceCopilotShell — mobile tabs", () => {
  it("keeps all three panes mounted and toggles visibility on tab switch", async () => {
    mobileOverride = true;
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));

    const { getByTestId, getByRole } = renderShell();

    // Wait for session load so the chat pane reaches its thread branch.
    await flushSessionLoad();

    // Tab bar + all three panes are mounted.
    expect(getByRole("tablist")).toBeDefined();
    const chatPane = getByTestId("copilot-pane-chat");
    const editPane = getByTestId("copilot-pane-edit");
    const testPane = getByTestId("copilot-pane-test");
    expect(chatPane).toBeDefined();
    expect(editPane).toBeDefined();
    expect(testPane).toBeDefined();

    // Default active tab is chat.
    expect(hasHiddenClass(chatPane)).toBe(false);
    expect(hasHiddenClass(editPane)).toBe(true);
    expect(hasHiddenClass(testPane)).toBe(true);

    fireEvent.click(getByRole("tab", { name: "Edit" }));
    expect(hasHiddenClass(chatPane)).toBe(true);
    expect(hasHiddenClass(editPane)).toBe(false);
    expect(hasHiddenClass(testPane)).toBe(true);

    fireEvent.click(getByRole("tab", { name: "Test" }));
    expect(hasHiddenClass(chatPane)).toBe(true);
    expect(hasHiddenClass(editPane)).toBe(true);
    expect(hasHiddenClass(testPane)).toBe(false);
  });
});

describe("ExperienceCopilotShell — Apply forwarding", () => {
  it("forwards the message-list Apply to the onApply prop", async () => {
    getExperienceCopilotActive.mockResolvedValue(thread("thread-1"));
    listExperienceCopilotMessages.mockResolvedValue([]);
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          {
            toolCallId: "w1",
            toolName: "write_buffer",
            status: "done",
            summary: "wrote rules",
            target: "rules",
            proposed: "new rules",
          },
        ],
      },
    });

    const onApply = mock();
    const { getByTestId } = renderShell({ onApply });

    await flushSessionLoad();

    fireEvent.click(getByTestId("copilot-apply-btn"));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ rules: "new rules" });
  });
});

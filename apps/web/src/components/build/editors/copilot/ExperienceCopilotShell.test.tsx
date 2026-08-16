import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";
import { useCopilotReviewRoundStore } from "../../../../stores/experience-copilot-review-store.js";
import { useBootstrapStore } from "../../../../stores/api-actions/bootstrap-actions.js";
import type { ProviderProfileRecord } from "../../../../api/types.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = false;

// ── Fetch-level API router ───────────────────────────────────────────────
// RV follow-up: mock.module on the api modules is process-global and silently
// stops applying when another test file shares the bun process (the shell then
// holds the REAL clients → real fetch → ECONNREFUSED, tests red in a combined
// run). The api seam is faked at the FETCH level instead: the REAL hono / SSE
// clients run against a router serving canned payloads. globalThis.fetch is
// swapped in beforeAll and restored in afterAll — no module registry is
// touched, so this file coexists with any other test file in one process.
interface RouterState {
  activeThread: ExperienceCopilotThreadWire | null;
  messages: ExperienceCopilotMessageWire[];
  sessions: ExperienceCopilotThreadWire[];
  newSession: ExperienceCopilotThreadWire;
  activateReturns: ExperienceCopilotThreadWire | null;
  streamEvents: string[];
  /** Per-thread messages override (session-switcher test); falls back to `messages`. */
  messagesFor?: (threadId: string) => ExperienceCopilotMessageWire[];
  /** Hold the SSE stream open (freeze test): no events until `releaseStream()`. */
  holdStreamOpen: boolean;
  releaseStream: (() => void) | null;
}
let router: RouterState;

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

const FINISH_STOP = 'event: finish\ndata: {"finishReason":"stop"}\n\n';

const sseResponse = (events: readonly string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of events) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

function makeDigest(threadId: string): ExperienceCopilotMessageWire {
  return {
    id: "digest-1",
    threadId,
    role: "digest",
    content: "summary",
    toolCallsJson: null,
    toolCallId: "u1",
    createdAt: "",
  };
}

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/active$/.test(path)) {
    return jsonResponse(router.activeThread);
  }
  if (method === "GET" && /\/api\/experience-copilot\/([^/]+)\/messages$/.test(path)) {
    const threadId = path.match(/\/api\/experience-copilot\/([^/]+)\/messages$/)?.[1] ?? "";
    return jsonResponse(router.messagesFor ? router.messagesFor(threadId) : router.messages);
  }
  if (method === "POST" && /\/api\/experience-copilot\/script\/[^/]+\/session$/.test(path)) {
    return jsonResponse(router.newSession);
  }
  if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/sessions$/.test(path)) {
    return jsonResponse(router.sessions);
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/activate$/.test(path)) {
    return jsonResponse(router.activateReturns);
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    return jsonResponse({ metrics: null, autoCompact: true });
  }
  if (method === "PATCH" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { autoCompact?: boolean };
    return jsonResponse({ metrics: null, autoCompact: body.autoCompact ?? true });
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/compact$/.test(path)) {
    const threadId = path.match(/\/api\/experience-copilot\/([^/]+)\/compact$/)?.[1] ?? "";
    return jsonResponse({ digest: makeDigest(threadId), metrics: null });
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream$/.test(path)) {
    if (router.holdStreamOpen) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            router.releaseStream = () => {
              controller.enqueue(encoder.encode(FINISH_STOP));
              controller.close();
            };
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return sseResponse(router.streamEvents);
  }
  // NOTE: the gateway base resolves to "/null" under happy-dom (unset env
  // falls back to `String(null)` in build-config) — route on path SUFFIXES,
  // never exact equality.
  if (method === "POST" && path.endsWith("/api/experience/test/run")) return jsonResponse(TEST_RUN_DATA);
  if (method === "POST" && path.endsWith("/api/experience/playground/start")) return jsonResponse(PLAYGROUND_DATA);
  // Unmodeled endpoints (e.g. best-effort model-favorites) get a 404 body —
  // callers treat it like any RPC failure and swallow it.
  if (method === "GET" && path.endsWith("/model-favorites")) return jsonResponse([]);
  return new Response(JSON.stringify({ error: { message: `Unhandled fetch in test: ${method} ${path}` } }), { status: 404 });
});

/** Router fetch calls matching method + path pattern, with parsed JSON bodies. */
function apiCalls(
  method: string,
  pattern: RegExp,
): Array<{ path: string; body: Record<string, unknown> | null }> {
  return fetchRouter.mock.calls
    .map(([input, init]) => {
      const path = new URL(String(input), "http://gateway.test").pathname;
      return {
        method: (init?.method ?? "GET").toUpperCase(),
        path,
        body: init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
    })
    .filter((call) => call.method === method && pattern.test(call.path));
}

const streamCalls = () => apiCalls("POST", /\/api\/experience-copilot\/[^/]+\/stream$/);

// Markdown is heavy and its internals are pinned elsewhere; the shell test
// cares only that message text reaches the list.
// CD-8: capture the conflict toast (safe pattern — spread real sonner first).
const toastWarning = mock();
const realSonner = await import("sonner");
mock.module("sonner", () => ({
  ...realSonner,
  toast: Object.assign((...a: Parameters<typeof realSonner.toast>) => realSonner.toast(...a), realSonner.toast, {
    warning: toastWarning,
  }),
}));

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

// The ExperiencePlayground (inside the sandbox modal) drives BOTH
// runExperienceTest (the auto-derive discovery and the absorbed tester's
// discover) and startExperiencePlayground. Both are served by the fetch router
// above (POST /api/experience/test/run and /api/experience/playground/start),
// so the ER-14 send-to-copilot flow is observable through the REAL shell →
// child → callback → controller → client → router wiring — with no module mocks.
const TEST_RUN_DATA: Awaited<ReturnType<typeof import("../../../../api/experience-api.js").runExperienceTest>> = {
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
};
const PLAYGROUND_DATA: Awaited<ReturnType<typeof import("../../../../api/experience-api.js").startExperiencePlayground>> = {
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
};

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

const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = fetchRouter as unknown as typeof globalThis.fetch;
  ({ render, fireEvent, waitFor, act } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ EditorState } = await import("@codemirror/state"));
  ({ ExperienceCopilotShell } = await import("./ExperienceCopilotShell.js"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
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
  // The review round + the persisted localStorage draft now SURVIVE shell
  // unmounts (the whole point of the round store) — reset both, or a
  // previous test's hanging review leaks into the next mount.
  useCopilotReviewRoundStore.setState({ roundsByThread: {} });
  localStorage.clear();
  useProviderDataStore.setState({ profiles: PROFILES });
  // Reset the persisted copilot binding between tests (the shell restores it).
  const current = useBootstrapStore.getState().data;
  if (current) {
    useBootstrapStore.setState({ data: { ...current, uiSettings: { ...current.uiSettings, copilotProviderId: null, copilotModelName: null } } });
  }
  router = {
    activeThread: null,
    messages: [],
    sessions: [],
    newSession: thread("thread-new"),
    activateReturns: null,
    streamEvents: [FINISH_STOP],
    holdStreamOpen: false,
    releaseStream: null,
  };
  fetchRouter.mockClear();
});

function renderShell(over: Partial<Parameters<typeof ExperienceCopilotShell>[0]> = {}) {
  const props = {
    scriptId: "script-1",
    rulesCode: "// rules buffer",
    // XU-5: an empty visual source defaults the editor to the Code tab (matching
    // the pre-XU-5 "rules" default most tests assume); preview-default tests
    // pass a non-empty `visualSource` explicitly.
    visualSource: "",
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
    router.activeThread = thread("thread-1");
    router.messages = [
      msg({ id: "u1", role: "user", content: "Make it scarier" }),
      msg({ id: "a1", role: "assistant", content: "Here are the rules" }),
    ];

    const { getByText, getByTestId } = renderShell();

    await flushSessionLoad();

    expect(getByText("Make it scarier")).toBeDefined();
    expect(getByText("Here are the rules")).toBeDefined();
    expect(apiCalls("GET", /\/script\/script-1\/active$/)).toHaveLength(1);
    expect(apiCalls("GET", /\/experience-copilot\/thread-1\/messages$/)).toHaveLength(1);
    // threadId is set → the chat input area is mounted (only rendered past the
    // loading/error/threadId branch).
    expect(getByTestId("copilot-send-btn")).toBeDefined();
  });

  it("starts a NEW session when none is active", async () => {
    const { getByText } = renderShell();

    await flushSessionLoad();

    // MessageList's empty state (thread exists but no messages/activities).
    expect(getByText("experience_copilot_subtitle")).toBeDefined();
    expect(apiCalls("GET", /\/script\/script-1\/active$/)).toHaveLength(1);
    expect(apiCalls("POST", /\/script\/script-1\/session$/)).toHaveLength(1);
    expect(apiCalls("GET", /messages$/)).toHaveLength(0);
  });
});

describe("ExperienceCopilotShell — context meter + compact flow (CM-7/CM-8)", () => {
  it("mounts the meter once a thread is loaded and compacts on click (POST → refetch)", async () => {
    router.activeThread = thread("thread-1");
    router.messages = [
      msg({ id: "u1", role: "user", content: "Make it scarier" }),
    ];

    const { getByTestId } = renderShell();
    await flushSessionLoad();

    expect(getByTestId("copilot-context-meter")).toBeDefined();
    const callsBefore = apiCalls("GET", /\/experience-copilot\/thread-1\/messages$/).length;

    fireEvent.click(getByTestId("copilot-context-compact-btn"));
    await flushSessionLoad();

    // The compact call forwards the shell's current provider/model selection
    // (restored binding p1/m1 from the persisted uiSettings in this test).
    expect(apiCalls("POST", /\/experience-copilot\/thread-1\/compact$/)[0]?.body).toMatchObject({ providerProfileId: "p1", model: "m1" });
    // onCompacted → handleTurnSettled → refetch messages so the digest card appears.
    expect(apiCalls("GET", /\/experience-copilot\/thread-1\/messages$/).length).toBeGreaterThan(callsBefore);
  });
});

describe("ExperienceCopilotShell — session switcher (ER-12b)", () => {
  it("wires the switcher with the fetched sessions + active thread", async () => {
    router.activeThread = thread("thread-1");
    router.sessions = [
      { ...thread("thread-1"), title: "Active" },
      { ...thread("thread-2"), title: "Older", archivedAt: "2026-08-10T00:00:00Z" },
    ];

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
    router.activeThread = thread("thread-1");
    router.sessions = [
      { ...thread("thread-1"), title: "Active" },
      { ...thread("thread-2"), title: "Older", archivedAt: "2026-08-10T00:00:00Z" },
    ];
    router.messagesFor = (threadId) =>
      threadId === "thread-1"
        ? [msg({ id: "m-active", content: "active message", threadId })]
        : [msg({ id: "m-archived", content: "archived message", threadId })];
    router.activateReturns = { ...thread("thread-2"), archivedAt: null };

    const { getByTestId, getByText } = renderShell();
    await flushSessionLoad();

    expect(getByText("active message")).toBeDefined();

    fireEvent.click(getByTestId("copilot-session-thread-2"));
    await flushSessionLoad();

    expect(apiCalls("POST", /\/experience-copilot\/thread-2\/activate$/)).toHaveLength(1);
    expect(apiCalls("GET", /\/experience-copilot\/thread-2\/messages$/)).toHaveLength(1);
    expect(getByText("archived message")).toBeDefined();
    // Fetched once on mount, refetched once after the switch.
    expect(apiCalls("GET", /\/script\/script-1\/sessions$/)).toHaveLength(2);
  });

  it("new-session path: archives the current and resets messages", async () => {
    router.activeThread = thread("thread-1");
    router.sessions = [thread("thread-1")];
    router.messages = [msg({ content: "old message", threadId: "thread-1" })];
    router.newSession = thread("thread-new");

    const { getByTestId } = renderShell();
    await flushSessionLoad();

    fireEvent.click(getByTestId("copilot-session-new"));
    await flushSessionLoad();

    expect(apiCalls("POST", /\/script\/script-1\/session$/)).toHaveLength(1);
    // Messages are cleared (no thread rehydration for a brand-new thread).
    expect(apiCalls("GET", /messages$/)).toHaveLength(1); // only the initial mount fetch
    expect(apiCalls("GET", /\/script\/script-1\/sessions$/)).toHaveLength(2); // mount + refetch
  });
});

describe("ExperienceCopilotShell — editor sub-tab binding", () => {
  it("switches the CodeEditor between the Rules and Visual buffers", async () => {
    const onRulesChange = mock();
    const onVisualChange = mock();
    const { container, getByRole } = renderShell({ onRulesChange, onVisualChange, visualSource: "// visual buffer" });

    // Drain the async `loadSession` so its state updates are captured in act
    // (the editor pane renders regardless of session state).
    await flushSessionLoad();

    // XU-5: a non-empty visual source defaults to the Preview tab — navigate to
    // Code to reach the editor.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_code" }));

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

describe("ExperienceCopilotShell — visual validator (UX 2026-08-16 remark 6)", () => {
  it("visual tab: a broken visual source shows the problems banner; a clean one shows the OK chip", async () => {
    const broken = [
      "<style>.x{color:red}</style>",
      "<div></div>",
      "<script>",
      "(function(){ if (true { } })();",
      "</script>",
    ].join("\n");
    const first = renderShell({ visualSource: broken });
    await flushSessionLoad();

    // Banner only exists on the code tab's Visual buffer — preview (the default
    // here, since a visual source exists) has no validator.
    expect(first.queryByTestId("copilot-visual-validator")).toBeNull();
    fireEvent.click(first.getByRole("radio", { name: "experience_copilot_code" }));
    fireEvent.click(first.getByRole("radio", { name: "experience_copilot_visual" }));

    expect(first.getByTestId("copilot-visual-validator").textContent).toContain("experience_copilot_visual_problems");
    expect(first.getByTestId("copilot-visual-validator").textContent).toContain("script block 1");
    first.unmount();

    // A compile-clean visual shows the OK chip instead.
    const clean = "<style>.x{c:red}</style>\n<div></div>\n<script>var a = 1;</script>";
    const second = renderShell({ visualSource: clean });
    await flushSessionLoad();
    fireEvent.click(second.getByRole("radio", { name: "experience_copilot_code" }));
    fireEvent.click(second.getByRole("radio", { name: "experience_copilot_visual" }));
    expect(second.getByTestId("copilot-visual-validator").textContent).toContain("experience_copilot_visual_valid");
  });
});

describe("ExperienceCopilotShell — toolbar buttons + modals (ER-13b′)", () => {
  // Identity i18n (no LocaleProvider mounted): `useT` falls back to the
  // key-as-string default, so the component markers render their i18n keys
  // verbatim — matching the InteractiveTester/ExperienceEditor test pattern.
  it("renders the unified [Preview|Code|Try] outer toggle (no toolbar buttons, no tester)", async () => {
    const { getByRole, queryByTestId } = renderShell();
    await flushSessionLoad();

    // XU-6 (quote 10): the 3-position toggle is ALWAYS present — the old
    // "Test it" sandbox button is gone (the Try tab replaces it).
    expect(getByRole("radio", { name: "experience_copilot_preview" })).toBeDefined();
    expect(getByRole("radio", { name: "experience_copilot_code" })).toBeDefined();
    expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    // XU-5: the preview button is gone — preview is the default editor tab.
    expect(queryByTestId("copilot-toolbar-preview")).toBeNull();
    // XU-6: the sandbox "Test it" button is gone (the Try tab replaces it).
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
    // XU-4: the tester merged into the sandbox — no separate tester button.
    expect(queryByTestId("copilot-toolbar-tester")).toBeNull();
  });

  it("the tester modal is gone (InteractiveTester merged into the sandbox)", async () => {
    const { queryByTestId } = renderShell();
    await flushSessionLoad();

    expect(queryByTestId("copilot-tester-modal")).toBeNull();
    expect(queryByTestId("interactive-tester")).toBeNull();
  });

  it("preview is the DEFAULT editor tab when a visual exists (ExperienceFrame inline, no modal)", async () => {
    const { getByTestId, queryByTestId, container } = renderShell({ visualSource: "// visual buffer" });
    await flushSessionLoad();

    // The ExperienceFrame renders INLINE in the preview tab — no modal.
    expect(getByTestId("experience-frame-stub")).toBeDefined();
    expect(queryByTestId("copilot-preview-modal")).toBeNull();
    // The code editor is NOT mounted while the preview tab is active.
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("an empty visual source defaults to the Code tab and preview shows the empty-state on demand", async () => {
    const { container, getByRole, getByText, queryByTestId } = renderShell();
    await flushSessionLoad();

    // Empty visual → default is Code (the rules editor is mounted).
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(queryByTestId("experience-frame-stub")).toBeNull();

    // Switch to Preview → the empty-state (no frame).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_preview" }));
    expect(getByText("experience_playground_no_visual")).toBeDefined();
    expect(queryByTestId("experience-frame-stub")).toBeNull();
  });

  it("the Try tab renders the playground inline (no sandbox modal)", async () => {
    const { getByRole, getByTestId, queryByTestId } = renderShell();
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));

    // XU-6: the shared playground element mounts INLINE on the Try tab — the
    // sandbox modal is gone entirely.
    expect(queryByTestId("copilot-sandbox-modal")).toBeNull();
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
    router.activeThread = thread("thread-1");

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

    // The unified outer toggle lives in the Edit pane: the Try tab is present
    // (XU-6 — the old sandbox "Test it" button is gone).
    expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
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
  it("renders a 3-position OUTER toggle (preview/code/try)", async () => {
    const { getByRole } = renderShell({ creationMode: true });
    await flushSessionLoad();

    // Identity i18n: the creation labels resolve through `t` (key-as-string
    // fallback without a LocaleProvider).
    expect(getByRole("radio", { name: "experience_copilot_preview" })).toBeDefined();
    expect(getByRole("radio", { name: "experience_copilot_code" })).toBeDefined();
    expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
  });

  it("try position renders the playground inline and hides the code editor + toolbar buttons", async () => {
    const { container, getByRole, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));

    // The shared playground element mounts INLINE.
    expect(queryByTestId("experience-playground")).toBeTruthy();
    // The CodeEditor is absent on the try position.
    expect(container.querySelector(".cm-editor")).toBeNull();
    // Toggle only — the sandbox toolbar button is gone (XU-6), and the preview
    // button is gone entirely (XU-5).
    expect(queryByTestId("copilot-toolbar-tester")).toBeNull();
    expect(queryByTestId("copilot-toolbar-preview")).toBeNull();
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
  });

  it("does not render the sandbox modal (gone in all modes, XU-6)", async () => {
    const { getByRole, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));
    expect(queryByTestId("copilot-sandbox-modal")).toBeNull();
  });

  it("code position (rules): rules toolbar + code editor, no sandbox/test-it buttons", async () => {
    const { container, getByTestId, queryByTestId } = renderShell({
      creationMode: true,
      rulesToolbar: <div data-testid="rules-toolbar-slot">rules toolbar</div>,
    });
    await flushSessionLoad();

    // Empty visual → default is Code (inner rules sub-toggle).
    expect(getByTestId("rules-toolbar-slot")).toBeDefined();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    // The preview button is gone (XU-5); the sandbox/test-it button is gone
    // (XU-6 — the sandbox is now the inline Try tab in every mode).
    expect(queryByTestId("copilot-toolbar-tester")).toBeNull();
    expect(queryByTestId("copilot-toolbar-preview")).toBeNull();
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
  });

  it("code position (visual): visual toolbar + code editor", async () => {
    const { container, getByRole, getByTestId, queryByTestId } = renderShell({
      creationMode: true,
      visualToolbar: <div data-testid="visual-toolbar-slot">visual toolbar</div>,
    });
    await flushSessionLoad();

    // Default is Code (rules); switch the inner sub-toggle to Visual.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    expect(getByTestId("visual-toolbar-slot")).toBeDefined();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(queryByTestId("copilot-toolbar-tester")).toBeNull();
    expect(queryByTestId("copilot-toolbar-preview")).toBeNull();
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
  });

  it("preview position shows the empty-state in creation mode (no preview modal)", async () => {
    const { getByRole, getByText, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "experience_copilot_preview" }));
    expect(getByText("experience_playground_no_visual")).toBeDefined();
    expect(queryByTestId("copilot-preview-modal")).toBeNull();
    // XU-4: the tester modal is gone entirely.
    expect(queryByTestId("copilot-tester-modal")).toBeNull();
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
    await waitFor(() => expect(streamCalls().length).toBeGreaterThan(0));
    return streamCalls()[0]!.body!;
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
  it("tester send (absorbed): the sandbox diagnostics' discover copies the digest into the chat input (no auto-send); the manual send carries testFeedback", async () => {
    const { getByTestId, getByText, getByRole, findByText, container } = renderShell();
    await flushSessionLoad();

    // Switch to the Try tab (inline playground) and open its collapsed
    // diagnostics disclosure; run the absorbed discover ("Validate rules").
    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));
    fireEvent.click(getByText("experience_playground_diagnostics"));
    fireEvent.click(getByText("experience_tester_run"));
    // The playground's auto-derive also POSTs run once on mount, so the explicit
    // discover is the SECOND call.
    await waitFor(() => expect(apiCalls("POST", /\/api\/experience\/test\/run$/).length).toBeGreaterThanOrEqual(2));
    // Wait for the result to render (the definition block appears after setTesterResult).
    await findByText("experience_tester_definition");

    // The send-to-copilot button is present after a successful run.
    const sendBtn = await findByText("experience_tester_send_to_copilot");
    fireEvent.click(sendBtn);

    // UX 2026-08-16 remark 6: clicking COPIES into the chat input — it must NOT
    // dispatch the turn. No stream POST happens until the user sends.
    await new Promise((r) => setTimeout(r, 25));
    expect(streamCalls()).toHaveLength(0);

    // Switch back to the Code tab so the inline playground unmounts (only the
    // chat input textarea remains in the container).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_code" }));

    // The digest text sits in the chat input, prefilled for the user to send.
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(0);

    // The manual send posts the digest as the user message with testFeedback.
    fireEvent.click(getByTestId("copilot-send-btn"));
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    const body = streamCalls()[0]!.body!;
    expect(body.testFeedback).toMatchObject({ ok: true, status: "active" });
    expect(body.step).not.toBe("test");
    expect(typeof body.content).toBe("string");
    expect((body.content as string).length).toBeGreaterThan(0);
  });

  it("playground send: the inline-Try playground copies a diagnostics digest into the input; manual send carries it", async () => {
    const { getByTestId, getByText, getByRole, findByText, container } = renderShell();
    await flushSessionLoad();

    // Switch to the Try tab (inline playground) + start a session.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(apiCalls("POST", /\/api\/experience\/playground\/start$/)).toHaveLength(1));
    // Wait for the session to render (the turn title appears after setSession).
    await findByText("experience_playground_turn_title");

    // Open the Developer-diagnostics disclosure (the send button lives inside).
    fireEvent.click(getByText("experience_playground_diagnostics"));
    const sendBtn = await findByText("experience_playground_send_diagnostics");
    fireEvent.click(sendBtn);

    // UX 2026-08-16 remark 6: copy, not dispatch.
    await new Promise((r) => setTimeout(r, 25));
    expect(streamCalls()).toHaveLength(0);

    // Switch back to the Code tab so the inline playground unmounts, then send
    // the prefilled digest manually.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_code" }));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(0);
    fireEvent.click(getByTestId("copilot-send-btn"));

    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    const body = streamCalls()[0]!.body!;
    expect(body.testFeedback).toMatchObject({ ok: true, status: "active", revision: 0 });
  });
});

describe("ExperienceCopilotShell — CD-3: freeze/unfreeze + revert", () => {
  it("freezes the editor (read-only + badge) while the model is generating and thaws after settle", async () => {
    // Hang the stream so isSending stays true while we assert the frozen state.
    router.holdStreamOpen = true;

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
    await act(async () => { router.releaseStream?.(); });
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
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    // Drain the settle → refetch chain.
    await waitFor(() => expect(apiCalls("GET", /messages$/).length).toBeGreaterThan(0));

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
    await waitFor(() => expect(streamCalls()).toHaveLength(1));

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
    // …but the try (sandbox) position has no code editor / review affordances.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));
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
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await waitFor(() => expect(apiCalls("GET", /messages$/).length).toBeGreaterThan(0));

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
    // XU-5: the OUTER Code tab also carries a dot (review dots on both levels).
    expect(queryByTestId("copilot-outer-dot-code")).not.toBeNull();

    // Accept-all writes the proposed buffer into the rules draft.
    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onRulesChange).toHaveBeenCalledWith("// rules buffer v2");
  });

  it("per-hunk dismiss (✕) drops hunks from the round without touching the buffer (RV-2)", async () => {
    const onRulesChange = mock();
    const base = "// rules buffer\nconst keep = 1;\nconst tail = 2.";
    const { container, getByTestId, queryByTestId } = renderShell({ onRulesChange, rulesCode: base });
    await flushSessionLoad();

    // Real send (snapshot), then a two-hunk rules proposal (header + tail).
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-new": [
          {
            toolCallId: "w1",
            toolName: "write_buffer",
            status: "done",
            summary: "header + tail",
            target: "rules",
            proposed: "// RULES v2\nconst keep = 1;\nconst tail = 22.",
          },
        ],
      },
    });
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());
    await waitFor(() => expect(container.querySelectorAll(".cm-copilotDiffDismiss")).toHaveLength(2));

    // Dismiss the first hunk: it leaves the round, the buffer is untouched.
    fireEvent.click(container.querySelector<HTMLButtonElement>(".cm-copilotDiffDismiss")!);
    await waitFor(() => expect(container.querySelectorAll(".cm-copilotDiffDismiss")).toHaveLength(1));
    expect(getByTestId("copilot-review-bar")).toBeDefined();
    expect(onRulesChange).not.toHaveBeenCalled();

    // Dismiss the last hunk: the round resolves and the bar disappears.
    fireEvent.click(container.querySelector<HTMLButtonElement>(".cm-copilotDiffDismiss")!);
    await waitFor(() => expect(queryByTestId("copilot-review-bar")).toBeNull());
    expect(onRulesChange).not.toHaveBeenCalled();
  });
});

describe("ExperienceCopilotShell — RV-3: tab-scoped cancel buttons", () => {
  const BASE = "// rules buffer\nconst keep = 1;\nconst tail = 2.";
  const PROPOSED = "// RULES v2\nconst keep = 1;\nconst tail = 22.";
  // Hunk 0 (the header) accepted, hunk 1 (the tail) still pending.
  const HYBRID = "// RULES v2\nconst keep = 1;\nconst tail = 2.";

  async function startReview(utils: ReturnType<typeof renderShell>) {
    await flushSessionLoad();
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();
    await act(async () => {
      useExperienceCopilotTurnStore.setState({
        turnsByThread: {
          "thread-new": [
            {
              toolCallId: "w1",
              toolName: "write_buffer",
              status: "done",
              summary: "header + tail",
              target: "rules",
              proposed: PROPOSED,
            },
          ],
        },
      });
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());
  }

  it("«Отменить все непринятые» dismisses only THIS tab's pending hunks (buffer + accepted untouched)", async () => {
    const onRulesChange = mock();
    const onVisualChange = mock();
    const utils = renderShell({ onRulesChange, onVisualChange, rulesCode: BASE });
    await startReview(utils);

    // Accept hunk 0 → hunk 1 is the only pending hunk.
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    expect(onRulesChange).toHaveBeenCalledWith(HYBRID);
    const callsAfterAccept = onRulesChange.mock.calls.length;

    // «Отменить все непринятые»: hunk 1 leaves the round; nothing else moves.
    fireEvent.click(utils.getByTestId("copilot-dismiss-pending"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    expect(onRulesChange.mock.calls.length).toBe(callsAfterAccept);
    expect(onVisualChange).not.toHaveBeenCalled();
    expect(utils.queryByTestId("copilot-buffer-dot-visual")).toBeNull();
  });

  it("«Отменить все» (clean) rolls accepted hunks back to the snapshot base without clearTurn", async () => {
    toastWarning.mockClear();
    const onRulesChange = mock();
    const utils = renderShell({ onRulesChange, rulesCode: BASE });
    await startReview(utils);

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    expect(onRulesChange).toHaveBeenCalledWith(HYBRID);
    // The parent applies the accept → the draft becomes the hybrid.
    utils.rerender(<ExperienceCopilotShell {...utils.props} rulesCode={HYBRID} onRulesChange={onRulesChange} />);
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    expect(onRulesChange).toHaveBeenLastCalledWith(BASE);
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    // RV-3: the round is cancelled WITHOUT popping the snapshot / clearTurn —
    // the live turn's activities survive (the toolbar revert is a separate path).
    expect(useExperienceCopilotTurnStore.getState().turnsByThread["thread-new"]?.length).toBeGreaterThan(0);
  });

  it("«Отменить все» (drift) reverses anchored accepted hunks and toasts nothing when all anchor", async () => {
    toastWarning.mockClear();
    const onRulesChange = mock();
    const utils = renderShell({ onRulesChange, rulesCode: BASE });
    await startReview(utils);

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    expect(onRulesChange).toHaveBeenCalledWith(HYBRID);
    // Drift the MIDDLE context line (not part of hunk 0's added/removed lines),
    // so hunk 0 still anchors onto the drifted buffer.
    utils.rerender(
      <ExperienceCopilotShell
        {...utils.props}
        rulesCode={HYBRID.replace("const keep = 1;", "const keep = 999;")}
        onRulesChange={onRulesChange}
      />,
    );

    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    expect(onRulesChange).toHaveBeenLastCalledWith("// rules buffer\nconst keep = 999;\nconst tail = 2.");
    expect(toastWarning).not.toHaveBeenCalled();
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
  });

  it("tooLarge: «Отменить все» on a pending wholesale proposal dismisses it (buffer untouched)", async () => {
    toastWarning.mockClear();
    const onRulesChange = mock();
    const bigBase = Array.from({ length: 900 }, (_, i) => `line-${i}`).join("\n");
    const bigProposed = Array.from({ length: 900 }, (_, i) => `other-${i}`).join("\n");
    const utils = renderShell({ onRulesChange, rulesCode: bigBase });
    await flushSessionLoad();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-new": [
          {
            toolCallId: "w-big",
            toolName: "write_buffer",
            status: "done",
            summary: "rewrote",
            target: "rules",
            proposed: bigProposed,
          },
        ],
      },
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    // The tooLarge fallback has no hunk decomposition; the only reachable
    // cancel is «Отменить все» on the still-pending sentinel (accept-all
    // resolves the round immediately, RV-1). It leaves the buffer untouched.
    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    expect(onRulesChange).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("cancelling the rules tab leaves a live VISUAL round untouched (per-tab scoping)", async () => {
    const onRulesChange = mock();
    const onVisualChange = mock();
    const utils = renderShell({ onRulesChange, onVisualChange, rulesCode: BASE });
    await startReview(utils);

    // A SECOND proposal lands on the visual buffer while the rules round is
    // still open — both rounds are live at once (CD-8: they hang until resolved).
    await act(async () => {
      useExperienceCopilotTurnStore.setState({
        turnsByThread: {
          "thread-new": [
            {
              toolCallId: "w1",
              toolName: "write_buffer",
              status: "done",
              summary: "header + tail",
              target: "rules",
              proposed: PROPOSED,
            },
            {
              toolCallId: "w2",
              toolName: "write_buffer",
              status: "done",
              summary: "visual edit",
              target: "visual",
              proposed: "// visual buffer v2",
            },
          ],
        },
      });
    });

    // Cancel the RULES round from the rules tab.
    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    // The rules round is gone (its review bar disappears — nothing was
    // accepted, so the buffer is never touched)…
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    expect(onRulesChange).not.toHaveBeenCalled();
    // …but the VISUAL round is NOT cancelled: its buffer is untouched and its
    // tab dot stays lit (the cancel is per-tab by design, RV-3).
    expect(onVisualChange).not.toHaveBeenCalled();
    await waitFor(() => expect(utils.getByTestId("copilot-buffer-dot-visual")).not.toBeNull());
  });
});

describe("ExperienceCopilotShell — CD-8: dangling proposal across a new turn", () => {
  async function sendOne(content: string) {
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: content } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls().length).toBeGreaterThan(0));
    fetchRouter.mockClear();
    await flushSessionLoad();
  }

  function seedProposal(text: string) {
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-new": [
          {
            toolCallId: `w-${text.length}`,
            toolName: "write_buffer",
            status: "done",
            summary: "wrote rules",
            target: "rules",
            proposed: text,
          },
        ],
      },
    });
  }

  it("a chat-only follow-up turn does not kill the unresolved review (nothing auto-applied)", async () => {
    const onRulesChange = mock();
    const { getByTestId } = renderShell({ onRulesChange });
    await flushSessionLoad();

    // Turn 1 (real send → snapshot), then its proposal lands in the live store.
    await sendOne("edit the rules");
    seedProposal("// rules buffer v2");
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());

    // Turn 2: a plain chat message with NO tools. The live store is cleared at
    // send start (audit feed + history cards), but the capture keeps the
    // proposal hanging — not applied, not dropped.
    await sendOne("a question, no tools");
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());
    expect(onRulesChange).not.toHaveBeenCalled();

    // Still resolvable by hand: accept-all writes the dangling proposal.
    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onRulesChange).toHaveBeenCalledWith("// rules buffer v2");
  });

  it("a revising turn's live proposal REPLACES the dangling one (last-wins)", async () => {
    const onRulesChange = mock();
    const { getByTestId } = renderShell({ onRulesChange });
    await flushSessionLoad();

    await sendOne("edit the rules");
    seedProposal("// rules buffer v2");
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());

    // The new turn revises the same buffer — its live proposal wins.
    await sendOne("revise it again");
    seedProposal("// rules buffer v3");
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());

    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onRulesChange).toHaveBeenCalledWith("// rules buffer v3");
    expect(onRulesChange).not.toHaveBeenCalledWith("// rules buffer v2");
  });

  it("a visual-only follow-up proposal does not re-light the resolved rules review (RV-1)", async () => {
    const onRulesChange = mock();
    const onVisualChange = mock();
    const { getByTestId, queryByTestId, getByRole } = renderShell({ onRulesChange, onVisualChange });
    await flushSessionLoad();

    // Turn 1: a rules proposal the user FULLY accepts — the round resolves
    // and the review bar disappears.
    await sendOne("edit the rules");
    seedProposal("// rules buffer v2");
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());
    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onRulesChange).toHaveBeenCalledWith("// rules buffer v2");
    await waitFor(() => expect(queryByTestId("copilot-review-bar")).toBeNull());

    // Turn 2: the model proposes ONLY a visual (rules untouched).
    await sendOne("now write the visual");
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-new": [
          {
            toolCallId: "v1",
            toolName: "write_buffer",
            status: "done",
            summary: "wrote visual",
            target: "visual",
            proposed: "<!doctype html><html><body>v2</body></html>",
          },
        ],
      },
    });

    // The visual round shows on the visual tab…
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());

    // …while the rules tab stays RESOLVED: no re-lit review bar, no dot. The
    // old combined proposalKey reset BOTH accepted sets on any buffer change,
    // re-lighting hunks the user had already accepted (and saved).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_rules" }));
    await waitFor(() => expect(queryByTestId("copilot-review-bar")).toBeNull());
    expect(queryByTestId("copilot-buffer-dot-rules")).toBeNull();
  });
});

describe("ExperienceCopilotShell — CD-8: conflict hunks under buffer drift", () => {
  it("a hunk whose anchor text is gone is skipped with a toast; no silent rebase", async () => {
    toastWarning.mockClear();
    const onRulesChange = mock();
    const utils = renderShell({ onRulesChange });
    await flushSessionLoad();

    // Real send (snapshot), then a two-hunk proposal over a multi-line buffer.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();

    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-new": [
          {
            toolCallId: "w1",
            toolName: "write_buffer",
            status: "done",
            summary: "two edits",
            target: "rules",
            proposed: "// RULES v2\nconst keep = 1;\nconst tail = 2;",
          },
        ],
      },
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    // External drift: the template tool rewrote the whole buffer — no hunk can
    // anchor. Accept-all must skip BOTH hunks, warn, and write NOTHING.
    utils.rerender(
      <ExperienceCopilotShell
        {...utils.props}
        rulesCode="// HAND-EDITED BUFFER"
        onRulesChange={onRulesChange}
      />,
    );
    fireEvent.click(utils.getByTestId("copilot-accept-all"));

    expect(onRulesChange).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it("a cleanly-anchored hunk still applies onto the drifted buffer", async () => {
    toastWarning.mockClear();
    const onRulesChange = mock();
    const base = "// rules buffer\nconst keep = 1;\nconst tail = 2.";
    const utils = renderShell({ onRulesChange, rulesCode: base });
    await flushSessionLoad();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();

    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-new": [
          {
            toolCallId: "w1",
            toolName: "write_buffer",
            status: "done",
            summary: "header + tail",
            target: "rules",
            proposed: "// RULES v2\nconst keep = 1;\nconst tail = 22;",
          },
        ],
      },
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    // Drift away from the MIDDLE line only: the header hunk and the tail hunk
    // still anchor; they splice onto the drifted text (no clobber of the edit).
    utils.rerender(
      <ExperienceCopilotShell
        {...utils.props}
        rulesCode={base.replace("const keep = 1;", "const keep = 999;")}
        onRulesChange={onRulesChange}
      />,
    );
    fireEvent.click(utils.getByTestId("copilot-accept-all"));

    expect(onRulesChange).toHaveBeenCalledTimes(1);
    expect(onRulesChange).toHaveBeenCalledWith("// RULES v2\nconst keep = 999;\nconst tail = 22;");
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe("ExperienceCopilotShell — round survives unmount/remount (the hanging-diff contract)", () => {
  const BASE = "// rules buffer\nconst keep = 1;\nconst tail = 2.";
  const PROPOSED = "// RULES v2\nconst keep = 1;\nconst tail = 22.";
  // Hunk 0 (the header) accepted, hunk 1 (the tail) still pending.
  const HYBRID = "// RULES v2\nconst keep = 1;\nconst tail = 2.";

  it("restores the pending review and the accept progress after navigating away and back", async () => {
    const onRulesChange = mock();
    const first = renderShell({ rulesCode: BASE, onRulesChange });
    await flushSessionLoad();

    // A real turn (snapshot) against the BASE buffers, then a two-hunk proposal.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();
    await act(async () => {
      useExperienceCopilotTurnStore.setState({
        turnsByThread: {
          "thread-new": [
            {
              toolCallId: "w1",
              toolName: "write_buffer",
              status: "done",
              summary: "header + tail",
              target: "rules",
              proposed: PROPOSED,
            },
          ],
        },
      });
    });
    await waitFor(() => expect(first.getByTestId("copilot-review-bar")).toBeDefined());
    await waitFor(() => expect(first.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(2));

    // Accept the FIRST hunk (the header): the hybrid lands in the draft…
    fireEvent.click(first.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith(HYBRID));
    // …and only the tail hunk remains pending.
    await waitFor(() => expect(first.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));

    // The user navigates away (prompt tracing, the tester, another pane)…
    first.unmount();

    // …and comes back. The parent editor's draft now holds the hybrid text
    // (accepted-hunk text is ordinary draft state).
    const second = renderShell({ rulesCode: HYBRID, onRulesChange: mock() });
    await flushSessionLoad();

    // The review reappears — with ONLY the still-pending hunk: the previously
    // accepted header is not re-lit (accept progress survived the remount).
    await waitFor(() => expect(second.getByTestId("copilot-review-bar")).toBeDefined());
    await waitFor(() => expect(second.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    expect(second.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!.dataset.hunkId).toBe("1");
  });

  it("restores the round after a full reload path (localStorage envelope v2)", async () => {
    // Session 1: proposal lands, one hunk accepted.
    const onRulesChange = mock();
    const first = renderShell({ rulesCode: BASE, onRulesChange });
    await flushSessionLoad();
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();
    await act(async () => {
      useExperienceCopilotTurnStore.setState({
        turnsByThread: {
          "thread-new": [
            {
              toolCallId: "w1",
              toolName: "write_buffer",
              status: "done",
              summary: "header + tail",
              target: "rules",
              proposed: PROPOSED,
            },
          ],
        },
      });
    });
    await waitFor(() => expect(first.getByTestId("copilot-review-bar")).toBeDefined());
    fireEvent.click(first.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(onRulesChange).toHaveBeenCalledWith(HYBRID));

    // F5: the shell unmounts first, THEN both in-memory stores die with the
    // page; only the localStorage draft remains. (Unmounting before the wipe
    // matters: a still-mounted shell's sync effect would see the emptied
    // stores and CLEAR the persisted key — on a real reload nothing is
    // mounted when the stores die.)
    first.unmount();
    useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
    useCopilotReviewRoundStore.setState({ roundsByThread: {} });

    // Fresh page load: the shell's mount effect rehydrates from localStorage.
    const second = renderShell({ rulesCode: HYBRID, onRulesChange: mock() });
    await flushSessionLoad();

    await waitFor(() => expect(second.getByTestId("copilot-review-bar")).toBeDefined());
    await waitFor(() => expect(second.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    expect(second.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!.dataset.hunkId).toBe("1");
  });
});

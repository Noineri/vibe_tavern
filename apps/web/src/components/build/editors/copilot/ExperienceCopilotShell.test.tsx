import { afterAll, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { wireUiSettings } from "../../../../../test/wire-fixtures.js";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { expectReviewOutcomeFixture, type ReviewOutcomeFixture } from "../../../../../test/review-outcome-fixtures.js";
import type { AgentPlan, ExperienceCopilotContextLink, ExperienceCopilotMessageWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { experienceCopilotStreamRequestSchema } from "@vibe-tavern/api-contracts";
import { useAgentReviewOutcomeStore } from "../../../../stores/agent-review-outcome-store.js";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useSnapshotStore } from "../../../../stores/snapshot-store.js";
import { useAgentTurnStore } from "../../../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../../../stores/agent-review-store.js";
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
  /** Fail this many following POST stream requests before opening their SSE body. */
  nextStreamFailures: number;
  /** Per-thread messages override (session-switcher test); falls back to `messages`. */
  messagesFor?: (threadId: string) => ExperienceCopilotMessageWire[];
  /** Hold the SSE stream open (freeze test): no events until `releaseStream()`. */
  holdStreamOpen: boolean;
  releaseStream: (() => void) | null;
  /** CX-6: the pinned-context links served by GET/PATCH …/context-links. */
  contextLinks: ExperienceCopilotContextLink[];
  /** CX-6: when true the context-links PATCH returns 500 (revert-path test). */
  contextLinksFail: boolean;
  /** PM-6: the script-owned plan served by GET /api/scripts/:id/agent-plan.
   *  Default empty — the AgentPlanPanel stays hidden for every test that does
   *  not set it (mirrors the hidden-until-first-plan contract). */
  agentPlan: AgentPlan;
}
let router: RouterState;

/** PM-6: the empty plan — hidden panel. */
const EMPTY_PLAN: AgentPlan = { goal: "", constraints: [], tasks: [] };

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
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    return jsonResponse(router.contextLinks);
  }
  if (method === "PATCH" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    if (router.contextLinksFail) {
      return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { links?: ExperienceCopilotContextLink[] };
    router.contextLinks = body.links ?? [];
    return jsonResponse(router.contextLinks);
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/compact$/.test(path)) {
    const threadId = path.match(/\/api\/experience-copilot\/([^/]+)\/compact$/)?.[1] ?? "";
    return jsonResponse({ digest: makeDigest(threadId), metrics: null });
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream$/.test(path)) {
    if (router.nextStreamFailures > 0) {
      router.nextStreamFailures--;
      return new Response(JSON.stringify({ error: { message: "pre-stream failure" } }), { status: 400 });
    }
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
  if (method === "POST" && path.endsWith("/api/experience/test/discover")) return jsonResponse({ definition: TEST_RUN_DATA.definition });
  if (method === "POST" && path.endsWith("/api/experience/test/run")) return jsonResponse(TEST_RUN_DATA);
  if (method === "POST" && path.endsWith("/api/experience/playground/start")) return jsonResponse(PLAYGROUND_DATA);
  // CX-6: the shell fetches the mention catalog on mount (best-effort). Serve
  // the empty/default shapes so the picks come from the test-seeded snapshot
  // store instead of the router.
  if (method === "GET" && path.endsWith("/api/personas")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/lorebooks/all")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/scripts/all")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/coauthor/skills")) return jsonResponse({ entries: SKILL_CATALOG_ENTRIES, errors: [] });
  // PM-6: the shell's useAgentPlan fetches the script-owned plan once per
  // scriptId (module-level cache in use-agent-plan.ts — one GET per unique
  // id per process, which is exactly what the apiCalls assertions below see).
  if (method === "GET" && /\/api\/scripts\/[^/]+\/agent-plan$/.test(path)) {
    return jsonResponse({ plan: router.agentPlan });
  }
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

// The ExperiencePlayground (inside the sandbox modal) drives discoverExperience
// (the auto-derive, discover-only), runExperienceTest (the absorbed tester's
// discover) and startExperiencePlayground. All are served by the fetch router
// above (POST /api/experience/test/discover, /test/run and
// /api/experience/playground/start), so the ER-14 send-to-copilot flow is
// observable through the REAL shell → child → callback → controller → client →
// router wiring — with no module mocks.
// CX-6: the shell's mount-time catalog fetch hits the skills endpoint; the
// loader test seeds one entry so the pinned pill resolves its display label.
const SKILL_CATALOG_ENTRIES = [
  {
    id: "s1",
    source: "builtin",
    name: "My Skill",
    description: "d",
    manifestPath: "s1/SKILL.md",
    shadowsBuiltin: false,
  },
];

const TEST_RUN_DATA: Awaited<ReturnType<typeof import("../../../../api/experience-api.js").runExperienceTest>> = {
  definition: {
    apiVersion: 1,
    manifest: { id: "round", name: "Round", mode: "turn" },
    declaredCapabilities: [{ capability: "participants", reason: "x" }],
    hasChoose: false,
    hasFlavor: false,
    hasUpdate: false,
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
  seatLegality: { seats: [], turnOwners: [] },
};
const PLAYGROUND_DATA: Awaited<ReturnType<typeof import("../../../../api/experience-api.js").startExperiencePlayground>> = {
  playgroundSessionId: "pg-shell-1",
  initialState: {},
  state: { round: 1 },
  projection: { state: { round: 1 }, actions: [{ type: "score", label: "Score" }] },
  events: [],
  effects: [],
  pendingTimers: 0,
  seed: 42,
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
const realCopilotProfileModal = await import("../../../shared/agent-shell/AgentProfileModal.js");
mock.module("../../../shared/agent-shell/AgentProfileModal.js", () => ({
  ...realCopilotProfileModal,
  AgentProfileModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="copilot-profile-modal-stub" /> : null),
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
const outcomesBeforeShellSuite = useAgentReviewOutcomeStore.getState().outcomesByThread;
const supersededBeforeShellSuite = useAgentReviewOutcomeStore.getState().supersededByThread;
beforeAll(async () => {
  globalThis.fetch = fetchRouter as unknown as typeof globalThis.fetch;
  ({ render, fireEvent, waitFor, act } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ EditorState } = await import("@codemirror/state"));
  ({ ExperienceCopilotShell } = await import("./ExperienceCopilotShell.js"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  useAgentReviewOutcomeStore.setState({ outcomesByThread: outcomesBeforeShellSuite, supersededByThread: supersededBeforeShellSuite });
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
    contextLinks: [],
    todo: [],
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
  useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {} });
  useAgentReviewOutcomeStore.setState({ outcomesByThread: outcomesBeforeShellSuite, supersededByThread: supersededBeforeShellSuite });
  // The review round + the persisted localStorage draft now SURVIVE shell
  // unmounts (the whole point of the round store) — reset both, or a
  // previous test's hanging review leaks into the next mount.
  useAgentReviewRoundStore.setState({ roundsByThread: {} });
  localStorage.clear();
  // CX-6: the mention catalog reads the live snapshot store — reset it so a
  // previous test's seeded characters don't leak into the next test's popover.
  useSnapshotStore.setState({ allCharacters: [] });
  useProviderDataStore.setState({ profiles: PROFILES });
  // Reset the persisted per-kind binding between tests (the shell restores
  // it from the bootstrap map — SC-0e; the legacy global pair is untouched).
  const current = useBootstrapStore.getState().data;
  if (current) {
    useBootstrapStore.setState({ data: { ...current, agentKindSettings: {} } });
  }
  router = {
    activeThread: null,
    messages: [],
    sessions: [],
    newSession: thread("thread-new"),
    activateReturns: null,
    streamEvents: [FINISH_STOP],
    nextStreamFailures: 0,
    holdStreamOpen: false,
    releaseStream: null,
    contextLinks: [],
    contextLinksFail: false,
    agentPlan: EMPTY_PLAN,
  };
  fetchRouter.mockClear();
});

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim, so every key-based assertion keeps passing). This silences
// react-i18next's NO_I18NEXT_INSTANCE warning from the @-mention popover
// WITHOUT touching the process-global i18n singleton: initI18n() has no reset
// and would poison sibling files sharing the worker (R13).
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

// The provider must wrap BOTH the initial render and every rerender: a root
// element type change between render and rerender unmounts/remounts the tree.
function withIsolatedI18n(node: ReactNode) {
  return <I18nextProvider i18n={makeIsolatedI18n()}>{node}</I18nextProvider>;
}

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
  const utils = render(withIsolatedI18n(<ExperienceCopilotShell {...props} />));
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
    expect(getByText("agent_subtitle")).toBeDefined();
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

describe("ExperienceCopilotShell — agent plan panel (PM-6)", () => {
  // The plan owner cache in use-agent-plan.ts is MODULE-level (one entry per
  // script id, never evicted), so every case here renders the shell with a
  // UNIQUE scriptId — that is what makes `router.agentPlan` deterministic per
  // test despite the shared cache (same trick the review tests use for
  // buffer content).
  const PLAN: AgentPlan = {
    goal: "Ship the editor",
    constraints: [],
    tasks: [
      { id: "t1", title: "Design the turn loop", body: "", status: "completed" },
      { id: "t2", title: "Write the rules buffer", body: "", status: "active" },
      { id: "t3", title: "Bind the visual", body: "", status: "pending" },
    ],
  };

  it("mounts the AgentPlanPanel DIRECTLY below the meter, fed by useAgentPlan's GET", async () => {
    router.activeThread = thread("thread-1");
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];
    router.agentPlan = PLAN;

    const { getByTestId } = renderShell({ scriptId: "script-plan-mount" });
    await flushSessionLoad();

    const meter = getByTestId("copilot-context-meter");
    // Mount order: the panel is the meter's IMMEDIATE next sibling (the pinned
    // stack stays header → meter → panel → feed — unchanged from the todo era).
    await waitFor(() => {
      const panel = getByTestId("agent-plan-panel");
      expect(meter.nextElementSibling).toBe(panel);
    });
    // Fed by the hook: collapsed summary shows the active task + remaining.
    const panel = getByTestId("agent-plan-panel");
    expect(panel.getAttribute("data-state")).toBe("collapsed");
    expect(panel.textContent).toContain("Write the rules buffer");
    expect(panel.textContent).toContain("· 2");
    // The panel's data came over the script-scoped route (not the thread wire).
    expect(apiCalls("GET", /\/api\/scripts\/script-plan-mount\/agent-plan$/)).toHaveLength(1);
  });

  it("stays hidden when the stored plan is empty", async () => {
    router.activeThread = thread("thread-1");
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];
    router.agentPlan = EMPTY_PLAN;

    const { getByTestId, queryByTestId } = renderShell({ scriptId: "script-plan-empty" });
    await flushSessionLoad();

    expect(getByTestId("copilot-context-meter")).toBeDefined();
    expect(queryByTestId("agent-plan-panel")).toBeNull();
  });

  it("locks the editor button while a turn streams (locked = ctrl.isSending)", async () => {
    router.activeThread = thread("thread-1");
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];
    router.agentPlan = PLAN;
    // Hang the stream so isSending stays true while we assert the locked state.
    router.holdStreamOpen = true;

    const { container, getByTestId } = renderShell({ scriptId: "script-plan-locked" });
    await flushSessionLoad();
    await waitFor(() => expect(getByTestId("agent-plan-panel")).toBeDefined());

    const editorButton = getByTestId("agent-plan-open-editor");
    expect((editorButton as HTMLButtonElement).disabled).toBe(false);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);

    await waitFor(() => expect((getByTestId("agent-plan-open-editor") as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("ExperienceCopilotShell — todo panel (TAG-8, restored PM-7)", () => {
  const PLAN = [
    { status: "completed", title: "Design the turn loop" },
    { status: "active", title: "Write the rules buffer" },
    { status: "pending", title: "Bind the visual" },
  ] as const;

  it("mounts the panel DIRECTLY below the meter, seeded from the thread wire todo", async () => {
    router.activeThread = { ...thread("thread-1"), todo: [...PLAN] };
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];

    const { getByTestId, queryByTestId } = renderShell();
    await flushSessionLoad();

    const meter = getByTestId("copilot-context-meter");
    const panel = getByTestId("copilot-todo-panel");
    // Mount order: the panel is the meter's IMMEDIATE next sibling (the pinned
    // stack is header → meter → todo → plan → feed; the plan panel is hidden
    // here because the stored plan is empty — the independent-hiding contract).
    expect(meter.nextElementSibling).toBe(panel);
    expect(queryByTestId("agent-plan-panel")).toBeNull();
    // Seeded from the wire: collapsed summary shows the active goal + remaining.
    expect(panel.getAttribute("data-state")).toBe("collapsed");
    expect(panel.textContent).toContain("Write the rules buffer");
    expect(panel.textContent).toContain("· 2");
    // The panel state went through the session-scoped store (not local).
    expect(useAgentTurnStore.getState().getTodo("experience", "thread-1")).toHaveLength(3);
  });

  it("stays hidden when the thread wire todo is empty", async () => {
    router.activeThread = thread("thread-1"); // todo: []
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];

    const { getByTestId, queryByTestId } = renderShell();
    await flushSessionLoad();

    expect(getByTestId("copilot-context-meter")).toBeDefined();
    expect(queryByTestId("copilot-todo-panel")).toBeNull();
  });

  it("reflects the live `todo` tool call (store rewrite → panel re-renders)", async () => {
    router.activeThread = thread("thread-1"); // todo: [] → hidden at first
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];

    const { getByTestId, queryByTestId } = renderShell();
    await flushSessionLoad();
    expect(queryByTestId("copilot-todo-panel")).toBeNull();

    act(() => {
      useAgentTurnStore.getState().setTodo("experience", "thread-1", [
        { status: "active", title: "Fresh plan step" },
      ]);
    });

    const panel = getByTestId("copilot-todo-panel");
    expect(panel.textContent).toContain("Fresh plan step");
    expect(panel.textContent).toContain("· 1");
  });
});

describe("ExperienceCopilotShell — todo + plan coexistence (PM-7)", () => {
  const TODO = [
    { status: "active", title: "Tweak the copy" },
  ] as const;
  const PLAN: AgentPlan = {
    goal: "Ship the editor",
    constraints: [],
    tasks: [
      { id: "t1", title: "Design the turn loop", body: "", status: "completed" },
      { id: "t2", title: "Write the rules buffer", body: "", status: "active" },
    ],
  };

  it("both panels mounted: todo DIRECTLY ABOVE the plan section (owner ruling: todo = session, plan = script)", async () => {
    router.activeThread = { ...thread("thread-1"), todo: [...TODO] };
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];
    router.agentPlan = PLAN;

    const { getByTestId } = renderShell({ scriptId: "script-coexist-both" });
    await flushSessionLoad();

    const meter = getByTestId("copilot-context-meter");
    await waitFor(() => expect(getByTestId("agent-plan-panel")).toBeDefined());
    const todoPanel = getByTestId("copilot-todo-panel");
    const planPanel = getByTestId("agent-plan-panel");
    // Pinned stack: header → meter → TODO → PLAN → feed — todo above plan.
    expect(meter.nextElementSibling).toBe(todoPanel);
    expect(todoPanel.nextElementSibling).toBe(planPanel);
    // Both render their own data (todo's current step; plan's active task).
    expect(todoPanel.textContent).toContain("Tweak the copy");
    expect(planPanel.textContent).toContain("Write the rules buffer");
  });

  it("each panel hides independently: plan shown while todo empty", async () => {
    router.activeThread = thread("thread-1"); // todo: [] → todo hidden
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];
    router.agentPlan = PLAN;

    const { getByTestId, queryByTestId } = renderShell({ scriptId: "script-coexist-plan-only" });
    await flushSessionLoad();

    await waitFor(() => expect(getByTestId("agent-plan-panel")).toBeDefined());
    expect(queryByTestId("copilot-todo-panel")).toBeNull();
    // The plan panel is the meter's immediate sibling again (todo rendered nothing).
    expect(getByTestId("copilot-context-meter").nextElementSibling).toBe(getByTestId("agent-plan-panel"));
  });

  it("each panel hides independently: todo shown while the plan is empty", async () => {
    router.activeThread = { ...thread("thread-1"), todo: [...TODO] };
    router.messages = [msg({ id: "u1", role: "user", content: "hi" })];
    router.agentPlan = EMPTY_PLAN;

    const { getByTestId, queryByTestId } = renderShell({ scriptId: "script-coexist-todo-only" });
    await flushSessionLoad();

    expect(getByTestId("copilot-todo-panel")).toBeDefined();
    expect(queryByTestId("agent-plan-panel")).toBeNull();
    // Session switching never touches the plan: it stays the empty-plan GET.
    expect(apiCalls("GET", /\/api\/scripts\/script-coexist-todo-only\/agent-plan$/)).toHaveLength(1);
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
    fireEvent.click(getByRole("radio", { name: "agent_code" }));

    const cmEl = container.querySelector<HTMLElement>(".cm-editor");
    expect(cmEl).not.toBeNull();
    const view = EditorView.findFromDOM(cmEl!);
    expect(view).not.toBeNull();
    expect(view!.state.doc.toString()).toBe("// rules buffer");

    // Switch to the Visual buffer.
    fireEvent.click(getByRole("radio", { name: "agent_visual" }));

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
    fireEvent.click(first.getByRole("radio", { name: "agent_code" }));
    fireEvent.click(first.getByRole("radio", { name: "agent_visual" }));

    expect(first.getByTestId("copilot-visual-validator").textContent).toContain("agent_visual_problems");
    expect(first.getByTestId("copilot-visual-validator").textContent).toContain("script block 1");
    first.unmount();

    // A compile-clean visual shows the OK chip instead.
    const clean = "<style>.x{c:red}</style>\n<div></div>\n<script>var a = 1;</script>";
    const second = renderShell({ visualSource: clean });
    await flushSessionLoad();
    fireEvent.click(second.getByRole("radio", { name: "agent_code" }));
    fireEvent.click(second.getByRole("radio", { name: "agent_visual" }));
    expect(second.getByTestId("copilot-visual-validator").textContent).toContain("agent_visual_valid");
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
    expect(getByRole("radio", { name: "agent_preview" })).toBeDefined();
    expect(getByRole("radio", { name: "agent_code" })).toBeDefined();
    expect(getByRole("radio", { name: "agent_try_it" })).toBeDefined();
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
    fireEvent.click(getByRole("radio", { name: "agent_preview" }));
    expect(getByText("experience_playground_no_visual")).toBeDefined();
    expect(queryByTestId("experience-frame-stub")).toBeNull();
  });

  it("the Try tab renders the playground inline (no sandbox modal)", async () => {
    const { getByRole, getByTestId, queryByTestId } = renderShell();
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));

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

    fireEvent.click(getByRole("tab", { name: "agent_tab_edit" }));
    expect(hasHiddenClass(chatPane)).toBe(true);
    expect(hasHiddenClass(editPane)).toBe(false);

    // The unified outer toggle lives in the Edit pane: the Try tab is present
    // (XU-6 — the old sandbox "Test it" button is gone).
    expect(getByRole("radio", { name: "agent_try_it" })).toBeDefined();
  });

  it("guards the whole mobile flex column with min-w-0 (4a: the 844px tablist blow-out)", async () => {
    // Regression pin, 2026-08-17 audit (MOBILE_AND_PROMPT_FIXES_REPORT 4a defect 2):
    // the mobile branch used to render `flex min-h-0 flex-1 flex-col` divs with
    // no min-width guard. A content-driven min-content width inside the chat
    // pane then inflated every flex item up the chain (min-width:auto) and
    // pushed the Чат/Правка tablist off-screen (844px on a 390px viewport).
    // The desktop branch pins widths (w-[440px] shrink-0 / min-w-0), so this
    // only manifested on mobile. happy-dom does not compute layout, so the pin
    // asserts the guard classes on the real rendered DOM chain.
    mobileOverride = true;
    router.activeThread = thread("thread-1");
    router.messages = [msg({ id: "u1", role: "user", content: "guards" })];

    const { getByTestId, getByRole } = renderShell();
    await flushSessionLoad();

    const tablist = getByRole("tablist");
    expect(tablist.classList.contains("min-w-0")).toBe(true);

    const shellRoot = tablist.parentElement;
    if (!(shellRoot instanceof HTMLElement)) throw new Error("shell root missing");
    expect(shellRoot.classList.contains("min-w-0")).toBe(true);

    const chatPane = getByTestId("copilot-pane-chat");
    const editPane = getByTestId("copilot-pane-edit");
    expect(chatPane.classList.contains("min-w-0")).toBe(true);
    expect(editPane.classList.contains("min-w-0")).toBe(true);

    const panesContainer = chatPane.parentElement;
    if (!(panesContainer instanceof HTMLElement)) throw new Error("panes container missing");
    expect(panesContainer.classList.contains("min-w-0")).toBe(true);

    // Shared pane roots (used by BOTH branches — on desktop their widths are
    // pinned by the branch wrappers, so the guard is a no-op there).
    const chatRoot = chatPane.firstElementChild;
    if (!(chatRoot instanceof HTMLElement)) throw new Error("chat pane content root missing");
    expect(chatRoot.classList.contains("min-w-0")).toBe(true);
    const editRoot = editPane.firstElementChild;
    if (!(editRoot instanceof HTMLElement)) throw new Error("edit pane content root missing");
    expect(editRoot.classList.contains("min-w-0")).toBe(true);

    // The message list root must not re-open the hole between the pane and
    // the (internally scrollable) message scroller.
    const messageListRoot = chatPane.querySelector('[data-testid="copilot-message-list"]');
    if (!(messageListRoot instanceof HTMLElement)) throw new Error("message list root missing");
    expect(messageListRoot.classList.contains("min-w-0")).toBe(true);

    // 4a follow-up round 2: on mobile the EDIT pane content root is the single
    // scroll document — the toolbar wall (visual buffer ~322px) scrolls away
    // with the code instead of pinning above a ~72px flex remainder.
    expect(editRoot.classList.contains("max-md:overflow-y-auto")).toBe(true);
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

    fireEvent.click(getByRole("radio", { name: "agent_visual" }));
    expect(queryByTestId("rules-toolbar-slot")).toBeNull();
  });

  it("renders visualToolbar in the Visual buffer and hides it in the Rules buffer", async () => {
    const { getByTestId, queryByTestId, getByRole } = renderShell({
      visualToolbar: <div data-testid="visual-toolbar-slot">visual toolbar</div>,
    });
    await flushSessionLoad();

    // Default editorBuffer is rules → the visual slot is absent.
    expect(queryByTestId("visual-toolbar-slot")).toBeNull();

    fireEvent.click(getByRole("radio", { name: "agent_visual" }));
    expect(getByTestId("visual-toolbar-slot")).toBeDefined();

    fireEvent.click(getByRole("radio", { name: "agent_rules" }));
    expect(queryByTestId("visual-toolbar-slot")).toBeNull();
  });
});

describe("ExperienceCopilotShell — creation mode (ER-13d-1)", () => {
  it("renders a 3-position OUTER toggle (preview/code/try)", async () => {
    const { getByRole } = renderShell({ creationMode: true });
    await flushSessionLoad();

    // Identity i18n: the creation labels resolve through `t` (key-as-string
    // fallback without a LocaleProvider).
    expect(getByRole("radio", { name: "agent_preview" })).toBeDefined();
    expect(getByRole("radio", { name: "agent_code" })).toBeDefined();
    expect(getByRole("radio", { name: "agent_try_it" })).toBeDefined();
  });

  it("try position renders the playground inline and hides the code editor + toolbar buttons", async () => {
    const { container, getByRole, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));

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

    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));
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
    fireEvent.click(getByRole("radio", { name: "agent_visual" }));

    expect(getByTestId("visual-toolbar-slot")).toBeDefined();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(queryByTestId("copilot-toolbar-tester")).toBeNull();
    expect(queryByTestId("copilot-toolbar-preview")).toBeNull();
    expect(queryByTestId("copilot-toolbar-sandbox")).toBeNull();
  });

  it("preview position shows the empty-state in creation mode (no preview modal)", async () => {
    const { getByRole, getByText, queryByTestId } = renderShell({ creationMode: true });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "agent_preview" }));
    expect(getByText("experience_playground_no_visual")).toBeDefined();
    expect(queryByTestId("copilot-preview-modal")).toBeNull();
    // XU-4: the tester modal is gone entirely.
    expect(queryByTestId("copilot-tester-modal")).toBeNull();
  });
});

describe("ExperienceCopilotShell — provider binding persistence (SC-0e: per-kind)", () => {
  /** Seed the persisted per-kind binding. The bootstrap store starts empty
   * in tests (no bootstrap fetch), so synthesize a minimal data record when
   * needed — the shell only reads `data.agentKindSettings["experience"]`
   * from it (was: the global `uiSettings` copilot pair — owner decision 2
   * moved the source to the kind's settings, SC-0d/0e). */
  function seedBinding(providerId: string | null, modelName: string | null): void {
    const current = useBootstrapStore.getState().data;
    const base = current ?? {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: {
        ...wireUiSettings(),
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
        copilotProviderId: null,
        copilotModelName: null,
        updatedAt: "",
      },
      agentKindSettings: {},
      isArmServer: false,
    };
    useBootstrapStore.setState({
      data: {
        ...base,
        agentKindSettings: {
          ...base.agentKindSettings,
          experience: {
            agentKind: "experience",
            providerProfileId: providerId,
            modelName,
            defaultProfileId: null,
            updatedAt: "",
            servesChatModes: [],
          },
        },
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
    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));
    fireEvent.click(getByText("experience_playground_diagnostics"));
    fireEvent.click(getByText("experience_tester_run"));
    // The playground's auto-derive POSTs the discover-only endpoint once on mount;
    // the explicit discover is the ONLY run call.
    await waitFor(() => expect(apiCalls("POST", /\/api\/experience\/test\/discover$/).length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(apiCalls("POST", /\/api\/experience\/test\/run$/).length).toBeGreaterThanOrEqual(1));
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
    fireEvent.click(getByRole("radio", { name: "agent_code" }));

    // The digest text sits in the chat input, prefilled for the user to send.
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(0);

    // The manual send posts the digest as the user message with testFeedback.
    fireEvent.click(getByTestId("copilot-send-btn"));
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    const body = streamCalls()[0]!.body!;
    expect(body.testFeedback).toMatchObject({ ok: true, status: "active" });
    expect(body.launchContext).toEqual({
      participants: [{ id: "you", label: "You", controller: "human" }],
      capabilityGrants: ["participants"],
      settings: {},
    });
    expect(body.step).not.toBe("test");
    expect(typeof body.content).toBe("string");
    expect((body.content as string).length).toBeGreaterThan(0);
  });

  it("playground send: the inline-Try playground copies a diagnostics digest into the input; manual send carries it", async () => {
    const { getByTestId, getByText, getByRole, findByText, container } = renderShell();
    await flushSessionLoad();

    // Switch to the Try tab (inline playground) + start a session.
    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));
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
    fireEvent.click(getByRole("radio", { name: "agent_code" }));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(0);
    fireEvent.click(getByTestId("copilot-send-btn"));

    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    const body = streamCalls()[0]!.body!;
    expect(body.testFeedback).toMatchObject({ ok: true, status: "active", revision: 0 });
    expect(body.launchContext).toMatchObject({
      participants: [{ id: "you", label: "You", controller: "human" }],
      capabilityGrants: [],
      settings: {},
    });
    const startBody = apiCalls("POST", /\/api\/experience\/playground\/start$/)[0]!.body!;
    expect((body.launchContext as { seed?: string }).seed).toBe(
      (startBody as { seed?: string }).seed,
    );
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
      withIsolatedI18n(
        <ExperienceCopilotShell
          scriptId="script-1"
          rulesCode="// rules buffer v2"
          visualSource="// visual buffer"
          onRulesChange={onRulesChange}
          onVisualChange={mock()}
        />,
      ),
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
      withIsolatedI18n(
        <ExperienceCopilotShell
          scriptId="script-1"
          rulesCode="// rules buffer v2"
          visualSource="// visual buffer"
          onRulesChange={mock()}
          onVisualChange={mock()}
          creationMode
        />,
      ),
    );
    expect(queryByTestId("copilot-toolbar-revert")).not.toBeNull();
    // …but the try (sandbox) position has no code editor / review affordances.
    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));
    expect(queryByTestId("copilot-toolbar-revert")).toBeNull();
  });
});

describe("ExperienceCopilotShell — RO-4: resolved outcomes through real HTTP", () => {
  const BASE = "// rules buffer\nconst keep = 1;\nconst tail = 2.";
  const PROPOSED = "// RULES v2\nconst keep = 1;\nconst tail = 22.";

  function ControlledShell({ initialRules = BASE, rulesOverride, onRulesCode }: { initialRules?: string; rulesOverride?: string; onRulesCode?: (rules: string) => void }) {
    const [rulesCode, setRulesCode] = useState(initialRules);
    useEffect(() => {
      if (rulesOverride !== undefined) setRulesCode(rulesOverride);
    }, [rulesOverride]);
    return (
      <ExperienceCopilotShell
        scriptId="ro4-supervisor-script"
        rulesCode={rulesCode}
        onRulesChange={(rules) => {
          setRulesCode(rules);
          onRulesCode?.(rules);
        }}
        visualSource=""
        onVisualChange={() => {}}
        rulesSaved={rulesCode === initialRules}
        visualSaved={true}
      />
    );
  }

  async function sendFollowup(utils: ReturnType<typeof render>, content: string, count: number) {
    const textarea = utils.container.querySelector<HTMLTextAreaElement>("textarea")!;
    fireEvent.change(textarea, { target: { value: content } });
    fireEvent.click(utils.getByTestId("copilot-send-btn"));
    await waitFor(() => expect(streamCalls()).toHaveLength(count));
    await flushSessionLoad();
    return experienceCopilotStreamRequestSchema.parse(streamCalls()[count - 1]!.body);
  }

  async function openReview(utils: ReturnType<typeof render>, threadId: string) {
    return openReviewProposal(utils, threadId, PROPOSED);
  }

  /** RO-6: the raw stream bodies this mounted flow sent (1-based call numbers), pinned
   *  against the shared fixture the server suite replays into the provider prompt. */
  function sentCopilotRequests(scenario: string, calls: readonly number[]): ReviewOutcomeFixture {
    const sent = streamCalls();
    return {
      surface: "copilot",
      scenario,
      requests: calls.map((call) => ({ mode: "stream" as const, body: sent[call - 1]!.body })),
    };
  }

  async function openReviewProposal(utils: ReturnType<typeof render>, threadId: string, proposed: string) {
    await flushSessionLoad();
    await sendFollowup(utils, "propose changes", 1);
    await act(async () => {
      useAgentTurnStore.getState().upsertActivity("experience", threadId, {
        toolCallId: "ro4-supervisor-proposal",
        toolName: "write_buffer",
        status: "done",
        target: "rules",
        proposed,
        summary: "header and tail",
      });
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());
  }

  function awaitingAskMessages(threadId: string): ExperienceCopilotMessageWire[] {
    const toolCallId = "ro4-ask-tool-call";
    const question = "Which buffer should change?";
    const options = ["Rules", "Visual"];
    return [
      msg({ id: "ro4-ask-user", threadId, role: "user", content: "Please clarify" }),
      msg({
        id: "ro4-ask-carrier",
        threadId,
        role: "assistant",
        content: "",
        toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId, toolName: "ask_user", input: { question, options, recommended: "Rules" } }]),
      }),
      msg({
        id: "ro4-ask-result",
        threadId,
        role: "tool",
        toolCallId,
        content: JSON.stringify({ toolName: "ask_user", output: { status: "awaiting_answer", question, options, recommended: "Rules" } }),
      }),
    ];
  }

  it("toolbar revert of a fully accepted round reports cancelled on two following HTTP turns", async () => {
    const threadId = "ro4-supervisor-full-revert";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);

    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    fireEvent.click(utils.getByTestId("copilot-toolbar-revert"));
    await waitFor(() => expect(utils.queryByTestId("copilot-toolbar-revert")).toBeNull());

    for (const count of [2, 3]) {
      const body = await sendFollowup(utils, `explain revert ${count}`, count);
      expect(body.rules).toBe(BASE);
      expect(body.rulesSaved).toBe(true);
      expect(body.visualSaved).toBe(true);
      expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({ outcome: "cancelled" });
    }
    await expectReviewOutcomeFixture("copilot-revert-cancelled", sentCopilotRequests("toolbar revert of a fully accepted round, two following turns", [2, 3]));
  });

  it("cancel of a partially accepted round retains cancelled rather than recomputing rejected in HTTP", async () => {
    const threadId = "ro4-supervisor-partial-cancel";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    const body = await sendFollowup(utils, "explain cancelled review", 2);
    expect(body.rules).toBe(BASE);
    expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({ outcome: "cancelled" });
    await expectReviewOutcomeFixture("copilot-partial-cancel", sentCopilotRequests("cancel of a partially accepted round", [2]));
  });

  it("reverting accepted rules preserves a rejected visual outcome that never changed the buffer", async () => {
    const threadId = "ro4-supervisor-revert-target-isolation";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);
    await act(async () => {
      useAgentTurnStore.getState().upsertActivity("experience", threadId, {
        toolCallId: "ro4-supervisor-visual-proposal",
        toolName: "write_buffer",
        status: "done",
        target: "visual",
        proposed: "<div>proposed visual</div>",
        summary: "visual proposal",
      });
    });
    fireEvent.click(utils.getByRole("radio", { name: "agent_visual" }));
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());
    fireEvent.click(utils.getByTestId("copilot-dismiss-pending"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    fireEvent.click(utils.getByRole("radio", { name: "agent_rules" }));
    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    fireEvent.click(utils.getByTestId("copilot-toolbar-revert"));
    await waitFor(() => expect(utils.queryByTestId("copilot-toolbar-revert")).toBeNull());

    const body = await sendFollowup(utils, "explain rules-only revert", 2);
    expect(body.rules).toBe(BASE);
    expect(body.visual).toBe("");
    expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({ outcome: "cancelled" });
    expect(body.reviewSnapshot?.targets.find((target) => target.target === "visual")).toMatchObject({ outcome: "rejected" });
    await expectReviewOutcomeFixture("copilot-revert-rules-keep-visual-rejection", sentCopilotRequests("rules revert beside a rejected visual proposal", [2]));
  });

  it("a replacement proposal reports the superseded round identity without inheriting its applied hunks", async () => {
    const threadId = "ro4-supervisor-supersession";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));

    const priorBody = await sendFollowup(utils, "revise the pending proposal", 2);
    const prior = priorBody.reviewSnapshot?.targets.find((target) => target.target === "rules");
    expect(prior).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 1, rejected: 0, pending: 1 } });
    await act(async () => {
      useAgentTurnStore.getState().upsertActivity("experience", threadId, {
        toolCallId: "ro4-supervisor-replacement-proposal",
        toolName: "write_buffer",
        status: "done",
        target: "rules",
        proposed: "// RULES v3\nconst keep = 1;\nconst tail = 333.",
        summary: "revised header and tail",
      });
    });
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(2));

    const body = await sendFollowup(utils, "explain the replacement", 3);
    const current = body.reviewSnapshot?.targets.find((target) => target.target === "rules" && target.roundId !== prior?.roundId);
    expect(current).toMatchObject({ outcome: "awaiting", hunks: { accepted: 0, rejected: 0, pending: 2 } });
    expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules" && target.roundId === prior?.roundId)).toMatchObject({
      outcome: "superseded",
      supersededByRound: current?.roundId,
    });
    await expectReviewOutcomeFixture("copilot-supersession", sentCopilotRequests("a replacement proposal supersedes a partially applied round", [2, 3]));
  });

  it("retries a failed normal send with the same partial review snapshot and independent save flags", async () => {
    const threadId = "ro4-normal-retry";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));

    router.nextStreamFailures = 1;
    const failed = await sendFollowup(utils, "retry this review", 2);
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());
    const retried = await sendFollowup(utils, "retry this review", 3);
    const failedReview = failed.reviewSnapshot?.targets.find((target) => target.target === "rules");
    const retriedReview = retried.reviewSnapshot?.targets.find((target) => target.target === "rules");

    expect(failed).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(retried).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(failedReview).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 1, rejected: 0, pending: 1 } });
    expect(retriedReview).toEqual(failedReview);
    expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1);
    await expectReviewOutcomeFixture("copilot-send-error-retry", sentCopilotRequests("failed normal send and its retry", [2, 3]));
  });

  it("rolls back a failed ask answer and retries its review snapshot through the rendered ask card", async () => {
    const threadId = "ro4-ask-retry";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));

    router.messages = awaitingAskMessages(threadId);
    await sendFollowup(utils, "show the question", 2);
    await waitFor(() => expect(utils.getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("awaiting"));

    router.nextStreamFailures = 1;
    fireEvent.click(utils.getByTestId("copilot-ask-chip-0"));
    await waitFor(() => expect(streamCalls()).toHaveLength(3));
    await waitFor(() => expect(utils.getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("awaiting"));
    const failed = experienceCopilotStreamRequestSchema.parse(streamCalls()[2]!.body);

    fireEvent.click(utils.getByTestId("copilot-ask-chip-0"));
    await waitFor(() => expect(streamCalls()).toHaveLength(4));
    const retried = experienceCopilotStreamRequestSchema.parse(streamCalls()[3]!.body);
    const failedReview = failed.reviewSnapshot?.targets.find((target) => target.target === "rules");
    const retriedReview = retried.reviewSnapshot?.targets.find((target) => target.target === "rules");

    expect(failed.answer).toEqual({ toolCallId: "ro4-ask-tool-call", text: "Rules" });
    expect(retried.answer).toEqual(failed.answer);
    expect(failed).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(retried).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(failedReview).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 1, rejected: 0, pending: 1 } });
    expect(retriedReview).toEqual(failedReview);
    await expectReviewOutcomeFixture("copilot-ask-answer-retry", sentCopilotRequests("failed ask_user answer and its retry", [3, 4]));
  });

  it("keeps only cleanly anchored accepted hunks applied across two HTTP turns", async () => {
    const threadId = "ro4-accept-drift";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);
    utils.rerender(withIsolatedI18n(<ControlledShell rulesOverride={BASE.replace("// rules buffer", "// external header")} />));
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    const first = await sendFollowup(utils, "explain anchored change", 2);
    const second = await sendFollowup(utils, "explain anchored change again", 3);
    const firstReview = first.reviewSnapshot?.targets.find((target) => target.target === "rules");
    const secondReview = second.reviewSnapshot?.targets.find((target) => target.target === "rules");

    expect(first.rules).toContain("// external header");
    expect(first.rules).toContain("const tail = 22.");
    expect(first).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(firstReview).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 1, rejected: 0, pending: 1 } });
    expect(secondReview).toEqual(firstReview);
    await expectReviewOutcomeFixture("copilot-manual-edit-before-accept", sentCopilotRequests("manual buffer edit, then accept-all applies only anchored hunks", [2, 3]));
  });

  it("resolves an explicit tooLarge acceptance when the live parent buffer already equals the proposal", async () => {
    const threadId = "ro4-too-large-already-applied";
    const base = Array.from({ length: 900 }, (_, index) => `base-${index}`).join("\n");
    const proposed = Array.from({ length: 900 }, (_, index) => `proposed-${index}`).join("\n");
    const onRulesCode = mock();
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell initialRules={base} onRulesCode={onRulesCode} />));
    await openReviewProposal(utils, threadId, proposed);
    utils.rerender(withIsolatedI18n(<ControlledShell initialRules={base} rulesOverride={proposed} onRulesCode={onRulesCode} />));
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    const body = await sendFollowup(utils, "explain wholesale acceptance", 2);
    const review = body.reviewSnapshot?.targets.find((target) => target.target === "rules");

    expect(body.rules).toBe(proposed);
    expect(body).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(review).toMatchObject({ outcome: "applied", hunks: { accepted: 1, rejected: 0, pending: 0 } });
    expect(onRulesCode).not.toHaveBeenCalled();
  });

  it("cancelling a drifted round retains only accepted hunks whose reverse anchor still exists", async () => {
    const threadId = "ro4-cancel-drift";
    const base = ["start", "A: old", ...Array.from({ length: 6 }, (_, index) => `a-gap-${index}`), "B: old", ...Array.from({ length: 6 }, (_, index) => `b-gap-${index}`), "C: old", "end"].join("\n");
    const proposed = base.replace("A: old", "A: new").replace("B: old", "B: new").replace("C: old", "C: new");
    let liveRules = base;
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell initialRules={base} onRulesCode={(rules) => { liveRules = rules; }} />));
    await openReviewProposal(utils, threadId, proposed);
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(2));
    utils.rerender(withIsolatedI18n(<ControlledShell initialRules={base} rulesOverride={liveRules.replace("A: new", "A: drift")} onRulesCode={(rules) => { liveRules = rules; }} />));
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(2));

    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    const first = await sendFollowup(utils, "explain partial cancellation", 2);
    const second = await sendFollowup(utils, "explain partial cancellation again", 3);
    const firstReview = first.reviewSnapshot?.targets.find((target) => target.target === "rules");
    const secondReview = second.reviewSnapshot?.targets.find((target) => target.target === "rules");

    expect(first.rules).toContain("A: drift");
    expect(first.rules).toContain("B: old");
    expect(first.rules).toContain("C: old");
    expect(firstReview).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 1, rejected: 2, pending: 0 } });
    expect(secondReview).toEqual(firstReview);
    await expectReviewOutcomeFixture("copilot-cancel-after-manual-edit", sentCopilotRequests("manual edit after a partial accept, then cancel keeps the surviving hunk", [2, 3]));
  });

  it("cumulatively applies separately accepted hunks into the controlled parent buffer and HTTP snapshot", async () => {
    const threadId = "ro4-cumulative-individual-accept";
    const base = ["start", "A: old", ...Array.from({ length: 6 }, (_, index) => `a-gap-${index}`), "B: old", ...Array.from({ length: 6 }, (_, index) => `b-gap-${index}`), "C: old", "end"].join("\n");
    const proposed = base.replace("A: old", "A: new").replace("B: old", "B: new").replace("C: old", "C: new");
    let liveRules = base;
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell initialRules={base} onRulesCode={(rules) => { liveRules = rules; }} />));
    await openReviewProposal(utils, threadId, proposed);

    const first = utils.container.querySelectorAll<HTMLButtonElement>(".cm-copilotDiffAccept")[0]!;
    fireEvent.click(first);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(2));
    expect(liveRules).toContain("A: new");
    expect(liveRules).toContain("B: old");
    expect(liveRules).toContain("C: old");

    const second = utils.container.querySelectorAll<HTMLButtonElement>(".cm-copilotDiffAccept")[0]!;
    fireEvent.click(second);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    expect(liveRules).toContain("A: new");
    expect(liveRules).toContain("B: new");
    expect(liveRules).toContain("C: old");

    const partial = await sendFollowup(utils, "explain cumulative partial acceptance", 2);
    const partialReview = partial.reviewSnapshot?.targets.find((target) => target.target === "rules");
    expect(partial.rules).toBe(liveRules);
    expect(partial).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(partialReview).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 2, rejected: 0, pending: 1 } });

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    expect(liveRules).toContain("A: new");
    expect(liveRules).toContain("B: new");
    expect(liveRules).toContain("C: new");

    for (const count of [3, 4]) {
      const body = await sendFollowup(utils, `explain cumulative completion ${count}`, count);
      expect(body.rules).toBe(liveRules);
      expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
        roundId: partialReview?.roundId,
        outcome: "applied",
        hunks: { accepted: 3, rejected: 0, pending: 0 },
      });
    }
    await expectReviewOutcomeFixture("copilot-partial-then-full-apply", sentCopilotRequests("partial local apply before Save, then full apply over two following turns", [2, 3, 4]));
  });

  it("accept-all preserves a previously dismissed hunk in both the live buffer and HTTP outcome", async () => {
    const threadId = "ro4-supervisor-dismiss-before-accept-all";
    const base = ["start", "A: old", ...Array.from({ length: 6 }, (_, index) => `a-gap-${index}`), "B: old", ...Array.from({ length: 6 }, (_, index) => `b-gap-${index}`), "C: old", "end"].join("\n");
    const proposed = base.replace("A: old", "A: new").replace("B: old", "B: new").replace("C: old", "C: new");
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell initialRules={base} />));
    await openReviewProposal(utils, threadId, proposed);

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffDismiss")).toHaveLength(2));
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffDismiss")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    for (const count of [2, 3]) {
      const body = await sendFollowup(utils, `explain preserved rejection ${count}`, count);
      expect(body.rules).toContain("A: new");
      expect(body.rules).toContain("B: old");
      expect(body.rules).toContain("C: new");
      expect(body).toMatchObject({ rulesSaved: false, visualSaved: true });
      expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
        outcome: "applied-partial",
        hunks: { accepted: 2, rejected: 1, pending: 0 },
      });
    }
  });

  it("accept-all preserves a previously dismissed visual hunk in the live buffer and HTTP outcome", async () => {
    const threadId = "ro4-supervisor-visual-dismiss-before-accept-all";
    const base = ["<main>", "A: old", ...Array.from({ length: 6 }, (_, index) => `a-gap-${index}`), "B: old", ...Array.from({ length: 6 }, (_, index) => `b-gap-${index}`), "C: old", "</main>"].join("\n");
    const proposed = base.replace("A: old", "A: new").replace("B: old", "B: new").replace("C: old", "C: new");
    function ControlledVisualShell() {
      const [visualSource, setVisualSource] = useState(base);
      return <ExperienceCopilotShell scriptId="ro4-supervisor-visual-script" rulesCode={BASE} onRulesChange={() => {}} visualSource={visualSource} onVisualChange={setVisualSource} rulesSaved={true} visualSaved={visualSource === base} />;
    }
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledVisualShell />));
    await flushSessionLoad();
    fireEvent.click(utils.getByRole("radio", { name: "agent_code" }));
    fireEvent.click(utils.getByRole("radio", { name: "agent_visual" }));
    await sendFollowup(utils, "propose visual changes", 1);
    await act(async () => {
      useAgentTurnStore.getState().upsertActivity("experience", threadId, {
        toolCallId: "ro4-supervisor-visual-proposal",
        toolName: "write_buffer",
        status: "done",
        target: "visual",
        proposed,
        summary: "visual changes",
      });
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffDismiss")).toHaveLength(2));
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffDismiss")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    for (const count of [2, 3]) {
      const body = await sendFollowup(utils, `explain preserved visual rejection ${count}`, count);
      expect(body.visual).toContain("A: new");
      expect(body.visual).toContain("B: old");
      expect(body.visual).toContain("C: new");
      expect(body).toMatchObject({ rulesSaved: true, visualSaved: false });
      expect(body.reviewSnapshot?.targets.find((target) => target.target === "visual")).toMatchObject({
        outcome: "applied-partial",
        hunks: { accepted: 2, rejected: 1, pending: 0 },
      });
    }
    await expectReviewOutcomeFixture("copilot-visual-mixed", sentCopilotRequests("visual: dismissed hunk survives accept-all over two turns", [2, 3]));
  });

  it("retains an actual accepted-and-dismissed round as partial across two following requests", async () => {
    const threadId = "ro4-mixed-accept-dismiss";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    fireEvent.click(utils.getByTestId("copilot-dismiss-pending"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    for (const count of [2, 3]) {
      const body = await sendFollowup(utils, `explain mixed result ${count}`, count);
      expect(body.rules).toBe("// RULES v2\nconst keep = 1;\nconst tail = 2.");
      expect(body).toMatchObject({ rulesSaved: false, visualSaved: true });
      expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
        outcome: "applied-partial",
        hunks: { accepted: 1, rejected: 1, pending: 0 },
      });
    }
    await expectReviewOutcomeFixture("copilot-mixed-accept-reject", sentCopilotRequests("one hunk accepted, the rest rejected, over two turns", [2, 3]));
  });

  it("retains an actual full rejection without changing the clean parent buffer", async () => {
    const threadId = "ro4-full-rejection";
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, threadId);

    fireEvent.click(utils.getByTestId("copilot-dismiss-pending"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    for (const count of [2, 3]) {
      const body = await sendFollowup(utils, `explain rejection ${count}`, count);
      expect(body.rules).toBe(BASE);
      expect(body).toMatchObject({ rulesSaved: true, visualSaved: true });
      expect(body.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
        outcome: "rejected",
        hunks: { accepted: 0, rejected: 2, pending: 0 },
      });
    }

    utils.unmount();
    const remounted = render(withIsolatedI18n(<ControlledShell />));
    await flushSessionLoad();
    const afterRemount = await sendFollowup(remounted, "explain rejection after remount", 4);
    expect(afterRemount.rules).toBe(BASE);
    expect(afterRemount).toMatchObject({ rulesSaved: true, visualSaved: true });
    expect(afterRemount.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
      outcome: "rejected",
      hunks: { accepted: 0, rejected: 2, pending: 0 },
    });
    await expectReviewOutcomeFixture("copilot-full-rejection-remount", sentCopilotRequests("full rejection over two turns and a remount", [2, 3, 4]));
  });

  it("keeps a completed local application through review-round reset and shell remount", async () => {
    const threadId = "ro4-reset-remount";
    router.newSession = thread(threadId);
    let setMounted: ((mounted: boolean) => void) | undefined;
    function PersistentShell() {
      const [rulesCode, setRulesCode] = useState(BASE);
      const [mounted, setMountedState] = useState(true);
      setMounted = setMountedState;
      return mounted ? (
        <ExperienceCopilotShell
          scriptId="ro4-reset-remount-script"
          rulesCode={rulesCode}
          onRulesChange={setRulesCode}
          visualSource=""
          onVisualChange={() => {}}
          rulesSaved={rulesCode === BASE}
          visualSaved={true}
        />
      ) : null;
    }
    const utils = render(withIsolatedI18n(<PersistentShell />));
    await openReview(utils, threadId);
    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    const completed = await sendFollowup(utils, "explain completed review", 2);
    const completedReview = completed.reviewSnapshot?.targets.find((target) => target.target === "rules");
    expect(completed.rules).toBe(PROPOSED);
    expect(completedReview).toMatchObject({ outcome: "applied", hunks: { accepted: 2, rejected: 0, pending: 0 } });

    act(() => useAgentReviewRoundStore.getState().resetRound("experience", threadId));
    const afterReset = await sendFollowup(utils, "explain after round reset", 3);
    expect(afterReset.rules).toBe(PROPOSED);
    expect(afterReset.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
      roundId: completedReview?.roundId,
      outcome: "applied",
      hunks: { accepted: 2, rejected: 0, pending: 0 },
    });

    act(() => setMounted?.(false));
    await waitFor(() => expect(utils.queryByTestId("copilot-send-btn")).toBeNull());
    act(() => setMounted?.(true));
    await flushSessionLoad();
    const afterRemount = await sendFollowup(utils, "explain after remount", 4);
    expect(afterRemount.rules).toBe(PROPOSED);
    expect(afterRemount.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
      roundId: completedReview?.roundId,
      outcome: "applied",
      hunks: { accepted: 2, rejected: 0, pending: 0 },
    });
    await expectReviewOutcomeFixture("copilot-completed-review-reset-remount", sentCopilotRequests("completed review through a round reset and a remount", [2, 3, 4]));
  });

  it("keeps a pending mixed choice through a normal next turn and remount", async () => {
    const threadId = "ro4-pending-remount";
    router.newSession = thread(threadId);
    let setMounted: ((mounted: boolean) => void) | undefined;
    function PersistentShell() {
      const [rulesCode, setRulesCode] = useState(BASE);
      const [mounted, setMountedState] = useState(true);
      setMounted = setMountedState;
      return mounted ? (
        <ExperienceCopilotShell
          scriptId="ro4-pending-remount-script"
          rulesCode={rulesCode}
          onRulesChange={setRulesCode}
          visualSource=""
          onVisualChange={() => {}}
          rulesSaved={rulesCode === BASE}
          visualSaved={true}
        />
      ) : null;
    }
    const utils = render(withIsolatedI18n(<PersistentShell />));
    await openReview(utils, threadId);
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));

    const afterNextTurn = await sendFollowup(utils, "keep the pending hunk", 2);
    const partialReview = afterNextTurn.reviewSnapshot?.targets.find((target) => target.target === "rules");
    expect(afterNextTurn.rules).toBe("// RULES v2\nconst keep = 1;\nconst tail = 2.");
    expect(partialReview).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 1, rejected: 0, pending: 1 } });

    act(() => setMounted?.(false));
    await waitFor(() => expect(utils.queryByTestId("copilot-send-btn")).toBeNull());
    act(() => setMounted?.(true));
    await flushSessionLoad();
    await waitFor(() => expect(utils.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    const afterRemount = await sendFollowup(utils, "keep it after remount", 3);
    expect(afterRemount.rules).toBe(afterNextTurn.rules);
    expect(afterRemount.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
      roundId: partialReview?.roundId,
      outcome: "applied-partial",
      hunks: { accepted: 1, rejected: 0, pending: 1 },
    });

    fireEvent.click(utils.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!);
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    const completed = await sendFollowup(utils, "accept the restored pending hunk", 4);
    expect(completed.rules).toBe(PROPOSED);
    expect(completed.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
      outcome: "applied",
      hunks: { accepted: 2, rejected: 0, pending: 0 },
    });
  });

  it("isolates thread ledger records and restores the original buffer and outcome on return", async () => {
    const firstThread = "ro4-thread-one";
    const secondThread = "ro4-thread-two";
    router.activeThread = thread(firstThread);
    router.sessions = [thread(firstThread), thread(secondThread)];
    router.messagesFor = () => [];
    const utils = render(withIsolatedI18n(<ControlledShell />));
    await openReview(utils, firstThread);
    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    const firstBody = await sendFollowup(utils, "explain first thread", 2);
    const firstReview = firstBody.reviewSnapshot?.targets.find((target) => target.target === "rules");
    expect(firstBody.rules).toBe(PROPOSED);
    expect(firstReview).toMatchObject({ outcome: "applied", hunks: { accepted: 2, rejected: 0, pending: 0 } });

    router.activateReturns = thread(secondThread);
    fireEvent.click(utils.getByTestId(`copilot-session-${secondThread}`));
    await flushSessionLoad();
    const secondBody = await sendFollowup(utils, "explain second thread", 3);
    expect(secondBody.rules).toBe(PROPOSED);
    expect(secondBody.reviewSnapshot?.targets).toEqual([]);

    router.activateReturns = thread(firstThread);
    fireEvent.click(utils.getByTestId(`copilot-session-${firstThread}`));
    await flushSessionLoad();
    const returned = await sendFollowup(utils, "explain returned thread", 4);
    expect(returned.rules).toBe(PROPOSED);
    expect(returned.reviewSnapshot?.targets.find((target) => target.target === "rules")).toMatchObject({
      roundId: firstReview?.roundId,
      outcome: "applied",
      hunks: { accepted: 2, rejected: 0, pending: 0 },
    });
    await expectReviewOutcomeFixture("copilot-session-switch", sentCopilotRequests("session switch isolates the ledger and the return restores it", [2, 3, 4]));
  });

  it("batch acceptance reverses only the surviving applied anchor after independent drift", async () => {
    const threadId = "ro4-batch-cancel-partial-reverse";
    const base = ["start", "A: old", ...Array.from({ length: 6 }, (_, index) => `a-gap-${index}`), "B: old", ...Array.from({ length: 6 }, (_, index) => `b-gap-${index}`), "C: old", "end"].join("\n");
    const proposed = base.replace("A: old", "A: new").replace("B: old", "B: new").replace("C: old", "C: new");
    let liveRules = base;
    router.newSession = thread(threadId);
    const utils = render(withIsolatedI18n(<ControlledShell initialRules={base} onRulesCode={(rules) => { liveRules = rules; }} />));
    await openReviewProposal(utils, threadId, proposed);

    utils.rerender(withIsolatedI18n(<ControlledShell initialRules={base} rulesOverride={base.replace("C: old", "C: external")} onRulesCode={(rules) => { liveRules = rules; }} />));
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());
    fireEvent.click(utils.getByTestId("copilot-accept-all"));
    await waitFor(() => expect(liveRules).toContain("B: new"));

    const accepted = await sendFollowup(utils, "explain partial batch acceptance", 2);
    const acceptedReview = accepted.reviewSnapshot?.targets.find((target) => target.target === "rules");
    expect(accepted.rules).toContain("A: new");
    expect(accepted.rules).toContain("B: new");
    expect(accepted.rules).toContain("C: external");
    expect(accepted).toMatchObject({ rulesSaved: false, visualSaved: true });
    expect(acceptedReview).toMatchObject({ outcome: "applied-partial", hunks: { accepted: 2, rejected: 0, pending: 1 } });
    const roundId = acceptedReview?.roundId;
    expect(roundId).toBeDefined();

    utils.rerender(withIsolatedI18n(<ControlledShell initialRules={base} rulesOverride={liveRules.replace("A: new", "A: drift")} onRulesCode={(rules) => { liveRules = rules; }} />));
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());
    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());

    for (const count of [3, 4]) {
      const body = await sendFollowup(utils, `explain partial reversal ${count}`, count);
      const review = body.reviewSnapshot?.targets.find((target) => target.target === "rules");
      expect(body.rules).toContain("A: drift");
      expect(body.rules).toContain("B: old");
      expect(body.rules).toContain("C: external");
      expect(body).toMatchObject({ rulesSaved: false, visualSaved: true });
      expect(review).toMatchObject({ roundId, outcome: "applied-partial", hunks: { accepted: 1, rejected: 2, pending: 0 } });
    }
    await expectReviewOutcomeFixture("copilot-revert-of-accepted-partial", sentCopilotRequests("accept-all over external drift, then revert of the accepted hunks", [2, 3, 4]));
  });
});

describe("ExperienceCopilotShell — CD-6: inline review flow", () => {
  it("shows the review bar + tab dot after a proposal and accepts all into the buffer", async () => {
    const onRulesChange = mock();
    const { getByTestId, queryByTestId } = renderShell({ onRulesChange, rulesSaved: false, visualSaved: true });
    await flushSessionLoad();

    // A real turn (snapshot) against the v1 buffers.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edit the rules" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await waitFor(() => expect(apiCalls("GET", /messages$/).length).toBeGreaterThan(0));

    // The turn's write_buffer proposal lands in the live store (as the SSE
    // tool-result path would fill it).
    await act(async () => {
      useAgentTurnStore.setState({
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

    // The real shell → controller → fetch router path reports the successful
    // local application before either independent buffer has been saved.
    fireEvent.change(textarea, { target: { value: "describe the accepted edit" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(2));
    const body = streamCalls()[1]!.body!;
    expect(body.rulesSaved).toBe(false);
    expect(body.visualSaved).toBe(true);
    expect((body.reviewSnapshot as { targets: Array<{ target: string; outcome: string }> }).targets.map(({ target, outcome }) => ({ target, outcome }))).toEqual([
      { target: "rules", outcome: "applied" },
    ]);
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
    await act(async () => {
      useAgentTurnStore.setState({
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
      useAgentTurnStore.setState({
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
    utils.rerender(withIsolatedI18n(<ExperienceCopilotShell {...utils.props} rulesCode={HYBRID} onRulesChange={onRulesChange} />));
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    fireEvent.click(utils.getByTestId("copilot-cancel-all"));
    expect(onRulesChange).toHaveBeenLastCalledWith(BASE);
    await waitFor(() => expect(utils.queryByTestId("copilot-review-bar")).toBeNull());
    // RV-3: the round is cancelled WITHOUT popping the snapshot / clearTurn —
    // the live turn's activities survive (the toolbar revert is a separate path).
    expect(useAgentTurnStore.getState().turnsByThread["thread-new"]?.length).toBeGreaterThan(0);
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
      withIsolatedI18n(
        <ExperienceCopilotShell
          {...utils.props}
          rulesCode={HYBRID.replace("const keep = 1;", "const keep = 999;")}
          onRulesChange={onRulesChange}
        />,
      ),
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
    await act(async () => {
      useAgentTurnStore.setState({
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
      useAgentTurnStore.setState({
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

  // Direct store writes re-render the mounted shell outside React's event flow
  // — wrap the trigger in act() so no "not wrapped in act" warning fires.
  function seedProposal(text: string) {
    act(() => {
      useAgentTurnStore.setState({
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
    await act(async () => {
      useAgentTurnStore.setState({
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
    });

    // The visual round shows on the visual tab…
    fireEvent.click(getByRole("radio", { name: "agent_visual" }));
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());

    // …while the rules tab stays RESOLVED: no re-lit review bar, no dot. The
    // old combined proposalKey reset BOTH accepted sets on any buffer change,
    // re-lighting hunks the user had already accepted (and saved).
    fireEvent.click(getByRole("radio", { name: "agent_rules" }));
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

    await act(async () => {
      useAgentTurnStore.setState({
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
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    // External drift: the template tool rewrote the whole buffer — no hunk can
    // anchor. Accept-all must skip BOTH hunks, warn, and write NOTHING.
    utils.rerender(
      withIsolatedI18n(
        <ExperienceCopilotShell
          {...utils.props}
          rulesCode="// HAND-EDITED BUFFER"
          onRulesChange={onRulesChange}
        />,
      ),
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

    await act(async () => {
      useAgentTurnStore.setState({
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
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    // Drift away from the MIDDLE line only: the header hunk and the tail hunk
    // still anchor; they splice onto the drifted text (no clobber of the edit).
    utils.rerender(
      withIsolatedI18n(
        <ExperienceCopilotShell
          {...utils.props}
          rulesCode={base.replace("const keep = 1;", "const keep = 999;")}
          onRulesChange={onRulesChange}
        />,
      ),
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
      useAgentTurnStore.setState({
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
      useAgentTurnStore.setState({
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
    useAgentTurnStore.setState({ turnsByThread: {} });
    useAgentReviewRoundStore.setState({ roundsByThread: {} });

    // Fresh page load: the shell's mount effect rehydrates from localStorage.
    const second = renderShell({ rulesCode: HYBRID, onRulesChange: mock() });
    await flushSessionLoad();

    await waitFor(() => expect(second.getByTestId("copilot-review-bar")).toBeDefined());
    await waitFor(() => expect(second.container.querySelectorAll(".cm-copilotDiffAccept")).toHaveLength(1));
    expect(second.container.querySelector<HTMLButtonElement>(".cm-copilotDiffAccept")!.dataset.hunkId).toBe("1");
  });
});

// ─── CX-6: pinned-context pills + @-mention pick → PATCH ────────────────────

describe("ExperienceCopilotShell — pinned context (CX-6)", () => {
  /** The mention popover's listbox (i18n is uninitialized in this process, so
   *  the aria-label is the raw key — the ONLY listbox with that label; cmdk
   *  (the model DropdownSelect) renders its own role=option rows elsewhere). */
  const mentionListbox = () =>
    document.body.querySelector('[role="listbox"][aria-label="copilot_mention_picker_label"]');

  it("loads the active thread's contextLinks and renders its pill with the catalog label", async () => {
    router.activeThread = { ...thread("thread-1"), contextLinks: [{ targetType: "skill", targetId: "s1" }] };
    router.messages = [msg({ id: "u1", role: "user", content: "hello" })];

    const { getByTestId } = renderShell();
    await flushSessionLoad();

    // The pill resolves "My Skill" from the mounted catalog's skills entry.
    await waitFor(() => expect(getByTestId("copilot-context-pill-skill-s1").textContent).toContain("My Skill"));
  });

  it("@-pick PATCHes the appended link and shows the new pill", async () => {
    router.activeThread = thread("thread-1");
    router.messages = [msg({ id: "u1", role: "user", content: "hello" })];
    useSnapshotStore.setState({
      allCharacters: [
        {
          id: "ch1",
          name: "Alice",
          subtitle: "wanderer",
          tags: [],
          avatarAssetId: null,
          avatarFullAssetId: null,
          avatarCropJson: null,
          avatarExt: null,
          avatarFullExt: null,
          updatedAt: "",
        },
      ],
    });

    const { getByTestId } = renderShell();
    await flushSessionLoad();

    const ta = getByTestId("copilot-chat-input") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "@Al" } });
    ta.setSelectionRange(3, 3);
    fireEvent.select(ta);

    await waitFor(() =>
      expect(mentionListbox()?.querySelectorAll('[role="option"]')).toHaveLength(1),
    );
    fireEvent.keyDown(ta, { key: "Enter" });

    await waitFor(() => {
      const patches = apiCalls("PATCH", /\/api\/experience-copilot\/thread-1\/context-links$/);
      expect(patches).toHaveLength(1);
      expect(patches[0]?.body).toEqual({ links: [{ targetType: "character", targetId: "ch1" }] });
    });
    await waitFor(() => expect(getByTestId("copilot-context-pill-character-ch1").textContent).toContain("Alice"));
  });

  it("a failing PATCH reverts the pill (optimistic rollback)", async () => {
    router.activeThread = thread("thread-1");
    router.messages = [msg({ id: "u1", role: "user", content: "hello" })];
    router.contextLinksFail = true;
    useSnapshotStore.setState({
      allCharacters: [
        {
          id: "ch1",
          name: "Alice",
          subtitle: "wanderer",
          tags: [],
          avatarAssetId: null,
          avatarFullAssetId: null,
          avatarCropJson: null,
          avatarExt: null,
          avatarFullExt: null,
          updatedAt: "",
        },
      ],
    });

    const { queryByTestId, getByTestId } = renderShell();
    await flushSessionLoad();

    const ta = getByTestId("copilot-chat-input") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "@Al" } });
    ta.setSelectionRange(3, 3);
    fireEvent.select(ta);

    await waitFor(() =>
      expect(mentionListbox()?.querySelectorAll('[role="option"]')).toHaveLength(1),
    );
    fireEvent.keyDown(ta, { key: "Enter" });

    await waitFor(() => expect(apiCalls("PATCH", /context-links$/)).toHaveLength(1));
    // The optimistic pill appeared, then the 500 reverted it.
    await waitFor(() => expect(queryByTestId("copilot-context-pill-character-ch1")).toBeNull());
  });

  it("unpinning a pill PATCHes the filtered set and removes it", async () => {
    router.activeThread = {
      ...thread("thread-1"),
      contextLinks: [{ targetType: "character", targetId: "ch1" }],
    };
    router.messages = [msg({ id: "u1", role: "user", content: "hello" })];
    useSnapshotStore.setState({
      allCharacters: [
        {
          id: "ch1",
          name: "Alice",
          subtitle: "wanderer",
          tags: [],
          avatarAssetId: null,
          avatarFullAssetId: null,
          avatarCropJson: null,
          avatarExt: null,
          avatarFullExt: null,
          updatedAt: "",
        },
      ],
    });

    const { queryByTestId, getByTestId } = renderShell();
    await flushSessionLoad();

    await waitFor(() => expect(getByTestId("copilot-context-pill-character-ch1")).toBeDefined());
    fireEvent.click(getByTestId("copilot-context-pill-remove-character-ch1"));

    await waitFor(() => {
      const patches = apiCalls("PATCH", /\/api\/experience-copilot\/thread-1\/context-links$/);
      expect(patches[0]?.body).toEqual({ links: [] });
    });
    // Optimistic removal: the pill disappears immediately (the PATCH succeeded,
    // so there is no revert).
    await waitFor(() => expect(queryByTestId("copilot-context-pill-character-ch1")).toBeNull());
  });
});

describe("ExperienceCopilotShell — E6 mobile management surfaces (MOBILE_DEFECTS_ROUND_2)", () => {
  it("onBack renders a chevron left of the tablist; editTabHeader renders at the top of the edit pane", async () => {
    mobileOverride = true;
    const onBack = mock();
    const { getByTestId } = renderShell({ onBack, editTabHeader: <div data-testid="e6-header-node">management cluster</div> });
    // Settle the mount-time loadSession chain inside act (every other test
    // does this via flushSessionLoad — without it the chain lands outside
    // act() and warns repeatedly).
    await flushSessionLoad();

    const chevron = getByTestId("copilot-mobile-back");
    expect(chevron.getAttribute("aria-label")).toBe("experience_editor_back");
    // The tablist proper is the chevron's next row sibling.
    expect(chevron.nextElementSibling?.getAttribute("role")).toBe("tablist");

    // The header node lives INSIDE the edit pane, above the editor pane.
    const editPane = getByTestId("copilot-pane-edit");
    const header = getByTestId("e6-header-node");
    expect(header.closest('[data-testid="copilot-pane-edit"]')).not.toBeNull();
    expect(editPane.firstElementChild).toBe(header.parentElement);

    fireEvent.click(chevron);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("editTabDirty badges the Правка tab while Чат is active — and neither renders on desktop", async () => {
    mobileOverride = true;
    const { getByTestId, findByRole } = renderShell({ editTabDirty: true });
    await flushSessionLoad();

    const editTab = await findByRole("tab", { name: "agent_tab_edit" });
    expect(editTab.querySelector("span[aria-hidden]")).not.toBeNull();
    // Чат stays the visible pane (no auto-switch — the deliberate difference
    // from co-author's CA-14).
    expect(hasHiddenClass(getByTestId("copilot-pane-chat"))).toBe(false);
    expect(hasHiddenClass(getByTestId("copilot-pane-edit"))).toBe(true);

    // Desktop: neither the chevron slot nor the header slot renders, and the
    // dirty flag produces no badge.
    mobileOverride = false;
    const desktop = renderShell({ editTabDirty: true });
    await flushSessionLoad();
    expect(desktop.queryByTestId("copilot-mobile-back")).toBeNull();
    expect(desktop.queryByTestId("copilot-edit-tab-header")).toBeNull();
    expect(desktop.container.querySelector('[role="tablist"] span[aria-hidden]')).toBeNull();
  });
});

// ── SS-7B2: script trust threading to the inline playground ─────────────

describe("ExperienceCopilotShell — script trust threading (SS-7B2)", () => {
  it("threads an untrusted import: the playground renders the shared auto-skip state and no discovery POST fires", async () => {
    const { getByRole, getByTestId, queryByTestId } = renderShell({
      script: { origin: "imported", firstEnabledAt: null },
    });
    await flushSessionLoad();

    jest.useFakeTimers();
    try {
      fireEvent.click(getByRole("radio", { name: "agent_try_it" }));

      // The shared localized auto-skip state renders (identity i18n — the
      // shared message key verbatim) instead of the discovery-driven no-fields
      // line: the editor-threaded trust data reached the playground.
      expect(getByTestId("playground-auto-skip").textContent).toBe("script_safety_checks_after_enabling");
      expect(queryByTestId("playground-no-fields")).toBeNull();

      // Advance past the debounce deterministically: the auto-derive POST
      // would have fired by now if the guard had not skipped it.
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(apiCalls("POST", /\/api\/experience\/test\/discover$/)).toHaveLength(0);
      expect(apiCalls("POST", /\/api\/experience\/test\/run$/)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("in-app parity: the playground's debounced auto-discovery POSTs as before", async () => {
    const { getByRole, queryByTestId } = renderShell({
      script: { origin: "in_app", firstEnabledAt: null },
    });
    await flushSessionLoad();

    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));

    await waitFor(
      () => expect(apiCalls("POST", /\/api\/experience\/test\/discover$/).length).toBeGreaterThanOrEqual(1),
      { timeout: 4000 },
    );
    expect(queryByTestId("playground-auto-skip")).toBeNull();
  });

  it("playground findings Show in code leaves Try, opens Rules, and refreshes the same-line reveal", async () => {
    const { container, findByTestId, getByRole, getByText } = renderShell({
      rulesCode: "const safe = 1;\nconst value = eval('x');",
      script: { origin: "imported", firstEnabledAt: null },
    });
    await flushSessionLoad();
    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));
    fireEvent.click(getByText("experience_playground_start"));
    await findByTestId("script-safety-findings-modal");
    fireEvent.click(getByText("script_safety_findings_show_in_code"));

    await waitFor(() => expect(getByRole("radio", { name: "agent_code" }).getAttribute("aria-checked")).toBe("true"));
    const firstView = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
    if (!firstView) throw new Error("rules editor missing");
    const findingPosition = firstView.state.doc.line(2).from;
    expect(firstView.state.selection.main.head).toBe(findingPosition);

    firstView.dispatch({ selection: { anchor: 0 } });
    expect(firstView.state.selection.main.head).toBe(0);
    fireEvent.click(getByRole("radio", { name: "agent_try_it" }));
    fireEvent.click(getByText("experience_playground_start"));
    await findByTestId("script-safety-findings-modal");
    fireEvent.click(getByText("script_safety_findings_show_in_code"));
    await waitFor(() => expect(EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)?.state.selection.main.head).toBe(findingPosition));
  });
});

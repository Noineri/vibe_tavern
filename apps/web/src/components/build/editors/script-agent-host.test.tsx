/**
 * Script agent host — behavioral tests (AS-9, AGENT_SHELL_PLAN Wave 4 closer).
 *
 * Drives the REAL generic AgentShell with kind "script" through the host's
 * real transport (fetch-level router — no mock.module on the api modules, so
 * this file coexists with any other test file sharing the bun worker).
 * The RELIABILITY contract mirrors ExperienceCopilotShell.test.tsx: the
 * router serves canned payloads, globalThis.fetch is swapped in beforeAll
 * and restored in afterAll, and every process-global store touched here is
 * reset in beforeEach.
 *
 * Pins:
 *   - a write_buffer proposal for `code` shows hunk review and Apply writes
 *     the draft (the host's single-buffer session over the shared review
 *     primitives);
 *   - a dice script's send carries scriptKind: "dice" in its send options;
 *   - mobile shows the [Chat][Edit] tab row (both panes mounted, tab switch
 *     toggles visibility, the edit-tab dirty dot lights while a proposal is
 *     pending);
 *   - an imported never-enabled (untrusted) script shows the trust-refusal
 *     card when the model's run_script_test is refused.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { afterAll, beforeAll, beforeEach, describe, it, expect, mock } from "bun:test";
import { wireScript } from "../../../../test/wire-fixtures.js";
import type { ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import type { ScriptLinkRecord, ScriptRecord } from "../../../api/types.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import type { LinkTarget } from "../../shared/LinkBindingPopover.js";
import type { ScriptAgentHostProps } from "./script-agent-host.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../../stores/agent-review-store.js";
import { useAgentReviewOutcomeStore } from "../../../stores/agent-review-outcome-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useScriptSafetySettingsStore } from "../../../stores/script-safety-settings-store.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = false;

// ── Fetch-level API router ───────────────────────────────────────────────
// Same rationale as ExperienceCopilotShell.test.tsx: mock.module on the api
// modules is process-global and silently stops applying when another test
// file shares the bun process, so the transport seam is faked at the FETCH
// level instead. The REAL hono / SSE clients run against a router serving
// canned payloads. globalThis.fetch is swapped in beforeAll and restored in
// afterAll — no module registry is touched.
interface RouterState {
  activeThread: ExperienceCopilotThreadWire | null;
  messages: ExperienceCopilotMessageWire[];
  sessions: ExperienceCopilotThreadWire[];
  newSession: ExperienceCopilotThreadWire;
  streamEvents: string[];
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

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/active$/.test(path)) {
    return jsonResponse(router.activeThread);
  }
  if (method === "POST" && /\/api\/experience-copilot\/script\/[^/]+\/session$/.test(path)) {
    return jsonResponse(router.newSession);
  }
  if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/sessions$/.test(path)) {
    return jsonResponse(router.sessions);
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
    return jsonResponse(router.messages);
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    return jsonResponse({ metrics: null, autoCompact: true });
  }
  if (method === "PATCH" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    return jsonResponse({ metrics: null, autoCompact: true });
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    return jsonResponse([]);
  }
  if (method === "PATCH" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    return jsonResponse([]);
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream$/.test(path)) {
    return sseResponse(router.streamEvents);
  }
  // NOTE: the gateway base resolves to "/null" under happy-dom (unset env
  // falls back to `String(null)` in build-config) — route on path SUFFIXES,
  // never exact equality.
  if (method === "GET" && /\/api\/scripts\/[^/]+\/agent-plan$/.test(path)) {
    return jsonResponse({ plan: { goal: "", constraints: [], tasks: [] } });
  }
  if (method === "GET" && path.endsWith("/api/personas")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/lorebooks/all")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/scripts/all")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/coauthor/skills")) return jsonResponse({ entries: [], errors: [] });
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
// only cares that message/activity text reaches the list.
const realMarkdown = await import("../../../lib/markdown.js");
mock.module("../../../lib/markdown.js", () => ({
  ...realMarkdown,
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The editing surface's owner picker (LinkBindingPopover) anchors Radix
// popovers that never mount under happy-dom. The picker is pinned in its own
// suite — stub it here to a deterministic double (same shape as the
// ScriptEditor suite's double).
mock.module("../../shared/LinkBindingPopover.js", () => ({
  LinkBindingPopover: (props: {
    links: Array<{ targetType: string; targetId: string }>;
    onSetLinks: (links: Array<{ targetType: string; targetId: string }>) => void;
  }) => (
    <div data-testid="script-owner-picker">
      {props.links.map((link) => (
        <button
          key={`${link.targetType}:${link.targetId}`}
          type="button"
          onClick={() => props.onSetLinks(props.links.filter((candidate) => candidate !== link))}
        >
          {link.targetId}
        </button>
      ))}
      <button type="button" onClick={() => props.onSetLinks([...props.links, { targetType: "persona", targetId: "persona-2" }])}>add-persona</button>
      <button type="button" onClick={() => props.onSetLinks([...props.links, { targetType: "lorebook", targetId: "lb-1" }])}>add-mixed</button>
    </div>
  ),
}));

// The shell reads `useIsMobile` only through the host props here (AgentShell
// takes isMobile as a prop), but the editing surface reads the hook —
// override it with the same mutable cell so both halves agree.
const realMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;
let AgentShell: typeof import("../../shared/agent-shell/AgentShell.js").AgentShell;

const realFetch = globalThis.fetch;
const outcomesBeforeSuite = useAgentReviewOutcomeStore.getState().outcomesByThread;
const supersededBeforeSuite = useAgentReviewOutcomeStore.getState().supersededByThread;
const safetyBeforeSuite = useScriptSafetySettingsStore.getState().suppressImportWarnings;
beforeAll(async () => {
  globalThis.fetch = fetchRouter as unknown as typeof globalThis.fetch;
  ({ render, fireEvent, waitFor, act } = await import("@testing-library/react"));
  ({ AgentShell } = await import("../../shared/agent-shell/AgentShell.js"));
  // The script host self-registers (registerAgentHost("script")) as a module
  // side effect — the shell resolves it by kind at render time. Without this
  // import the shell would throw "unknown agent kind".
  await import("./script-agent-host.js");
});
afterAll(() => {
  globalThis.fetch = realFetch;
  useAgentReviewOutcomeStore.setState({ outcomesByThread: outcomesBeforeSuite, supersededByThread: supersededBeforeSuite });
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: safetyBeforeSuite });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function thread(id: string, scriptId: string): ExperienceCopilotThreadWire {
  return {
    id,
    scriptId,
    draftSessionId: null,
    title: "Script agent",
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    metrics: null,
    contextLinks: [],
    todo: [],
  };
}

// p1 carries one tool-capable cached model so the REAL `useProviderModels`
// hook serves the model list from cache (no fetch) — the send path needs a
// resolved provider + model or it toasts and never streams.
const PROFILES = [
  {
    id: "p1",
    name: "OpenAI Pro",
    cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }] },
  },
] as unknown as ProviderProfileRecord[];

const BASE_CODE = "// code buffer\nconst keep = 1;\nconst tail = 2.";
const PROPOSED_CODE = "// CODE v2\nconst keep = 1;\nconst tail = 22.";

function makeScript(over: Partial<ScriptRecord> = {}): ScriptRecord {
  return {
    ...wireScript(),
    id: "script-under-test",
    name: "Test Script",
    code: BASE_CODE,
    scriptKind: "prompt",
    ...over,
  };
}

function makeHostProps(script: ScriptRecord, isMobile: boolean, over: Partial<ScriptAgentHostProps> = {}): ScriptAgentHostProps {
  return {
    isMobile,
    activeScript: script,
    activeScriptId: script.id,
    draftDirty: false,
    apiRefOpen: false,
    scriptSafetyExtensions: [],
    characterName: undefined,
    scriptLinks: [],
    linkCharacters: [],
    linkPersonas: [],
    onSetScriptLinks: mock(),
    onUpdateDraft: mock(),
    onToggleApiRef: mock(),
    onAddFromTemplate: mock(),
    onRevealLine: mock(),
    ...over,
  };
}

beforeEach(() => {
  mobileOverride = false;
  useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {} });
  useAgentReviewRoundStore.setState({ roundsByThread: {} });
  useAgentReviewOutcomeStore.setState({ outcomesByThread: outcomesBeforeSuite, supersededByThread: supersededBeforeSuite });
  // The ScriptTester inside the editing surface skips its settings fetch when
  // the singleton is already loaded — seed it so no settings request fires.
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  localStorage.clear();
  useSnapshotStore.setState({ allCharacters: [] });
  useProviderDataStore.setState({ profiles: PROFILES });
  const current = useBootstrapStore.getState().data;
  if (current) {
    useBootstrapStore.setState({ data: { ...current, uiSettings: { ...current.uiSettings, copilotProviderId: null, copilotModelName: null } } });
  }
  router = {
    activeThread: null,
    messages: [],
    sessions: [],
    newSession: thread("script-thread-new", "script-under-test"),
    streamEvents: [FINISH_STOP],
  };
  fetchRouter.mockClear();
});

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim, so every key-based assertion keeps passing). This silences
// react-i18next's NO_I18NEXT_INSTANCE warning WITHOUT touching the
// process-global i18n singleton: initI18n() has no reset and would poison
// sibling files sharing the worker (R13).
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

function renderScriptShell(
  script: ScriptRecord,
  hostOver: Partial<ScriptAgentHostProps> = {},
  shellOver: { isMobile?: boolean; editTabDirty?: boolean; onBack?: () => void } = {},
) {
  const isMobile = shellOver.isMobile ?? mobileOverride;
  const hostProps = makeHostProps(script, isMobile, hostOver);
  const utils = render(
    withIsolatedI18n(
      <AgentShell
        kind="script"
        ownerId={script.id}
        scriptId={script.id}
        isMobile={isMobile}
        editTabDirty={shellOver.editTabDirty}
        onBack={shellOver.onBack}
        hostProps={hostProps}
      />,
    ),
  );
  return { ...utils, hostProps };
}

/**
 * Drain the chained async `loadSession` microtasks (and React's scheduler
 * macrotasks) inside `act`, so its `setThreadId`/`setMessages` updates are
 * captured and do not emit React 19 "not wrapped in act" warnings. Mirrors
 * the bounded drain in `test/dom-env.ts`.
 */
async function flushSessionLoad() {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function hasHiddenClass(el: HTMLElement): boolean {
  return el.className.split(/\s+/).includes("hidden");
}

describe("script-agent-host — write_buffer hunk review (AS-9)", () => {
  it("a write_buffer proposal for `code` shows hunk review and Apply writes the draft", async () => {
    const onUpdateDraft = mock();
    const script = makeScript({ id: "script-review", code: BASE_CODE });
    const { getByTestId } = renderScriptShell(script, { onUpdateDraft });
    await flushSessionLoad();

    // A real turn (snapshot) against the code buffer.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "rewrite it" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();

    // The turn's write_buffer proposal lands in the live store (as the SSE
    // tool-result path would fill it).
    await act(async () => {
      useAgentTurnStore.getState().upsertActivity("script", "script-thread-new", {
        toolCallId: "w1",
        toolName: "write_buffer",
        status: "done",
        target: "code",
        proposed: PROPOSED_CODE,
        summary: "rewrite",
      });
    });

    // The review bar appears with the pending count.
    await waitFor(() => expect(getByTestId("copilot-review-bar")).toBeDefined());
    expect(getByTestId("copilot-review-count").textContent).toContain("copilot_review_hunks_count");

    // Accept-all writes the proposed buffer into the draft.
    fireEvent.click(getByTestId("copilot-accept-all"));
    expect(onUpdateDraft).toHaveBeenCalledWith({ code: PROPOSED_CODE });
  });
});

describe("script-agent-host — dice send options (AS-9)", () => {
  it("a dice script sends scriptKind: dice with the live draft code", async () => {
    const diceCode = "const roll = context.dice.roll('1d20');\ncontext.state.set('roll', roll.total);";
    // draftDirty → the buffer's save state travels as codeSaved: false.
    const script = makeScript({ id: "script-dice", scriptKind: "dice", code: diceCode });
    renderScriptShell(script, { draftDirty: true });
    await flushSessionLoad();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "roll it" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));

    // The per-turn send options: the LIVE merged draft (never a stale DB
    // read), the runtime kind, and the buffer's save state.
    const body = streamCalls()[0]!.body!;
    expect(body).toMatchObject({ code: diceCode, scriptKind: "dice", codeSaved: false });
  });
});

describe("script-agent-host — mobile tabs (AS-9)", () => {
  it("shows the [Chat][Edit] tab row: both panes mounted, tab switch toggles visibility, dirty dot on pending", async () => {
    mobileOverride = true;
    const onBack = mock();
    const script = makeScript({ id: "script-mobile", code: BASE_CODE });
    const utils = renderScriptShell(script, {}, { isMobile: true, onBack });
    await flushSessionLoad();

    // 2-tab bar + both panes mounted; the mobile back chevron carries the
    // shared generic back wording (the shell owns no back copy of its own).
    expect(utils.getByRole("tablist")).toBeDefined();
    expect(utils.getByRole("tab", { name: "agent_tab_chat" })).toBeDefined();
    expect(utils.getByRole("tab", { name: "agent_tab_edit" })).toBeDefined();
    const chevron = utils.getByTestId("copilot-mobile-back");
    expect(chevron.getAttribute("aria-label")).toBe("import_back");
    const chatPane = utils.getByTestId("copilot-pane-chat");
    const editPane = utils.getByTestId("copilot-pane-edit");
    expect(hasHiddenClass(chatPane)).toBe(false);
    expect(hasHiddenClass(editPane)).toBe(true);

    fireEvent.click(utils.getByRole("tab", { name: "agent_tab_edit" }));
    expect(hasHiddenClass(chatPane)).toBe(true);
    expect(hasHiddenClass(editPane)).toBe(false);
    fireEvent.click(utils.getByRole("tab", { name: "agent_tab_chat" }));
    expect(hasHiddenClass(chatPane)).toBe(false);
    expect(hasHiddenClass(editPane)).toBe(true);

    fireEvent.click(chevron);
    expect(onBack).toHaveBeenCalledTimes(1);

    // A real turn snapshots the code buffer; the model's write_buffer answer
    // then hangs as a pending proposal (as the SSE tool-result path would
    // fill it — the review needs the snapshot base, so the send comes first).
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "rewrite it" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();
    await act(async () => {
      useAgentTurnStore.getState().upsertActivity("script", "script-thread-new", {
        toolCallId: "w-mobile",
        toolName: "write_buffer",
        status: "done",
        target: "code",
        proposed: PROPOSED_CODE,
        summary: "rewrite",
      });
    });
    await waitFor(() => expect(utils.getByTestId("copilot-review-bar")).toBeDefined());

    // A pending proposal lights the edit-tab dirty dot while Chat stays the
    // visible pane (no auto-switch — the deliberate shell contract).
    utils.rerender(
      withIsolatedI18n(
        <AgentShell
          kind="script"
          ownerId={script.id}
          scriptId={script.id}
          isMobile
          editTabDirty
          onBack={onBack}
          hostProps={makeHostProps(script, true)}
        />,
      ),
    );
    const editTab = utils.getByRole("tab", { name: "agent_tab_edit" });
    expect(editTab.querySelector("span[aria-hidden]")).not.toBeNull();
    expect(hasHiddenClass(utils.getByTestId("copilot-pane-chat"))).toBe(false);
    expect(hasHiddenClass(utils.getByTestId("copilot-pane-edit"))).toBe(true);
  });
});

describe("script-agent-host — trust refusal (AS-9)", () => {
  it("an imported never-enabled script shows the trust-refusal card when the model's test is refused", async () => {
    // The script under authoring: imported, never enabled — its code does not
    // run (not even for tests) until the user reviews the import warning and
    // enables it in the editor.
    const script = makeScript({ id: "script-trust", origin: "imported", firstEnabledAt: null, enabled: false });
    // The backend's structured refusal envelope (script-agent-tools: a refusal,
    // never a throw, so the model can relay the reason in the same turn).
    const refusal = {
      ok: false,
      errorCode: "script_not_trusted",
      errorMessage:
        "script is imported and never enabled — enable it in the editor first: its code does not run (not even for tests) until the user reviews the import warning and enables it through the import-warning flow; tell the user this",
    };
    router.streamEvents = [
      `event: tool-call\ndata: ${JSON.stringify({ toolCallId: "run-1", toolName: "run_script_test", args: { input: "hello" } })}\n\n`,
      `event: tool-result\ndata: ${JSON.stringify({ toolCallId: "run-1", toolName: "run_script_test", output: refusal })}\n\n`,
      FINISH_STOP,
    ];
    const { findByTestId, queryByTestId } = renderScriptShell(script);
    await flushSessionLoad();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "test it" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));

    // The refused test surfaces as a tool card carrying the refusal envelope
    // (the controller's generic non-proposal branch: always a done card with
    // the best-effort string summary) — and opens NO hunk review.
    const card = await findByTestId("copilot-activity-card");
    expect(card.getAttribute("data-tool")).toBe("run_script_test");
    expect(card.textContent).toContain("script_not_trusted");
    expect(queryByTestId("copilot-review-bar")).toBeNull();
  });
});

describe("script-agent-editor-tabs — Code/Test tabs (AS-8c2)", () => {
  it("a prompt script shows Code (default, with editor) and Check (with ScriptTester) tabs", async () => {
    const script = makeScript({ id: "script-tabs-prompt", code: BASE_CODE });
    const utils = renderScriptShell(script);
    await flushSessionLoad();

    // Two tab radios (the shared SegmentedControl radiogroup); Code selected
    // by default with a live CodeMirror editor mounted.
    const codeRadio = utils.getByRole("radio", { name: "agent_code" });
    const checkRadio = utils.getByRole("radio", { name: "script_tab_check" });
    expect(codeRadio.getAttribute("aria-checked")).toBe("true");
    expect(checkRadio.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector(".cm-editor")).not.toBeNull();

    // The Check tab hides the editor and shows the prompt-script tester
    // (its input hint is ScriptTester-only — the dice tester has none).
    fireEvent.click(checkRadio);
    expect(codeRadio.getAttribute("aria-checked")).toBe("false");
    expect(checkRadio.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(document.body.textContent).toContain("script_test_input_hint");
  });

  it("a dice script shows the dice tester on the Check tab", async () => {
    const script = makeScript({ id: "script-tabs-dice", scriptKind: "dice", code: "const roll = 1;" });
    const utils = renderScriptShell(script);
    await flushSessionLoad();

    // Code is still the default tab with the editor mounted.
    expect(utils.getByRole("radio", { name: "agent_code" }).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".cm-editor")).not.toBeNull();

    // The Check tab swaps the editor for the dice tester: no prompt-tester
    // input hint, but the dice tester's own character field is present.
    fireEvent.click(utils.getByRole("radio", { name: "script_tab_check" }));
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(document.body.textContent).not.toContain("script_test_input_hint");
    expect(document.body.textContent).toContain("script_test_character_name");
  });
});

describe("script-agent-editor-tabs — review dot (AS-8c2)", () => {
  it("a write_buffer proposal lights the Code tab's pending dot", async () => {
    const script = makeScript({ id: "script-tabs-dot", code: BASE_CODE });
    const { queryByTestId } = renderScriptShell(script);
    await flushSessionLoad();

    // No round open — the Code tab label is the plain string (no dot).
    expect(queryByTestId("copilot-outer-dot-code")).toBeNull();

    // Reuse the AS-9 send flow: a real turn snapshots the buffer, then the
    // model's write_buffer answer lands as the pending proposal.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "rewrite it" } });
    fireEvent.click(document.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await flushSessionLoad();
    await act(async () => {
      useAgentTurnStore.getState().upsertActivity("script", "script-thread-new", {
        toolCallId: "w-dot",
        toolName: "write_buffer",
        status: "done",
        target: "code",
        proposed: PROPOSED_CODE,
        summary: "rewrite",
      });
    });

    await waitFor(() => expect(queryByTestId("copilot-outer-dot-code")).not.toBeNull());
  });
});

describe("script-agent-editor-tabs — Code toolbar strip (AS-8c4e)", () => {
  it("edits the description through onUpdateDraft", async () => {
    const onUpdateDraft = mock();
    const script = makeScript({ id: "script-desc-edit", scopeType: "global", description: "Does things" });
    const utils = renderScriptShell(script, { onUpdateDraft });
    await flushSessionLoad();

    // The Code tab (default) opens with the description field.
    const input = utils.getByPlaceholderText("script_desc_placeholder") as HTMLInputElement;
    expect(input.value).toBe("Does things");
    fireEvent.change(input, { target: { value: "New desc" } });
    expect(onUpdateDraft).toHaveBeenCalledWith({ description: "New desc" });
  });

  it("renders the links block for entity scripts only", async () => {
    const script = makeScript({ id: "script-links-entity", scopeType: "entity" });
    const utils = renderScriptShell(script);
    await flushSessionLoad();
    utils.getByText("script_links_label");
    utils.getByTestId("script-owner-picker");
  });

  it("renders no links block for global scripts", async () => {
    const script = makeScript({ id: "script-links-global", scopeType: "global" });
    const utils = renderScriptShell(script);
    await flushSessionLoad();
    expect(utils.queryByText("script_links_label")).toBeNull();
    expect(utils.queryByTestId("script-owner-picker")).toBeNull();
  });

  it("passes bound links through and filters non-entity links on set", async () => {
    const onSetScriptLinks = mock();
    const script = makeScript({ id: "script-links-set", scopeType: "entity" });
    const links: ScriptLinkRecord[] = [{ scriptId: script.id, targetType: "character", targetId: "c1" }];
    const characters: LinkTarget[] = [{ id: "c1", name: "C1", avatarAssetId: null }];
    const utils = renderScriptShell(script, { scriptLinks: links, linkCharacters: characters, onSetScriptLinks });
    await flushSessionLoad();

    utils.getByText("c1");
    fireEvent.click(utils.getByText("add-persona"));
    expect(onSetScriptLinks).toHaveBeenCalledWith([
      { targetType: "character", targetId: "c1" },
      { targetType: "persona", targetId: "persona-2" },
    ]);
    fireEvent.click(utils.getByText("add-mixed"));
    // The lorebook link is dropped: only character/persona links survive.
    expect(onSetScriptLinks).toHaveBeenLastCalledWith([{ targetType: "character", targetId: "c1" }]);
  });

  it("keeps the API toggle as the last item of the templates row", async () => {
    const onToggleApiRef = mock();
    const script = makeScript({ id: "script-apiref-row", scopeType: "global" });
    const utils = renderScriptShell(script, { onToggleApiRef });
    await flushSessionLoad();

    const apiButton = utils.getByRole("button", { name: "script_api_reference" });
    const row = apiButton.parentElement;
    expect(row?.className).toContain("flex-wrap");
    // The toggle shares the row with the template buttons (no own row) and
    // sits last among them.
    const buttons = row ? Array.from(row.querySelectorAll(":scope > button")) : [];
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons[buttons.length - 1]).toBe(apiButton);
    // The reference panel stays hidden until toggled.
    expect(utils.queryByText("script_api_context")).toBeNull();
    fireEvent.click(apiButton);
    expect(onToggleApiRef).toHaveBeenCalledTimes(1);
  });

  it("shows the API reference panel below the templates row once open", async () => {
    const script = makeScript({ id: "script-apiref-open", scopeType: "global", scriptKind: "prompt" });
    const utils = renderScriptShell(script, { apiRefOpen: true });
    await flushSessionLoad();
    expect(utils.getByText("script_api_context")).toBeDefined();
  });
});

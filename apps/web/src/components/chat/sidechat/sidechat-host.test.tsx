/**
 * Sidechat host — behavioral tests (SIDECHAT_PLAN, Wave 4 / SC-13b).
 *
 * Drives the REAL generic AgentShell with kind "sidechat-ooc" through the
 * host's real transport (fetch-level router — no mock.module on the api
 * modules, so this file coexists with any other test file sharing the bun
 * worker; the script-agent-host.test.tsx reliability contract). Fetch is
 * swapped per test and restored after each (beforeEach install, afterEach +
 * afterAll restore); every process-global store touched here is re-seeded in
 * beforeEach.
 *
 * Pins:
 *   - module-load registration: the chat-only host (no editor pane), the
 *     kind's five tool toggles, the chat profile assignment, the branch plan
 *     owner, the five meter labels, the sidechat i18n keys;
 *   - selectSidechatOwner from the active chat + active branch (null while
 *     either is missing; mode-agnostic — gating is the served-modes
 *     selector's answer);
 *   - served modes come from the bootstrap kind-settings map (a co-author
 *     chat is not served; nothing hard-codes the mode);
 *   - sessions are scoped to chat+branch (switching branch switches the
 *     routes; the script routes are never touched);
 *   - search/read captions live (args + output summary) and reloaded (the
 *     persisted {toolName, output} wrapper); unparseable → undefined;
 *   - the default model is the active profile's pair; a saved binding wins;
 *   - a chat-only AgentShell render shows the empty hint with no editor pane.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { CHAT_MODE, type AgentThreadOwner } from "@vibe-tavern/domain";
import type {
  AgentKindSettingsWire,
  ExperienceCopilotMessageWire,
  ExperienceCopilotThreadWire,
} from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";
import { getAgentHost } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../../stores/agent-review-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { selectSidechatServedChatModes, SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { selectSidechatOwner } from "./sidechat-host.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = false;

// ── Fetch-level API router ───────────────────────────────────────────────
// Same rationale as script-agent-host.test.tsx: mock.module on the api
// modules is process-global and silently stops applying when another test
// file shares the bun process, so the transport seam is faked at the FETCH
// level instead. The REAL hono clients run against a router serving canned
// payloads.
interface RouterState {
  activeThread: ExperienceCopilotThreadWire | null;
  messages: ExperienceCopilotMessageWire[];
  sessions: ExperienceCopilotThreadWire[];
  newSession: ExperienceCopilotThreadWire;
}
let router: RouterState;

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  // SC-0b chat-owner lifecycle (the sidechat transport's owner-keyed members).
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/active$/.test(path)) {
    return jsonResponse(router.activeThread);
  }
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/sessions$/.test(path)) {
    return jsonResponse(router.sessions);
  }
  if (method === "POST" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/session$/.test(path)) {
    return jsonResponse(router.newSession);
  }
  // Per-thread routes (owner-agnostic — the experience client's members).
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
    return jsonResponse(router.messages);
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    return jsonResponse({ metrics: null, autoCompact: true });
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    return jsonResponse([]);
  }
  // NOTE: the gateway base resolves to "/null" under happy-dom (unset env
  // falls back to `String(null)` in build-config) — route on path SUFFIXES,
  // never exact equality.
  if (method === "GET" && path.includes("/branches/") && path.endsWith("/plan")) {
    return jsonResponse({ plan: { goal: "", constraints: [], tasks: [] } });
  }
  if (method === "GET" && path.endsWith("/api/personas")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/lorebooks/all")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/scripts/all")) return jsonResponse([]);
  if (method === "GET" && path.endsWith("/api/coauthor/skills")) return jsonResponse({ entries: [], errors: [] });
  if (method === "GET" && path.endsWith("/model-favorites")) return jsonResponse([]);
  return new Response(JSON.stringify({ error: { message: `Unhandled fetch in test: ${method} ${path}` } }), { status: 500 });
});

/** Router fetch calls matching method + path pattern. Strips the "/null"
 *  gateway-base prefix happy-dom produces (unset env falls back to
 *  `String(null)` in build-config — the script host suite's NOTE). */
function apiCalls(method: string, pattern: RegExp): string[] {
  return fetchRouter.mock.calls
    .map(([input, init]) => {
      const raw = new URL(String(input), "http://gateway.test").pathname;
      const path = raw.replace(/^\/null/, "");
      return { method: (init?.method ?? "GET").toUpperCase(), path };
    })
    .filter((call) => call.method === method && pattern.test(call.path))
    .map((call) => call.path);
}

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The shell takes isMobile as a prop, but nested surfaces read the hook —
// override it with the same mutable cell so both halves agree.
const realMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let renderHook: typeof import("@testing-library/react").renderHook;
let waitFor: typeof import("@testing-library/react").waitFor;
let AgentShell: typeof import("../../shared/agent-shell/AgentShell.js").AgentShell;
let useAgentModelBinding: typeof import("../../shared/agent-shell/use-agent-model-binding.js").useAgentModelBinding;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ render, act, renderHook, waitFor } = await import("@testing-library/react"));
  ({ AgentShell } = await import("../../shared/agent-shell/AgentShell.js"));
  ({ useAgentModelBinding } = await import("../../shared/agent-shell/use-agent-model-binding.js"));
  // The sidechat host self-registers (registerAgentHost("sidechat-ooc")) as a
  // module side effect — the shell resolves it by kind at render time.
  // Without this import the shell would throw "unknown agent kind".
  await import("./sidechat-host.js");
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function chatThread(id: string, chatId: string, branchId: string): ExperienceCopilotThreadWire {
  return {
    id,
    scriptId: null,
    draftSessionId: null,
    title: "Sidechat",
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    metrics: null,
    contextLinks: [],
    todo: [],
  } as unknown as ExperienceCopilotThreadWire;
}

// p1 is the ACTIVE provider profile (the RP pair, SC-7); each profile carries
// one tool-capable cached model so the REAL `useProviderModels` hook serves
// the model list from cache (no fetch).
const PROFILES = [
  {
    id: "p1",
    name: "Active RP provider",
    isActive: true,
    defaultModel: "m1",
    cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }] },
  },
  {
    id: "p2",
    name: "Other provider",
    isActive: false,
    defaultModel: "m2",
    cachedModels: { models: [{ id: "m2", label: "Model Two", contextLength: 200000, capabilities: { tools: true } }] },
  },
] as unknown as ProviderProfileRecord[];

function kindEntry(kind: string, providerProfileId: string | null, modelName: string | null): AgentKindSettingsWire {
  return {
    agentKind: kind,
    providerProfileId,
    modelName,
    defaultProfileId: null,
    updatedAt: "",
    servesChatModes: [CHAT_MODE.rp],
  };
}

function seedStores(map: Record<string, AgentKindSettingsWire>): void {
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: wireUiSettings(),
      agentKindSettings: map,
      isArmServer: false,
    },
  });
  useProviderDataStore.setState({ profiles: PROFILES });
}

const CHAT_OWNER: AgentThreadOwner = { kind: "chat", chatId: "chat-1", branchId: "branch-1", agentKind: SIDECHAT_AGENT_KIND };

beforeEach(() => {
  mobileOverride = false;
  globalThis.fetch = fetchRouter as unknown as typeof fetch;
  useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {} });
  useAgentReviewRoundStore.setState({ roundsByThread: {} });
  localStorage.clear();
  seedStores({});
  router = {
    activeThread: null,
    messages: [],
    sessions: [],
    newSession: chatThread("sidechat-thread-new", "chat-1", "branch-1"),
  };
  fetchRouter.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
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

function withIsolatedI18n(node: ReactNode) {
  return <I18nextProvider i18n={makeIsolatedI18n()}>{node}</I18nextProvider>;
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

// ── Registration + selectors ────────────────────────────────────────────────

describe("sidechat-host — registration (SC-13b)", () => {
  it("registers the chat-only host with the kind's five toggles and chat assignment", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.kind).toBe("sidechat-ooc");
    // Chat-only: no editor pane (the shell renders its chat pane).
    expect(host.renderEditorPane).toBeUndefined();
    expect([...host.toolKeys].sort()).toEqual(
      ["propose_objective", "read_context_item", "read_plan", "search_context", "todo"].sort(),
    );
    expect(host.profileAssignment).toEqual({ target: "chat" });
    // No record-proposal renderers yet — the objective card is SC-13c's.
    expect(host.recordProposalRenderers).toEqual({});
  });

  it("carries the branch plan owner and the five meter labels", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.planOwner?.({ owner: CHAT_OWNER })).toEqual({
      kind: "chatBranch",
      chatId: "chat-1",
      branchId: "branch-1",
    });
    expect(host.meterSegmentLabels).toEqual({
      context: "sidechat_meter_context",
      rp_summaries: "sidechat_meter_rp_summaries",
      rp_messages: "sidechat_meter_rp_messages",
      digest: "sidechat_meter_digest",
      discussion: "sidechat_meter_discussion",
    });
  });

  it("carries the sidechat i18n keys (empty hint + input placeholder)", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.i18n.placeholder).toBe("sidechat_input_placeholder");
    expect(host.i18n.emptySub).toBe("sidechat_empty_hint");
  });
});

describe("sidechat-host — owner and served modes (SC-13b)", () => {
  it("selectSidechatOwner builds the chat owner from the active chat + branch", () => {
    expect(selectSidechatOwner({ id: "chat-1" }, { id: "branch-1" })).toEqual(CHAT_OWNER);
    expect(selectSidechatOwner(null, { id: "branch-1" })).toBeNull();
    expect(selectSidechatOwner({ id: "chat-1" }, null)).toBeNull();
  });

  it("served modes come from the bootstrap kind-settings map (co-author not served)", () => {
    const served = selectSidechatServedChatModes({ [SIDECHAT_AGENT_KIND]: kindEntry(SIDECHAT_AGENT_KIND, null, null) });
    expect([...served]).toEqual([CHAT_MODE.rp]);
    expect(served.includes(CHAT_MODE.coauthor)).toBe(false);
  });

  it("served modes are empty before the bootstrap map arrives", () => {
    expect(selectSidechatServedChatModes(undefined)).toEqual([]);
    expect(selectSidechatServedChatModes({})).toEqual([]);
  });
});

// ── Transport scoping ───────────────────────────────────────────────────────

describe("sidechat-host — sessions scoped to chat+branch (SC-13b)", () => {
  it("the lifecycle members call the chat routes with chat+branch+kind", async () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    router.activeThread = chatThread("sidechat-thread-1", "chat-1", "branch-1");
    router.sessions = [router.activeThread];

    await host.transport.getActiveThread(CHAT_OWNER);
    await host.transport.listSessions(CHAT_OWNER);
    await host.transport.startSession(CHAT_OWNER);

    const base = "/api/agent/chats/chat-1/branches/branch-1/sidechat-ooc";
    expect(apiCalls("GET", /\/active$/)).toEqual([`${base}/active`]);
    expect(apiCalls("GET", /\/sessions$/)).toEqual([`${base}/sessions`]);
    expect(apiCalls("POST", /\/session$/)).toEqual([`${base}/session`]);
    // The script routes are never touched by a chat owner.
    expect(apiCalls("GET", /experience-copilot\/script\//)).toEqual([]);
    expect(apiCalls("POST", /experience-copilot\/script\//)).toEqual([]);
  });

  it("switching branch switches sessions (no silent rebind)", async () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    const branch2: AgentThreadOwner = { kind: "chat", chatId: "chat-1", branchId: "branch-2", agentKind: SIDECHAT_AGENT_KIND };

    await host.transport.getActiveThread(CHAT_OWNER);
    await host.transport.getActiveThread(branch2);

    expect(apiCalls("GET", /\/active$/)).toEqual([
      "/api/agent/chats/chat-1/branches/branch-1/sidechat-ooc/active",
      "/api/agent/chats/chat-1/branches/branch-2/sidechat-ooc/active",
    ]);
  });
});

// ── Captions ────────────────────────────────────────────────────────────────

function searchActivity(over: Partial<AgentToolActivity> = {}): AgentToolActivity {
  return {
    toolCallId: "s1",
    toolName: "search_context",
    status: "done",
    args: { query: "lore", scope: "active_first" },
    summary: JSON.stringify({ results: [{ type: "lore-entry", id: "e1" }, { type: "character", id: "c1" }] }),
    ...over,
  };
}

describe("sidechat-host — tool captions (SC-13b)", () => {
  it("search_context captions live (query from args, count from results.length)", () => {
    const caption = getAgentHost(SIDECHAT_AGENT_KIND).toolCaption?.(searchActivity());
    expect(caption).toEqual({
      titleKey: "sidechat_search_caption",
      titleParams: { query: "lore", count: 2 },
    });
  });

  it("search_context captions reloaded (the persisted {toolName, output} wrapper)", () => {
    const caption = getAgentHost(SIDECHAT_AGENT_KIND).toolCaption?.(
      searchActivity({
        summary: JSON.stringify({
          toolName: "search_context",
          output: { results: [{ type: "script", id: "s1" }] },
        }),
      }),
    );
    expect(caption).toEqual({
      titleKey: "sidechat_search_caption",
      titleParams: { query: "lore", count: 1 },
    });
  });

  it("read_context_item captions from the output title (live and reloaded)", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    const live = host.toolCaption?.({
      toolCallId: "r1",
      toolName: "read_context_item",
      status: "done",
      args: { type: "character", id: "c1" },
      summary: JSON.stringify({ type: "character", id: "c1", title: "Hero", content: "# Hero" }),
    });
    expect(live).toEqual({ titleKey: "sidechat_read_caption", titleParams: { title: "Hero" } });
    const reloaded = host.toolCaption?.({
      toolCallId: "r1",
      toolName: "read_context_item",
      status: "done",
      args: { type: "character", id: "c1" },
      summary: JSON.stringify({
        toolName: "read_context_item",
        output: { type: "character", id: "c1", title: "Hero", content: "# Hero" },
      }),
    });
    expect(reloaded).toEqual({ titleKey: "sidechat_read_caption", titleParams: { title: "Hero" } });
  });

  it("anything unparseable falls back (undefined)", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.toolCaption?.(searchActivity({ summary: "not json" }))).toBeUndefined();
    expect(host.toolCaption?.(searchActivity({ args: {} }))).toBeUndefined();
    expect(host.toolCaption?.(searchActivity({ summary: JSON.stringify({ nothing: true }) }))).toBeUndefined();
    expect(
      host.toolCaption?.({
        toolCallId: "r1",
        toolName: "read_context_item",
        status: "done",
        summary: JSON.stringify({ type: "character", id: "c1", content: "no title" }),
      }),
    ).toBeUndefined();
    // Any other tool keeps the shell's fallback.
    expect(host.toolCaption?.({ toolCallId: "t1", toolName: "todo", status: "done" })).toBeUndefined();
  });
});

// ── Default model ───────────────────────────────────────────────────────────

describe("sidechat-host — default model binding (SC-13b)", () => {
  it("the default is the active profile's pair (no fetch — the hook is pure)", () => {
    const binding = getAgentHost(SIDECHAT_AGENT_KIND).defaultModelBinding?.({ owner: CHAT_OWNER, profiles: PROFILES });
    expect(binding).toEqual({ providerProfileId: "p1", modelName: "m1" });
  });

  it("no active profile (or no default model) degrades to the shell fallback", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.defaultModelBinding?.({ owner: CHAT_OWNER, profiles: [] })).toBeUndefined();
    const noDefault = PROFILES.map((profile) =>
      profile.id === "p1" ? { ...profile, defaultModel: null } : { ...profile, isActive: false },
    );
    expect(host.defaultModelBinding?.({ owner: CHAT_OWNER, profiles: noDefault })).toEqual({ providerProfileId: "p1" });
  });

  it("the hook resolves the active pair with no saved binding", async () => {
    const { result } = renderHook(() => useAgentModelBinding(SIDECHAT_AGENT_KIND, CHAT_OWNER));
    await waitFor(() => expect(result.current.providerProfileId).toBe("p1"));
    expect(result.current.model).toBe("m1");
  });

  it("a saved binding still wins over the active pair (SC-0e)", async () => {
    seedStores({ [SIDECHAT_AGENT_KIND]: kindEntry(SIDECHAT_AGENT_KIND, "p2", "m2") });
    const { result } = renderHook(() => useAgentModelBinding(SIDECHAT_AGENT_KIND, CHAT_OWNER));
    await waitFor(() => expect(result.current.providerProfileId).toBe("p2"));
    expect(result.current.model).toBe("m2");
  });
});

// ── Chat-only render ────────────────────────────────────────────────────────

describe("sidechat-host — chat-only shell render (SC-13b)", () => {
  it("a chat owner mounts the chat pane with the empty hint and no editor pane", async () => {
    router.activeThread = chatThread("sidechat-thread-1", "chat-1", "branch-1");
    const { getByText, getByTestId, queryByTestId } = render(
      withIsolatedI18n(<AgentShell kind={SIDECHAT_AGENT_KIND} owner={CHAT_OWNER} isMobile={false} />),
    );
    await flushSessionLoad();

    // The sidechat's empty-chat hint (the descriptor's emptySub key).
    await waitFor(() => expect(getByText("sidechat_empty_hint")).toBeDefined());
    // The chat pane's composer is present; no editor-pane surface mounts.
    expect(getByTestId("copilot-send-btn")).toBeDefined();
    expect(queryByTestId("copilot-review-bar")).toBeNull();
    // The branch plan loads through the descriptor's chatBranch owner.
    expect(apiCalls("GET", /\/api\/agent\/chats\/chat-1\/branches\/branch-1\/plan$/).length).toBe(1);
  });
});

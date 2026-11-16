/**
 * Sidechat host — behavioral tests (SIDECHAT_PLAN, Wave 4 / SC-13b).
 *
 * Drives the REAL generic AgentShell with kind "sidechat-ooc" through the
 * host's real transport (fetch-level router — no mock.module on the api
 * modules, so this file coexists with any other test file sharing the bun
 * worker; the script-agent-host.test.tsx reliability contract). The
 * router/seed/reset/drain scaffolding comes from the shared harness
 * (apps/web/test/agent-shell-harness.ts — ASHU-6, fork #5 of 7): the harness
 * serves the agent-chats triple over live router state, the copilot context
 * family, the bootstrap quartet and the fail-loud tail; this file's stateful
 * routes (feed page, live messages, the SC-23d context-links GET/PATCH) ride
 * the custom-first escape hatch. Fetch is swapped per test and restored after
 * each (beforeEach install, afterEach + afterAll restore); every
 * process-global store touched here is re-seeded in beforeEach.
 *
 * Pins:
 *   - module-load registration: the chat-only host (no editor pane), the
 *     kind's six tool toggles, the chat profile assignment, the branch plan
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
 *   - a chat-only AgentShell render shows the empty hint with no editor pane;
 *   - prompt presets pin in the sidechat (group lists presets by name, pin /
 *     unpin round-trip the link) and stay out of the other assistants.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import type { ReactNode } from "react";
import { agentFeedPageFromMessages } from "../../../../test/agent-feed-page.js";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { CHAT_MODE, type AgentThreadOwner, type PromptPresetDto } from "@vibe-tavern/domain";
import type {
  AgentKindSettingsWire,
  ExperienceCopilotContextLink,
  ExperienceCopilotMessageWire,
  ExperienceCopilotThreadWire,
} from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import {
  chatThread,
  flushSessionLoad,
  jsonResponse,
  resetShellStores,
  seedShellStores,
  shellRouter,
} from "../../../../test/agent-shell-harness.js";
import { wireProviderProfile } from "../../../../test/wire-fixtures.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";
import { getAgentHost, registerAgentHost, type AgentHostTransport } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useChatStore } from "../../../stores/chat-store.js";
import { useSidechatMobileStore } from "../../../stores/sidechat-mobile-store.js";
import { Icons } from "../../shared/icons.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { selectSidechatServedChatModes, SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { selectSidechatOwner } from "./sidechat-host.js";
import { DIRECTOR_MESSAGE_RECORD_TYPES } from "@vibe-tavern/api-contracts";
import { ObjectiveProposalCard } from "./ObjectiveProposalCard.js";
import { DirectorMessageProposalCard } from "./director-message-proposal-card.js";
import { STORY_PLAN_RECORD_TYPE, StoryPlanProposalCard } from "./StoryPlanProposalCard.js";
import { TRACKER_SCENE_RECORD_TYPE, TrackerSceneProposalCard } from "./TrackerSceneProposalCard.js";
import { STORY_DECK_RECORD_TYPE, StoryDeckProposalCard } from "./StoryDeckProposalCard.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = false;

// ── Fetch-level API router ───────────────────────────────────────────────
// The shared harness router (agent-shell-harness.ts, fork #5 of 7 migrated)
// serves the agent-chats triple over the live router state (SC-0b chat-owner
// lifecycle), the copilot context family, the bootstrap quartet and the
// fail-loud tail; this file's STATEFUL routes (the feed page, the live
// messages pair, the SC-23d pinned-context-links GET/PATCH) ride the
// custom-first escape hatch. Same rationale as script-agent-host.test.tsx:
// mock.module on the api modules is process-global and silently stops
// applying when another test file shares the bun process, so the transport
// seam is faked at the FETCH level instead — the REAL hono clients run
// against a router serving canned payloads.
interface RouterState {
  activeThread: ExperienceCopilotThreadWire | null;
  messages: ExperienceCopilotMessageWire[];
  sessions: ExperienceCopilotThreadWire[];
  newSession: ExperienceCopilotThreadWire;
  /** SC-23d: the pinned-context links served by GET/PATCH …/context-links. */
  contextLinks: ExperienceCopilotContextLink[];
  /** Park writes at the fetch boundary to reproduce pin/send ordering. */
  contextLinkWriteGates?: Promise<void>[];
  streamContextLinks?: ExperienceCopilotContextLink[][];
  streamBodies?: Record<string, unknown>[];
  streamFailure?: "sse" | "transport";
}
// A STABLE object the harness reads per-request — beforeEach mutates FIELDS,
// never reassigns (the harness captures the reference at build time).
const router: RouterState = {
  activeThread: null,
  messages: [],
  sessions: [],
  newSession: chatThread({ id: "sidechat-thread-new" }),
  contextLinks: [],
};

const fetchRouter = mock(
  shellRouter({
    agentChats: router,
    custom: ({ path, method, init }) => {
      // NOTE: the gateway base resolves to "/null" under happy-dom (unset env
      // falls back to `String(null)` in build-config) — route on path SUFFIXES,
      // never exact equality.
      const feedThreadId = /\/api\/agent\/threads\/([^/]+)\/feed$/.exec(path)?.[1];
      if (method === "GET" && feedThreadId) return jsonResponse(agentFeedPageFromMessages(feedThreadId, router.messages));
      // Per-thread routes (owner-agnostic — the experience client's members).
      if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
        return jsonResponse(router.messages);
      }
      if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
        return jsonResponse(router.contextLinks);
      }
      if (method === "PATCH" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { links?: ExperienceCopilotContextLink[] };
        // SC-23d: park writes at the fetch boundary to reproduce pin/send
        // ordering (dev-side write gates).
        const gate = router.contextLinkWriteGates?.shift();
        if (gate) return gate.then(() => {
          router.contextLinks = body.links ?? [];
          return jsonResponse(router.contextLinks);
        });
        router.contextLinks = body.links ?? [];
        return jsonResponse(router.contextLinks);
      }
      // The answer stream (SC-23d + DMT-24b-era capture hooks): snapshot the
      // SERVER-side links at POST time, record the request body (the client's
      // promptAttachments ride it), and honor the streamFailure probes.
      if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream$/.test(path)) {
        router.streamContextLinks?.push([...router.contextLinks]);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        router.streamBodies?.push(body);
        if (router.streamFailure === "transport") return Promise.reject(new Error("transport unavailable"));
        if (router.streamFailure === "sse") {
          router.messages.push({ id: "stored-user", threadId: "sidechat-thread-1", role: "user", content: "Discuss.", toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null, createdAt: "2026-01-01T00:00:00Z", promptAttachments: [{ presetId: "pp1", displayName: "Stored RP", promptText: "<rp_prompt>saved</rp_prompt>" }] });
          return Promise.resolve(new Response('event: error\ndata: {"message":"failed","category":"server_error"}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
        }
        // dev-exact success frame: the named `event: finish` frame drives the
        // client's onFinish cleanup path (bare `data:` lines do not).
        return Promise.resolve(new Response('event: finish\ndata: {"finishReason":"stop"}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
      }
      return null; // fall through to the harness routes
    },
  }),
);

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
// R15: load-time COPY of the real namespace — never spread the live binding.
const realTooltip = { ...(await import("../../shared/Tooltip.js")) };
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The shell takes isMobile as a prop, but nested surfaces read the hook —
// override it with the same mutable cell so both halves agree.
// R15: load-time COPY of the real namespace — never spread the live binding.
const realMobile = { ...(await import("../../../hooks/use-mobile.js")) };
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let renderHook: typeof import("@testing-library/react").renderHook;
let waitFor: typeof import("@testing-library/react").waitFor;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentShell: typeof import("../../shared/agent-shell/AgentShell.js").AgentShell;
let useAgentModelBinding: typeof import("../../shared/agent-shell/use-agent-model-binding.js").useAgentModelBinding;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ render, act, renderHook, waitFor, fireEvent } = await import("@testing-library/react"));
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

// p1 is the ACTIVE provider profile (the RP pair, SC-7); each profile carries
// one tool-capable cached model so the REAL `useProviderModels` hook serves
// the model list from cache (no fetch). The rows ride the wire factory — the
// erased literals also hid the required `cachedAt` on `cachedModels`.
const PROFILES: ProviderProfileRecord[] = [
  wireProviderProfile({
    id: "p1",
    name: "Active RP provider",
    isActive: true,
    defaultModel: "m1",
    cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }], cachedAt: "2026-01-01T00:00:00.000Z" },
  }),
  wireProviderProfile({
    id: "p2",
    name: "Other provider",
    isActive: false,
    defaultModel: "m2",
    cachedModels: { models: [{ id: "m2", label: "Model Two", contextLength: 200000, capabilities: { tools: true } }], cachedAt: "2026-01-01T00:00:00.000Z" },
  }),
];

function kindEntry(kind: string, providerProfileId: string | null, modelName: string | null): AgentKindSettingsWire {
  return {
    agentKind: kind,
    providerProfileId,
    modelName,
    defaultProfileId: null,
    updatedAt: "",
    servesChatModes: [CHAT_MODE.rp],
    autoCompactDefault: true,
  };
}

/** File-local seeding delta on the harness seedShellStores (the shared agent-kind map + this suite's profiles and prompt presets). */
function seedStores(map: Record<string, AgentKindSettingsWire>, presets: PromptPresetDto[] = []): void {
  seedShellStores({ agentKinds: map, profiles: PROFILES, promptPresets: presets });
}

const CHAT_OWNER: AgentThreadOwner = { kind: "chat", chatId: "chat-1", branchId: "branch-1", agentKind: SIDECHAT_AGENT_KIND };

beforeEach(() => {
  mobileOverride = false;
  globalThis.fetch = testFetch(fetchRouter);
  resetShellStores();
  useSnapshotStore.setState({ allCharacters: [] });
  localStorage.clear();
  seedStores({});
  // Field mutation, never reassignment — the harness holds the reference.
  router.activeThread = null;
  router.messages = [];
  router.sessions = [];
  router.newSession = chatThread({ id: "sidechat-thread-new" });
  router.contextLinks = [];
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

// ── Registration + selectors ────────────────────────────────────────────────

describe("sidechat-host — registration (SC-13b)", () => {
  it("registers the chat-only host with the kind's thirteen toggles and chat assignment", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.kind).toBe("sidechat-ooc");
    // Chat-only: no editor pane (the shell renders its chat pane).
    expect(host.renderEditorPane).toBeUndefined();
    // Behavior change (DR-4b): was the 8 DR-4a toggles → now 9, `ask_user`
    // appended (owner ruling 2026-10-27, DIRECTOR_MODE_PLAN DR-4b ruling B —
    // off in the OOC seed, on in the director seed), basis: the wire
    // contract (SIDECHAT_OOC_TOOL_KEYS) gained the key.
    // Behavior change (DMT-34): was 9 → now 12 — the three director message
    // tools joined the wire contract (on in the director seed, absent from
    // the OOC seed and the kind default), basis: SIDECHAT_OOC_TOOL_KEYS
    // gained the keys.
    // Behavior change (DK-5a): was 12 → now 13 — `propose_deck` joined the
    // wire contract (the DMT-34 land-together pattern; on in the director
    // seed, absent from the OOC seed and the kind default), basis:
    // SIDECHAT_OOC_TOOL_KEYS gained the key.
    expect([...host.toolKeys].sort()).toEqual(
      [
        "propose_objective",
        "propose_plan",
        "propose_tracker_template",
        "read_context_item",
        "read_message_prompt",
        "read_plan",
        "search_context",
        "todo",
        "ask_user",
        "propose_message_edit",
        "propose_message_variant",
        "request_message_swipe",
        "propose_deck",
      ].sort(),
    );
    expect(host.profileAssignment).toEqual({ target: "chat" });
    // AP-2: the sidechat renders RP colors without RP sizes.
    expect(host.messageMarkup).toBe("rp-colors");
    // SC-13c + DR-10a + DR-10b: the objective card renders
    // `recordType: "objective"` in place; the story-plan card renders the
    // `propose_plan` tool's record type and the tracker-scene card
    // `propose_tracker_template`'s (the web-side pins of the proposal
    // domain's constants). DMT-33: ONE card serves BOTH Director message
    // record types, keyed off the SHARED contract constants (the DMT-11
    // schema module — the host consumes the keys, never local literals).
    // DK-8: the story-deck card renders `propose_deck`'s record type.
    expect(Object.keys(host.recordProposalRenderers)).toEqual([
      "objective",
      "story-plan",
      "tracker-scene",
      DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit,
      DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant,
      "story-deck",
    ]);
    expect(host.recordProposalRenderers.objective).toBe(ObjectiveProposalCard);
    expect(host.recordProposalRenderers["story-plan"]).toBe(StoryPlanProposalCard);
    expect(host.recordProposalRenderers["tracker-scene"]).toBe(TrackerSceneProposalCard);
    expect(host.recordProposalRenderers[DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit]).toBe(DirectorMessageProposalCard);
    expect(host.recordProposalRenderers[DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant]).toBe(DirectorMessageProposalCard);
    expect(host.recordProposalRenderers[STORY_DECK_RECORD_TYPE]).toBe(StoryDeckProposalCard);
    expect(STORY_PLAN_RECORD_TYPE).toBe("story-plan");
    expect(STORY_DECK_RECORD_TYPE).toBe("story-deck");
    expect(TRACKER_SCENE_RECORD_TYPE).toBe("tracker-scene");
    // The shared contract's keys ARE the wire spellings (the web-side pin of
    // the DMT-11 recordType constants).
    expect(DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit).toBe("message-edit");
    expect(DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant).toBe("message-variant");
  });

  it("carries the branch plan owner and the six meter labels", () => {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.planOwner?.({ owner: CHAT_OWNER })).toEqual({
      kind: "chatBranch",
      chatId: "chat-1",
      branchId: "branch-1",
    });
    // Behavior change (DR-4b): was the five SC-9 labels → now six,
    // `story_plan` after `context` (the <story_plan> context section's own
    // meter segment), basis: DIRECTOR_MODE_PLAN DR-4b.
    expect(host.meterSegmentLabels).toEqual({
      context: "sidechat_meter_context",
      story_plan: "sidechat_meter_story_plan",
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

  it("labels its empty state with the kind label, not the generic assistant title (DR-7, owner 2026-10-27)", () => {
    // Mock §3: the OOC empty state's title reads «Сайдчат»/"Sidechat" — the
    // kind label — while the panel header keeps the generic agent title.
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.i18n.emptyTitle).toBe("agent_kind_sidechat");
    expect(host.i18n.title).toBe("agent_title");
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
    router.activeThread = chatThread({ id: "sidechat-thread-1" });
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

// ── Copy to composer ────────────────────────────────────────────────────────

describe("sidechat-host — copy to composer (SC-16)", () => {
  function copyAction() {
    const host = getAgentHost(SIDECHAT_AGENT_KIND);
    expect(host.messageActions).toHaveLength(1);
    return host.messageActions![0]!;
  }

  it("declares the copy action (label key, the RP row's copy icon, test id)", () => {
    const action = copyAction();
    expect(action.labelKey).toBe("sidechat_copy_to_composer");
    expect(action.icon).toBe(Icons.Copy);
    expect(action.testId).toBe("sidechat-copy-to-composer");
  });

  it("empty draft → the reply text is set", () => {
    useChatStore.setState({ draft: "" });
    copyAction().onSelect("Consider asking about her brother");
    expect(useChatStore.getState().draft).toBe("Consider asking about her brother");
    useChatStore.setState({ draft: "" });
  });

  it("non-empty draft → the reply is appended on a new line", () => {
    useChatStore.setState({ draft: "Already typed" });
    copyAction().onSelect("Consider asking about her brother");
    expect(useChatStore.getState().draft).toBe("Already typed\nConsider asking about her brother");
    useChatStore.setState({ draft: "" });
  });

  it("sends nothing (no transport call, no turn state)", () => {
    useChatStore.setState({ draft: "" });
    copyAction().onSelect("Consider asking about her brother");
    expect(fetchRouter.mock.calls).toEqual([]);
    expect(useAgentTurnStore.getState().turnsByThread).toEqual({});
    useChatStore.setState({ draft: "" });
  });

  it("switches the mobile tab back to Chat", () => {
    useChatStore.setState({ draft: "" });
    useSidechatMobileStore.setState({ tab: "sidechat" });
    copyAction().onSelect("Consider asking about her brother");
    expect(useSidechatMobileStore.getState().tab).toBe("chat");
    expect(useChatStore.getState().draft).toBe("Consider asking about her brother");
    useChatStore.setState({ draft: "" });
    useSidechatMobileStore.setState({ tab: "chat" });
  });
});

// ── Chat-only render ────────────────────────────────────────────────────────

describe("sidechat-host — chat-only shell render (SC-13b)", () => {
  it("a chat owner mounts the chat pane with the empty hint and no editor pane", async () => {
    const owner: AgentThreadOwner = { ...CHAT_OWNER, branchId: "chat-only-branch" };
    router.activeThread = chatThread({ id: "sidechat-thread-1" });
    const { getByText, getByTestId, queryByTestId } = render(
      withIsolatedI18n(<AgentShell kind={SIDECHAT_AGENT_KIND} owner={owner} isMobile={false} />),
    );
    await flushSessionLoad();

    // The sidechat's empty-chat hint (the descriptor's emptySub key).
    await waitFor(() => expect(getByText("sidechat_empty_hint")).toBeDefined());
    // The chat pane's composer is present; no editor-pane surface mounts.
    expect(getByTestId("copilot-send-btn")).toBeDefined();
    expect(queryByTestId("copilot-review-bar")).toBeNull();
    // The branch plan loads through the descriptor's chatBranch owner.
    expect(apiCalls("GET", /\/api\/agent\/chats\/chat-1\/branches\/chat-only-branch\/plan$/).length).toBe(1);
  });
});

// ── Prompt preset pins (SC-23d) ────────────────────────────────────────────

/** A full preset DTO — the shell reads only id+name, the store type wants
 *  the whole row. */
function presetFixture(id: string, name: string): PromptPresetDto {
  return {
    id,
    name,
    system: "",
    jailbreak: "",
    prefill: "",
    authorsNote: "",
    authorsNoteDepth: 0,
    authorsNotePosition: "in_prompt",
    authorsNoteRole: "system",
    summary: "",
    tools: "",
    nsfw: "",
    enhanceDefinitions: "",
    customInjections: [],
    promptOrder: [],
    advancedMode: false,
    mergeConsecutiveRoles: false,
    perSendPrefillEnabled: false,
    scriptAiSystemPrompt: "",
    aiAssistantPrompts: "",
    createdAt: "",
    updatedAt: "",
  };
}

/** Router PATCH calls matching a path pattern, with parsed JSON bodies. */
function patchBodies(pattern: RegExp): unknown[] {
  return fetchRouter.mock.calls
    .map(([input, init]) => {
      const raw = new URL(String(input), "http://gateway.test").pathname;
      const path = raw.replace(/^\/null/, "");
      return {
        method: (init?.method ?? "GET").toUpperCase(),
        path,
        body: init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : null,
      };
    })
    .filter((call) => call.method === "PATCH" && pattern.test(call.path))
    .map((call) => call.body);
}

/** The @-mention popover's rows (i18n is isolated-empty here, so the
 *  listbox's aria-label is the raw key — the ONLY listbox with that label;
 *  cmdk (the model DropdownSelect) renders its own rows elsewhere). */
function mentionOptions(): HTMLElement[] {
  const listbox = document.body.querySelector('[role="listbox"][aria-label="copilot_mention_picker_label"]');
  return Array.from(listbox?.querySelectorAll('[role="option"]') ?? []);
}

// SC-23d: a minimal non-sidechat assistant proving the preset group is
// offered per host. A stub transport (no fetch — canned session data), so
// the only catalog rows come from the shell's own sources.
const OTHER_KIND = "sc23d-other-assistant";

function otherTransport(): AgentHostTransport {
  const thread = chatThread({ id: "other-thread-1" });
  return {
    sendStream: async () => ({ finishReason: "stop", metrics: null }),
    answerAsk: async () => ({ finishReason: "stop", metrics: null }),
    getActiveThread: async () => thread,
    listMessages: async () => [],
    startSession: async () => thread,
    listSessions: async () => [],
    activateSession: async () => thread,
    renameSession: async () => thread,
    setContextLinks: async (_threadId: string, links: ExperienceCopilotContextLink[]) => links,
    deleteTurn: async () => ({ deletedMessageIds: [], deletedUserMessageId: null }),
    // AP-31: the assistant-edit member — canned (these preset tests never
    // edit; present so the stub stays the full transport).
    editMessage: async (_threadId: string, messageId: string, content: string): Promise<ExperienceCopilotMessageWire> => ({
      id: messageId,
      threadId: _threadId,
      role: "assistant",
      content,
      toolCallsJson: null,
      toolCallId: null,
      reasoning: null,
      reasoningDurationMs: null,
      createdAt: "",
    }),
  };
}

describe("sidechat-host — prompt preset pins (SC-23d)", () => {
  function renderSidechat(links: ExperienceCopilotContextLink[] = []) {
    router.activeThread = { ...chatThread({ id: "sidechat-thread-1" }), contextLinks: links };
    return render(
      withIsolatedI18n(<AgentShell kind={SIDECHAT_AGENT_KIND} owner={CHAT_OWNER} isMobile={false} />),
    );
  }

  function openMention(getByTestId: (id: string) => HTMLElement, value: string): HTMLTextAreaElement {
    const ta = getByTestId("copilot-chat-input") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value } });
    ta.setSelectionRange(value.length, value.length);
    fireEvent.select(ta);
    return ta;
  }

  it("lists prompt presets by name in the sidechat @ picker", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP")]);
    const { getByTestId } = renderSidechat();
    await flushSessionLoad();

    openMention(getByTestId, "@Deep");

    await waitFor(() => expect(mentionOptions()).toHaveLength(1));
    const row = mentionOptions()[0];
    expect(row?.textContent).toContain("Deep RP");
    // i18n is isolated-empty, so the chip renders the raw key.
    expect(row?.textContent).toContain("copilot_mention_type_prompt_preset");
  });

  it("does not list prompt presets in other assistants", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP")]);
    // A character proves the OTHER assistant's picker itself works — only
    // the preset group stays out.
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
    const unregister = registerAgentHost({
      kind: OTHER_KIND,
      i18n: {
        title: "agent_title",
        kindLabel: "agent_kind_sidechat",
        placeholder: "agent_input_placeholder",
        loading: "agent_loading",
        emptyTitle: "agent_title",
      },
      // AP-17: required on every descriptor (four keys, tuple-typed).
      starterPromptKeys: [
        "agent_starter_sidechat_recap",
        "agent_starter_sidechat_feelings",
        "agent_starter_sidechat_twists",
        "agent_starter_sidechat_pacing",
      ],
      toolKeys: [],
      profileAssignment: { target: "chat" },
      // AP-2: required on every descriptor (a missing markup is a compile break).
      messageMarkup: "plain",
      bufferSpecs: [],
      transport: otherTransport(),
      buildSendOptions: () => ({}),
      recordProposalRenderers: {},
    });
    try {
      const otherOwner: AgentThreadOwner = { kind: "chat", chatId: "chat-1", branchId: "branch-1", agentKind: OTHER_KIND };
      const { getByTestId } = render(
        withIsolatedI18n(<AgentShell kind={OTHER_KIND} owner={otherOwner} isMobile={false} />),
      );
      await flushSessionLoad();

      openMention(getByTestId, "@");
      await waitFor(() => expect(mentionOptions()).toHaveLength(1));
      expect(mentionOptions()[0]?.textContent).toContain("Alice");
      expect(document.body.textContent).not.toContain("Deep RP");
    } finally {
      unregister();
    }
  });

  it("pinning a preset PATCHes the appended link and shows its chip", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP")]);
    const { getByTestId } = renderSidechat();
    await flushSessionLoad();

    const ta = openMention(getByTestId, "@Deep");
    await waitFor(() => expect(mentionOptions()).toHaveLength(1));
    fireEvent.keyDown(ta, { key: "Enter" });

    const pattern = /\/api\/experience-copilot\/[^/]+\/context-links$/;
    await waitFor(() => expect(patchBodies(pattern)).toHaveLength(1));
    expect(patchBodies(pattern)[0]).toEqual({
      links: [{ targetType: "prompt_preset", targetId: "pp1" }],
    });
    await waitFor(() =>
      expect(getByTestId("copilot-context-pill-prompt_preset-pp1").textContent).toContain("Deep RP"),
    );
  });

  it("reloads pending links and renders confirmed snapshots without resurrecting consumed chips", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP")]);
    const first = renderSidechat();
    await flushSessionLoad();
    const ta = openMention(first.getByTestId, "@Deep");
    await waitFor(() => expect(mentionOptions()).toHaveLength(1));
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(router.contextLinks).toEqual([{ targetType: "prompt_preset", targetId: "pp1" }]));
    first.unmount();

    const pending = renderSidechat(router.contextLinks);
    await waitFor(() => expect(pending.getByTestId("copilot-context-pill-prompt_preset-pp1")).toBeTruthy());
    pending.unmount();

    // The server has consumed the pending link and returned the persisted message.
    router.contextLinks = [];
    router.messages = [{ id: "stored-user", threadId: "sidechat-thread-1", role: "user", content: "Discuss.", toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null, createdAt: "2026-01-01T00:00:00Z", promptAttachments: [{ presetId: "pp1", displayName: "Stored RP", promptText: "<rp_prompt>saved</rp_prompt>" }] }];
    const confirmed = renderSidechat(router.contextLinks);
    await waitFor(() => expect(confirmed.getByText("Stored RP")).toBeTruthy());
    expect(confirmed.queryByTestId("copilot-context-pill-prompt_preset-pp1")).toBeNull();
    fireEvent.click(confirmed.getByRole("button", { name: /prompt_attachment_view/ }));
    await waitFor(() => expect(confirmed.getByTestId("sent-file-summary-scroll").textContent).toBe("<rp_prompt>saved</rp_prompt>"));
  });

  it("unpinning a preset PATCHes the filtered set and removes its chip", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP")]);
    router.activeThread = {
      ...chatThread({ id: "sidechat-thread-1" }),
      contextLinks: [{ targetType: "prompt_preset", targetId: "pp1" }],
    };
    const { getByTestId, queryByTestId } = render(
      withIsolatedI18n(<AgentShell kind={SIDECHAT_AGENT_KIND} owner={CHAT_OWNER} isMobile={false} />),
    );
    await flushSessionLoad();

    await waitFor(() =>
      expect(getByTestId("copilot-context-pill-prompt_preset-pp1").textContent).toContain("Deep RP"),
    );
    fireEvent.click(getByTestId("copilot-context-pill-remove-prompt_preset-pp1"));

    const pattern = /\/api\/experience-copilot\/[^/]+\/context-links$/;
    await waitFor(() => expect(patchBodies(pattern)).toHaveLength(1));
    expect(patchBodies(pattern)[0]).toEqual({ links: [] });
    await waitFor(() => expect(queryByTestId("copilot-context-pill-prompt_preset-pp1")).toBeNull());
  });

  it("sends the preset identity and clears it on finish even while its PATCH is parked", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP")]);
    let releaseWrite!: () => void;
    router.contextLinkWriteGates = [new Promise<void>((resolve) => { releaseWrite = resolve; })];
    router.streamContextLinks = [];
    router.streamBodies = [];
    const { getByTestId, queryByTestId } = renderSidechat();
    await flushSessionLoad();

    try {
      const ta = openMention(getByTestId, "@Deep");
      await waitFor(() => expect(mentionOptions()).toHaveLength(1));
      fireEvent.keyDown(ta, { key: "Enter" });
      await waitFor(() => expect(getByTestId("copilot-context-pill-prompt_preset-pp1")).toBeTruthy());
      await waitFor(() => expect(patchBodies(/\/context-links$/)).toHaveLength(1));

      fireEvent.change(ta, { target: { value: "Discuss the attached preset." } });
      fireEvent.click(getByTestId("copilot-send-btn"));
      await waitFor(() => expect(router.streamContextLinks).toHaveLength(1));
      // The real shell sent while the server still had NO pinned preset.
      expect(router.streamContextLinks).toEqual([[]]);
      expect(router.contextLinks).toEqual([]);
      expect(router.streamBodies?.[0]?.promptAttachments).toEqual([{ presetId: "pp1" }]);
      await waitFor(() => expect(queryByTestId("copilot-context-pill-prompt_preset-pp1")).toBeNull());
    } finally {
      await act(async () => { releaseWrite(); });
    }
    await waitFor(() => expect(router.contextLinks).toEqual([{ targetType: "prompt_preset", targetId: "pp1" }]));
  });

  it("sends both visible identities despite out-of-order full replacements", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP"), presetFixture("pp2", "Other RP")]);
    let releaseFirstWrite!: () => void;
    router.contextLinkWriteGates = [new Promise<void>((resolve) => { releaseFirstWrite = resolve; })];
    router.streamBodies = [];
    const { getByTestId, queryByTestId } = renderSidechat();
    await flushSessionLoad();

    try {
      const first = openMention(getByTestId, "@Deep");
      await waitFor(() => expect(mentionOptions()).toHaveLength(1));
      fireEvent.keyDown(first, { key: "Enter" });
      await waitFor(() => expect(patchBodies(/\/context-links$/)).toHaveLength(1));

      const second = openMention(getByTestId, "@Other");
      await waitFor(() => expect(mentionOptions()).toHaveLength(1));
      fireEvent.keyDown(second, { key: "Enter" });
      await waitFor(() => expect(router.contextLinks).toHaveLength(2));
    } finally {
      await act(async () => { releaseFirstWrite(); });
    }

    await waitFor(() => expect(router.contextLinks).toEqual([{ targetType: "prompt_preset", targetId: "pp1" }]));
    expect(getByTestId("copilot-context-pill-prompt_preset-pp1")).toBeTruthy();
    expect(getByTestId("copilot-context-pill-prompt_preset-pp2")).toBeTruthy();
    const ta = getByTestId("copilot-chat-input");
    fireEvent.change(ta, { target: { value: "Discuss both." } });
    fireEvent.click(getByTestId("copilot-send-btn"));
    await waitFor(() => expect(router.streamBodies).toHaveLength(1));
    expect(router.streamBodies?.[0]?.promptAttachments).toEqual([{ presetId: "pp1" }, { presetId: "pp2" }]);
    await waitFor(() => expect(queryByTestId("copilot-context-pill-prompt_preset-pp2")).toBeNull());
  });

  it("clears only submitted presets and keeps character pins", async () => {
    seedStores({}, [presetFixture("pp1", "Deep RP")]);
    router.streamBodies = [];
    const { getByTestId, queryByTestId } = renderSidechat([
      { targetType: "prompt_preset", targetId: "pp1" },
      { targetType: "character", targetId: "character-1" },
    ]);
    await flushSessionLoad();
    await waitFor(() => expect(getByTestId("copilot-context-pill-prompt_preset-pp1")).toBeTruthy());
    fireEvent.change(getByTestId("copilot-chat-input"), { target: { value: "Discuss." } });
    fireEvent.click(getByTestId("copilot-send-btn"));
    await waitFor(() => expect(queryByTestId("copilot-context-pill-prompt_preset-pp1")).toBeNull());
    expect(getByTestId("copilot-context-pill-character-character-1")).toBeTruthy();
  });

  for (const failure of ["sse", "transport"] as const) {
    it(`keeps the pending preset on ${failure} failure`, async () => {
      seedStores({}, [presetFixture("pp1", "Deep RP")]);
      router.streamFailure = failure;
      router.streamBodies = [];
      const { getByTestId } = renderSidechat();
      await flushSessionLoad();
      const ta = openMention(getByTestId, "@Deep");
      await waitFor(() => expect(mentionOptions()).toHaveLength(1));
      fireEvent.keyDown(ta, { key: "Enter" });
      await waitFor(() => expect(getByTestId("copilot-context-pill-prompt_preset-pp1")).toBeTruthy());
      fireEvent.change(ta, { target: { value: "Discuss." } });
      fireEvent.click(getByTestId("copilot-send-btn"));
      await waitFor(() => expect(router.streamBodies).toHaveLength(1));
      await flushSessionLoad();
      expect(router.streamBodies?.[0]?.promptAttachments).toEqual([{ presetId: "pp1" }]);
      expect(getByTestId("copilot-context-pill-prompt_preset-pp1")).toBeTruthy();
      if (failure === "sse") {
        await waitFor(() => expect(getByTestId("copilot-error-card-retry")).toBeTruthy());
        expect(document.body.textContent).toContain("Stored RP");
        router.streamFailure = undefined;
        fireEvent.click(getByTestId("copilot-error-card-retry"));
        await waitFor(() => expect(router.streamBodies).toHaveLength(2));
        expect(router.streamBodies?.[1]?.regenerate).toBe(true);
        expect(router.messages).toHaveLength(1);
        expect(router.messages[0]?.promptAttachments).toHaveLength(1);
        expect(getByTestId("copilot-context-pill-prompt_preset-pp1")).toBeTruthy();
      }
      // A blind resend after a post-write drop can duplicate the whole message,
      // a generic transport race shared with content-only sends.
    });
  }
});

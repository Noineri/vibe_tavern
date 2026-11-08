/**
 * Director message tools — cross-boundary user flows (DMT-35).
 *
 * Drives the REAL generic AgentShell with kind "sidechat-ooc" through the
 * host's real transport (fetch-level router — no mock.module on the api
 * modules, the sidechat-host.test.tsx / script-agent-host.test.tsx
 * reliability contract), so the three Director message tools' cards are
 * exercised through the REAL projection paths and the REAL controls:
 *   - live: the composer send's SSE frames (tool-call/tool-result) project
 *     through the shared stream callbacks — the permission card through the
 *     ONE api-contracts decoder, the two proposal cards through the record
 *     proposal parse;
 *   - history: the paged feed serves the persisted `{ toolName, output }`
 *     rows and the persisted extraction decodes them — field-for-field the
 *     same cards;
 *   - replay: the run discovery + GET replay re-drives the same frames
 *     through the same callbacks (BR-3a) — and stays TOAST-FREE even when
 *     the replayed stream carries a swipe-run-outcome tail frame;
 *   - the editable swipe instruction round-trips: the card field's edited
 *     text rides the answer POST verbatim (`answer.instruction`), decided
 *     exactly once;
 *   - the swipe-run-outcome toast fires ONLY on the live answer path (the
 *     DMT-24b wiring in use-agent-controller), the card keeps its granted
 *     receipt;
 *   - a stale-base conflict surfaces through the REAL apply route's 409
 *     (conflict line, Apply disabled, Reject kept);
 *   - an applied proposal's target-scoped message companion ingests into the
 *     snapshot store through the canonical action (the full
 *     route → card → ingest chain over the HTTP boundary).
 *
 * Runner: bun:test with scoped happy-dom. Fetch is swapped per test and
 * restored after each (beforeEach install, afterEach + afterAll restore);
 * every process-global store touched here is re-seeded in beforeEach; the
 * global i18next `t` and the sonner toast are spied and restored in
 * afterAll (the use-agent-controller.test.ts precedent).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import type { ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  DIRECTOR_MESSAGE_RECORD_TYPES,
  type AgentKindSettingsWire,
  type DirectorSwipeGrantedReceipt,
  type ExperienceCopilotMessageWire,
  type RecordProposal,
} from "@vibe-tavern/api-contracts";
import { CHAT_MODE, type AgentThreadOwner, type PromptPresetDto } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";
import { agentFeedPageFromMessages } from "../../../../test/agent-feed-page.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useDirectorSwipeDraftStore } from "../../../stores/director-swipe-draft-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { brandId, type ChatBranchId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import type { AppMessage, AppSnapshot } from "../../../api/types.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = false;

// Radix Tooltip needs a global Provider the isolated render here doesn't mount
// (the sidechat-host.test.tsx registration, byte-identical).
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

// The toast + the global i18n `t` are SPIED (not module-mocked): the DMT-24b
// toast wiring and the replay toast-freedom are observed at their real call
// sites, and both spies restore in afterAll.
const { toast } = await import("sonner");
const toastError = spyOn(toast, "error");
const { i18next } = await import("../../../i18n/i18n.js");
const i18nT = spyOn(i18next, "t").mockImplementation(
  ((key: string) => String(key)) as typeof i18next.t,
);

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let AgentShell: typeof import("../../shared/agent-shell/AgentShell.js").AgentShell;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ AgentShell } = await import("../../shared/agent-shell/AgentShell.js"));
  // The sidechat host self-registers (registerAgentHost("sidechat-ooc")) as a
  // module side effect — the shell resolves it by kind at render time.
  await import("./sidechat-host.js");
});

afterAll(() => {
  globalThis.fetch = realFetch;
  toastError.mockRestore();
  i18nT.mockRestore();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const THREAD = "sidechat-thread-1";
const CHAT_OWNER: AgentThreadOwner = { kind: "chat", chatId: "chat-1", branchId: "branch-1", agentKind: SIDECHAT_AGENT_KIND };

const DRAFT_INSTRUCTION = "Draft: rewrite the reply about the dusty study.";
const EDITED_INSTRUCTION = "Edited: rewrite the reply, mention the brass key.";
const REPLY_FIRST_LINE = "The door creaks open, revealing a dusty study.";

const EDIT_CANDIDATE = "She sat by the opened door slowly, exactly as staged.";

const EDIT_PROPOSAL: RecordProposal = {
  kind: "record",
  id: "tc-edit",
  recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit,
  op: "update",
  targetId: "m1",
  payload: {
    source: { messageId: "m1", variantId: "v1", position: 3, variantNumber: 1 },
    sourceText: "She opened the door slowly.",
    instruction: "Fix the pose — she is sitting, not standing.",
    candidate: EDIT_CANDIDATE,
    editor: { modelId: "editor-model", finishReason: "stop" },
  },
  status: "pending",
};

const VARIANT_PROPOSAL: RecordProposal = {
  kind: "record",
  id: "tc-variant",
  recordType: DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant,
  op: "create",
  targetId: "m1",
  payload: {
    sources: [{ messageId: "m1", variantId: "v1", position: 3, variantNumber: 2 }],
    content: "The Director's own alternative reply.",
  },
  status: "pending",
};

const SWIPE_MARKER = {
  status: "awaiting_permission" as const,
  messageId: "m1",
  variantId: "v1",
  position: 3,
  variantNumber: 2,
  replyFirstLine: REPLY_FIRST_LINE,
  instruction: DRAFT_INSTRUCTION,
};

const SWIPE_TOOL_CALL_ID = "tc-swipe";
const EDIT_TOOL_CALL_ID = "tc-edit";
const VARIANT_TOOL_CALL_ID = "tc-variant";

/** The granted receipt the server writes into the row when the answer lands
 *  (the router applies it to the canned history — the honest simulation of
 *  the split-turn's in-place rewrite). */
function grantedReceipt(instruction: string): DirectorSwipeGrantedReceipt {
  return {
    status: "granted",
    messageId: SWIPE_MARKER.messageId,
    variantId: SWIPE_MARKER.variantId,
    position: SWIPE_MARKER.position,
    variantNumber: SWIPE_MARKER.variantNumber,
    replyFirstLine: REPLY_FIRST_LINE,
    instruction,
  };
}

function toolRow(id: string, toolName: string, toolCallId: string, output: unknown): ExperienceCopilotMessageWire {
  return {
    id,
    threadId: THREAD,
    role: "tool",
    content: JSON.stringify({ toolName, output }),
    toolCallsJson: null,
    toolCallId,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "2026-11-07T10:00:00Z",
  };
}

function plainRow(id: string, role: "user" | "assistant", content: string): ExperienceCopilotMessageWire {
  return {
    id,
    threadId: THREAD,
    role,
    content,
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "2026-11-07T09:00:00Z",
  };
}

/** The persisted turn: user row, assistant target, then the three tool rows —
 *  the swipe request LAST (the chronologically last activity: the permission
 *  card's interactive rule). */
function historyRows(swipeOutput: unknown = SWIPE_MARKER): ExperienceCopilotMessageWire[] {
  return [
    plainRow("row-user", "user", "What is behind the door?"),
    plainRow("row-assistant", "assistant", REPLY_FIRST_LINE),
    toolRow("row-edit", "propose_message_edit", EDIT_TOOL_CALL_ID, EDIT_PROPOSAL),
    toolRow("row-variant", "propose_message_variant", VARIANT_TOOL_CALL_ID, VARIANT_PROPOSAL),
    toolRow("row-swipe", "request_message_swipe", SWIPE_TOOL_CALL_ID, swipeOutput),
  ];
}

// ── Fetch-level API router ──────────────────────────────────────────────────

interface StreamFrame {
  id?: number;
  event: string;
  data: unknown;
}

interface RouterState {
  feedMessages: ExperienceCopilotMessageWire[];
  /** The frames the NEXT POST .../stream serves (send or answer), one-shot. */
  streamScript: StreamFrame[];
  /** The frames the GET run replay serves (id-cursed, replayable). */
  replayScript: StreamFrame[];
  /** The thread /api/agent-runs lists as active (replay discovery). */
  runningThread: string | null;
  /** The canned apply/reject outcome per toolCallId. */
  applyOutcomes: Record<string, { status: number; body: unknown }>;
  /** Every POST .../stream body (send or answer assertions). */
  streamBodies: Array<Record<string, unknown>>;
  /** Every proposals-route POST path. */
  proposalPosts: string[];
}
let router: RouterState;

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

function sseResponse(frames: readonly StreamFrame[]): Response {
  const encoder = new TextEncoder();
  const text = frames
    .map((frame) => `${frame.id !== undefined ? `id: ${frame.id}\n` : ""}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const FINISH: StreamFrame = { event: "finish", data: { finishReason: "stop" } };

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  // Run discovery (BR-3a replay) — the thread currently running.
  if (method === "GET" && path.endsWith("/api/agent-runs")) {
    return jsonResponse(router.runningThread === null ? [] : [{ threadId: router.runningThread }]);
  }
  // Run replay: the recorded frames with their numbered cursors.
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/run$/.test(path)) {
    return sseResponse(router.replayScript);
  }
  // The stream endpoint: send (content) or answer (answer) — recorded.
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream$/.test(path)) {
    router.streamBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const frames = router.streamScript;
    router.streamScript = [];
    return sseResponse(frames.length > 0 ? frames : [FINISH]);
  }
  const feedThreadId = /\/api\/agent\/threads\/([^/]+)\/feed$/.exec(path)?.[1];
  if (method === "GET" && feedThreadId) return jsonResponse(agentFeedPageFromMessages(feedThreadId, router.feedMessages));
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
    return jsonResponse(router.feedMessages);
  }
  // The proposals apply/reject routes — canned per-test outcomes.
  const proposalMatch = /\/api\/agent\/threads\/([^/]+)\/proposals\/([^/]+)\/(apply|reject)$/.exec(path);
  if (method === "POST" && proposalMatch) {
    router.proposalPosts.push(path);
    const outcome = router.applyOutcomes[proposalMatch[2] ?? ""];
    if (outcome === undefined) return jsonResponse({ error: { message: `No canned outcome for ${proposalMatch[2]}` } }, 500);
    return jsonResponse(outcome.body, outcome.status);
  }
  // SC-0b chat-owner lifecycle (the sidechat transport's owner-keyed members).
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/active$/.test(path)) {
    return jsonResponse(chatThread(THREAD));
  }
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/sessions$/.test(path)) {
    return jsonResponse([chatThread(THREAD)]);
  }
  if (method === "POST" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/session$/.test(path)) {
    return jsonResponse(chatThread(THREAD));
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    return jsonResponse({ metrics: null, autoCompact: true });
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    return jsonResponse([]);
  }
  // NOTE: the gateway base resolves to "/null" under happy-dom (unset env
  // falls back to `String(null)` in build-config) — route on path SUFFIXES,
  // never exact equality (the sidechat-host NOTE).
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

function chatThread(id: string) {
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
  };
}

// p1 is the ACTIVE provider profile (each profile carries one tool-capable
// cached model so the REAL `useProviderModels` hook serves the model list).
const PROFILES = [
  {
    id: "p1",
    name: "Active RP provider",
    isActive: true,
    defaultModel: "m1",
    cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }] },
  },
] as unknown as ProviderProfileRecord[];

function kindEntry(kind: string): AgentKindSettingsWire {
  return {
    agentKind: kind,
    providerProfileId: null,
    modelName: null,
    defaultProfileId: null,
    updatedAt: "",
    servesChatModes: [CHAT_MODE.rp],
    autoCompactDefault: true,
  };
}

function seedStores(presets: PromptPresetDto[] = []): void {
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: presets,
      uiSettings: wireUiSettings(),
      agentKindSettings: { [SIDECHAT_AGENT_KIND]: kindEntry(SIDECHAT_AGENT_KIND) },
      isArmServer: false,
    },
  });
  useProviderDataStore.setState({ profiles: PROFILES });
}

beforeEach(() => {
  mobileOverride = false;
  globalThis.fetch = testFetch(fetchRouter);
  useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {}, feedByThread: {} });
  useSnapshotStore.setState({ allCharacters: [] });
  useDirectorSwipeDraftStore.setState({ draftsByThread: {} });
  toastError.mockClear();
  localStorage.clear();
  seedStores();
  router = {
    feedMessages: [],
    streamScript: [],
    replayScript: [],
    runningThread: null,
    applyOutcomes: {},
    streamBodies: [],
    proposalPosts: [],
  };
  fetchRouter.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim) — the sidechat-host pattern; the process-global i18n singleton is
// never re-initialized (R13).
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

function renderShell(over: { owner?: AgentThreadOwner } = {}) {
  return render(
    <I18nextProvider i18n={makeIsolatedI18n()}>
      <AgentShell kind={SIDECHAT_AGENT_KIND} owner={over.owner ?? CHAT_OWNER} isMobile={false} />
    </I18nextProvider>,
  );
}

/** Drain the chained async `loadSession` microtasks (and React's scheduler
 *  macrotasks) inside `act` — the sidechat-host bounded drain. */
async function flushSessionLoad() {
  const { act } = await import("@testing-library/react");
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function sendComposerTurn(getByTestId: (id: string) => HTMLElement, content: string): Promise<void> {
  const ta = getByTestId("copilot-chat-input") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: content } });
  fireEvent.click(getByTestId("copilot-send-btn"));
}

// ── The snapshot-store seeding for the companion ingest ─────────────────────

function makeVariant(over: Partial<AppMessage["variants"][number]>): AppMessage["variants"][number] {
  return {
    id: brandId<MessageVariantId>("v1"),
    messageId: brandId<MessageId>("m1"),
    variantIndex: 0,
    content: "She opened the door slowly.",
    isSelected: true,
    finishReason: "stop",
    createdAt: "2026-11-01T00:00:00Z",
    modelId: "rp-model",
    presetName: null,
    tokenCount: 3,
    attachmentsJson: null,
    sceneTracker: null,
    ...over,
  };
}

function makeSnapshotMessage(variants: AppMessage["variants"]): AppMessage {
  return {
    id: brandId<MessageId>("m1"),
    chatId: brandId<ChatId>("c1"),
    branchId: brandId<ChatBranchId>("b1"),
    role: "assistant",
    authorType: "assistant",
    position: 3,
    content: "She opened the door slowly.",
    state: "complete",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    tokenCount: 3,
    variants,
    selectedVariantIndex: 0,
    modelId: "rp-model",
    sceneTracker: null,
    attachments: [],
  };
}

// ── Live turn ───────────────────────────────────────────────────────────────

describe("director message tools — the live turn's three cards", () => {
  it("a live turn's tool results project all three cards through the real callbacks: edit diff + save + editable swipe field", async () => {
    router.streamScript = [
      { event: "tool-call", data: { toolCallId: EDIT_TOOL_CALL_ID, toolName: "propose_message_edit", args: { position: 3, instruction: "Fix the pose" } } },
      { event: "tool-result", data: { toolCallId: EDIT_TOOL_CALL_ID, toolName: "propose_message_edit", output: EDIT_PROPOSAL, isError: false } },
      { event: "tool-call", data: { toolCallId: VARIANT_TOOL_CALL_ID, toolName: "propose_message_variant", args: { position: 3, sourceVariants: [2] } } },
      { event: "tool-result", data: { toolCallId: VARIANT_TOOL_CALL_ID, toolName: "propose_message_variant", output: VARIANT_PROPOSAL, isError: false } },
      { event: "tool-call", data: { toolCallId: SWIPE_TOOL_CALL_ID, toolName: "request_message_swipe", args: { position: 3, instruction: DRAFT_INSTRUCTION } } },
      { event: "tool-result", data: { toolCallId: SWIPE_TOOL_CALL_ID, toolName: "request_message_swipe", output: SWIPE_MARKER, isError: false } },
      FINISH,
    ];
    const { getByTestId, getAllByTestId, getByText } = renderShell();
    await flushSessionLoad();

    await sendComposerTurn(getByTestId, "Show me the tools");
    await waitFor(() => expect(getAllByTestId("director-message-proposal-card")).toHaveLength(2));

    // The message-EDIT card: pending review with the editor's candidate.
    const editCard = getAllByTestId("director-message-proposal-card").find(
      (card) => card.getAttribute("data-record-type") === "message-edit",
    );
    expect(editCard).toBeDefined();
    expect(editCard!.getAttribute("data-status")).toBe("pending");
    expect(editCard!.textContent).toContain(EDIT_CANDIDATE);
    // (Both Director cards expose the apply/save button under the SAME
    // testid — every button query below is scoped to its card.)

    // The message-VARIANT card: the Director's complete reply, Save enabled.
    const variantCard = getAllByTestId("director-message-proposal-card").find(
      (card) => card.getAttribute("data-record-type") === "message-variant",
    );
    expect(variantCard).toBeDefined();
    expect(variantCard!.textContent).toContain("The Director's own alternative reply.");

    // The swipe permission card: the ONE decoder's awaiting state with the
    // full instruction visible and editable, interactive after the settle.
    await waitFor(() => expect(getByTestId("copilot-permission-swipe-allow").getAttribute("disabled")).toBeNull());
    const field = getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement;
    expect(field.value).toBe(DRAFT_INSTRUCTION);

    // Rendering made NO resolution call before the user acts.
    expect(router.proposalPosts).toEqual([]);
    expect(getByText(DRAFT_INSTRUCTION).tagName).toBe("TEXTAREA");
  });
});

// ── Reloaded history ────────────────────────────────────────────────────────

describe("director message tools — reloaded history", () => {
  it("the persisted { toolName, output } rows project the same three cards through the persisted extraction", async () => {
    router.feedMessages = historyRows();
    const { getByTestId, getAllByTestId } = renderShell();
    await flushSessionLoad();

    await waitFor(() => expect(getAllByTestId("director-message-proposal-card")).toHaveLength(2));
    const editCard = getAllByTestId("director-message-proposal-card").find(
      (card) => card.getAttribute("data-record-type") === "message-edit",
    );
    expect(editCard!.getAttribute("data-status")).toBe("pending");
    expect(editCard!.textContent).toContain(EDIT_CANDIDATE);
    const variantCard = getAllByTestId("director-message-proposal-card").find(
      (card) => card.getAttribute("data-record-type") === "message-variant",
    );
    expect(variantCard!.textContent).toContain("The Director's own alternative reply.");

    // The swipe card is interactive (the thread's LAST activity, no stream).
    await waitFor(() => expect(getByTestId("copilot-permission-swipe-allow").getAttribute("disabled")).toBeNull());
    expect((getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement).value).toBe(DRAFT_INSTRUCTION);
    expect(router.proposalPosts).toEqual([]);
  });

  it("a reloaded GRANTED row renders the receipt with the final approved text, no fetch", async () => {
    router.feedMessages = historyRows(grantedReceipt(EDITED_INSTRUCTION));
    const { getByTestId, queryByTestId } = renderShell();
    await flushSessionLoad();

    await waitFor(() => expect(getByTestId("copilot-permission-swipe-approved-text").textContent).toBe(EDITED_INSTRUCTION));
    expect(queryByTestId("copilot-permission-swipe-allow")).toBeNull();
    expect(queryByTestId("copilot-permission-swipe-reject")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });
});

// ── The editable instruction round-trip + decision once ──────────────────────

describe("director message tools — the swipe answer", () => {
  it("the edited instruction rides the answer POST verbatim; the decision sends exactly once", async () => {
    router.feedMessages = historyRows();
    const { getByTestId } = renderShell();
    await flushSessionLoad();
    await waitFor(() => expect(getByTestId("copilot-permission-swipe-allow").getAttribute("disabled")).toBeNull());

    // The edit round-trip: the field's text goes into the draft store and
    // rides the answer verbatim — never the recorded draft.
    const field = getByTestId("copilot-permission-swipe-instruction") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: EDITED_INSTRUCTION } });
    expect(field.value).toBe(EDITED_INSTRUCTION);

    // ONE click: the optimistic override resolves the card in place (the
    // awaiting block unmounts — a second click is impossible by rendering,
    // the send-once guard the card pins elsewhere).
    fireEvent.click(getByTestId("copilot-permission-swipe-allow"));

    await waitFor(() => expect(router.streamBodies).toHaveLength(1));
    const answerBody = router.streamBodies[0]!;
    expect(answerBody.answer).toEqual({
      toolCallId: SWIPE_TOOL_CALL_ID,
      decision: "allow",
      instruction: EDITED_INSTRUCTION,
    });
    // Exactly ONE generation-bearing answer — no duplicate send.
    expect(router.streamBodies).toHaveLength(1);
    // The decision was ACCEPTED: the answer turn settled with the finish.
    expect(router.streamScript).toEqual([]);
  });

  it("the swipe-run-outcome toast fires on the LIVE answer path only, and the answer turn settles", async () => {
    router.feedMessages = historyRows();
    router.streamScript = [
      { event: "swipe-run-outcome", data: { toolCallId: SWIPE_TOOL_CALL_ID, outcome: { status: "failed", reason: "RP provider blew up" } } },
      FINISH,
    ];
    const { getByTestId } = renderShell();
    await flushSessionLoad();
    await waitFor(() => expect(getByTestId("copilot-permission-swipe-allow").getAttribute("disabled")).toBeNull());

    fireEvent.click(getByTestId("copilot-permission-swipe-allow"));

    // The non-fatal tail frame toasts the failure (the established
    // generation-failure scheme) WITHOUT failing the answer turn: exactly one
    // answer POST, the script's finish consumed, no duplicate send.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[0]).toBe("copilot_permission_swipe_run_failed");
    expect(toastError.mock.calls[0]?.[1]).toEqual({ description: "RP provider blew up" });
    expect(router.streamBodies).toHaveLength(1);
    // No edit this time: the allow still carries the FIELD text (the
    // recorded draft — the card's empty-text gate refuses a blank field).
    expect(router.streamBodies[0]!.answer).toEqual({
      toolCallId: SWIPE_TOOL_CALL_ID,
      decision: "allow",
      instruction: DRAFT_INSTRUCTION,
    });
    expect(router.streamScript).toEqual([]);
  });
});

// ── Replay ──────────────────────────────────────────────────────────────────

describe("director message tools — run replay", () => {
  it("replay re-projects the three cards through the same callbacks and NEVER re-fires the outcome toast nor an answer POST", async () => {
    router.feedMessages = []; // the replay alone drives the cards
    router.runningThread = THREAD;
    router.replayScript = [
      { id: 1, event: "tool-call", data: { toolCallId: EDIT_TOOL_CALL_ID, toolName: "propose_message_edit", args: { position: 3 } } },
      { id: 2, event: "tool-result", data: { toolCallId: EDIT_TOOL_CALL_ID, toolName: "propose_message_edit", output: EDIT_PROPOSAL, isError: false } },
      { id: 3, event: "tool-call", data: { toolCallId: VARIANT_TOOL_CALL_ID, toolName: "propose_message_variant", args: { position: 3 } } },
      { id: 4, event: "tool-result", data: { toolCallId: VARIANT_TOOL_CALL_ID, toolName: "propose_message_variant", output: VARIANT_PROPOSAL, isError: false } },
      { id: 5, event: "tool-call", data: { toolCallId: SWIPE_TOOL_CALL_ID, toolName: "request_message_swipe", args: { position: 3 } } },
      { id: 6, event: "tool-result", data: { toolCallId: SWIPE_TOOL_CALL_ID, toolName: "request_message_swipe", output: SWIPE_MARKER, isError: false } },
      // The absorbed failure rides the replay too — the replay path stays
      // toast-free (the onSwipeRunOutcome callback is live-answer-only).
      { id: 7, event: "swipe-run-outcome", data: { toolCallId: SWIPE_TOOL_CALL_ID, outcome: { status: "failed", reason: "RP provider blew up" } } },
      { id: 8, ...FINISH },
    ];
    const { getByTestId, getAllByTestId } = renderShell();
    await flushSessionLoad();

    await waitFor(() => expect(getAllByTestId("director-message-proposal-card")).toHaveLength(2));
    await waitFor(() => expect(getByTestId("copilot-permission-swipe-instruction").textContent).toContain(DRAFT_INSTRUCTION));
    // The replay never re-fires the toast and never POSTs a send/answer.
    expect(toastError).not.toHaveBeenCalledWith("copilot_permission_swipe_run_failed", expect.anything());
    expect(router.streamBodies).toEqual([]);
  });
});

// ── Review resolution through the real routes ───────────────────────────────

describe("director message tools — review resolution through the apply route", () => {
  /** The rendered EDIT card scoped to itself (both Director cards expose the
   *  apply/save button under the same testid — every button query here is a
   *  plain `card.querySelector` against THIS card's subtree). The card
   *  lookup uses the RENDER-BOUND getAllByTestId (the dom-env contract:
   *  query via render()'s returned queries, R7). */
  async function editCard(renderQueries: {
    getAllByTestId: (id: string) => HTMLElement[];
  }): Promise<HTMLElement> {
    let found: HTMLElement | undefined;
    await waitFor(() => {
      found = renderQueries.getAllByTestId("director-message-proposal-card").find(
        (candidate) => candidate.getAttribute("data-record-type") === "message-edit",
      );
      if (found === undefined) throw new Error("edit card not rendered yet");
      if (found.querySelector('[data-testid="director-message-proposal-apply"]') === null) {
        throw new Error("edit card controls not rendered yet");
      }
    });
    return found!;
  }

  it("a stale-base 409 from the REAL route pins the conflict line, keeps pending, disables Apply, keeps Reject", async () => {
    router.feedMessages = historyRows();
    router.applyOutcomes[EDIT_TOOL_CALL_ID] = {
      status: 409,
      body: { error: { message: "The selected message variant's content changed before this edit could be applied." } },
    };
    const { getByTestId, getAllByTestId } = renderShell();
    await flushSessionLoad();
    const card = await editCard({ getAllByTestId });

    fireEvent.click(card.querySelector('[data-testid="director-message-proposal-apply"]')!);

    await waitFor(() => {
      if (card.querySelector('[data-testid="director-message-proposal-conflict-line"]') === null) {
        throw new Error("conflict line not pinned yet");
      }
    });
    expect(card.getAttribute("data-status")).toBe("pending");
    expect(card.querySelector('[data-testid="director-message-proposal-apply"]')!.getAttribute("disabled")).not.toBeNull();
    expect(card.querySelector('[data-testid="director-message-proposal-reject"]')!.getAttribute("disabled")).toBeNull();
    expect(router.proposalPosts).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(getByTestId("copilot-permission-card")).toBeDefined();
  });

  it("an applied edit ingests its target-scoped companion into the snapshot store through the canonical action", async () => {
    const companion = {
      chatId: "c1",
      branchId: "b1",
      message: { id: "m1", position: 3, content: EDIT_CANDIDATE, updatedAt: "2026-11-07T11:00:00Z" },
      variants: [
        { id: "v1", variantIndex: 0, content: EDIT_CANDIDATE, isSelected: true, modelId: null, presetName: null },
        { id: "v2", variantIndex: 1, content: "second swipe", isSelected: false, modelId: null, presetName: null },
      ],
    };
    router.feedMessages = historyRows();
    router.applyOutcomes[EDIT_TOOL_CALL_ID] = {
      status: 200,
      body: { proposal: { ...EDIT_PROPOSAL, status: "applied" }, message: companion },
    };
    // The open conversation carries the target message (the companion's
    // scope must match for the canonical action to merge).
    useSnapshotStore.getState().ingestSnapshot({
      activeChat: { id: "c1", activeBranchId: "b1" },
      activeBranch: { id: "b1" },
      messages: [makeSnapshotMessage([makeVariant({})])],
    } as unknown as AppSnapshot);
    const { getAllByTestId } = renderShell();
    await flushSessionLoad();
    const card = await editCard({ getAllByTestId });

    fireEvent.click(card.querySelector('[data-testid="director-message-proposal-apply"]')!);

    // The full chain over the REAL route response: applied status, one POST.
    await waitFor(() => {
      if (card.getAttribute("data-status") !== "applied") throw new Error("edit card not applied yet");
    });
    expect(router.proposalPosts).toHaveLength(1);
    // The companion landed in the snapshot store (the canonical ingest).
    const stored = useSnapshotStore.getState().messagesById["m1"];
    expect(stored?.content).toBe(EDIT_CANDIDATE);
    expect(stored?.variants[0]?.content).toBe(EDIT_CANDIDATE);
    expect(stored?.variants[0]?.isSelected).toBe(true);
    expect(stored?.variants[1]?.content).toBe("second swipe");
  });
});

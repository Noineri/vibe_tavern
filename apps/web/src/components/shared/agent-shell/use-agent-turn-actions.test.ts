/**
 * Agent turn action row (AGENT_SHELL_POLISH, Wave 3 / AP-11) — the ROW layer:
 * per-message eligibility + action construction (`buildAgentTurnRow`, pure)
 * and the delete-confirm state machine on the turn-actions hook
 * (`pendingDelete` / request / confirm / cancel).
 *
 * Eligibility matrix (the unit contract):
 * - assistant rows: copy always; regenerate only on the LAST turn's rows;
 *   delete unless streaming or digest-covered;
 * - user rows: delete (with the answer) unless streaming or digest-covered —
 *   user rows carry a row for the FIRST time here (SC-16's assistant-only
 *   rule covered HOST actions; turn actions are new);
 * - streaming (`isSending`): NO rows at all, either role (host rows ride
 *   the same gate — the RP row hides its actions while generating);
 * - digest-covered (at/before the digest anchor): delete hidden, copy kept.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { AgentMessageAction } from "../../../lib/agent-host-registry.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { act, renderHook } = await import("@testing-library/react");
const {
  buildAgentTurnRow,
  useAgentTurnActions,
} = await import("./use-agent-turn-actions.js");

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "assistant",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
    ...over,
  };
}

function hostAction(testId: string): AgentMessageAction {
  return {
    labelKey: "sidechat_copy_to_composer",
    icon: () => null,
    onSelect: () => {},
    testId,
  };
}

function callbacks() {
  return {
    onCopy: mock((_text: string) => {}),
    onRegenerate: mock(() => {}),
    onRequestDelete: mock((_messageId: string, _includeUserMessage: boolean) => {}),
  };
}

function testIds(actions: AgentMessageAction[] | undefined): string[] {
  return (actions ?? []).map((a) => a.testId);
}

describe("buildAgentTurnRow — eligibility matrix", () => {
  it("assistant row on the last turn: copy + regenerate + delete (answer only)", () => {
    const cb = callbacks();
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: cb,
    });

    expect(testIds(turnActions)).toEqual(["copilot-turn-copy", "copilot-turn-regenerate", "copilot-turn-delete"]);
  });

  it("assistant row on an earlier turn: copy + delete, NO regenerate", () => {
    const cb = callbacks();
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "a1", role: "assistant" }),
      visibleIndex: 1,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: cb,
    });

    expect(testIds(turnActions)).toEqual(["copilot-turn-copy", "copilot-turn-delete"]);
  });

  it("assistant row at/before the digest anchor on an earlier turn: copy only (delete hidden)", () => {
    const cb = callbacks();
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "a1", role: "assistant" }),
      visibleIndex: 1,
      lastUserVisibleIndex: 3,
      lastDigestVisibleIndex: 2,
      isSending: false,
      callbacks: cb,
    });

    expect(testIds(turnActions)).toEqual(["copilot-turn-copy"]);
  });

  it("covered last-turn assistant row: copy + regenerate, NO delete (cover gates delete only)", () => {
    const cb = callbacks();
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: 4,
      isSending: false,
      callbacks: cb,
    });

    expect(testIds(turnActions)).toEqual(["copilot-turn-copy", "copilot-turn-regenerate"]);
  });

  it("user row: delete with the answer (includeUserMessage = true)", () => {
    const cb = callbacks();
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "u2", role: "user", content: "plan it" }),
      visibleIndex: 2,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: cb,
    });

    expect(testIds(turnActions)).toEqual(["copilot-turn-delete"]);
    turnActions![0]!.onSelect("plan it");
    expect(cb.onRequestDelete).toHaveBeenCalledTimes(1);
    expect(cb.onRequestDelete.mock.calls[0]).toEqual(["u2", true]);
  });

  it("user row at/before the digest anchor: no row", () => {
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "u1", role: "user", content: "old" }),
      visibleIndex: 0,
      lastUserVisibleIndex: 3,
      lastDigestVisibleIndex: 2,
      isSending: false,
      callbacks: callbacks(),
    });

    expect(turnActions).toBeUndefined();
  });

  it("streaming: no turn rows for either role (host rows ride the same gate)", () => {
    const assistant = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: true,
      hostActions: [hostAction("host-action")],
      callbacks: callbacks(),
    });
    const user = buildAgentTurnRow({
      message: message({ id: "u2", role: "user" }),
      visibleIndex: 2,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: true,
      callbacks: callbacks(),
    });

    expect(assistant.turnActions).toBeUndefined();
    expect(assistant.hostActions).toBeUndefined();
    expect(user.turnActions).toBeUndefined();
  });

  it("host actions pass through on assistant rows, drop on user rows (SC-16)", () => {
    const host = [hostAction("host-action")];
    const assistant = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      hostActions: host,
      callbacks: callbacks(),
    });
    const user = buildAgentTurnRow({
      message: message({ id: "u2", role: "user" }),
      visibleIndex: 2,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      hostActions: host,
      callbacks: callbacks(),
    });

    expect(assistant.hostActions).toBe(host);
    expect(user.hostActions).toBeUndefined();
  });

  it("copy forwards the message text; regenerate carries no text (adapted within the shape)", () => {
    const cb = callbacks();
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant", content: "turn text" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: cb,
    });

    turnActions![0]!.onSelect("turn text");
    expect(cb.onCopy).toHaveBeenCalledTimes(1);
    expect(cb.onCopy.mock.calls[0]).toEqual(["turn text"]);
    turnActions![1]!.onSelect("turn text");
    expect(cb.onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("assistant delete requests the answer only (includeUserMessage = false)", () => {
    const cb = callbacks();
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant", content: "turn text" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: cb,
    });

    turnActions![2]!.onSelect("turn text");
    expect(cb.onRequestDelete.mock.calls[0]).toEqual(["a2", false]);
  });

  it("label keys reuse the existing copy / regen / delete keys (no new button wording)", () => {
    const { turnActions } = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: callbacks(),
    });

    expect(turnActions!.map((a) => a.labelKey)).toEqual(["copy", "regen", "delete"]);
  });
});

// ─── AP-12: edit-last eligibility (`canEditLast`) ───────────────────────
// WAS (characterized at AP-11, basis: the row builder above): user rows
// carried delete only — no edit signal existed. NOW: the LAST user row
// (uncovered, not streaming) additionally reports `canEditLast` — the block
// renders its «Изменить» opener there. The delete row itself is unchanged.

describe("buildAgentTurnRow — edit-last eligibility (AP-12)", () => {
  it("last user row: delete + canEditLast", () => {
    const { turnActions, canEditLast } = buildAgentTurnRow({
      message: message({ id: "u2", role: "user", content: "plan it" }),
      visibleIndex: 2,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: callbacks(),
    });

    expect(testIds(turnActions)).toEqual(["copilot-turn-delete"]);
    expect(canEditLast).toBe(true);
  });

  it("earlier user row: delete, NO canEditLast", () => {
    const { turnActions, canEditLast } = buildAgentTurnRow({
      message: message({ id: "u1", role: "user", content: "old" }),
      visibleIndex: 0,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: callbacks(),
    });

    expect(testIds(turnActions)).toEqual(["copilot-turn-delete"]);
    expect(canEditLast).toBeUndefined();
  });

  it("covered last user row: no row, no canEditLast (digest floor)", () => {
    const { turnActions, canEditLast } = buildAgentTurnRow({
      message: message({ id: "u2", role: "user", content: "new" }),
      visibleIndex: 2,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: 3,
      isSending: false,
      callbacks: callbacks(),
    });

    expect(turnActions).toBeUndefined();
    expect(canEditLast).toBeUndefined();
  });

  it("streaming last user row: no row, no canEditLast", () => {
    const { turnActions, canEditLast } = buildAgentTurnRow({
      message: message({ id: "u2", role: "user", content: "plan it" }),
      visibleIndex: 2,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: true,
      callbacks: callbacks(),
    });

    expect(turnActions).toBeUndefined();
    expect(canEditLast).toBeUndefined();
  });

  it("assistant rows never report canEditLast (edit is a user-row affordance)", () => {
    const { canEditLast } = buildAgentTurnRow({
      message: message({ id: "a2", role: "assistant" }),
      visibleIndex: 3,
      lastUserVisibleIndex: 2,
      lastDigestVisibleIndex: null,
      isSending: false,
      callbacks: callbacks(),
    });

    expect(canEditLast).toBeUndefined();
  });
});

// ─── Delete-confirm state machine (on the hook — the modal renders from the pane) ───

const originalFetch = globalThis.fetch;
let deleteCalls: Array<{ threadId: string; body: Record<string, unknown> }> = [];
let settled: boolean[] = [];

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), "http://gateway.test");
  const deleteMatch = url.pathname.match(/\/api\/experience-copilot\/([^/]+)\/turns\/delete$/);
  if ((init?.method ?? "GET").toUpperCase() === "POST" && deleteMatch) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    deleteCalls.push({ threadId: deleteMatch[1] ?? "", body });
    const messageId = String(body.messageId ?? "");
    return new Response(JSON.stringify({
      deletedMessageIds: [messageId],
      deletedUserMessageId: body.includeUserMessage === true ? messageId : null,
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: `Unhandled fetch: ${url.pathname}` } }), { status: 404 });
});

const routerFetch = Object.assign(fetchRouter, { preconnect: () => {} });

function hookArgs(over: { threadId?: string | null } = {}) {
  return {
    kind: "experience",
    threadId: over.threadId ?? "thread-1",
    providerProfileId: "provider-1",
    onTurnSettled: (ok: boolean) => settled.push(ok),
    threadMessages: [] as ExperienceCopilotMessageWire[],
    sendTurn: async () => {},
    // Never invoked in this suite (confirm path only) — only the required
    // pair is present; a call would be a wiring bug, so they throw.
    buildStreamCallbacks: () => ({
      onStatus: neverCalled,
      onChunk: neverCalled,
    }),
    turnState: {
      isSendingRef: { current: false },
      abortRef: { current: null },
      setIsSending: mock(() => {}),
      setPendingText: mock(() => {}),
      setPendingReasoning: mock(() => {}),
      setPendingAskAnswer: mock(() => {}),
      setPendingPermissionAnswer: mock(() => {}),
      setTurnFailure: mock(() => {}),
    },
  };
}

// The hook's transport DI seam — only deleteTurn is ever called here; the
// rest are unreachable stubs (a call is a wiring bug, so they throw — the
// use-agent-controller-permission.test.ts pattern).
const neverCalled = () => {
  throw new Error("not implemented in this suite");
};
type AgentHostTransport = import("../../../lib/agent-host-registry.js").AgentHostTransport;
function stubTransport(deleteTurn: AgentHostTransport["deleteTurn"]): AgentHostTransport {
  return {
    sendStream: neverCalled,
    answerAsk: neverCalled,
    getActiveThread: neverCalled,
    listMessages: neverCalled,
    startSession: neverCalled,
    listSessions: neverCalled,
    activateSession: neverCalled,
    renameSession: neverCalled,
    setContextLinks: neverCalled,
    deleteTurn,
  } as unknown as AgentHostTransport;
}

describe("useAgentTurnActions — delete confirm", () => {
  beforeEach(() => {
    globalThis.fetch = routerFetch;
    deleteCalls = [];
    settled = [];
  });

  afterAll(() => {
    if (globalThis.fetch === routerFetch) globalThis.fetch = originalFetch;
  });

  it("request stages the pending delete; cancel clears it without touching the API", () => {
    const deleteTurn = mock<AgentHostTransport["deleteTurn"]>(
      async () => ({ deletedMessageIds: [], deletedUserMessageId: null }),
    );
    const { result } = renderHook(() =>
      useAgentTurnActions({ ...hookArgs(), transport: stubTransport(deleteTurn) }),
    );

    expect(result.current.pendingDelete).toBeNull();
    act(() => result.current.requestDeleteTurn("a1", false));
    expect(result.current.pendingDelete).toEqual({ messageId: "a1", includeUserMessage: false });
    act(() => result.current.cancelDeleteTurn());
    expect(result.current.pendingDelete).toBeNull();
    expect(deleteTurn).not.toHaveBeenCalled();
    expect(settled).toEqual([]);
  });

  it("confirm deletes through the transport, clears the pending state, and settles once", async () => {
    const { deleteCopilotTurn } = await import("../../../api/experience-copilot-api.js");
    const { result } = renderHook(() =>
      useAgentTurnActions({ ...hookArgs(), transport: stubTransport(deleteCopilotTurn) }),
    );

    act(() => result.current.requestDeleteTurn("u1", true));
    await act(async () => {
      await result.current.confirmDeleteTurn();
    });

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({
      threadId: "thread-1",
      body: { messageId: "u1", includeUserMessage: true },
    });
    expect(result.current.pendingDelete).toBeNull();
    expect(settled).toEqual([true]);
  });

  it("switching threads drops a staged delete (never confirms against the wrong thread)", () => {
    const deleteTurn = mock<AgentHostTransport["deleteTurn"]>(
      async () => ({ deletedMessageIds: [], deletedUserMessageId: null }),
    );
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useAgentTurnActions({ ...hookArgs({ threadId }), transport: stubTransport(deleteTurn) }),
      { initialProps: { threadId: "thread-1" as string | null } },
    );

    act(() => result.current.requestDeleteTurn("a1", false));
    expect(result.current.pendingDelete).not.toBeNull();
    rerender({ threadId: "thread-2" });
    expect(result.current.pendingDelete).toBeNull();
  });
});

// ─── CA-4e3: edit-last keeps the row's attachment files and resends them ─────

describe("useAgentTurnActions — edit-last attachments (CA-4e3)", () => {
  beforeEach(() => {
    globalThis.fetch = routerFetch;
    deleteCalls = [];
    settled = [];
  });

  const file: import("@vibe-tavern/domain").Attachment = {
    id: "att1", assetId: "asset-1", name: "notes.md", type: "file",
    mimeType: "text/markdown", sizeBytes: 12, tokenCount: 42,
  };

  it("deletes with keepAttachmentFiles and resends the row's attachments as they are", async () => {
    const sendTurn = mock(async (_content: string, _opts?: unknown) => {});
    const deleteTurn = mock<AgentHostTransport["deleteTurn"]>(
      async () => ({ deletedMessageIds: ["u1"], deletedUserMessageId: "u1" }),
    );
    const threadMessages = [
      message({ id: "u1", role: "user", content: "Read this", attachments: [file] }),
      message({ id: "a1", role: "assistant" }),
    ];
    const { result } = renderHook(() =>
      useAgentTurnActions({ ...hookArgs(), threadMessages, sendTurn, transport: stubTransport(deleteTurn) }),
    );

    await act(async () => {
      await result.current.handleEditLast("revised");
    });

    expect(deleteTurn).toHaveBeenCalledTimes(1);
    expect(deleteTurn.mock.calls[0][1]).toEqual({ messageId: "u1", includeUserMessage: true, keepAttachmentFiles: true });
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0]).toEqual(["revised", { attachments: [file] }]);
  });

  it("an attachment-only row edits with empty text", async () => {
    const sendTurn = mock(async (_content: string, _opts?: unknown) => {});
    const deleteTurn = mock<AgentHostTransport["deleteTurn"]>(
      async () => ({ deletedMessageIds: ["u1"], deletedUserMessageId: "u1" }),
    );
    const threadMessages = [
      message({ id: "u1", role: "user", content: "", attachments: [file] }),
      message({ id: "a1", role: "assistant" }),
    ];
    const { result } = renderHook(() =>
      useAgentTurnActions({ ...hookArgs(), threadMessages, sendTurn, transport: stubTransport(deleteTurn) }),
    );

    await act(async () => {
      await result.current.handleEditLast("   ");
    });

    expect(deleteTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0][0]).toBe("");
  });

  it("a plain staged delete still sends no keepAttachmentFiles (CA-4d2 unchanged)", async () => {
    const deleteTurn = mock<AgentHostTransport["deleteTurn"]>(
      async () => ({ deletedMessageIds: [], deletedUserMessageId: null }),
    );
    const { result } = renderHook(() =>
      useAgentTurnActions({ ...hookArgs(), transport: stubTransport(deleteTurn) }),
    );

    act(() => result.current.requestDeleteTurn("u1", true));
    await act(async () => {
      await result.current.confirmDeleteTurn();
    });

    expect(deleteTurn.mock.calls[0][1]).toEqual({ messageId: "u1", includeUserMessage: true });
  });
});

// ─── AP-13: the ONE category→description derivation (toast + card share it) ───
// WAS (characterized at AP-10, basis: the toast branches in
// use-agent-turn-actions.ts): auth → auth desc; rate_limit/timeout/network/
// server_error → transient desc; empty_response/parse_error → empty desc;
// everything else → bare toast. NOW: the same mapping, named and shared.

describe("copilotFailureDescriptionKey — the shared toast/card derivation", () => {
  it("maps the auth category to the guidance text", async () => {
    const { copilotFailureDescriptionKey } = await import("./use-agent-turn-actions.js");
    expect(copilotFailureDescriptionKey("authentication")).toBe("provider_error_auth_desc");
  });

  it("maps the transient categories to the try-again text", async () => {
    const { copilotFailureDescriptionKey } = await import("./use-agent-turn-actions.js");
    for (const category of ["rate_limit", "timeout", "network", "server_error"] as const) {
      expect(copilotFailureDescriptionKey(category)).toBe("provider_error_transient_desc");
    }
  });

  it("maps the empty categories to the regenerate text", async () => {
    const { copilotFailureDescriptionKey } = await import("./use-agent-turn-actions.js");
    for (const category of ["empty_response", "parse_error"] as const) {
      expect(copilotFailureDescriptionKey(category)).toBe("provider_error_empty_desc");
    }
  });

  it("returns undefined for undescribed categories (the toast stays bare, the card hides its description)", async () => {
    const { copilotFailureDescriptionKey } = await import("./use-agent-turn-actions.js");
    for (const category of ["unknown", "invalid_request", "aborted", "subscription_required"] as const) {
      expect(copilotFailureDescriptionKey(category)).toBeUndefined();
    }
  });
});

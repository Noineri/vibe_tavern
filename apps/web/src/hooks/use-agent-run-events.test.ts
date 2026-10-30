import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { brandId, type ChatId, type AgentThreadOwner } from "@vibe-tavern/domain";
import { useDomEnv } from "../../test/dom-env.js";
import { installI18nContextSeam } from "../../test/i18n-context-seam.js";
useDomEnv();
const { renderHook, waitFor, act } = await import("@testing-library/react");
const { toast } = await import("sonner");
const { registerAgentHost } = await import("../lib/agent-host-registry.js");
const { registerVisibleAgentThread, useVisibleAgentThread } = await import("../lib/agent-run-visibility.js");
const { useChatStore } = await import("../stores/chat-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useNavigationStore } = await import("../stores/navigation-store.js");
const { useCoauthorTurnStore } = await import("../stores/coauthor-turn-store.js");
const { snapshotCoauthorEditorSnapshotStateForTests, restoreCoauthorEditorSnapshotStateForTests } = await import("../lib/coauthor-editor-snapshot.js");
const originalEditor = snapshotCoauthorEditorSnapshotStateForTests();
const originalChat = useChatStore.getState(), originalSnapshot = useSnapshotStore.getState(), originalNavigation = useNavigationStore.getState(), originalTurn = useCoauthorTurnStore.getState();
const originalFetch = globalThis.fetch;
const api = await import("../api/experience-copilot-api.js");
let language = "en";
installI18nContextSeam({ custom: { t: (key, values) => JSON.stringify({ key, values, language }) } });
const { useAgentRunEvents } = await import("./use-agent-run-events.js");

class Source {
  static instances: Source[] = [];
  listeners = new Map<string, EventListener>();
  closed = false;
  constructor(readonly url: string) { Source.instances.push(this); }
  addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener); }
  removeEventListener(name: string, listener: EventListener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
  close() { this.closed = true; }
  emit(payload: unknown) { this.raw(JSON.stringify(payload)); }
  raw(data: string) { this.listeners.get("agent.run")?.(new MessageEvent("agent.run", { data })); }
}
const originalSource = globalThis.EventSource;
const tokenKey = "vibe_mobile_token";
const originalToken = localStorage.getItem(tokenKey);
const success = spyOn(toast, "success").mockImplementation(() => "toast");
const info = spyOn(toast, "info").mockImplementation(() => "toast");
const error = spyOn(toast, "error").mockImplementation(() => "toast");
const kinds = ["experience", "script", "sidechat-ooc"] as const;
const opens = new Map(kinds.map((kind) => [kind, mock(async (_owner: AgentThreadOwner) => {})]));
const unregister = kinds.map((kind) => registerAgentHost({
  kind, open: opens.get(kind)!,
  i18n: { title: "agent_title", kindLabel: "agent_kind_script", placeholder: "agent_title", loading: "agent_title", emptyTitle: "agent_title" },
  starterPromptKeys: ["agent_title", "agent_title", "agent_title", "agent_title"],
  toolKeys: [], bufferSpecs: [], profileAssignment: { target: "script" }, messageMarkup: "plain", recordProposalRenderers: {}, buildSendOptions: () => ({}),
  transport: {
    sendStream: api.streamExperienceCopilot, answerAsk: api.answerCopilotAsk, deleteTurn: api.deleteCopilotTurn, editMessage: api.editCopilotMessage,
    getActiveThread: () => api.getExperienceCopilotActive("script"), startSession: () => api.startExperienceCopilotSession("script"), listSessions: () => api.listExperienceCopilotSessions("script"),
    listMessages: api.listExperienceCopilotMessages, activateSession: api.activateExperienceCopilotSession, renameSession: api.renameExperienceCopilotSession, setContextLinks: api.setExperienceCopilotContextLinks,
  },
}));
function restoreToken() {
  if (originalToken === null) localStorage.removeItem(tokenKey);
  else localStorage.setItem(tokenKey, originalToken);
}
function restoreStores() {
  globalThis.fetch = originalFetch;
  restoreCoauthorEditorSnapshotStateForTests(originalEditor);
  useChatStore.setState(originalChat, true); useSnapshotStore.setState(originalSnapshot, true);
  useNavigationStore.setState(originalNavigation, true); useCoauthorTurnStore.setState(originalTurn, true);
}
beforeEach(() => {
  restoreStores();
  globalThis.EventSource = originalSource;
  restoreToken(); language = "en";
  Source.instances = [];
  success.mockClear(); info.mockClear(); error.mockClear();
  for (const open of opens.values()) { open.mockClear(); open.mockImplementation(async () => {}); }
  globalThis.EventSource = Source as unknown as typeof EventSource;
});
afterAll(() => {
  restoreStores();
  globalThis.EventSource = originalSource;
  restoreToken(); success.mockRestore(); info.mockRestore(); error.mockRestore();
  for (const off of unregister) off();
});
function notification(kind: typeof kinds[number] = "script", state = "finished") {
  const owner: AgentThreadOwner = kind === "sidechat-ooc"
    ? { kind: "chat", chatId: "chat", branchId: "branch", agentKind: kind }
    : { kind: "script", scriptId: "script" };
  return { threadId: "thread", kind, title: "Named host", state, owner };
}

for (const [state, level, key] of [
  ["finished", success, "agent_run_finished_toast"],
  ["asking", info, "agent_run_asking_toast"],
  ["failed", error, "agent_run_failed_toast"],
] as const) {
  test(`${state} shows its existing sonner level, host name and one Open action`, () => {
    const h = renderHook(() => useAgentRunEvents());
    try {
      Source.instances[0]!.emit(notification("script", state));
      expect(level).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(level.mock.calls[0]![0]))).toEqual({ key, values: { name: "Named host" }, language: "en" });
      expect(level.mock.calls[0]![1]?.action).toMatchObject({ label: JSON.stringify({ key: "agent_run_open", language: "en" }), onClick: expect.any(Function) });
    } finally { h.unmount(); }
  });
}

for (const kind of kinds) {
  test(`${kind} Open delegates the exact typed owner to that descriptor`, async () => {
    const h = renderHook(() => useAgentRunEvents());
    try {
      const event = notification(kind);
      Source.instances[0]!.emit(event);
      const action = success.mock.calls[0]![1]!.action;
      if (typeof action !== "object" || action === null || !("onClick" in action)) throw new Error("No Open action");
      await action.onClick(new MouseEvent("click") as unknown as Parameters<typeof action.onClick>[0]);
      expect(opens.get(kind)!).toHaveBeenCalledWith(event.owner);
      expect([...opens.values()].reduce((count, open) => count + open.mock.calls.length, 0)).toBe(1);
    } finally { h.unmount(); }
  });
}

test("on-screen state is checked at delivery and hidden/unmounted views receive notifications", () => {
  const h = renderHook(() => useAgentRunEvents());
  const off = registerVisibleAgentThread("script", "thread");
  try {
    Source.instances[0]!.emit(notification());
    expect(success).not.toHaveBeenCalled();
    off();
    Source.instances[0]!.emit(notification());
    expect(success).toHaveBeenCalledTimes(1);
  } finally { off(); h.unmount(); }
});

test("started/stopped, malformed data, unknown hosts and non-navigable owners stay quiet", () => {
  const h = renderHook(() => useAgentRunEvents());
  try {
    const source = Source.instances[0]!;
    for (const state of ["started", "stopped"]) source.emit(notification("script", state));
    source.raw("not json"); source.emit(null); source.emit({ ...notification(), title: null });
    source.emit({ ...notification(), kind: "unknown-host" });
    source.emit({ ...notification(), owner: { kind: "draft", draftSessionId: null } });
    source.emit({ ...notification("sidechat-ooc"), owner: { kind: "chat", chatId: "chat", branchId: "branch", agentKind: "wrong-kind" } });
    expect(success).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  } finally { h.unmount(); }
});

test("the authenticated channel survives rerenders/locale changes, and cleanup rejects late delivery", () => {
  localStorage.setItem(tokenKey, "test token");
  const h = renderHook(() => useAgentRunEvents());
  const source = Source.instances[0]!;
  const late = source.listeners.get("agent.run")!;
  try {
    expect(source.url).toContain("/api/agent-runs/events?token=test%20token");
    language = "ru"; h.rerender();
    expect(Source.instances).toHaveLength(1);
    source.emit(notification());
    expect(JSON.parse(String(success.mock.calls[0]![0])).language).toBe("ru");
  } finally { h.unmount(); }
  expect(source.closed).toBe(true);
  expect(source.listeners.size).toBe(0);
  late(new MessageEvent("agent.run", { data: JSON.stringify(notification()) }));
  expect(success).toHaveBeenCalledTimes(1);
});

test("a failed Open action reports the existing request error instead of rejecting unhandled", async () => {
  opens.get("script")!.mockImplementation(async () => { throw new Error("Destination no longer exists"); });
  const h = renderHook(() => useAgentRunEvents());
  try {
    Source.instances[0]!.emit(notification());
    const action = success.mock.calls[0]![1]!.action;
    if (typeof action !== "object" || action === null || !("onClick" in action)) throw new Error("No Open action");
    await action.onClick(new MouseEvent("click") as unknown as Parameters<typeof action.onClick>[0]);
    expect(error).toHaveBeenCalledWith("Destination no longer exists");
  } finally { h.unmount(); }
});

const coauthorEvent = (state = "finished") => ({ threadId: "chat:coauthor-chat", kind: "coauthor", title: "Character", state,
  owner: { kind: "chat", chatId: "coauthor-chat", mode: "coauthor" } });

for (const [state, level] of [["finished", success], ["failed", error]] as const) {
  test(`Co-Author ${state} notification opens the exact existing character chat, not an agent thread`, async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input); requests.push(url);
      if (url.endsWith("/api/agent-runs")) return Response.json([]);
      if (url.endsWith("/coauthor/review")) return Response.json(null);
      return Response.json({ activeChat: { id: "coauthor-chat", characterId: "coauthor-character", mode: "coauthor" }, activeBranch: { id: "branch" } });
    }) as typeof fetch;
    const h = renderHook(() => useAgentRunEvents());
    try {
      Source.instances[0]!.emit(coauthorEvent(state));
      expect(level).toHaveBeenCalledTimes(1);
      const action = level.mock.calls[0]![1]!.action;
      if (typeof action !== "object" || !action || !("onClick" in action)) throw new Error("No Open action");
      await action.onClick(new MouseEvent("click") as unknown as Parameters<typeof action.onClick>[0]);
      expect(String(useChatStore.getState().activeChatId)).toBe("coauthor-chat");
      expect(useChatStore.getState().selectedCharacterId).toBe("coauthor-character");
      expect(useNavigationStore.getState().mode).toBe("play");
      expect(requests.some((url) => url.includes("/experience-copilot/"))).toBe(false);
    } finally { h.unmount(); }
  });
}

test("the mounted Co-Author visibility lease suppresses only its chat and releases on unmount", () => {
  const view = renderHook(() => useVisibleAgentThread("coauthor", "chat:coauthor-chat", true));
  const h = renderHook(() => useAgentRunEvents());
  try {
    Source.instances[0]!.emit(coauthorEvent());
    expect(success).not.toHaveBeenCalled();
    view.unmount();
    Source.instances[0]!.emit(coauthorEvent());
    expect(success).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); h.unmount(); }
});

test("mismatched Co-Author owners never create notifications", () => {
  const h = renderHook(() => useAgentRunEvents());
  try {
    const event = coauthorEvent();
    Source.instances[0]!.emit({ ...event, owner: { ...event.owner, mode: "rp" } });
    Source.instances[0]!.emit({ ...event, threadId: "chat:another-chat" });
    Source.instances[0]!.emit({ ...event, owner: { ...event.owner, chatId: "" } });
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled();
  } finally { h.unmount(); }
});

const replyEvent = (state = "finished", chatId = "rp-chat") => ({ threadId: `chat:${chatId}`, kind: "rp", title: "Reply header character", state,
  owner: { kind: "chat", chatId, mode: "rp" } });

test("a background RP reply uses the header name and Open navigates to its exact roleplay chat", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input); requests.push(url);
    if (url.endsWith("/queue")) return Response.json([]);
    return Response.json({ activeChat: { id: "rp-chat", characterId: "rp-character", mode: "rp" }, activeBranch: { id: "branch" } });
  }) as typeof fetch;
  const h = renderHook(() => useAgentRunEvents());
  try {
    Source.instances[0]!.emit(replyEvent());
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(success.mock.calls[0]![0]))).toEqual({ key: "chat_new_reply_toast", values: { name: "Reply header character" }, language: "en" });
    const action = success.mock.calls[0]![1]!.action;
    if (typeof action !== "object" || !action || !("onClick" in action)) throw new Error("No Open action");
    await action.onClick(new MouseEvent("click") as unknown as Parameters<typeof action.onClick>[0]);
    expect(String(useChatStore.getState().activeChatId)).toBe("rp-chat");
    expect(useChatStore.getState().selectedCharacterId).toBe("rp-character");
    expect(useNavigationStore.getState().mode).toBe("play");
    expect(requests.some((url) => url.includes("/experience-copilot/"))).toBe(false);
  } finally { h.unmount(); }
});

test("a queue of three toasts only after the final job, not per variant", async () => {
  let pending = 2;
  globalThis.fetch = Object.assign(async () => Response.json(pending ? [{ id: "waiting", chatId: "rp-chat", messageId: "assistant", model: "model", promptPresetId: null, status: "pending", enqueuedAt: 1 }] : []), { preconnect: originalFetch.preconnect });
  const h = renderHook(() => useAgentRunEvents());
  try {
    const source = Source.instances[0]!;
    for (let index = 0; index < 3; index++) {
      await act(async () => { source.emit(replyEvent("started")); source.emit(replyEvent()); });
      if (index < 2) expect(success).not.toHaveBeenCalled();
      else await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
      pending -= 1;
    }
    await act(async () => { source.emit(replyEvent()); });
    expect(success).toHaveBeenCalledTimes(1); // Duplicate terminal delivery without another start.
  } finally { h.unmount(); }
});

test("fast queue finishes cannot race late canonical reads into multiple completion toasts", async () => {
  const releases: Array<(response: Response) => void> = [];
  globalThis.fetch = Object.assign(() => new Promise<Response>((resolve) => { releases.push(resolve); }), { preconnect: originalFetch.preconnect });
  const h = renderHook(() => useAgentRunEvents());
  try {
    for (let index = 0; index < 3; index++) { Source.instances[0]!.emit(replyEvent("started")); Source.instances[0]!.emit(replyEvent()); }
    expect(releases).toHaveLength(3);
    await act(async () => { for (const release of releases) release(Response.json([])); });
    expect(success).toHaveBeenCalledTimes(1);
  } finally { h.unmount(); }
});

test("visible RP, errors, stops, asking and owner/key mismatches stay quiet", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => { requests.push(String(input)); return Response.json([]); }) as typeof fetch;
  const h = renderHook(() => useAgentRunEvents());
  try {
    useChatStore.setState({ activeChatId: brandId<ChatId>("rp-chat") });
    useSnapshotStore.setState({ activeChat: { id: "rp-chat", mode: "rp" } as typeof originalSnapshot.activeChat });
    for (const state of ["started", "finished", "failed", "stopped", "asking"]) Source.instances[0]!.emit(replyEvent(state));
    Source.instances[0]!.emit({ ...replyEvent(), threadId: "chat:wrong" });
    Source.instances[0]!.emit({ ...replyEvent(), owner: { kind: "chat", chatId: "rp-chat", mode: "coauthor" } });
    expect(requests).toEqual([]);
    expect(success).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  } finally { h.unmount(); }
});

test("a late queue read after navigation or unmount cannot toast the now-visible reply", async () => {
  let release!: (response: Response) => void;
  globalThis.fetch = Object.assign(() => new Promise<Response>((resolve) => { release = resolve; }), { preconnect: originalFetch.preconnect });
  const h = renderHook(() => useAgentRunEvents());
  Source.instances[0]!.emit(replyEvent());
  useChatStore.setState({ activeChatId: brandId<ChatId>("rp-chat") });
  useSnapshotStore.setState({ activeChat: { id: "rp-chat", mode: "rp" } as typeof originalSnapshot.activeChat });
  await act(async () => { release(Response.json([])); });
  expect(success).not.toHaveBeenCalled();
  useNavigationStore.getState().setMode("build");
  Source.instances[0]!.emit(replyEvent("started")); Source.instances[0]!.emit(replyEvent());
  h.unmount();
  await act(async () => { release(Response.json([])); });
  expect(success).not.toHaveBeenCalled();
});

test("background errors and stops stay quiet and invalidate older in-flight completion checks", async () => {
  const releases: Array<(response: Response) => void> = [];
  globalThis.fetch = Object.assign(() => new Promise<Response>((resolve) => { releases.push(resolve); }), { preconnect: originalFetch.preconnect });
  const h = renderHook(() => useAgentRunEvents());
  try {
    for (const state of ["failed", "stopped", "asking"]) {
      const source = Source.instances[0]!;
      source.emit(replyEvent("started")); source.emit(replyEvent());
      source.emit(replyEvent("started")); source.emit(replyEvent(state));
    }
    await act(async () => { for (const release of releases) release(Response.json([])); });
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled();
  } finally { h.unmount(); }
});

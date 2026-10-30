/** Real AppShell hook/coordinator/API/parser/store; only HTTP is doubled. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { buildCoauthorReviewEnvelope, type CoauthorReviewEnvelope } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../test/dom-env.js";
useDomEnv();
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { useCoauthorReviewPersistence } = await import("./use-coauthor-review-persistence.js");
const { coauthorReviews, saveDraft, loadDraft } = await import("../lib/coauthor-draft.js");
const { useChatStore } = await import("../stores/chat-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useCoauthorTurnStore } = await import("../stores/coauthor-turn-store.js");
const { chatStreamToolCallbacks } = await import("./chat-stream-tool-callbacks.js");
const { publishCoauthorReviewSession, readCoauthorReviewSession, snapshotCoauthorEditorSnapshotStateForTests, restoreCoauthorEditorSnapshotStateForTests } = await import("../lib/coauthor-editor-snapshot.js");
const originalEditor = snapshotCoauthorEditorSnapshotStateForTests();
const id = brandId<ChatId>("server-review-chat");
const storageKey = `vt:coauthor-draft:${id}`;
const originalStorage = localStorage.getItem(storageKey);
const originalFetch = globalThis.fetch;
const originalChat = useChatStore.getState(), originalSnapshot = useSnapshotStore.getState(), originalTurn = useCoauthorTurnStore.getState();
const proposal = (toolCallId = "profile") => ({ toolCallId, toolName: "write_profile", status: "done" as const, target: "profile" as const, proposed: "---\nname: Draft\n---\n# Personality\nBold." });
let remote: CoauthorReviewEnvelope | null, running: boolean, failPut: boolean;
let requests: string[];
let delayedGet: (() => Promise<Response>) | undefined;
function restore() {
  restoreCoauthorEditorSnapshotStateForTests(originalEditor);
  globalThis.fetch = originalFetch;
  useChatStore.setState(originalChat, true); useSnapshotStore.setState(originalSnapshot, true); useCoauthorTurnStore.setState(originalTurn, true);
  if (originalStorage === null) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, originalStorage);
}
beforeEach(() => {
  restore(); localStorage.removeItem(storageKey);
  remote = null; running = false; failPut = false; requests = []; delayedGet = undefined;
  useChatStore.setState({ activeChatId: id, generations: {} });
  useSnapshotStore.setState({ activeChat: { id, mode: "coauthor" } as NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]> });
  useCoauthorTurnStore.setState({ turnsByChat: {} });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://gateway.test");
    const path = url.pathname.slice(url.pathname.indexOf("/api/")), method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (path === "/api/agent-runs") return Response.json(running ? [{ threadId: `chat:${id}` }] : []);
    if (path !== `/api/chats/${id}/coauthor/review`) throw new Error(`Unexpected ${method} ${path}`);
    if (method === "PUT") {
      if (failPut) return Response.json({ error: "Upload failed" }, { status: 500 });
      remote = JSON.parse(String(init?.body)) as CoauthorReviewEnvelope;
    }
    if (method === "DELETE") { remote = null; return Response.json({ ok: true }); }
    return delayedGet && method === "GET" ? delayedGet() : Response.json(remote);
  }) as typeof fetch;
});
afterAll(restore);

test("server-only proposals restore after reload with no localStorage key or browser write", async () => {
  remote = buildCoauthorReviewEnvelope([proposal()]);
  const hook = renderHook(() => useCoauthorReviewPersistence());
  try {
    await waitFor(() => expect(useCoauthorTurnStore.getState().getActivities(id)).toEqual(remote!.activities));
    expect(requests.every((request) => request.startsWith("GET"))).toBe(true);
    expect(loadDraft(id)).toBeNull();
  } finally { hook.unmount(); }
});

test("legacy upload happens once, is confirmed before key removal, and survives another reload", async () => {
  saveDraft(id, [proposal(), { toolCallId: "tracker", toolName: "set_tracker_template", status: "done", trackerTemplate: { version: 1, scene: null, objective: null } }]);
  await coauthorReviews.hydrate(id);
  expect(remote?.activities.map((a) => a.toolCallId)).toEqual(["profile", "tracker"]);
  expect(loadDraft(id)).toBeNull();
  useCoauthorTurnStore.setState({ turnsByChat: {} });
  await coauthorReviews.hydrate(id);
  expect(useCoauthorTurnStore.getState().getActivities(id)).toEqual(remote!.activities);
  expect(requests.filter((request) => request.startsWith("PUT"))).toHaveLength(1);
});

test("failed migration preserves the key and the ordered lane can retry", async () => {
  saveDraft(id, [proposal()]); failPut = true;
  await expect(coauthorReviews.hydrate(id)).rejects.toThrow("Upload failed");
  expect(loadDraft(id)).toEqual([proposal()]);
  failPut = false;
  await coauthorReviews.hydrate(id);
  expect(loadDraft(id)).toBeNull();
  expect(useCoauthorTurnStore.getState().getActivities(id)).toEqual(remote!.activities);
});

test("a newer server draft wins over legacy, without a browser PUT", async () => {
  saveDraft(id, [proposal("legacy")]); remote = buildCoauthorReviewEnvelope([proposal("server")]);
  await coauthorReviews.hydrate(id);
  expect(useCoauthorTurnStore.getState().getActivities(id)[0]?.toolCallId).toBe("server");
  expect(loadDraft(id)).toBeNull();
  expect(requests.filter((request) => request.startsWith("PUT"))).toHaveLength(0);
});

test("a running producer defers migration and never uploads partial live/replay output", async () => {
  running = true; saveDraft(id, [proposal("legacy")]);
  useCoauthorTurnStore.getState().upsertActivity(id, proposal("partial"));
  await coauthorReviews.hydrate(id);
  expect(requests).toEqual(["GET /api/agent-runs"]);
  expect(loadDraft(id)?.[0]?.toolCallId).toBe("legacy");
  expect(useCoauthorTurnStore.getState().getActivities(id)[0]?.toolCallId).toBe("partial");
});

test("turn settlement restores the prior server review after a read-only/no-proposal turn", async () => {
  remote = buildCoauthorReviewEnvelope([proposal("older")]);
  useChatStore.getState().startGeneration(id);
  useCoauthorTurnStore.getState().upsertActivity(id, { toolCallId: "read", toolName: "read_skill_file", status: "done", readPath: "skill.md" });
  const hook = renderHook(() => useCoauthorReviewPersistence());
  try {
    expect(requests).toEqual([]);
    await act(async () => { useChatStore.getState().finishGeneration(id); });
    await waitFor(() => expect(useCoauthorTurnStore.getState().getActivities(id).map((a) => a.toolCallId)).toEqual(["read", "older"]));
    expect(requests.every((request) => request.startsWith("GET"))).toBe(true);
  } finally { hook.unmount(); }
});

test("a cleared server draft removes stale local proposals on the next visit", async () => {
  publishCoauthorReviewSession(id, "character", [proposal("retained")]);
  useCoauthorTurnStore.getState().upsertActivity(id, proposal("stale"));
  await coauthorReviews.hydrate(id);
  expect(useCoauthorTurnStore.getState().getActivities(id)).toEqual([]);
  expect(readCoauthorReviewSession(id, "character")).toEqual([]);
});

test("live and replay tracker results project the canonical proposal, keeping args and one review card", async () => {
  const trackerTemplate = { version: 1 as const, scene: null, objective: null };
  const callbacks = chatStreamToolCallbacks(id);
  callbacks.onToolCall?.({ toolCallId: "tracker", toolName: "set_tracker_template", args: { scene: null } });
  callbacks.onToolResult?.({ toolCallId: "tracker", toolName: "set_tracker_template", output: { trackerTemplate, summary: "Tracker proposal" }, isError: false });
  remote = buildCoauthorReviewEnvelope(useCoauthorTurnStore.getState().getActivities(id));
  await coauthorReviews.hydrate(id);
  expect(useCoauthorTurnStore.getState().getActivities(id)).toEqual([{ toolCallId: "tracker", toolName: "set_tracker_template", args: { scene: null }, status: "done", trackerTemplate, summary: "Tracker proposal" }]);
  expect(requests.every((request) => request.startsWith("GET"))).toBe(true);
});

test("explicit resolution deletes the exact server review and a reload cannot restore it", async () => {
  const origin = [proposal()]; remote = buildCoauthorReviewEnvelope(origin);
  await coauthorReviews.hydrate(id);
  await coauthorReviews.resolve(id, origin);
  useCoauthorTurnStore.getState().clearTurn(id);
  await coauthorReviews.hydrate(id);
  expect(remote).toBeNull();
  expect(useCoauthorTurnStore.getState().getActivities(id)).toEqual([]);
  expect(requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);
});

test("late resolution preserves a newer server proposal instead of deleting it", async () => {
  const origin = [proposal("origin")];
  useCoauthorTurnStore.setState({ turnsByChat: { [id]: origin } });
  remote = buildCoauthorReviewEnvelope([proposal("replacement")]);
  await coauthorReviews.resolve(id, origin);
  expect(remote?.activities[0]?.toolCallId).toBe("replacement");
  expect(useCoauthorTurnStore.getState().getActivities(id)[0]?.toolCallId).toBe("replacement");
  expect(requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(0);
});

test("resolution refuses a running producer and leaves the offered draft available", async () => {
  const origin = [proposal()]; remote = buildCoauthorReviewEnvelope(origin); running = true;
  await expect(coauthorReviews.resolve(id, origin)).rejects.toThrow("still owns");
  expect(remote?.activities).toEqual(origin);
  expect(requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(0);
});

test("hydration cannot overwrite activity arriving during a slow response", async () => {
  let release!: (response: Response) => void, requested!: () => void;
  const barrier = new Promise<void>((resolve) => { requested = resolve; });
  delayedGet = () => { requested(); return new Promise((resolve) => { release = resolve; }); };
  const pending = coauthorReviews.hydrate(id);
  try {
    await barrier;
    useCoauthorTurnStore.getState().upsertActivity(id, proposal("new-turn"));
  } finally { release(Response.json(buildCoauthorReviewEnvelope([proposal("stale")]))); await pending; }
  expect(useCoauthorTurnStore.getState().getActivities(id)[0]?.toolCallId).toBe("new-turn");
});

test("leaving a view invalidates its pending hydration and RP never fetches reviews", async () => {
  let release!: (response: Response) => void, requested!: () => void;
  const barrier = new Promise<void>((resolve) => { requested = resolve; });
  delayedGet = () => { requested(); return new Promise((resolve) => { release = resolve; }); };
  const hook = renderHook(() => useCoauthorReviewPersistence());
  await barrier;
  hook.unmount();
  release(Response.json(buildCoauthorReviewEnvelope([proposal("late")])));
  await coauthorReviews.hydrate(id, () => false); // Drain the same ordered lane.
  expect(useCoauthorTurnStore.getState().getActivities(id)).toEqual([]);
  requests = [];
  useSnapshotStore.setState({ activeChat: { id, mode: "rp" } as NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]> });
  const rp = renderHook(() => useCoauthorReviewPersistence());
  try { expect(requests).toEqual([]); } finally { rp.unmount(); }
});

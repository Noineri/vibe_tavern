import { afterAll, beforeEach, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
useDomEnv();
const { openBuildAgent, openSidechatAgent } = await import("./agent-host-navigation.js");
const { useBuildNavigationStore } = await import("../stores/build-navigation-store.js");
const { useCharacterStore } = await import("../stores/character-store.js");
const { useNavigationStore } = await import("../stores/navigation-store.js");
const { useChatStore } = await import("../stores/chat-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useSidechatOpenStore, SIDECHAT_OPEN_KEY_PREFIX } = await import("../stores/sidechat-open-store.js");
const { useSidechatMobileStore } = await import("../stores/sidechat-mobile-store.js");
function snapshot<T>(store: { getState: () => T; setState: (state: T, replace: true) => void }) {
  const before = store.getState();
  return () => store.setState(before, true);
}
const restore = [snapshot(useBuildNavigationStore), snapshot(useCharacterStore), snapshot(useNavigationStore), snapshot(useChatStore), snapshot(useSnapshotStore), snapshot(useSidechatOpenStore), snapshot(useSidechatMobileStore)];
const originalFetch = globalThis.fetch;
const storageKey = `${SIDECHAT_OPEN_KEY_PREFIX}destination-chat`;
const originalStorage = localStorage.getItem(storageKey);
let requests: Array<[string, string]>;
function reset() {
  globalThis.fetch = originalFetch;
  for (const apply of restore) apply();
  if (originalStorage === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, originalStorage);
}
beforeEach(() => {
  reset(); requests = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "http://gateway.test").pathname;
    requests.push([init?.method ?? "GET", path]);
    return Response.json({ activeChat: { id: "destination-chat", characterId: "character", mode: "rp" }, activeBranch: { id: path.endsWith("/activate") ? "destination-branch" : "previous-branch" } });
  }) as typeof fetch;
});
afterAll(reset);

for (const kind of ["experience", "script"] as const) {
  test(`${kind} Open selects its build panel and a fresh entity intent`, async () => {
    await openBuildAgent(kind, { kind: "script", scriptId: "destination-script" });
    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useCharacterStore.getState().buildTab).toBe(kind === "experience" ? "experience" : "lorebook");
    const first = useBuildNavigationStore.getState().agentOpenIntent!;
    expect(first).toEqual({ kind, scriptId: "destination-script" });
    await openBuildAgent(kind, { kind: "script", scriptId: "next-script" });
    useBuildNavigationStore.getState().consumeAgentOpen(first);
    expect(useBuildNavigationStore.getState().agentOpenIntent!.scriptId).toBe("next-script");
    expect(requests).toEqual([]);
  });
}

test("sidechat Open loads its chat and exact branch, then opens both desktop and mobile destinations", async () => {
  await openSidechatAgent({ kind: "chat", chatId: "destination-chat", branchId: "destination-branch", agentKind: "sidechat-ooc" });
  expect(requests.map(([method, path]) => [method, path.replace(/^.*\/api/, "/api")])).toEqual([
    ["GET", "/api/chats/destination-chat"], ["POST", "/api/chats/destination-chat/branches/destination-branch/activate"],
  ]);
  expect(String(useChatStore.getState().activeChatId)).toBe("destination-chat");
  expect(String(useSnapshotStore.getState().activeBranch!.id)).toBe("destination-branch");
  expect(useNavigationStore.getState().mode).toBe("play");
  expect(useSidechatOpenStore.getState().openByChat["destination-chat"]).toBe(true);
  expect(useSidechatMobileStore.getState().tab).toBe("sidechat");
});

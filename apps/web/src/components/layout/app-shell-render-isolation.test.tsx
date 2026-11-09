/**
 * AppShell root-keystroke render isolation (LAG-1, step 1 of
 * AGENT_SHELL_RENDER_LAG_REPORT).
 *
 * WHAT THIS PROVES
 *   Idle keystrokes — `setDraft` (the RP / co-author composer) and
 *   `setEditingDraft` (a message edit field) — re-render NEITHER the
 *   sidechat's AgentShell NOR the co-author editor panel while a chat is
 *   active. Before LAG-1 the app root subscribed to both draft fields (plus
 *   isSending) and dragged the whole right column along on every keystroke.
 *
 * HOW IT PROVES IT
 *   The real panels are mounted — the real AgentShell through the sidechat
 *   host's module-load registration (fetch-level router, same as
 *   SidechatPanel.test.tsx) and the real editor pane chrome (the live form
 *   stubbed at the module boundary, same as CoauthorEditorPanel.test.tsx) —
 *   under a harness parent that reproduces the pre-fix AppShell shape: it
 *   subscribes to the two per-keystroke store fields, so every keystroke
 *   re-renders the PARENT and re-creates the panel element (exactly what
 *   useShellSurface does per AppShell render). Both panels take no props, so
 *   a memo boundary (the MessageBlock pattern) must absorb that parent
 *   re-render entirely. Panel renders are counted through a counting stub on
 *   ResizableSidePane — the first child of BOTH panels — because a Profiler
 *   around a memo-bailing panel fires anyway (R12: count the target's OWN
 *   renders; a memo bail skips the pane subtree too, so the pane's render
 *   count per panelTestId IS the panel's render count).
 *
 *   A static guard additionally pins the AppShell SOURCE: the three dead
 *   root subscriptions (draft / editingDraft / isSending) stay deleted — a
 *   re-introduced root subscription would re-render the app root per
 *   keystroke even with the panels memoized (same discipline as the STATIC
 *   IMPORT GUARD in message-block-isolation.test.tsx).
 *
 * POSITIVE CONTROLS (not just negatives)
 *   The sidechat panel's open-store flip must still re-render it after the
 *   reset — the counter is live and the panel's own subscription graph is
 *   active, so a 0 is never vacuous. Both panes' mount renders are asserted
 *   before the counters reset (after memo() nothing but their own stores can
 *   re-render them — that is the boundary's contract).
 *
 * Runner: bun:test with scoped happy-dom (useDomEnv).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import type { ReactNode } from "react";
import { brandId, CHAT_MODE } from "@vibe-tavern/domain";
import type {
  AgentKindSettingsWire,
  ExperienceCopilotThreadWire,
} from "@vibe-tavern/api-contracts";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireBranch, wireChat, wireProviderProfile, wireUiSettings } from "../../../test/wire-fixtures.js";
import type { ProviderProfileRecord } from "../../api/types.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useAgentTurnStore } from "../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../stores/agent-review-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { SIDECHAT_AGENT_KIND } from "../../api/agent-kind-served-modes.js";
import { useSidechatOpenStore } from "../../stores/sidechat-open-store.js";
import { useSidechatCallDirectorStore } from "../../stores/sidechat-call-director-store.js";
import { useChatStore } from "../../stores/chat-store.js";

useDomEnv();

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
// Load-time copy of the real namespace (R15) so the factory never re-imports
// the live, possibly-rewritten module.
const realTooltip = { ...(await import("../shared/Tooltip.js")) };
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The panels read isMobile through the hook — pin the suite to desktop with
// the same mutable-cell pattern as SidechatPanel.test.tsx.
let mobileOverride = false;
const realMobile = { ...(await import("../../hooks/use-mobile.js")) };
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

// The live MD editor reads snapshot/coauthor stores and fires API fetches on
// mount — pinned in its own suite. Stub it to a probe (same shape as
// CoauthorEditorPanel.test.tsx); render counting does not need its body.
const realForm = { ...(await import("../coauthor/CoauthorCharacterForm.js")) };
mock.module("../coauthor/CoauthorCharacterForm.js", () => ({
  ...realForm,
  CoauthorCharacterForm: () => <div data-testid="coauthor-form-probe">editor</div>,
}));

// House i18n pattern via the shared co-load seam: provider-less renders echo
// raw keys (identity spec) — the mount must succeed, the strings are not under test.
installI18nContextSeam();

// ── Per-panel render counter (R12 discipline) ─────────────────────────────────
// A <Profiler> around the panel cannot see a memo bail: the harness rebuilds
// the Profiler's children element every render, so onRender fires for the
// Profiler fiber itself even when the memoized panel below skipped. Instead
// count the panel's OWN re-renders where they are observable from inside the
// memo boundary: BOTH panels render ResizableSidePane as their first child,
// so that component's render count per panelTestId IS the panel's render
// count (a memo bail skips the whole subtree, pane included). The real pane
// runs through a direct call (hooks attach to the counting fiber — no element
// indirection that could bail on its own).
const paneRenders: Record<string, number> = {};
const realPane = { ...(await import("../shared/resizable-side-pane.js")) };
mock.module("../shared/resizable-side-pane.js", () => ({
  ...realPane,
  ResizableSidePane: (props: { panelTestId?: string }) => {
    const key = props.panelTestId ?? "pane";
    paneRenders[key] = (paneRenders[key] ?? 0) + 1;
    return realPane.ResizableSidePane(props as Parameters<typeof realPane.ResizableSidePane>[0]);
  },
}));

// ── Fetch-level API router (same rationale and routes as SidechatPanel.test.tsx:
// the transport seam is faked at the FETCH level so the REAL hono clients run
// against canned payloads; no api-module mocking to poison co-loaded files). ──

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

const activeThread = chatThread("sidechat-thread-a");

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/active$/.test(path)) {
    return jsonResponse(activeThread);
  }
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/sessions$/.test(path)) {
    return jsonResponse([]);
  }
  if (method === "POST" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/session$/.test(path)) {
    return jsonResponse(chatThread("sidechat-thread-new"));
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream/.test(path)) {
    return new Response('data: {"finishReason":"stop"}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
    return jsonResponse([]);
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    return jsonResponse({ metrics: null, autoCompact: true });
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    return jsonResponse([]);
  }
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

function chatThread(id: string): ExperienceCopilotThreadWire {
  // The literal carries every member of the wire schema — the old cast was
  // noise; the annotation alone types it.
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

// ── Store seeding (same fixtures as SidechatPanel.test.tsx; the snapshot and
//    provider rows ride the wire factories — the ONE derivation of those
//    records; ids pinned to the values the erased literals carried) ──────────

type ActiveChat = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]>;
type ActiveBranch = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeBranch"]>;

const CHAT_A: ActiveChat = wireChat({ id: brandId<ChatId>("chat-a") });
const BRANCH_A: ActiveBranch = wireBranch({
  id: brandId<ChatBranchId>("branch-a"),
  chatId: brandId<ChatId>("chat-a"),
});

const PROFILES: ProviderProfileRecord[] = [
  wireProviderProfile({
    id: "p1",
    name: "Active RP provider",
    isActive: true,
    defaultModel: "m1",
    cachedModels: {
      models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }],
      // The erased literal omitted this required member of the cached-models
      // record; the reader (`profile.cachedModels.models`) never looked at it.
      cachedAt: "2026-01-01T00:00:00.000Z",
    },
  }),
];

function kindEntry(kind: string, servesChatModes: string[]): AgentKindSettingsWire {
  return {
    agentKind: kind,
    providerProfileId: null,
    modelName: null,
    defaultProfileId: null,
    updatedAt: "",
    servesChatModes: servesChatModes as AgentKindSettingsWire["servesChatModes"],
    autoCompactDefault: true,
  };
}

function seedStores(): void {
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: wireUiSettings(),
      agentKindSettings: { [SIDECHAT_AGENT_KIND]: kindEntry(SIDECHAT_AGENT_KIND, [CHAT_MODE.rp]) },
      isArmServer: false,
    },
  });
  useProviderDataStore.setState({ profiles: PROFILES });
}

function seedChat(chat: ActiveChat, branch: ActiveBranch): void {
  useSnapshotStore.setState({ activeChat: chat, activeBranch: branch });
}

const realFetch = globalThis.fetch;

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let waitFor: typeof import("@testing-library/react").waitFor;
let SidechatPanel: typeof import("../chat/sidechat/SidechatPanel.js").SidechatPanel;
let CoauthorEditorPanel: typeof import("../coauthor/CoauthorEditorPanel.js").CoauthorEditorPanel;

beforeAll(async () => {
  ({ render, act, waitFor } = await import("@testing-library/react"));
  ({ SidechatPanel } = await import("../chat/sidechat/SidechatPanel.js"));
  ({ CoauthorEditorPanel } = await import("../coauthor/CoauthorEditorPanel.js"));
});

beforeEach(() => {
  mobileOverride = false;
  globalThis.fetch = testFetch(fetchRouter);
  useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {} });
  useAgentReviewRoundStore.setState({ roundsByThread: {} });
  localStorage.clear();
  useSidechatOpenStore.setState({ openByChat: {} });
  useSidechatCallDirectorStore.setState({ pending: {} });
  useChatStore.setState({ draft: "", editingDraft: "", editingMessageId: null });
  for (const key of Object.keys(paneRenders)) delete paneRenders[key];
  seedStores();
  seedChat(CHAT_A, BRANCH_A);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * The pre-fix AppShell shape: a parent that subscribes to the per-keystroke
 * store fields, so every `setDraft` / `setEditingDraft` re-renders the
 * PARENT. The panels below must be immune to exactly this re-render. The
 * panel element is built PER PARENT RENDER (a builder prop, not a `children`
 * element) — the real AppShell re-creates `<SidechatPanel />` / `<CoauthorEditorPanel />
 * on every render (useShellSurface), and a stable `children` reference would
 * let React bail out on subtree identity alone, making the pin vacuous.
 */
function KeystrokeSubscribingRoot({ build }: { build: () => ReactNode }) {
  const draft = useChatStore((s) => s.draft);
  const editingDraft = useChatStore((s) => s.editingDraft);
  // Consume both values so the subscription is real (the root re-renders per
  // keystroke; the panels under test must not follow).
  return <div data-keystroke-sink={draft.length + editingDraft.length}>{build()}</div>;
}

/** Drain the shell's chained async microtasks + React's scheduler macrotasks. */
async function flushSessionLoad() {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe("LAG-1 step 1 — right panels are immune to root keystroke re-renders", () => {
  it("idle setDraft / setEditingDraft re-render neither panel while a chat is active", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");

    const sidechat = render(
      <KeystrokeSubscribingRoot
        build={() => <SidechatPanel />}
      />,
    );
    await flushSessionLoad();
    // The real AgentShell mounted (the composer is in the DOM) — the subject
    // of the assertion is alive, not an empty placeholder. A second flush
    // drains the session-load tail so no late settle lands inside the
    // measured phase below.
    await waitFor(() => expect(sidechat.queryByTestId("copilot-send-btn")).toBeDefined());
    await flushSessionLoad();
    expect(paneRenders["sidechat-panel"] ?? 0).toBeGreaterThanOrEqual(1); // mounted — counter is live

    const editor = render(
      <KeystrokeSubscribingRoot
        build={() => <CoauthorEditorPanel />}
      />,
    );
    await flushSessionLoad();
    expect(editor.getByTestId("coauthor-editor-panel")).toBeDefined();
    expect(paneRenders["coauthor-editor-panel"] ?? 0).toBeGreaterThanOrEqual(1); // mounted — counter is live

    paneRenders["sidechat-panel"] = 0;
    paneRenders["coauthor-editor-panel"] = 0;

    // The keystroke storm: one store write per keystroke, each re-rendering
    // the harness root (AppShell-of-today shape).
    act(() => { useChatStore.getState().setDraft("h"); });
    await act(async () => { await Promise.resolve(); });
    act(() => { useChatStore.getState().setDraft("he"); });
    await act(async () => { await Promise.resolve(); });
    act(() => { useChatStore.getState().setEditingDraft("x"); });
    await act(async () => { await Promise.resolve(); });
    act(() => { useChatStore.getState().setEditingDraft("xy"); });
    await act(async () => { await Promise.resolve(); });

    expect(paneRenders["sidechat-panel"] ?? 0).toBe(0); // the AgentShell's pane did not re-render
    expect(paneRenders["coauthor-editor-panel"] ?? 0).toBe(0); // the editor pane did not re-render

    // POSITIVE CONTROL: the sidechat's own open-store flip still re-renders
    // the panel (and its pane) — the 0 above is the panels' isolation, not a
    // dead counter or a panel that never mounted.
    act(() => { useSidechatOpenStore.getState().setOpen("chat-a", false); });
    await flushSessionLoad();
    expect(paneRenders["sidechat-panel"] ?? 0).toBeGreaterThan(0);

    sidechat.unmount();
    editor.unmount();
  });

  it("STATIC GUARD: AppShell keeps no per-keystroke root subscriptions", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(import.meta.dirname, "AppShell.tsx");
    const src = await fs.readFile(file, "utf8");

    // The three dead subscriptions LAG-1 deleted. `s.draft)` /
    // `s.editingDraft)` match only selector form `useChatStore((s) => s.draft)`
    // — the unrelated `(personaId, draft) =>` lambda parameter does not match.
    expect(src).not.toContain("s.draft)");
    expect(src).not.toContain("s.editingDraft)");
    expect(src).not.toContain("useIsSending(");
  });
});

/**
 * Sidechat desktop panel — behavioral tests (SIDECHAT_PLAN, Wave 4 / SC-14).
 *
 * Mounts the REAL `SidechatPanel` (which mounts the REAL generic AgentShell
 * through the sidechat host's module-load registration) with a fetch-level
 * router — no mock.module on the api modules, so this file coexists with any
 * other test file sharing the bun worker (the script-agent-host.test.tsx
 * reliability contract). Fetch is swapped per test and restored after each;
 * every process-global store touched here is re-seeded in beforeEach.
 *
 * Pins (the four named SC-14 steps, plus the served-modes gate):
 *   - the closed handle opens the panel; the chevron flips `<` → `>`;
 *   - (SC-16b adaptation, SC-16e slide rework) closing keeps the pane mounted
 *     at full width while the slider glides out, then unmounts at the
 *     slider's own transform `transitionend` — the assertions below pin the
 *     slide frame and the post-transition unmount, same intent as before;
 *   - per-chat open state is restored (seeded open renders open);
 *   - switching chat A (open) → chat B (stored closed) shows B closed and
 *     leaves B's stored value untouched (never a cross-write);
 *   - width is restored and clamped (default 400, min 320, max 50% of the
 *     live viewport — the clamp source);
 *   - a co-author chat (or a missing bootstrap map) renders no panel at all;
 *   - the left-border drag resizes the panel and persists the width.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { CHAT_MODE } from "@vibe-tavern/domain";
import type {
  AgentKindSettingsWire,
  ExperienceCopilotMessageWire,
  ExperienceCopilotThreadWire,
} from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../../stores/agent-review-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { SIDECHAT_WIDTH_KEY } from "./SidechatPanel.js";
import { useSidechatOpenStore } from "../../../stores/sidechat-open-store.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = false;

// ── Viewport width control (the panel's 50% max reads window.innerWidth) ────
const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
function setViewportWidth(value: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value });
}

// ── Fetch-level API router ───────────────────────────────────────────────
// Same rationale as script-agent-host.test.tsx: the transport seam is faked at
// the FETCH level so the REAL hono clients run against canned payloads.
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
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/active$/.test(path)) {
    return jsonResponse(router.activeThread);
  }
  if (method === "GET" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/sessions$/.test(path)) {
    return jsonResponse(router.sessions);
  }
  if (method === "POST" && /\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/[^/]+\/session$/.test(path)) {
    return jsonResponse(router.newSession);
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
    return jsonResponse(router.messages);
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

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The panel reads isMobile through the hook — override it with the same
// mutable cell so the suite stays on desktop unless a test opts out.
const realMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let SidechatPanel: typeof import("./SidechatPanel.js").SidechatPanel;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ render, act, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ SidechatPanel } = await import("./SidechatPanel.js"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (innerWidthDescriptor) Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

type ActiveChat = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]>;
type ActiveBranch = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeBranch"]>;

const CHAT_A = { id: "chat-a", mode: "rp" } as unknown as ActiveChat;
const BRANCH_A = { id: "branch-a", chatId: "chat-a", label: "main" } as unknown as ActiveBranch;
const CHAT_B = { id: "chat-b", mode: "rp" } as unknown as ActiveChat;
const BRANCH_B = { id: "branch-b", chatId: "chat-b", label: "main" } as unknown as ActiveBranch;

function chatThread(id: string): ExperienceCopilotThreadWire {
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

// p1 is the ACTIVE provider profile; each profile carries one tool-capable
// cached model so the REAL `useProviderModels` hook serves the model list
// from cache (no fetch).
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

function seedChat(chat: ActiveChat, branch: ActiveBranch): void {
  useSnapshotStore.setState({ activeChat: chat, activeBranch: branch });
}

beforeEach(() => {
  mobileOverride = false;
  globalThis.fetch = fetchRouter as unknown as typeof fetch;
  useAgentTurnStore.setState({ turnsByThread: {}, todoByThread: {} });
  useAgentReviewRoundStore.setState({ roundsByThread: {} });
  localStorage.clear();
  // The open flag is shared process state now (SC-18a) — reset it alongside
  // localStorage so no test reads the previous test's in-memory entry.
  useSidechatOpenStore.setState({ openByChat: {} });
  setViewportWidth(1024);
  seedStores({ [SIDECHAT_AGENT_KIND]: kindEntry(SIDECHAT_AGENT_KIND, [CHAT_MODE.rp]) });
  seedChat(CHAT_A, BRANCH_A);
  router = {
    activeThread: chatThread("sidechat-thread-a"),
    messages: [],
    sessions: [],
    newSession: chatThread("sidechat-thread-new"),
  };
  fetchRouter.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim). Never touches the process-global i18n singleton (R13).
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
 * Dispatch the slider's own transform `transitionend` (SC-16e: the close
 * path moved from the pane's width transition to the slider's transform
 * transition). happy-dom 20.14.5 ships `TransitionEvent` but drops
 * `propertyName` from its init dict, and RTL forwards init straight into
 * the constructor — so `fireEvent.transitionEnd(el, { propertyName })` can
 * never satisfy the slider's property filter. A plain bubbling Event with
 * the expando assigned is what real browsers deliver; dispatch ON the
 * slider (`target === currentTarget`) inside `act` so React flushes.
 */
function endSlideTransition(el: HTMLElement): void {
  const end = new Event("transitionend", { bubbles: true, cancelable: true }) as Event & {
    propertyName?: string;
  };
  end.propertyName = "transform";
  act(() => {
    el.dispatchEvent(end);
  });
}

/**
 * Drain the chained async `loadSession` microtasks (and React's scheduler
 * macrotasks) inside `act`, so the shell's thread/messages updates are
 * captured and do not emit React 19 "not wrapped in act" warnings.
 */
async function flushSessionLoad() {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** The chevron svg inside the toggle (Icons.Caret rotates via inline style). */
function toggleChevronStyle(toggle: HTMLElement): string {
  return toggle.querySelector("svg")?.getAttribute("style") ?? "";
}

// ── Handle open/close ───────────────────────────────────────────────────────

describe("sidechat-panel — handle opens/closes (SC-14)", () => {
  it("closed by default: the `<` tab shows, no panel and no shell mount", () => {
    const { getByTestId, queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));

    expect(getByTestId("sidechat-closed")).toBeDefined();
    const toggle = getByTestId("sidechat-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("sidechat_toggle_label");
    // Closed chevron points left (the caret's rotate-180 inline style).
    expect(toggleChevronStyle(toggle)).toContain("rotate(180deg)");
    expect(queryByTestId("sidechat-panel")).toBeNull();
    // The shell is not mounted while closed (no empty hint, no composer).
    expect(queryByTestId("copilot-send-btn")).toBeNull();
  });

  it("closed shows a half-opacity capsule; open shows a line that the panel's hover grows into the capsule", async () => {
    const { getByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();

    const closed = getByTestId("sidechat-toggle");
    expect(closed.classList.contains("opacity-50")).toBe(true);
    expect(closed.classList.contains("hover:opacity-100")).toBe(true);
    expect(closed.classList.contains("focus-visible:opacity-100")).toBe(true);
    expect(closed.querySelector(".rounded-full.w-3\\.5.h-12")).not.toBeNull();

    fireEvent.click(closed);
    await flushSessionLoad();
    const panel = getByTestId("sidechat-panel");
    expect(panel.classList.contains("group/edge-pane")).toBe(true);
    const open = getByTestId("sidechat-toggle");
    expect(open.classList.contains("opacity-50")).toBe(false);
    const line = open.firstElementChild as HTMLElement;
    expect(line.classList.contains("w-1")).toBe(true);
    expect(line.classList.contains("group-hover/edge-pane:w-3.5")).toBe(true);
    expect(line.classList.contains("group-focus-visible/handle:w-3.5")).toBe(true);
    // The open-pane line stays inside the panel's clip frame.
    const anchor = open.closest(".absolute.left-0");
    expect(anchor).not.toBeNull();
    expect(panel.contains(anchor)).toBe(true);
  });

  it("clicking the handle opens the panel; the chevron flips to `>`; clicking closes", async () => {
    const { getByTestId, queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();

    fireEvent.click(getByTestId("sidechat-toggle"));
    await flushSessionLoad();
    const panel = getByTestId("sidechat-panel");
    expect(panel.style.width).toBe("400px");
    // The open chevron points right (no caret rotation).
    expect(toggleChevronStyle(getByTestId("sidechat-toggle"))).not.toContain("rotate");
    // The panel content is the mini-app chat pane: the shell's composer mounts.
    await waitFor(() => expect(queryByTestId("copilot-send-btn")).toBeDefined());
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("true");

    fireEvent.click(getByTestId("sidechat-toggle"));
    // The close slide (SC-16e) keeps the pane mounted at full width while
    // the slider glides out — then it unmounts at the slider's own
    // transform transition end and the handle returns.
    const closing = getByTestId("sidechat-panel");
    expect(closing.style.width).toBe("400px");
    expect(getByTestId("sidechat-slide").style.transform).toBe("translateX(100%)");
    expect(queryByTestId("sidechat-closed")).toBeNull();
    endSlideTransition(getByTestId("sidechat-slide"));
    expect(queryByTestId("sidechat-panel")).toBeNull();
    expect(getByTestId("sidechat-closed")).toBeDefined();
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("false");
  });
});

// ── Per-chat open state ─────────────────────────────────────────────────────

describe("sidechat-panel — per-chat open state (SC-14)", () => {
  it("restores the stored open state for the active chat", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    const { getByTestId, queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();

    expect(getByTestId("sidechat-panel")).toBeDefined();
    await waitFor(() => expect(queryByTestId("copilot-send-btn")).toBeDefined());
  });

  it("an outside store write opens the closed panel (SC-18a)", async () => {
    const { getByTestId, queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    expect(queryByTestId("sidechat-panel")).toBeNull();

    // SC-18's future entry opens through the store, not through the panel.
    act(() => {
      useSidechatOpenStore.getState().setOpen("chat-a", true);
    });
    await flushSessionLoad();
    expect(getByTestId("sidechat-panel")).toBeDefined();
    await waitFor(() => expect(queryByTestId("copilot-send-btn")).toBeDefined());
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("true");
  });

  it("switching chat A (open) → chat B (stored closed) shows B closed and leaves B's stored value untouched", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    localStorage.setItem("vt.sidechat.open.chat-b", "false");
    const { getByTestId, queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    expect(getByTestId("sidechat-panel")).toBeDefined();

    // Chat switch WITHOUT a remount (the panel stays mounted — the hook's
    // key-change path is what must re-read instead of cross-writing).
    act(() => {
      seedChat(CHAT_B, BRANCH_B);
    });

    // B starts its close slide immediately (full width held, still mounted),
    // and B's stored value is untouched — the pane unmounts at the slider's
    // transform transition end.
    expect(getByTestId("sidechat-panel").style.width).toBe("400px");
    endSlideTransition(getByTestId("sidechat-slide"));
    expect(getByTestId("sidechat-closed")).toBeDefined();
    expect(queryByTestId("sidechat-panel")).toBeNull();
    expect(localStorage.getItem("vt.sidechat.open.chat-b")).toBe("false");
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("true");
  });
});

// ── Width: restore + clamp ──────────────────────────────────────────────────

describe("sidechat-panel — width restore + clamp (SC-14)", () => {
  it("restores the stored width (default 400 when absent)", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    localStorage.setItem(SIDECHAT_WIDTH_KEY, "450");
    const first = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    expect(first.getByTestId("sidechat-panel").style.width).toBe("450px");
    first.unmount();

    localStorage.removeItem(SIDECHAT_WIDTH_KEY);
    const second = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    expect(second.getByTestId("sidechat-panel").style.width).toBe("400px");
    second.unmount();
  });

  it("clamps a stored width below the 320 min", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    localStorage.setItem(SIDECHAT_WIDTH_KEY, "100");
    const { getByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    expect(getByTestId("sidechat-panel").style.width).toBe("320px");
  });

  it("clamps a stored width above 50% of the live viewport", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    localStorage.setItem(SIDECHAT_WIDTH_KEY, "5000");
    setViewportWidth(1024);
    const { getByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    // 50% of 1024 = 512 — the clamp source is the live window width.
    expect(getByTestId("sidechat-panel").style.width).toBe("512px");
  });

  it("a window resize re-clamps the rendered width without touching the stored intent", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    localStorage.setItem(SIDECHAT_WIDTH_KEY, "500");
    setViewportWidth(1200);
    const { getByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    expect(getByTestId("sidechat-panel").style.width).toBe("500px");

    setViewportWidth(800);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(getByTestId("sidechat-panel").style.width).toBe("400px");
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("500");
  });
});

// ── Drag ────────────────────────────────────────────────────────────────────

describe("sidechat-panel — left-border drag (SC-14)", () => {
  it("drags the width and persists it", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    const { getByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    const panel = getByTestId("sidechat-panel");
    expect(panel.style.width).toBe("400px");

    // Drag left: clientX 600 → 500 grows the panel by 100.
    fireEvent.mouseDown(getByTestId("sidechat-resize"), { button: 0, clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(panel.style.width).toBe("500px");
    fireEvent.mouseUp(window);
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("500");
  });

  it("the drag clamps at the live 50% max", async () => {
    localStorage.setItem("vt.sidechat.open.chat-a", "true");
    setViewportWidth(1024);
    const { getByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    await flushSessionLoad();
    const panel = getByTestId("sidechat-panel");

    fireEvent.mouseDown(getByTestId("sidechat-resize"), { button: 0, clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 0 });
    fireEvent.mouseUp(window);
    expect(panel.style.width).toBe("512px");
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("512");
  });
});

// ── Served-modes gate ───────────────────────────────────────────────────────

describe("sidechat-panel — served-modes gate (SC-14)", () => {
  it("renders nothing on a co-author chat (not served)", () => {
    seedChat(
      { id: "chat-co", mode: "coauthor" } as unknown as ActiveChat,
      { id: "branch-co", chatId: "chat-co", label: "main" } as unknown as ActiveBranch,
    );
    const { queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    expect(queryByTestId("sidechat-closed")).toBeNull();
    expect(queryByTestId("sidechat-panel")).toBeNull();
    expect(queryByTestId("sidechat-toggle")).toBeNull();
  });

  it("renders nothing before the bootstrap kind-settings map arrives", () => {
    seedStores({});
    const { queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    expect(queryByTestId("sidechat-closed")).toBeNull();
    expect(queryByTestId("sidechat-panel")).toBeNull();
  });

  it("renders nothing while no chat is active", () => {
    useSnapshotStore.setState({ activeChat: null, activeBranch: null });
    const { queryByTestId } = render(withIsolatedI18n(<SidechatPanel />));
    expect(queryByTestId("sidechat-closed")).toBeNull();
    expect(queryByTestId("sidechat-panel")).toBeNull();
  });
});

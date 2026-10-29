/**
 * AgentShell stream-flush render isolation (LAG-3, step 4 of
 * AGENT_SHELL_RENDER_LAG_REPORT).
 *
 * WHAT THIS PROVES
 *   While an agent-shell host streams a reply, ONE delta flush per frame
 *   re-renders ONLY the message list (and its scroll hook) — the host
 *   editor pane, the composer, and the chat header (the header, context
 *   meter and model pills ride the same pane render) do NOT re-render per
 *   flush. Before LAG-3 the live stream text lived in controller state at
 *   the AgentShell root, so every flush re-rendered the whole shell tree.
 *   `isSending` STAYS on the controller: it flips twice per turn, never
 *   per flush — its renders are asserted live before the measured phase.
 *
 * HOW IT PROVES IT
 *   The real shell is mounted — the real ExperienceCopilotShell (host kind
 *   "experience", a host WITH an editor pane) through the fetch-level
 *   router (same seam as ExperienceCopilotShell.test.tsx) — and a real
 *   send opens a held-open SSE stream. Text deltas are enqueued through
 *   the REAL transport + SSE parser, and the frame clock is pinned through
 *   the ONE rafScheduler seam (lib/streaming-reveal.ts) — the same
 *   RevealScheduler boundary LAG-2 made the default — so a flush happens
 *   only when the test ticks a frame. Renders are counted through
 *   counting stubs (R12: count the target's OWN renders): the composer
 *   wraps the REAL AgentInputArea (the send path stays live — typing and
 *   the send button run for real), the editor pane and the header render
 *   marker stubs (their content is not under test, only their render
 *   counts). The counters are reset AFTER the send's isSending flips and
 *   BEFORE the measured flushes, so only flush renders are counted.
 *
 * POSITIVE CONTROLS (not just negatives)
 *   Each measured flush's text must LAND — the turn store's feed holds the
 *   concatenated text and the message list renders it — so the 0s are the
 *   panes' isolation, never a dead counter or a flush that never ran. The
 *   send itself is asserted to have rendered the counted components before
 *   the reset (the counters are live).
 *
 *   A STATIC GUARD additionally pins the controller source: the live
 *   stream text/reasoning stay OUT of use-agent-controller.ts (no
 *   `pendingText`/`pendingReasoning` anywhere in it) — re-introducing
 *   controller-held streaming state re-renders the shell root per flush
 *   again (same discipline as LAG-1's AppShell static guard).
 *
 * Runner: bun:test with scoped happy-dom (useDomEnv).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import type { ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../../../stores/agent-review-store.js";
import { useAgentPendingReviewStore } from "../../../stores/agent-pending-review-store.js";
import { useAgentReviewOutcomeStore } from "../../../stores/agent-review-outcome-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";

useDomEnv();

// Radix Tooltip needs a global Provider the isolated render here doesn't mount.
// Load-time copy of the real namespace (R15) so the factory never re-imports
// the live, possibly rewritten module.
const realTooltip = { ...(await import("../Tooltip.js")) };
mock.module("../Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The shell reads `useIsMobile` (matchMedia). Pin the suite to desktop so
// the desktop composer arm (AgentInputArea) and the two-pane layout mount
// (same mutable-cell pattern as ExperienceCopilotShell.test.tsx).
let mobileOverride = false;
const realMobile = { ...(await import("../../../hooks/use-mobile.js")) };
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

// Markdown internals are pinned elsewhere; the isolation test only needs
// message text to reach the DOM (the ExperienceCopilotShell suite's stub).
const realMarkdown = { ...(await import("../../../lib/markdown.js")) };
mock.module("../../../lib/markdown.js", () => ({
  ...realMarkdown,
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

// LAG-2's RevealScheduler seam, pinned at the ONE rafScheduler export: a
// frame runs ONLY when the test ticks it, so exactly one flush per tick is
// deterministic under the runner (no rAF timing). The rest of the module
// (StreamingReveal and friends) stays real.
const rafFrames: Array<{ run: () => void; cancelled: boolean }> = [];
const realReveal = { ...(await import("../../../lib/streaming-reveal.js")) };
mock.module("../../../lib/streaming-reveal.js", () => ({
  ...realReveal,
  rafScheduler: (callback: () => void) => {
    const frame = { run: callback, cancelled: false };
    rafFrames.push(frame);
    return () => {
      frame.cancelled = true;
    };
  },
}));

// ── Render counters (R12 discipline: count the target's OWN renders) ─────────
// The composer wraps the REAL component (the send path must stay live); the
// editor pane and the header render marker stubs — only their render counts
// are under test here.
let composerRenders = 0;
let editorPaneRenders = 0;
let headerRenders = 0;

const realInputArea = { ...(await import("./AgentInputArea.js")) };
mock.module("./AgentInputArea.js", () => ({
  ...realInputArea,
  AgentInputArea: (props: Parameters<typeof realInputArea.AgentInputArea>[0]) => {
    composerRenders += 1;
    return realInputArea.AgentInputArea(props);
  },
}));

const realEditor = { ...(await import("./AgentBufferReviewEditor.js")) };
mock.module("./AgentBufferReviewEditor.js", () => ({
  ...realEditor,
  AgentBufferReviewEditor: () => {
    editorPaneRenders += 1;
    return <div data-testid="editor-pane-probe" />;
  },
}));

const realHeader = { ...(await import("./AgentChatHeader.js")) };
mock.module("./AgentChatHeader.js", () => ({
  ...realHeader,
  AgentChatHeader: () => {
    headerRenders += 1;
    return <div data-testid="chat-header-probe" />;
  },
}));

// House i18n pattern via the shared co-load seam: provider-less renders echo
// raw keys (identity spec) — the mount must succeed, the strings are not under test.
installI18nContextSeam();

// ── Fetch-level API router (same rationale as ExperienceCopilotShell.test.tsx:
// the transport seam is faked at the FETCH level so the REAL hono clients and
// the REAL SSE parser run against canned payloads). ──────────────────────────

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

const activeThread = chatThread("thread-1");

// The held-open stream's write handle: each call enqueues SSE events; the
// test releases the FINISH at the very end so the turn settles cleanly.
let enqueueStream: ((events: string) => void) | null = null;
let releaseStream: (() => void) | null = null;

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/active$/.test(path)) {
    return jsonResponse(activeThread);
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) {
    return jsonResponse([]);
  }
  if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/sessions$/.test(path)) {
    return jsonResponse([]);
  }
  if (method === "POST" && /\/api\/experience-copilot\/[^/]+\/stream$/.test(path)) {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          enqueueStream = (events) => controller.enqueue(encoder.encode(events));
          releaseStream = () => {
            enqueueStream = null;
            controller.enqueue(encoder.encode('event: finish\ndata: {"finishReason":"stop"}\n\n'));
            controller.close();
          };
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) {
    return jsonResponse({ metrics: null, autoCompact: true });
  }
  if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context-links$/.test(path)) {
    return jsonResponse([]);
  }
  if (method === "GET" && /\/api\/scripts\/[^/]+\/agent-plan$/.test(path)) {
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
  return {
    id,
    scriptId: "script-1",
    draftSessionId: null,
    title: "Copilot",
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    metrics: null,
    contextLinks: [],
    todo: [],
  } as unknown as ExperienceCopilotThreadWire;
}

// ── Store seeding (the ExperienceCopilotShell suite's shapes) ───────────────

// One profile with a tool-capable cached model so the real useProviderModels
// hook serves the model list from cache (no fetch) and the send guard passes
// (no saved binding → the first profile, p1/m1).
const PROFILES = [
  {
    id: "p1",
    name: "OpenAI Pro",
    cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }] },
  },
] as unknown as ProviderProfileRecord[];

function seedStores(): void {
  const current = useBootstrapStore.getState().data;
  const base = current ?? {
    initialChatId: null,
    snapshot: null,
    isFirstRun: false,
    allCharacters: [],
    promptPresets: [],
    uiSettings: { ...wireUiSettings(), id: "default" },
    agentKindSettings: {},
    isArmServer: false,
  };
  useBootstrapStore.setState({
    data: {
      ...base,
      agentKindSettings: {
        ...base.agentKindSettings,
        experience: {
          agentKind: "experience",
          providerProfileId: null,
          modelName: null,
          defaultProfileId: null,
          updatedAt: "",
          servesChatModes: [],
          autoCompactDefault: true,
        },
      },
    },
  });
  useProviderDataStore.setState({ profiles: PROFILES });
  useSnapshotStore.setState({ allCharacters: [] });
}

const realFetch = globalThis.fetch;

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;
let ExperienceCopilotShell: typeof import("../../build/editors/copilot/ExperienceCopilotShell.js").ExperienceCopilotShell;

beforeAll(async () => {
  ({ render, fireEvent, waitFor, act } = await import("@testing-library/react"));
  // The real experience host registers kind "experience" (module-load side
  // effect, same as the shell suite) — the shell reads its descriptor for
  // transport, editor pane and i18n keys.
  await import("../../build/editors/copilot/experience-agent-host.js");
  ({ ExperienceCopilotShell } = await import("../../build/editors/copilot/ExperienceCopilotShell.js"));
});

beforeEach(() => {
  mobileOverride = false;
  globalThis.fetch = fetchRouter as unknown as typeof fetch;
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
  useAgentReviewRoundStore.setState({ roundsByThread: {} });
  useAgentPendingReviewStore.setState({ summariesByThread: {} });
  useAgentReviewOutcomeStore.setState({ outcomesByThread: {}, supersededByThread: {} });
  localStorage.clear();
  enqueueStream = null;
  releaseStream = null;
  rafFrames.length = 0;
  composerRenders = 0;
  editorPaneRenders = 0;
  headerRenders = 0;
  seedStores();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Drain the shell's chained async microtasks + React's scheduler macrotasks. */
async function flushSessionLoad() {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** Run the OLDEST scheduled frame (one flush per tick — LAG-2's cadence). */
function tickNextFrame(): void {
  const frame = rafFrames.shift();
  if (frame !== undefined && !frame.cancelled) frame.run();
}

/** The thread's concatenated live feed text ("" when none) — a flush witness. */
function feedTextOf(threadId: string): string {
  const feed = useAgentTurnStore.getState().feedByThread[threadId] ?? [];
  return feed
    .filter((entry) => entry.kind === "text")
    .map((entry) => (entry.kind === "text" ? entry.text : ""))
    .join("");
}

function sseTextDelta(delta: string): string {
  return `event: text-delta\ndata: ${JSON.stringify({ delta })}\n\n`;
}

describe("LAG-3 step 4 — a stream flush re-renders only the message list", () => {
  it("per-flush deltas re-render neither the host editor pane, the composer, nor the header", async () => {
    const { container, getByText, unmount } = render(
      <ExperienceCopilotShell
        scriptId="script-1"
        rulesCode="// rules buffer"
        visualSource=""
        onRulesChange={mock()}
        onVisualChange={mock()}
      />,
    );
    await flushSessionLoad();
    // The shell mounted: the editor pane probe (the host's editor pane) and
    // the composer are in the DOM — the counted subjects are alive.
    await waitFor(() => expect(container.querySelector('[data-testid="editor-pane-probe"]')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('[data-testid="copilot-send-btn"]')).not.toBeNull());

    // A real send through the real composer opens the held-open stream.
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "stream me" } });
    fireEvent.click(container.querySelector('[data-testid="copilot-send-btn"]') as HTMLElement);
    await waitFor(() => expect(enqueueStream).not.toBeNull());
    await flushSessionLoad();

    // POSITIVE CONTROL (counters are live): the send's isSending flip (the
    // twice-per-turn renders that STAY on the controller) rendered the
    // counted components before the measured phase.
    expect(composerRenders).toBeGreaterThan(0);
    expect(editorPaneRenders).toBeGreaterThan(0);
    expect(headerRenders).toBeGreaterThan(0);

    // ── Measured phase: only flush renders from here ──────────────────────
    composerRenders = 0;
    editorPaneRenders = 0;
    headerRenders = 0;

    // Three deltas in one frame → ONE flush (LAG-2's cadence).
    await act(async () => {
      enqueueStream?.(sseTextDelta("Hel") + sseTextDelta("lo") + sseTextDelta(" world"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      tickNextFrame();
    });

    // POSITIVE CONTROL (the flush landed): the feed holds the concatenated
    // text and the message list renders it — the 0s below are isolation,
    // never a flush that never ran.
    await waitFor(() => expect(feedTextOf("thread-1")).toBe("Hello world"));
    expect(getByText("Hello world")).toBeDefined();

    // The isolation pins: the flush re-rendered ONLY the message list.
    expect(composerRenders).toBe(0);
    expect(editorPaneRenders).toBe(0);
    expect(headerRenders).toBe(0);

    // A SECOND flush stays isolated too (repeated, not a one-off).
    composerRenders = 0;
    editorPaneRenders = 0;
    headerRenders = 0;
    await act(async () => {
      enqueueStream?.(sseTextDelta(" — and more"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      tickNextFrame();
    });
    await waitFor(() => expect(feedTextOf("thread-1")).toBe("Hello world — and more"));
    expect(composerRenders).toBe(0);
    expect(editorPaneRenders).toBe(0);
    expect(headerRenders).toBe(0);

    // Settle cleanly (the finish event closes the stream) before unmount.
    await act(async () => {
      releaseStream?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushSessionLoad();
    unmount();
  });

  it("STATIC GUARD: the controller holds no per-flush streaming state", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(import.meta.dirname, "use-agent-controller.ts");
    const src = await fs.readFile(file, "utf8");

    // LAG-3: the live stream text/reasoning live in the live-stream store,
    // NOT in controller state — controller-held streaming state re-renders
    // the AgentShell root per flush (the defect this unit removed).
    expect(src).not.toContain("pendingText");
    expect(src).not.toContain("pendingReasoning");
  });
});

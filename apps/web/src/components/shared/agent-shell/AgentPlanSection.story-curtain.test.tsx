/**
 * AgentPlanSection — the story curtain's tab row + bodies (DK-6, mockup
 * §1/§7). Integration over the REAL section: the DR-9 header row stays, and
 * under it the DK-6 tab strip with the per-tab bodies:
 *
 *  - the curtain opens onto the EVENTS tab — the default body (the premise
 *    line + the task list, today's curtain) with the tab row above it;
 *  - «Колода» swaps the body: the premise/tasks are gone, the deck body
 *    shows (the grid, or the empty state when the branch deck is empty);
 *  - «События» swaps back — the default body, byte-identical content;
 *  - the calendar body (DK-9): the segment is enabled and the body is the
 *    `StoryCalendarView` mount — here the §8 off state (the test's snapshot
 *    seed carries no tracker config, so the clock is unmarked);
 *  - the choice is remembered per chat: the same chat remounts onto
 *    «Колода», a different chat onto «События»;
 *  - the deck's «Пополнить у режиссёра» runs the director call with the
 *    deck's exact message key, disabled while the section is locked;
 *  - phone (§7, matchMedia stub): the same pieces render.
 *
 * Runner: bun:test + happy-dom; fetch-level routing (the real useAgentPlan
 * and useStoryDeck seams against canned payloads — no module-registry
 * touching except the director-call store, the strip-test pattern); the
 * i18n seam's identity `t`. Each test uses its OWN chat/branch (both plan
 * and deck caches are module-global).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");

installI18nContextSeam();

const mocks = { callDirector: mock() };
const realCallDirectorStore = { ...(await import("../../../stores/sidechat-call-director-store.js")) };
mock.module("../../../stores/sidechat-call-director-store.js", () => ({
  ...realCallDirectorStore,
  callDirector: mocks.callDirector,
}));

const { useStoryCurtainTabStore } = await import("../../../stores/story-curtain-tab-store.js");

let AgentPlanSection: typeof import("./AgentPlanSection.js").AgentPlanSection;
beforeAll(async () => {
  ({ AgentPlanSection } = await import("./AgentPlanSection.js"));
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const PLAN: AgentPlan = {
  goal: "A stray cat became a young man overnight",
  constraints: [],
  tasks: [
    { id: "done", title: "The morning after", body: "", status: "completed" },
    { id: "live", title: "The fridge raid", body: "Archie opens the fridge himself.", status: "active" },
    { id: "next", title: "House rules", body: "", status: "pending" },
  ],
};
const DECK = {
  cards: [
    { id: "k1", suit: "threat", title: "Vet visit", body: "The neighbor already rings the doorbell." },
    { id: "k2", suit: "discovery", title: "A collar with an address", body: "Engraved with another city." },
  ],
};

const plansByBranch = new Map<string, AgentPlan>();
const decksByBranch = new Map<string, { cards: Array<{ id: string; suit: string; title: string; body: string }> }>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  plansByBranch.clear();
  decksByBranch.clear();
  useStoryCurtainTabStore.setState({ tabsByChat: {} });
  globalThis.fetch = testFetch(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), "http://gateway.test").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (/\/deck$/.test(path)) {
      const branchId = path.split("/branches/")[1]?.split("/")[0] ?? "";
      return new Response(JSON.stringify({ deck: decksByBranch.get(branchId) ?? { cards: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/plan$/.test(path)) {
      const branchId = path.split("/branches/")[1]?.split("/")[0] ?? "";
      return new Response(JSON.stringify({ plan: plansByBranch.get(branchId) ?? { goal: "", constraints: [], tasks: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { message: `unrouted ${method} ${path}` } }), { status: 404 });
  });
  mocks.callDirector.mockReset();
  mocks.callDirector.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useStoryCurtainTabStore.setState({ tabsByChat: {} });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Mount the section for a seeded chat+branch and open the curtain. */
async function mountOpen(chatId: string, branchId: string, over: { locked?: boolean; deck?: typeof DECK | { cards: [] } } = {}) {
  plansByBranch.set(branchId, PLAN);
  decksByBranch.set(branchId, over.deck ?? { cards: [] });
  const view = render(
    <AgentPlanSection owner={{ kind: "chatBranch", chatId, branchId }} locked={over.locked ?? false} />,
  );
  await waitFor(() => expect(view.getByTestId("agent-plan-panel").textContent).toContain("The fridge raid"));
  fireEvent.click(view.getByTestId("agent-plan-toggle"));
  await waitFor(() => expect(view.getByTestId("story-curtain-tabs")).toBeDefined());
  return view;
}

function radioButtons(view: ReturnType<typeof render>): HTMLButtonElement[] {
  return [...view.container.querySelectorAll<HTMLButtonElement>("button[role='radio']")];
}

// ── The tab row + the per-tab bodies ─────────────────────────────────────────

describe("AgentPlanSection — the story curtain's tabs (DK-6)", () => {
  it("opens onto «События»: the tab row under the intact header, the default body (premise + tasks) byte-identical", async () => {
    const view = await mountOpen("scu-chat-1", "scu-b1");
    // The DR-9 header row is intact: the story title + the editor button
    // (the action order with the strip's check-now/call buttons is pinned by
    // the strip suite; a bare section carries the editor button).
    expect(view.getByTestId("agent-plan-curtain").textContent).toContain("agent_plan_story_title");
    // The editor button rides the collapsed row AND the curtain header
    // (a bare section defaults showEditorInCollapsedRow to true).
    expect(view.getByTestId("agent-plan-curtain").querySelector('[data-testid="agent-plan-open-editor"]')).not.toBeNull();
    // The default events body: the premise + the task list.
    expect(view.getByTestId("agent-plan-premise")).toBeDefined();
    expect(view.getByTestId("agent-plan-task-active")).toBeDefined();
    // The tab row: three segments; the deck count from the served empty deck.
    const segments = radioButtons(view);
    expect(segments.length).toBe(3);
    const deckSegment = segments.find((s) => s.textContent?.includes("story_deck_tab_deck"))!;
    expect(deckSegment.textContent).toContain("0");
    // The calendar segment is enabled (the DK-6 disabled placeholder is
    // gone since DK-9).
    const calendarSegment = segments.find((s) => s.textContent?.includes("story_deck_tab_calendar"))!;
    expect(calendarSegment.getAttribute("disabled")).toBeNull();
    // No deck body while the events tab is active.
    expect(view.queryByTestId("story-deck-empty")).toBeNull();
    expect(view.queryByTestId("story-deck-grid")).toBeNull();
  });

  it("«Колода» swaps the body (empty deck → the §7 empty state); «События» swaps back to the default body", async () => {
    const view = await mountOpen("scu-chat-2", "scu-b2", { deck: { cards: [] } });
    const deckSegment = radioButtons(view).find((s) => s.textContent?.includes("story_deck_tab_deck"))!;
    fireEvent.click(deckSegment);
    const empty = await waitFor(() => view.getByTestId("story-deck-empty"));
    expect(empty.textContent).toContain("story_deck_empty_title");
    // The default body is GONE on the deck tab.
    expect(view.queryByTestId("agent-plan-premise")).toBeNull();
    expect(view.queryByTestId("agent-plan-task-active")).toBeNull();

    // Back to «События»: the premise + the task list return.
    const eventsSegment = radioButtons(view).find((s) => s.textContent?.includes("story_deck_tab_events"))!;
    fireEvent.click(eventsSegment);
    await waitFor(() => expect(view.getByTestId("agent-plan-premise")).toBeDefined());
    expect(view.getByTestId("agent-plan-task-active")).toBeDefined();
    expect(view.queryByTestId("story-deck-empty")).toBeNull();
  });

  it("the deck tab with cards renders the grid; «Пополнить у режиссёра» carries the deck's exact message key; locked disables it", async () => {
    const view = await mountOpen("scu-chat-3", "scu-b3", { deck: DECK });
    const deckSegment = radioButtons(view).find((s) => s.textContent?.includes("story_deck_tab_deck"))!;
    fireEvent.click(deckSegment);
    await waitFor(() => expect(view.getAllByTestId("story-card")).toHaveLength(2));
    expect(view.queryByTestId("story-deck-empty")).toBeNull();

    const call = view.getByTestId("story-deck-call-director");
    expect(call.getAttribute("disabled")).toBeNull();
    fireEvent.click(call);
    expect(mocks.callDirector).toHaveBeenCalledTimes(1);
    expect(mocks.callDirector.mock.calls[0]).toEqual([
      "scu-chat-3",
      "scu-b3",
      "story_deck_call_director_message",
    ]);
    view.unmount();

    // The locked section: the deck body renders, the call is disabled.
    const locked = await mountOpen("scu-chat-4", "scu-b4", { locked: true, deck: DECK });
    const deckSegmentLocked = radioButtons(locked).find((s) => s.textContent?.includes("story_deck_tab_deck"))!;
    fireEvent.click(deckSegmentLocked);
    await waitFor(() => expect(locked.getAllByTestId("story-card")).toHaveLength(2));
    expect(locked.getByTestId("story-deck-call-director").getAttribute("disabled")).toBe("");
    fireEvent.click(locked.getByTestId("story-deck-call-director"));
    expect(mocks.callDirector).toHaveBeenCalledTimes(1);
    locked.unmount();
  });

  it("the calendar body renders the DK-9 calendar (with no tracker config in the snapshot: the §8 off state); the segment itself is enabled and drives the body", async () => {
    const view = await mountOpen("scu-chat-5", "scu-b5");
    // The segment is enabled (the DK-6 placeholder is gone).
    const calendarSegment = radioButtons(view).find((s) => s.textContent?.includes("story_deck_tab_calendar"))!;
    expect(calendarSegment.getAttribute("disabled")).toBeNull();
    fireEvent.click(calendarSegment);
    // The body is the calendar view — the §8 off state (the section test's
    // snapshot seed carries no insightsConfig, so the clock is unmarked).
    const off = await waitFor(() => view.getByTestId("story-cal-off"));
    expect(off.textContent).toContain("story_cal_off_title");
    expect(view.queryByTestId("agent-plan-premise")).toBeNull();
    view.unmount();
  });

  it("the choice is remembered per chat: the same chat remounts onto «Колода», another chat onto «События»", async () => {
    const view = await mountOpen("scu-chat-6", "scu-b6");
    fireEvent.click(radioButtons(view).find((s) => s.textContent?.includes("story_deck_tab_deck"))!);
    await waitFor(() => expect(view.getByTestId("story-deck-empty")).toBeDefined());
    view.unmount();

    // The SAME chat remounts onto «Колода» (the body follows the store).
    const remounted = await mountOpen("scu-chat-6", "scu-b6");
    await waitFor(() => expect(remounted.getByTestId("story-deck-empty")).toBeDefined());
    remounted.unmount();

    // A different chat opens onto the default «События».
    const other = await mountOpen("scu-chat-7", "scu-b7");
    expect(other.getByTestId("agent-plan-premise")).toBeDefined();
    expect(other.queryByTestId("story-deck-empty")).toBeNull();
    other.unmount();
  });

  it("phone (§7, matchMedia stub): the same pieces render — tabs, header actions, deck body", async () => {
    const realMatchMedia = window.matchMedia;
    // Member-for-member MediaQueryList literal (the 7a annotation shape) —
    // the literal satisfies the interface; no erasure.
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: query === "(max-width: 768px)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
    try {
      const view = await mountOpen("scu-chat-8", "scu-b8", { deck: DECK });
      expect(view.getByTestId("story-curtain-tabs")).toBeDefined();
      expect(view.getByTestId("agent-plan-curtain").querySelector('[data-testid="agent-plan-open-editor"]')).not.toBeNull();
      fireEvent.click(radioButtons(view).find((s) => s.textContent?.includes("story_deck_tab_deck"))!);
      await waitFor(() => expect(view.getAllByTestId("story-card")).toHaveLength(2));
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});

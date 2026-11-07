/**
 * StoryCurtainTabs (DIRECTOR_DECK_CALENDAR_PLAN DK-6) — the curtain's
 * second header row:
 *
 *  - the SegmentedControl carries the three tabs with muted counts
 *    («События <remaining> · Колода <cards> · Календарь» — calendar none);
 *  - the calendar segment is the DISABLED muted placeholder (DK-9 owns the
 *    body) — it cannot be clicked;
 *  - clicking «Колода» switches the choice (the body swap is the section's,
 *    pinned in AgentPlanSection.story-curtain.test.tsx);
 *  - the choice is remembered PER CHAT (the plain tab store): another chat
 *    reads the default «События», the first chat keeps «Колода» on remount.
 *
 * Runner: bun:test + happy-dom; the i18n seam's identity `t` (label echoes);
 * `globalThis.fetch` answers the deck GET with per-branch fixtures (the
 * deck cache is module-global — per-test branch ids keep entries disjoint);
 * the tab store resets between tests.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { StoryDeck } from "@vibe-tavern/api-contracts";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");

installI18nContextSeam();

const { useStoryCurtainTabStore, DEFAULT_STORY_CURTAIN_TAB } = await import(
  "../../../stores/story-curtain-tab-store.js"
);

let StoryCurtainTabs: typeof import("./StoryCurtainTabs.js").StoryCurtainTabs;
beforeAll(async () => {
  StoryCurtainTabs = (await import("./StoryCurtainTabs.js")).StoryCurtainTabs;
});

const DECK: StoryDeck = {
  cards: [
    { id: "c1", suit: "threat", title: "Vet visit", body: "The neighbor already rings the doorbell." },
    { id: "c2", suit: "change", title: "Storm and darkness", body: "The power dies." },
  ],
};
const EMPTY_DECK: StoryDeck = { cards: [] };

const decksByBranch = new Map<string, StoryDeck>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  decksByBranch.clear();
  useStoryCurtainTabStore.setState({ tabsByChat: {} });
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/deck")) {
      const branchId = url.split("/branches/")[1]?.split("/")[0] ?? "";
      return new Response(JSON.stringify({ deck: decksByBranch.get(branchId) ?? EMPTY_DECK }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useStoryCurtainTabStore.setState({ tabsByChat: {} });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** The active segment's label text (the identity `t` echoes the keys). */
function activeLabel(view: ReturnType<typeof render>): string {
  const checked = view.container.querySelector('[data-state="checked"]');
  return checked?.textContent ?? "";
}

describe("StoryCurtainTabs (DK-6)", () => {
  it("renders the three tabs with muted counts; the events count rides the header's remaining, the deck count the cards; the calendar segment is disabled", async () => {
    decksByBranch.set("sct-b1", DECK);
    const view = render(<StoryCurtainTabs chatId="sct-chat-1" branchId="sct-b1" eventsCount={3} />);
    const row = await waitFor(() => view.getByTestId("story-curtain-tabs"));
    // The three segments in order; the counts inline (identity echo + numerals).
    expect(row.textContent).toContain("story_deck_tab_events");
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("story_deck_tab_deck");
    await waitFor(() => expect(row.textContent).toContain("2"));
    expect(row.textContent).toContain("story_deck_tab_calendar");
    // The default tab is «События» (§1).
    expect(activeLabel(view)).toContain("story_deck_tab_events");
    // The calendar segment is disabled (the muted placeholder — DK-9 owns it).
    const segments = [...row.querySelectorAll<HTMLButtonElement>("button[role='radio']")];
    expect(segments.length).toBe(3);
    const calendar = segments.find((segment) => segment.textContent?.includes("story_deck_tab_calendar"));
    expect(calendar?.getAttribute("disabled")).toBe("");
  });

  it("clicking «Колода» switches the choice; remembered per chat — another chat reads the default, the first keeps its tab", async () => {
    decksByBranch.set("sct-b2", EMPTY_DECK);
    const view = render(<StoryCurtainTabs chatId="sct-chat-2" branchId="sct-b2" eventsCount={1} />);
    await waitFor(() => expect(view.getByTestId("story-curtain-tabs").textContent).toContain("story_deck_tab_deck"));
    const segments = [...view.getByTestId("story-curtain-tabs").querySelectorAll<HTMLButtonElement>("button[role='radio']")];
    const deckSegment = segments.find((segment) => segment.textContent?.includes("story_deck_tab_deck"))!;
    fireEvent.click(deckSegment);
    expect(activeLabel(view)).toContain("story_deck_tab_deck");
    expect(useStoryCurtainTabStore.getState().tabsByChat["sct-chat-2"]).toBe("deck");

    // A different chat still reads the default «События» (the first view
    // unmounts first — RTL queries span document.body).
    view.unmount();
    const other = render(<StoryCurtainTabs chatId="sct-chat-3" branchId="sct-b3" eventsCount={0} />);
    await waitFor(() => expect(other.getByTestId("story-curtain-tabs").textContent).toContain("story_deck_tab_deck"));
    expect(activeLabel(other)).toContain("story_deck_tab_events");
    other.unmount();

    // The first chat's choice survives an unmount/remount (remembered).
    view.unmount();
    const remounted = render(<StoryCurtainTabs chatId="sct-chat-2" branchId="sct-b2" eventsCount={1} />);
    await waitFor(() => expect(remounted.getByTestId("story-curtain-tabs").textContent).toContain("story_deck_tab_deck"));
    expect(activeLabel(remounted)).toContain("story_deck_tab_deck");
    remounted.unmount();
    expect(DEFAULT_STORY_CURTAIN_TAB).toBe("events");
  });
});

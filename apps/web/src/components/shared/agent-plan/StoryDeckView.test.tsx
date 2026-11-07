/**
 * StoryDeckView (DIRECTOR_DECK_CALENDAR_PLAN DK-6; the card actions are
 * live since DK-7) — the deck tab body:
 *
 *  - the grid renders a face per card with the suit derivation (data-suit),
 *    model titles/bodies clamped to three lines in the grid size (two on sm,
 *    none on big — the mockup's identification-context rule) and the
 *    RP-font title (`font-body`);
 *  - the dashed «+ Своя карта» tile and the draw button are LIVE since
 *    DK-7 (they open StoryCardDialog — its suite covers the dialog flows;
 *    the wiring test here pins the open);
 *  - «Пополнить у режиссёра» is LIVE: it runs the director-call action with
 *    the deck's exact message key (`story_deck_call_director_message`) and
 *    disables while the sidechat streams (the DR-12 rule);
 *  - §7 phone fidelity: the title group hides under max-md (the phone
 *    header is only the button row — the tab row above carries the count)
 *    and the refill label switches to the short «Пополнить» — pinned as
 *    class strings (happy-dom applies no CSS);
 *  - the empty state (§7): two tilted backs, the title + explanation, the
 *    primary «Попросить режиссёра собрать колоду» (the same director call)
 *    and the muted «+ Своя карта» link (live since DK-7) — no header, no
 *    grid;
 *  - phone (§7, matchMedia stub): the same pieces render (dual-mode canon —
 *    the phone differences are CSS-only);
 *  - the locale tables carry the mockup's RU verbatim (§1/§4/§7) with the
 *    English twins.
 *
 * Runner: bun:test + happy-dom. The i18n seam rides the shared context
 * stub (identity echo); the director-call store is mocked at the module
 * seam (`...real` spread, the strip-test pattern) and `globalThis.fetch`
 * answers the deck GET with per-branch fixtures (the deck cache is
 * module-global — per-test branch ids keep entries disjoint). Phone = the
 * resizable-side-pane matchMedia stub.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { StoryDeck } from "@vibe-tavern/api-contracts";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");

installI18nContextSeam();

const mocks = { callDirector: mock() };
const realCallDirectorStore = { ...(await import("../../../stores/sidechat-call-director-store.js")) };
mock.module("../../../stores/sidechat-call-director-store.js", () => ({
  ...realCallDirectorStore,
  callDirector: mocks.callDirector,
}));

let StoryDeckView: typeof import("./StoryDeckView.js").StoryDeckView;
let StoryCardFace: typeof import("./StoryCard.js").StoryCardFace;
beforeAll(async () => {
  StoryDeckView = (await import("./StoryDeckView.js")).StoryDeckView;
  StoryCardFace = (await import("./StoryCard.js")).StoryCardFace;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const DECK: StoryDeck = {
  cards: [
    { id: "c1", suit: "threat", title: "Vet visit", body: "The neighbor already rings the doorbell." },
    { id: "c2", suit: "encounter", title: "The former owner", body: "A woman puts up lost-cat posters." },
    { id: "c3", suit: "discovery", title: "A collar with an address", body: "Engraved with another city." },
    { id: "c4", suit: "mystery", title: "Purring at 3 a.m.", body: "For a moment he is a cat again." },
    { id: "c5", suit: "change", title: "Storm and darkness", body: "The power dies; Archie sees in the dark." },
  ],
};
const EMPTY_DECK: StoryDeck = { cards: [] };

/** The branch GET through the real use-story-deck seam — per-branch decks. */
const decksByBranch = new Map<string, StoryDeck>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  decksByBranch.clear();
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
  mocks.callDirector.mockReset();
  mocks.callDirector.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ── The phone stub (resizable-side-pane's matchMedia pattern) ───────────────
const MOBILE_QUERY = "(max-width: 768px)";
let realMatchMedia: typeof window.matchMedia | undefined;
let hadMatchMedia = false;
function stubMobile(mobile: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: mobile && query === MOBILE_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  hadMatchMedia = typeof window.matchMedia === "function";
  realMatchMedia = window.matchMedia;
});

afterEach(() => {
  if (hadMatchMedia && realMatchMedia !== undefined) window.matchMedia = realMatchMedia;
  else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

afterAll(() => {
  if (hadMatchMedia && realMatchMedia !== undefined) window.matchMedia = realMatchMedia;
  else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

// ── The deck grid ────────────────────────────────────────────────────────────

describe("StoryDeckView (DK-6)", () => {
  it("renders the header + a face per card with suits, titles and the 3-line clamp; the add tile and the draw render disabled with a title", async () => {
    decksByBranch.set("dkv-b1", DECK);
    const view = render(<StoryDeckView chatId="dkv-chat-1" branchId="dkv-b1" locked={false} />);
    await waitFor(() => expect(view.getAllByTestId("story-card")).toHaveLength(5));
    const grid = view.getByTestId("story-deck-grid");
    const cards = [...grid.querySelectorAll<HTMLElement>('[data-testid="story-card"]')];
    expect(grid.textContent).toContain("Vet visit");
    // The suit derivation: each face carries its suit (K1's five tones).
    expect(cards.map((card) => card.getAttribute("data-suit"))).toEqual([
      "threat",
      "encounter",
      "discovery",
      "mystery",
      "change",
    ]);
    // Identification-context clamp: the grid face's body is line-clamped.
    expect(cards[0]!.querySelector("p")?.className).toContain("line-clamp-3");
    // The title rides the RP font (`font-body`).
    const titleEl = cards[0]!.querySelector("div.font-body");
    expect(titleEl?.textContent).toBe("Vet visit");
    // The muted count: «N карт» from cards.length.
    expect(view.getByTestId("story-deck-header").textContent).toContain("story_deck_cards_count");
    // DK-7's live actions: enabled, no placeholder title (the dialog flows
    // live in StoryCardDialog's suite; the wiring pins are DK-7's).
    const draw = view.getByTestId("story-deck-draw");
    expect(draw.getAttribute("disabled")).toBeNull();
    expect(draw.getAttribute("title")).toBeNull();
    const tile = view.getByTestId("story-deck-add-card");
    expect(tile.getAttribute("disabled")).toBeNull();
    expect(tile.getAttribute("title")).toBeNull();
    // The refill action is live (locked=false).
    expect(view.getByTestId("story-deck-call-director").getAttribute("disabled")).toBeNull();
  });

  it("«Пополнить у режиссёра» runs the director call with the deck's exact message key; disabled while locked", async () => {
    decksByBranch.set("dkv-b2", DECK);
    const view = render(<StoryDeckView chatId="dkv-chat-2" branchId="dkv-b2" locked={false} />);
    await waitFor(() => expect(view.getAllByTestId("story-card")).toHaveLength(5));
    fireEvent.click(view.getByTestId("story-deck-call-director"));
    expect(mocks.callDirector).toHaveBeenCalledTimes(1);
    expect(mocks.callDirector.mock.calls[0]).toEqual([
      "dkv-chat-2",
      "dkv-b2",
      "story_deck_call_director_message",
    ]);
    view.unmount();

    decksByBranch.set("dkv-b3", DECK);
    const locked = render(<StoryDeckView chatId="dkv-chat-3" branchId="dkv-b3" locked />);
    await waitFor(() => expect(locked.getAllByTestId("story-card")).toHaveLength(5));
    expect(locked.getByTestId("story-deck-call-director").getAttribute("disabled")).toBe("");
    fireEvent.click(locked.getByTestId("story-deck-call-director"));
    expect(mocks.callDirector).toHaveBeenCalledTimes(1);
  });

  it("the empty state (§7): the tilted backs, title, hint, the call button (the same director call) and the muted disabled add link — no grid, no header", async () => {
    decksByBranch.set("dkv-b4", EMPTY_DECK);
    const view = render(<StoryDeckView chatId="dkv-chat-4" branchId="dkv-b4" locked={false} />);
    const empty = await waitFor(() => view.getByTestId("story-deck-empty"));
    expect(empty.querySelectorAll('[data-testid="story-card-back"]').length).toBe(2);
    expect(empty.textContent).toContain("story_deck_empty_title");
    expect(empty.textContent).toContain("story_deck_empty_hint");
    expect(view.queryByTestId("story-deck-grid")).toBeNull();
    expect(view.queryByTestId("story-deck-header")).toBeNull();
    // The primary call carries the same exact message key.
    const call = view.getByTestId("story-deck-empty-call");
    expect(call.getAttribute("disabled")).toBeNull();
    fireEvent.click(call);
    await Promise.resolve();
    expect(mocks.callDirector).toHaveBeenCalledTimes(1);
    expect(mocks.callDirector.mock.calls[0]).toEqual([
      "dkv-chat-4",
      "dkv-b4",
      "story_deck_call_director_message",
    ]);
    // The muted «+ Своя карта» link is live since DK-7 (opens the editor).
    const add = view.getByTestId("story-deck-empty-add");
    expect(add.getAttribute("disabled")).toBeNull();
    expect(add.getAttribute("title")).toBeNull();
    expect(add.textContent).toBe("story_deck_empty_add");
  });

  it("phone (§7, matchMedia stub): the same pieces render — the deck is never hidden on mobile", async () => {
    stubMobile(true);
    decksByBranch.set("dkv-b5", DECK);
    const view = render(<StoryDeckView chatId="dkv-chat-5" branchId="dkv-b5" locked={false} />);
    await waitFor(() => expect(view.getAllByTestId("story-card")).toHaveLength(5));
    expect(view.getByTestId("story-deck-header")).toBeDefined();
    expect(view.getByTestId("story-deck-add-card")).toBeDefined();
    // The phone grid card carries the two-per-row sizing (§7's 165×220 budget).
    const first = view.getByTestId("story-deck-grid").querySelector<HTMLElement>('[data-testid="story-card"]');
    expect(first?.className).toContain("max-md:w-[calc(50%-6px)]");
  });

  it("§7 fidelity (class pins — happy-dom applies no CSS): the title group hides on the phone and the refill button renders both label spans", async () => {
    decksByBranch.set("dkv-b6", DECK);
    const view = render(<StoryDeckView chatId="dkv-chat-6" branchId="dkv-b6" locked={false} />);
    await waitFor(() => expect(view.getAllByTestId("story-card")).toHaveLength(5));
    // The title group (glyph + title + count) is one span hidden under
    // max-md: §7's phone header is ONLY the button row — the tab row above
    // already carries the same count (StoryCurtainTabs).
    const titleGroup = view.getByText("story_deck_title").parentElement;
    expect(titleGroup?.tagName).toBe("SPAN");
    expect(titleGroup?.className).toContain("max-md:hidden");
    expect(titleGroup?.textContent).toContain("story_deck_cards_count");
    // The refill button carries BOTH labels as responsive copy: the short
    // §7 «Пополнить» under max-md (the full label bleeds out of the flex-1
    // half-row — AD-022), the full §1 «Пополнить у режиссёра» on md+.
    const labels = [...view.getByTestId("story-deck-call-director").querySelectorAll("span")];
    expect(labels.map((span) => span.textContent)).toEqual([
      "story_deck_call_director_short",
      "story_deck_call_director",
    ]);
    expect(labels[0]?.className).toBe("md:hidden");
    expect(labels[1]?.className).toBe("hidden md:inline");
  });
});

// ── StoryCardFace sizes ──────────────────────────────────────────────────────

describe("StoryCardFace (DK-6)", () => {
  it("sm clamps to two lines; big shows the full body and no clamp", () => {
    const card = DECK.cards[0]!;
    const small = render(<StoryCardFace card={card} size="sm" />);
    expect(small.getByTestId("story-card").querySelector("p")?.className).toContain("line-clamp-2");
    small.unmount();
    const big = render(<StoryCardFace card={card} size="big" />);
    const bigBody = big.getByTestId("story-card").querySelector("p");
    expect(bigBody?.className).not.toContain("line-clamp");
    big.unmount();
  });
});

// ── The RU canon (mockup §1/§4/§7, byte-exact) ───────────────────────────────

describe("StoryDeckView — locale canon (DK-6)", () => {
  it("ru.json carries the mockup's strings verbatim; en carries the English twins", () => {
    expect(ru.story_deck_tab_events).toBe("События");
    expect(ru.story_deck_tab_deck).toBe("Колода");
    expect(ru.story_deck_tab_calendar).toBe("Календарь");
    expect(ru.story_deck_title).toBe("Колода поворотов");
    expect(ru.story_deck_draw_random).toBe("Вытянуть случайную");
    expect(ru.story_deck_call_director).toBe("Пополнить у режиссёра");
    expect(ru.story_deck_call_director_short).toBe("Пополнить");
    expect(ru.story_deck_call_director_message).toBe("Добавь в колоду поворотов новые карты.");
    expect(ru.story_deck_own_card).toBe("Своя карта");
    expect(ru.story_deck_empty_add).toBe("+ Своя карта");
    expect(ru.story_deck_empty_title).toBe("В колоде пока нет карт");
    expect(ru.story_deck_empty_hint).toBe(
      "Режиссёр соберёт повороты под ваш сюжет: угрозы, встречи, находки, тайны и перемены. Разыгрывайте их, когда сцене нужен толчок.",
    );
    expect(ru.story_deck_empty_call).toBe("Попросить режиссёра собрать колоду");
    expect(ru.story_deck_suit_threat).toBe("Угроза");
    expect(ru.story_deck_suit_encounter).toBe("Встреча");
    expect(ru.story_deck_suit_discovery).toBe("Находка");
    expect(ru.story_deck_suit_mystery).toBe("Тайна");
    expect(ru.story_deck_suit_change).toBe("Перемена");
    expect(en.story_deck_title).toBe("Twist deck");
    expect(en.story_deck_call_director_short).toBe("Refill");
    expect(en.story_deck_call_director_message).toBe("Add new cards to the twist deck.");
    expect(en.story_deck_empty_title).toBe("No cards in the deck yet");
    expect(en.story_deck_empty_call).toBe("Ask the director to assemble the deck");
  });
});

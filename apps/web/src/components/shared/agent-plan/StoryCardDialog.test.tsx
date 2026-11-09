/**
 * StoryCardDialog (DIRECTOR_DECK_CALENDAR_PLAN DK-7) — the twist card's
 * dialog: view / edit / new / remove / draw / play, in both shells:
 *
 *  - view (§2): the big face + the §2 footer (left «Убрать из колоды»
 *    destructive + «Изменить», right «Закрыть» + «Разыграть сейчас»
 *    primary); the footer wraps (§6's rule — pinned as class strings);
 *  - play success: the POST body is `{}` (a plain play), the curtain tab
 *    switches to events (the tab store), the dialog closes;
 *  - the typed 409 (story_deck_foreign_goals): the calm confirm shows the
 *    replace-goals copy, the retry carries `{ replaceForeignGoals: true }`,
 *    «Отмена» keeps the dialog open with the card;
 *  - edit (from «Изменить»): the suit SegmentedControl renders THE suit
 *    derivation's five options, the fields edit the draft, the live preview
 *    follows the draft, Save PUTs the deck and returns to view;
 *  - new (the tile's editor): Save disables while the title is empty; Save
 *    PUTs a fresh `card_`-uuid card and CLOSES (the new-card flow's end);
 *  - remove: the destructive confirm; confirm PUTs the deck without the
 *    card and closes, cancel keeps the dialog;
 *  - draw (§3): the dialog opens FACE-DOWN (the back, the flip shell's
 *    transition class pins), flips to the face (~450 ms — waited via
 *    waitFor), under prefers-reduced-motion the face is there at once;
 *    playing from the draw hits the drawn card's route;
 *  - phone (§7, matchMedia stub): the BottomSheet shell — the primary is
 *    full width, «Закрыть» is absent (the sheet itself dismisses), the
 *    editor stacks fields + preview + the flex-1 footer pair;
 *  - the deck-grid wiring (through StoryDeckView): a card face opens the
 *    dialog, the draw opens it face-down, the tile opens the editor;
 *  - the locale tables carry the mockup's RU verbatim (§2/§3/§7) with the
 *    English twins.
 *
 * Runner: bun:test + happy-dom. The i18n seam rides the shared context stub
 * (identity echo — assertions quote i18n KEYS, never RU strings). fetch is
 * routed at the network level with per-test branch ids (the deck cache is
 * module-global); the play route's typed 409 body replays the server's
 * DomainError shape. Phone/reduced-motion = the matchMedia stub answering
 * BOTH queries (useIsMobile's max-width + the flip's prefers-reduced-motion).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import { useState } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { StoryDeck } from "@vibe-tavern/api-contracts";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";
import { useStoryCurtainTabStore } from "../../../stores/story-curtain-tab-store.js";

useDomEnv();
const { fireEvent, render, waitFor, within } = await import("@testing-library/react");

installI18nContextSeam();

let StoryCardDialog: typeof import("./StoryCardDialog.js").StoryCardDialog;
let StoryDeckView: typeof import("./StoryDeckView.js").StoryDeckView;
beforeAll(async () => {
  StoryCardDialog = (await import("./StoryCardDialog.js")).StoryCardDialog;
  StoryDeckView = (await import("./StoryDeckView.js")).StoryDeckView;
});

type StoryCardDialogRequest = import("./StoryCardDialog.js").StoryCardDialogRequest;

/** The dialog with a LIVE close — onClose nulls the request (what
 *  StoryDeckView does), so close/close-after-play assertions exercise the
 *  real closing path, not a mock stub. */
function DialogHarness({ chatId, branchId, locked, request }: {
  chatId: string;
  branchId: string;
  locked: boolean;
  request: StoryCardDialogRequest;
}) {
  const [current, setCurrent] = useState<StoryCardDialogRequest | null>(request);
  return (
    <StoryCardDialog
      chatId={chatId}
      branchId={branchId}
      locked={locked}
      request={current}
      onClose={() => setCurrent(null)}
    />
  );
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const DECK: StoryDeck = {
  cards: [
    { id: "c1", suit: "threat", title: "Vet visit", body: "The neighbor already rings the doorbell." },
    { id: "c2", suit: "mystery", title: "Purring at 3 a.m.", body: "For a moment he is a cat again." },
    { id: "c3", suit: "change", title: "Storm and darkness", body: "The power dies." },
  ],
};
const EMPTY_DECK: StoryDeck = { cards: [] };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Per-branch decks (GET) + the captured writes (PUT) + the play calls. */
const decksByBranch = new Map<string, StoryDeck>();
const originalFetch = globalThis.fetch;
let capturedPutDeck: unknown = null;
let playCalls: Array<{ cardId: string; body: unknown }> = [];
let playResponses: Array<{ status: number; body: unknown }> = [];

function installFetch(): void {
  globalThis.fetch = testFetch(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/deck") && method === "GET") {
      const branchId = url.split("/branches/")[1]?.split("/")[0] ?? "";
      return json({ deck: decksByBranch.get(branchId) ?? EMPTY_DECK });
    }
    if (url.includes("/deck") && method === "PUT") {
      capturedPutDeck = JSON.parse(String(init?.body));
      return json(capturedPutDeck);
    }
    if (url.includes("/play") && method === "POST") {
      playCalls.push({ cardId: url.split("/deck/")[1]?.split("/")[0] ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
      const next = playResponses.shift();
      return next !== undefined ? json(next.body, next.status) : json({ deck: EMPTY_DECK, event: {} }, 200);
    }
    return json({});
  });
}

beforeEach(() => {
  decksByBranch.clear();
  capturedPutDeck = null;
  playCalls = [];
  playResponses = [];
  installFetch();
  useStoryCurtainTabStore.setState({ tabsByChat: {} });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ── The matchMedia stub (useIsMobile's max-width query + the flip's
//    prefers-reduced-motion query — one stub answers both) ───────────────────
const MOBILE_QUERY = "(max-width: 768px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
let realMatchMedia: typeof window.matchMedia | undefined;
let hadMatchMedia = false;
let mobileMatches = false;
let reducedMotionMatches = false;
function stubMedia(options: { mobile?: boolean; reduced?: boolean } = {}): void {
  mobileMatches = options.mobile ?? false;
  reducedMotionMatches = options.reduced ?? false;
  // Member-for-member MediaQueryList literal (the 7a annotation shape) —
  // the literal satisfies the interface; no erasure.
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: (mobileMatches && query === MOBILE_QUERY) || (reducedMotionMatches && query === REDUCED_MOTION_QUERY),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  hadMatchMedia = typeof window.matchMedia === "function";
  realMatchMedia = window.matchMedia;
  stubMedia();
});

afterEach(() => {
  if (hadMatchMedia && realMatchMedia !== undefined) window.matchMedia = realMatchMedia;
  // Removing the member lib.dom types as always-present needs the reflective
  // form (the BottomSheet.test.tsx precedent) — no cast.
  else Reflect.deleteProperty(window, "matchMedia");
});

afterAll(() => {
  if (hadMatchMedia && realMatchMedia !== undefined) window.matchMedia = realMatchMedia;
  else Reflect.deleteProperty(window, "matchMedia");
});

// ── View (§2) ────────────────────────────────────────────────────────────────

describe("StoryCardDialog — view (§2)", () => {
  it("opens the clicked card big: the 300×420 face with the full body and the §2 footer (remove+edit left, close+play-now right)", async () => {
    decksByBranch.set("dkd-b1", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-1" branchId="dkd-b1" locked={false} request={{ kind: "card", cardId: "c1" }} />);
    const dialog = await waitFor(() => view.getByTestId("story-card-dialog"));
    const face = view.getByTestId("story-card");
    expect(face.getAttribute("data-card-id")).toBe("c1");
    // The big face: full height/width geometry, the body NOT clamped (the
    // big face shows the full body).
    expect(face.className).toContain("h-[420px]");
    expect(face.className).toContain("w-[300px]");
    expect(face.textContent).toContain("Vet visit");
    // The §2 footer: all four actions, named by their i18n keys.
    expect(within(dialog).getByTestId("story-card-dialog-remove").textContent).toBe("story_deck_dialog_remove");
    expect(within(dialog).getByTestId("story-card-dialog-edit").textContent).toBe("story_deck_dialog_edit");
    expect(within(dialog).getByTestId("story-card-dialog-close").textContent).toBe("story_deck_dialog_close");
    expect(within(dialog).getByTestId("story-card-dialog-play-now").textContent).toBe("story_deck_dialog_play_now");
    // §6's wrap rule pinned: the footer is flex-wrap (the RU four-button row
    // does not fit 380px at the default font — groups keep their lines).
    expect(dialog.className).toContain("w-[380px]");
    const footer = view.getByTestId("story-card-dialog-remove").parentElement?.parentElement;
    expect(footer?.className).toContain("flex-wrap");
    // The remove arm is the danger-tinted footer text (mockup §2).
    expect(view.getByTestId("story-card-dialog-remove").className).toContain("text-danger-text");
    // The play-now arm is the accent primary.
    expect(view.getByTestId("story-card-dialog-play-now").className).toContain("bg-accent");
  });

  it("locked (DR-12): the deck writes disable — play-now, edit, remove — close stays live", async () => {
    decksByBranch.set("dkd-b2", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-2" branchId="dkd-b2" locked={true} request={{ kind: "card", cardId: "c1" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    expect(view.getByTestId("story-card-dialog-play-now").getAttribute("disabled")).toBe("");
    expect(view.getByTestId("story-card-dialog-edit").getAttribute("disabled")).toBe("");
    expect(view.getByTestId("story-card-dialog-remove").getAttribute("disabled")).toBe("");
    expect(view.getByTestId("story-card-dialog-close").getAttribute("disabled")).toBeNull();
  });
});

// ── Play (DK-4a) ─────────────────────────────────────────────────────────────

describe("StoryCardDialog — play", () => {
  it("success: POSTs {} to the card's play route, switches the curtain to events, closes the dialog", async () => {
    decksByBranch.set("dkd-b3", DECK);
    playResponses = [
      {
        status: 200,
        body: {
          deck: { cards: DECK.cards.filter((card) => card.id !== "c1") },
          event: { id: "task_new", title: "Vet visit", body: DECK.cards[0]!.body, status: "active" },
        },
      },
    ];
    const view = render(<DialogHarness chatId="dkd-chat-3" branchId="dkd-b3" locked={false} request={{ kind: "card", cardId: "c1" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    fireEvent.click(view.getByTestId("story-card-dialog-play-now"));
    // The plain play body (its absence accepts the foreign-goals refusal).
    await waitFor(() => expect(playCalls).toHaveLength(1));
    expect(playCalls[0]!.cardId).toBe("c1");
    expect(playCalls[0]!.body).toEqual({});
    // The dialog closed and the curtain switched to the events tab — the
    // plan panel's own current-event highlight is the signal.
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());
    expect(useStoryCurtainTabStore.getState().tabsByChat["dkd-chat-3"]).toBe("events");
  });

  it("typed 409: the replace-goals confirm shows the copy; the retry carries replaceForeignGoals:true; success closes", async () => {
    decksByBranch.set("dkd-b4", DECK);
    playResponses = [
      {
        status: 409,
        body: {
          error: {
            kind: "Conflict",
            message: "The branch has no plan, and the goal tracker holds goals not from a plan.",
            details: { code: "story_deck_foreign_goals", foreignGoalCount: 2 },
          },
        },
      },
      {
        status: 200,
        body: { deck: { cards: [] }, event: { id: "task_new", title: "Vet visit", body: "", status: "active" } },
      },
    ];
    const view = render(<DialogHarness chatId="dkd-chat-4" branchId="dkd-b4" locked={false} request={{ kind: "card", cardId: "c1" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    fireEvent.click(view.getByTestId("story-card-dialog-play-now"));
    // The confirm appears with the replace-goals copy (the ask's verbatim
    // line, quoted by its key — the identity echo shows keys).
    await waitFor(() => view.getByText("story_deck_play_confirm_body"));
    expect(view.getByText("story_deck_play_confirm_title")).toBeDefined();
    // The confirm's play button (name = the story_deck_dialog_play key).
    const confirmPlay = view.getAllByRole("button", { name: "story_deck_dialog_play" });
    expect(confirmPlay).toHaveLength(1);
    fireEvent.click(confirmPlay[0]!);
    // The retry: the SAME route, now with the override flag.
    await waitFor(() => expect(playCalls).toHaveLength(2));
    expect(playCalls[1]!.cardId).toBe("c1");
    expect(playCalls[1]!.body).toEqual({ replaceForeignGoals: true });
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());
    expect(useStoryCurtainTabStore.getState().tabsByChat["dkd-chat-4"]).toBe("events");
  });

  it("typed 409 + «Отмена»: the confirm closes, the dialog stays open with the card, no retry", async () => {
    decksByBranch.set("dkd-b5", DECK);
    playResponses = [
      {
        status: 409,
        body: {
          error: {
            kind: "Conflict",
            message: "conflict",
            details: { code: "story_deck_foreign_goals", foreignGoalCount: 1 },
          },
        },
      },
    ];
    const view = render(<DialogHarness chatId="dkd-chat-5" branchId="dkd-b5" locked={false} request={{ kind: "card", cardId: "c2" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    fireEvent.click(view.getByTestId("story-card-dialog-play-now"));
    await waitFor(() => view.getByText("story_deck_play_confirm_body"));
    fireEvent.click(view.getByRole("button", { name: "cancel" }));
    expect(view.queryByText("story_deck_play_confirm_body")).toBeNull();
    // The dialog stays open with the card; no second POST.
    expect(view.getByTestId("story-card").getAttribute("data-card-id")).toBe("c2");
    expect(view.queryByTestId("story-card-dialog")).not.toBeNull();
    expect(playCalls).toHaveLength(1);
  });
});

// ── Edit (§2's editor, entered from «Изменить») ──────────────────────────────

describe("StoryCardDialog — edit", () => {
  it("the editor shows the five suit options (the ONE suit derivation), the fields and the live preview; Save PUTs and returns to view", async () => {
    decksByBranch.set("dkd-b6", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-6" branchId="dkd-b6" locked={false} request={{ kind: "card", cardId: "c1" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    // The deck GET resolves after the dialog mounts — wait for the card's
    // face (deck-derived) before entering the editor.
    await waitFor(() => expect(view.getByTestId("story-card").getAttribute("data-card-id")).toBe("c1"));
    fireEvent.click(view.getByTestId("story-card-dialog-edit"));
    // The editor: the suit radiogroup carries all five suits of the shared
    // derivation, with threat (the first option) checked.
    expect(view.getByRole("radiogroup", { name: "story_deck_field_suit" })).toBeDefined();
    const suits = ["threat", "encounter", "discovery", "mystery", "change"];
    for (const suit of suits) {
      expect(view.getByRole("radio", { name: `story_deck_suit_${suit}` })).toBeDefined();
    }
    expect(view.getByRole("radio", { name: "story_deck_suit_threat" }).getAttribute("data-state")).toBe("checked");
    // The fields carry the card's draft; the live preview mirrors it.
    const titleInput = view.getByLabelText("story_deck_field_title") as HTMLInputElement;
    expect(titleInput.value).toBe("Vet visit");
    const bodyField = view.getByLabelText("story_deck_field_body") as HTMLTextAreaElement;
    expect(bodyField.value).toBe("The neighbor already rings the doorbell.");
    expect(view.getByText("story_deck_field_body_hint")).toBeDefined();
    const previewTitle = view.getByTestId("story-card-dialog-preview").querySelector("div.font-body");
    expect(previewTitle?.textContent).toBe("Vet visit");
    // A draft edit reflects in the preview at once (LIVE preview).
    fireEvent.change(titleInput, { target: { value: "Vet visit, postponed" } });
    expect((view.getByLabelText("story_deck_field_title") as HTMLInputElement).value).toBe("Vet visit, postponed");
    expect(view.getByTestId("story-card-dialog-preview").querySelector("div.font-body")?.textContent).toBe("Vet visit, postponed");
    // Suit switch reflects too (the preview's data-suit).
    fireEvent.click(view.getByRole("radio", { name: "story_deck_suit_change" }));
    expect(view.getByTestId("story-card-dialog-preview").querySelector('[data-testid="story-card"]')?.getAttribute("data-suit")).toBe("change");
    // Save PUTs the full deck with the edited card…
    fireEvent.click(view.getByTestId("story-card-dialog-save"));
    await waitFor(() => expect(capturedPutDeck).not.toBeNull());
    const putDeck = (capturedPutDeck as { deck: StoryDeck }).deck;
    expect(putDeck.cards.map((card) => card.id)).toEqual(["c1", "c2", "c3"]);
    expect(putDeck.cards[0]).toEqual({ id: "c1", suit: "change", title: "Vet visit, postponed", body: "The neighbor already rings the doorbell." });
    // …and the dialog returns to VIEW mode (the edit flow's end).
    await waitFor(() => expect(view.getByTestId("story-card-dialog-play-now")).toBeDefined());
    expect(view.queryByTestId("story-card-dialog-save")).toBeNull();
  });

  it("Save disables while the title is empty (a card must have a title)", async () => {
    decksByBranch.set("dkd-b7", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-7" branchId="dkd-b7" locked={false} request={{ kind: "card", cardId: "c1" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    await waitFor(() => expect(view.getByTestId("story-card").getAttribute("data-card-id")).toBe("c1"));
    fireEvent.click(view.getByTestId("story-card-dialog-edit"));
    const save = view.getByTestId("story-card-dialog-save");
    expect(save.getAttribute("disabled")).toBeNull();
    const titleInput = view.getByLabelText("story_deck_field_title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "" } });
    expect(save.getAttribute("disabled")).toBe("");
    // A whitespace-only title is still empty.
    fireEvent.change(titleInput, { target: { value: "   " } });
    expect(save.getAttribute("disabled")).toBe("");
  });
});

// ── The edit heading (owner ruling 2026-11-07) ─────────────────────────────

describe("StoryCardDialog — the edit heading (phase-aware title)", () => {
  it("desktop: editing an EXISTING card carries the «Изменить карту» heading — the shell's accessible title AND the panel's visible h2 both switch to story_deck_dialog_edit_title; view stays story_deck_title; the new-card editor keeps its own heading", async () => {
    decksByBranch.set("dkd-b9", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-9" branchId="dkd-b9" locked={false} request={{ kind: "card", cardId: "c1" }} />);
    await waitFor(() => expect(view.getByTestId("story-card").getAttribute("data-card-id")).toBe("c1"));
    // View phase: the shell title is the deck title (the accessible Modal
    // title + its description twin; the view body carries no heading).
    expect(view.getAllByText("story_deck_title")).toHaveLength(2);
    expect(view.queryByText("story_deck_dialog_edit_title")).toBeNull();

    // The edit phase of an EXISTING card: the heading treatment the
    // new-card editor has — the shell title AND the panel's visible h2.
    fireEvent.click(view.getByTestId("story-card-dialog-edit"));
    const headings = await waitFor(() => view.getAllByText("story_deck_dialog_edit_title"));
    expect(headings.length).toBe(3);
    // The visible one is the panel's h2 (the same treatment as new-card).
    const h2 = headings.find((node) => node.tagName === "H2");
    expect(h2).toBeDefined();
    expect(view.queryByText("story_deck_own_card")).toBeNull();
    view.unmount();

    // The new-card editor keeps the own-card heading in BOTH layers.
    const view2 = render(<DialogHarness chatId="dkd-chat-9" branchId="dkd-b9" locked={false} request={{ kind: "new" }} />);
    const dialog2 = await waitFor(() => view2.getByTestId("story-card-dialog"));
    expect(within(dialog2).getByText("story_deck_own_card")).toBeDefined();
    expect(view2.queryByText("story_deck_dialog_edit_title")).toBeNull();
  });

  it("phone: the sheet title follows the phase — «Изменить карту» in the existing card's edit, none in view", async () => {
    stubMedia({ mobile: true });
    decksByBranch.set("dkd-b10", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-10" branchId="dkd-b10" locked={false} request={{ kind: "card", cardId: "c2" }} />);
    const dialog = await waitFor(() => view.getByTestId("story-card-dialog"));
    // View phase on the phone: no sheet title (today's drawing — the face
    // + the stacked actions).
    expect(within(dialog).queryByText("story_deck_dialog_edit_title")).toBeNull();
    expect(document.body.textContent).not.toContain("story_deck_dialog_edit_title");

    // The edit phase: the sheet title IS the edit heading.
    fireEvent.click(within(dialog).getByTestId("story-card-dialog-edit"));
    const sheet = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".glass-blur");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(sheet.textContent).toContain("story_deck_dialog_edit_title");
    expect(sheet.textContent).not.toContain("story_deck_own_card");
  });
});

// ── New card (the tile's editor) ─────────────────────────────────────────────

describe("StoryCardDialog — new card", () => {
  it("the «Своя карта» editor: Save disabled on an empty title; Save PUTs a fresh card_ uuid card and closes", async () => {
    decksByBranch.set("dkd-b8", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-8" branchId="dkd-b8" locked={false} request={{ kind: "new" }} />);
    const dialog = await waitFor(() => view.getByTestId("story-card-dialog"));
    // The editor's title (the mockup §2's heading, the own-card key).
    expect(within(dialog).getByText("story_deck_own_card")).toBeDefined();
    // The fresh draft: the first suit option, empty title — Save disabled.
    expect(view.getByRole("radio", { name: "story_deck_suit_threat" }).getAttribute("data-state")).toBe("checked");
    expect((view.getByLabelText("story_deck_field_title") as HTMLInputElement).value).toBe("");
    expect(view.getByTestId("story-card-dialog-save").getAttribute("disabled")).toBe("");
    const previewCard = view.getByTestId("story-card-dialog-preview").querySelector('[data-testid="story-card"]');
    expect(previewCard?.getAttribute("data-suit")).toBe("threat");
    // Fill the title + body → Save enabled → PUT appends a card_uuid card.
    fireEvent.change(view.getByLabelText("story_deck_field_title"), { target: { value: "A note in the jacket" } });
    fireEvent.change(view.getByLabelText("story_deck_field_body"), { target: { value: "Noa finds a cat-food note." } });
    expect(view.getByTestId("story-card-dialog-save").getAttribute("disabled")).toBeNull();
    fireEvent.click(view.getByTestId("story-card-dialog-save"));
    await waitFor(() => expect(capturedPutDeck).not.toBeNull());
    const putDeck = (capturedPutDeck as { deck: StoryDeck }).deck;
    expect(putDeck.cards).toHaveLength(4);
    const created = putDeck.cards[3]!;
    expect(created.id.startsWith("card_")).toBe(true);
    expect(created.id).not.toBe("c1");
    expect(created.suit).toBe("threat");
    expect(created.title).toBe("A note in the jacket");
    // The new-card flow CLOSES after the save (the created card shows in
    // the grid behind the dialog).
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());
  });
});

// ── Remove (§2's destructive footer arm) ─────────────────────────────────────

describe("StoryCardDialog — remove", () => {
  it("the destructive confirm: confirming PUTs the deck without the card and closes; cancelling keeps the dialog", async () => {
    decksByBranch.set("dkd-b9", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-9" branchId="dkd-b9" locked={false} request={{ kind: "card", cardId: "c2" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    fireEvent.click(view.getByTestId("story-card-dialog-remove"));
    // The confirm (title + the interpolated body, quoted by keys).
    await waitFor(() => view.getByText("story_deck_dialog_remove_title"));
    expect(view.getByText("story_deck_dialog_remove_body")).toBeDefined();
    // Cancel first: nothing written, the dialog stays.
    fireEvent.click(view.getByRole("button", { name: "cancel" }));
    expect(view.queryByText("story_deck_dialog_remove_title")).toBeNull();
    expect(capturedPutDeck).toBeNull();
    expect(view.queryByTestId("story-card-dialog")).not.toBeNull();
    // Confirm: PUT without c2, then close. While the confirm is open Radix
    // hides the background from the a11y tree, so the only role-visible
    // story_deck_dialog_remove button IS the confirm's.
    fireEvent.click(view.getByTestId("story-card-dialog-remove"));
    await waitFor(() => view.getByText("story_deck_dialog_remove_title"));
    fireEvent.click(view.getByRole("button", { name: "story_deck_dialog_remove" }));
    await waitFor(() => expect(capturedPutDeck).not.toBeNull());
    expect((capturedPutDeck as { deck: StoryDeck }).deck.cards.map((card) => card.id)).toEqual(["c1", "c3"]);
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());
  });
});

// ── Draw (§3) ────────────────────────────────────────────────────────────────

describe("StoryCardDialog — draw (§3)", () => {
  it("opens face-down (the back + the flip shell pins), flips to the face (~450ms), footer «Вернуть в колоду» · «Разыграть»", async () => {
    decksByBranch.set("dkd-b10", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-10" branchId="dkd-b10" locked={false} request={{ kind: "draw" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    // Face-down first: the back renders, the face does not (the face mounts
    // only when flipped — the DOM state the CSS backface-visibility rides).
    expect(view.getByTestId("story-card-back")).toBeDefined();
    expect(view.queryByTestId("story-card")).toBeNull();
    const flipShell = view.getByTestId("story-card-draw-flip");
    expect(flipShell.getAttribute("data-flipped")).toBe("false");
    // The flip transition pins (§3's rotateY ~450ms): the shell carries the
    // transform transition + duration + preserve-3d; happy-dom applies no
    // CSS, so the class strings ARE the boundary.
    expect(flipShell.className).toContain("transition-transform");
    expect(flipShell.className).toContain("duration-[450ms]");
    expect(flipShell.className).toContain("[transform-style:preserve-3d]");
    expect(flipShell.className).toContain("motion-reduce:transition-none");
    expect(flipShell.className).not.toContain("[transform:rotateY(180deg)]");
    // The draw footer (§3, centered): return + play.
    expect(view.getByTestId("story-card-dialog-return").textContent).toBe("story_deck_dialog_return");
    expect(view.getByTestId("story-card-dialog-play").textContent).toBe("story_deck_dialog_play");
    // The flip lands within the 450ms beat (parked on the resolved state —
    // no sleeps).
    await waitFor(() => expect(view.getByTestId("story-card-draw-flip").getAttribute("data-flipped")).toBe("true"), {
      timeout: 2000,
    });
    // The face now shows one of the deck's cards (uniform pick — any of
    // them); the shell carries the flipped transform.
    const face = await waitFor(() => view.getByTestId("story-card"));
    expect(DECK.cards.some((card) => card.id === face.getAttribute("data-card-id"))).toBe(true);
    expect(view.getByTestId("story-card-draw-flip").className).toContain("[transform:rotateY(180deg)]");
  });

  it("reduced motion: the face appears at once (no flip wait)", async () => {
    stubMedia({ reduced: true });
    decksByBranch.set("dkd-b11", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-11" branchId="dkd-b11" locked={false} request={{ kind: "draw" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    // The flip flag is immediate (no 450ms wait) — only the deck GET (and
    // the pick effect it triggers) stands between the open and the face.
    await waitFor(() => view.getByTestId("story-card-dialog"));
    expect(view.getByTestId("story-card-draw-flip").getAttribute("data-flipped")).toBe("true");
    await waitFor(() => view.getByTestId("story-card"));
  });

  it("playing from the draw hits the drawn card's play route and closes", async () => {
    decksByBranch.set("dkd-b12", DECK);
    playResponses = [
      { status: 200, body: { deck: { cards: [] }, event: { id: "task_new", title: "T", body: "", status: "active" } } },
    ];
    const view = render(<DialogHarness chatId="dkd-chat-12" branchId="dkd-b12" locked={false} request={{ kind: "draw" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    await waitFor(() => expect(view.getByTestId("story-card-draw-flip").getAttribute("data-flipped")).toBe("true"), {
      timeout: 2000,
    });
    const drawnId = await waitFor((): string => {
      const face = view.getByTestId("story-card");
      const cardId = face.getAttribute("data-card-id");
      expect(cardId).toBeTruthy();
      return cardId ?? "";
    });
    fireEvent.click(view.getByTestId("story-card-dialog-play"));
    await waitFor(() => expect(playCalls).toHaveLength(1));
    expect(playCalls[0]!.cardId).toBe(drawnId);
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());
    expect(useStoryCurtainTabStore.getState().tabsByChat["dkd-chat-12"]).toBe("events");
  });
});

// ── Phone (§7) — the BottomSheet shell ───────────────────────────────────────

describe("StoryCardDialog — phone (§7)", () => {
  it("the card sheet: the card, then «Разыграть сейчас» full width, «Изменить»+«Убрать из колоды» flex-1 — no «Закрыть»", async () => {
    stubMedia({ mobile: true });
    decksByBranch.set("dkd-b13", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-13" branchId="dkd-b13" locked={false} request={{ kind: "card", cardId: "c1" }} />);
    const dialog = await waitFor(() => view.getByTestId("story-card-dialog"));
    await waitFor(() => expect(within(dialog).getByTestId("story-card").getAttribute("data-card-id")).toBe("c1"));
    // §7: the primary is full width; the edit/remove pair share the row.
    const playNow = view.getByTestId("story-card-dialog-play-now");
    expect(playNow.className).toContain("w-full");
    expect(playNow.className).toContain("min-h-11");
    expect(view.getByTestId("story-card-dialog-edit").className).toContain("flex-1");
    expect(view.getByTestId("story-card-dialog-remove").className).toContain("flex-1");
    // The sheet has no «Закрыть» — the sheet chrome itself dismisses (§7).
    expect(within(dialog).queryByTestId("story-card-dialog-close")).toBeNull();
  });

  it("the phone editor: fields stack, the suit control is mobileFill+wrap, the preview follows, the footer pair is flex-1", async () => {
    stubMedia({ mobile: true });
    decksByBranch.set("dkd-b14", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-14" branchId="dkd-b14" locked={false} request={{ kind: "new" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    // The sheet's visible title is the own-card key (§2's editor heading).
    expect(view.getByText("story_deck_own_card")).toBeDefined();
    const suitGroup = view.getByRole("radiogroup", { name: "story_deck_field_suit" });
    expect(suitGroup.className).toContain("w-full");
    expect(suitGroup.className).toContain("flex-wrap");
    expect(view.getByTestId("story-card-dialog-preview")).toBeDefined();
    expect(view.getByTestId("story-card-dialog-cancel").className).toContain("flex-1");
    expect(view.getByTestId("story-card-dialog-save").className).toContain("flex-1");
  });

  it("the draw on the phone: face-down in the sheet, then the stacked play/return pair", async () => {
    stubMedia({ mobile: true });
    decksByBranch.set("dkd-b15", DECK);
    const view = render(<DialogHarness chatId="dkd-chat-15" branchId="dkd-b15" locked={false} request={{ kind: "draw" }} />);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    expect(view.getByTestId("story-card-back")).toBeDefined();
    await waitFor(() => expect(view.getByTestId("story-card-draw-flip").getAttribute("data-flipped")).toBe("true"), {
      timeout: 2000,
    });
    expect(view.getByTestId("story-card-dialog-play").className).toContain("w-full");
    expect(view.getByTestId("story-card-dialog-return").className).toContain("w-full");
  });
});

// ── The deck-grid wiring (through StoryDeckView) ─────────────────────────────

describe("StoryDeckView → StoryCardDialog wiring (DK-7)", () => {
  it("a card face opens the dialog; «Вытянуть случайную» opens it face-down; the tile opens the editor; the empty state's link opens the editor", async () => {
    decksByBranch.set("dkd-b16", DECK);
    const view = render(<StoryDeckView chatId="dkd-chat-16" branchId="dkd-b16" locked={false} />);
    await waitFor(() => expect(view.getAllByTestId("story-card")).toHaveLength(3));
    // The draw button is live (no placeholder title anymore).
    const draw = view.getByTestId("story-deck-draw");
    expect(draw.getAttribute("disabled")).toBeNull();
    expect(draw.getAttribute("title")).toBeNull();
    const tile = view.getByTestId("story-deck-add-card");
    expect(tile.getAttribute("disabled")).toBeNull();
    expect(tile.getAttribute("title")).toBeNull();

    // Click a card face → the dialog opens with that card → close. The
    // grid's faces share the story-card testid — dialog queries scope
    // through `within` (the dialog body renders one face of its own).
    fireEvent.click(view.getAllByTestId("story-deck-card-open")[0]!);
    await waitFor(() => view.getByTestId("story-card-dialog"));
    const dialog = view.getByTestId("story-card-dialog");
    expect(within(dialog).getByTestId("story-card").getAttribute("data-card-id")).toBe("c1");
    fireEvent.click(within(dialog).getByTestId("story-card-dialog-close"));
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());

    // The draw → the dialog opens face-down → return.
    fireEvent.click(view.getByTestId("story-deck-draw"));
    await waitFor(() => view.getByTestId("story-card-dialog"));
    const drawDialog = view.getByTestId("story-card-dialog");
    await waitFor(() => within(drawDialog).getByTestId("story-card-back"));
    expect(within(drawDialog).queryByTestId("story-card")).toBeNull();
    fireEvent.click(within(drawDialog).getByTestId("story-card-dialog-return"));
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());

    // The dashed tile → the new-card editor.
    fireEvent.click(view.getByTestId("story-deck-add-card"));
    await waitFor(() => view.getByTestId("story-card-dialog-save"));
    fireEvent.click(view.getByTestId("story-card-dialog-cancel"));
    await waitFor(() => expect(view.queryByTestId("story-card-dialog")).toBeNull());
  });

  it("the empty state's «+ Своя карта» link is live and opens the editor", async () => {
    decksByBranch.set("dkd-b17", EMPTY_DECK);
    const view = render(<StoryDeckView chatId="dkd-chat-17" branchId="dkd-b17" locked={false} />);
    const add = await waitFor(() => view.getByTestId("story-deck-empty-add"));
    expect(add.getAttribute("disabled")).toBeNull();
    expect(add.getAttribute("title")).toBeNull();
    fireEvent.click(add);
    await waitFor(() => view.getByTestId("story-card-dialog-save"));
    expect(view.getByLabelText("story_deck_field_title") as HTMLInputElement).toBeDefined();
  });
});

// ── The RU canon (mockup §2/§3, byte-exact) ──────────────────────────────────

describe("StoryCardDialog — locale canon (DK-7)", () => {
  it("ru.json carries the mockup's strings verbatim; en carries the English twins", () => {
    expect(ru.story_deck_dialog_edit).toBe("Изменить");
    expect(ru.story_deck_dialog_remove).toBe("Убрать из колоды");
    expect(ru.story_deck_dialog_close).toBe("Закрыть");
    expect(ru.story_deck_dialog_play_now).toBe("Разыграть сейчас");
    expect(ru.story_deck_dialog_play).toBe("Разыграть");
    expect(ru.story_deck_dialog_return).toBe("Вернуть в колоду");
    expect(ru.story_deck_dialog_save).toBe("Сохранить");
    expect(ru.story_deck_field_suit).toBe("Масть");
    expect(ru.story_deck_field_title).toBe("Название");
    expect(ru.story_deck_field_body).toBe("Что произойдёт");
    expect(ru.story_deck_field_body_hint).toBe(
      "Что должно произойти — это увидит модель, когда карта будет разыграна.",
    );
    expect(ru.story_deck_dialog_preview).toBe("Так карта выглядит в колоде");
    expect(ru.story_deck_play_confirm_body).toBe("Цели в трекере целей заменятся событиями плана.");
    expect(en.story_deck_dialog_edit).toBe("Edit");
    expect(en.story_deck_dialog_remove).toBe("Remove from deck");
    expect(en.story_deck_dialog_close).toBe("Close");
    expect(en.story_deck_dialog_play_now).toBe("Play now");
    expect(en.story_deck_dialog_play).toBe("Play");
    expect(en.story_deck_dialog_return).toBe("Return to deck");
    expect(en.story_deck_dialog_save).toBe("Save");
    expect(en.story_deck_field_suit).toBe("Suit");
    expect(en.story_deck_field_title).toBe("Title");
    expect(en.story_deck_field_body).toBe("What happens");
    expect(en.story_deck_field_body_hint).toBe(
      "What should happen — the model will see this when the card is played.",
    );
    expect(en.story_deck_dialog_preview).toBe("This is how the card looks in the deck");
    expect(en.story_deck_play_confirm_body).toBe("The goals in the goal tracker will be replaced with the plan's events.");
  });
});

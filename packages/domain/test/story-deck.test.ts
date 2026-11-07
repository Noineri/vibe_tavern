import { describe, expect, test } from "bun:test";
import {
  STORY_CARD_SUIT,
  normalizeStoryDeck,
} from "../src/index.js";

const CARD = {
  id: "card_1",
  suit: STORY_CARD_SUIT.threat,
  title: "The door wont hold",
  body: "Something on the other side starts pushing.",
};

describe("normalizeStoryDeck", () => {
  test("normalizes a valid deck and keeps card order", () => {
    const deck = normalizeStoryDeck({
      cards: [
        CARD,
        { id: "card_2", suit: STORY_CARD_SUIT.mystery, title: "The sealed letter", body: "Who wrote it?" },
        { id: "card_3", suit: STORY_CARD_SUIT.change, title: "The tide turns", body: "" },
      ],
    });

    expect(deck).toEqual({
      cards: [
        CARD,
        { id: "card_2", suit: "mystery", title: "The sealed letter", body: "Who wrote it?" },
        { id: "card_3", suit: "change", title: "The tide turns", body: "" },
      ],
    });
  });

  test("accepts every suit of the fixed set", () => {
    const deck = normalizeStoryDeck({
      cards: Object.values(STORY_CARD_SUIT).map((suit, i) => ({
        id: `card_${i}`,
        suit,
        title: `Card ${i}`,
        body: "",
      })),
    });

    expect(deck?.cards.map((card) => card.suit)).toEqual(Object.values(STORY_CARD_SUIT));
  });

  test("drops cards without an id or with a blank id", () => {
    const deck = normalizeStoryDeck({
      cards: [
        { title: "Missing id", body: "", suit: "threat" },
        { id: "   ", title: "Blank id", body: "", suit: "threat" },
        { ...CARD, title: "Kept" },
      ],
    });

    expect(deck?.cards).toEqual([{ ...CARD, title: "Kept" }]);
  });

  test("drops cards without a title or with a blank title", () => {
    const deck = normalizeStoryDeck({
      cards: [
        { id: "card_a", body: "", suit: "threat" },
        { id: "card_b", title: "   ", body: "", suit: "threat" },
        { ...CARD, title: "Kept" },
      ],
    });

    expect(deck?.cards).toEqual([{ ...CARD, title: "Kept" }]);
  });

  test("drops cards with an unknown or missing suit", () => {
    const deck = normalizeStoryDeck({
      cards: [
        { ...CARD, suit: "plot_twist" },
        { id: "card_a", title: "No suit", body: "" },
        { ...CARD, id: "card_b", title: "Kept" },
      ],
    });

    expect(deck?.cards).toEqual([{ ...CARD, id: "card_b", title: "Kept" }]);
  });

  test("defaults a missing or non-string body to an empty one", () => {
    const deck = normalizeStoryDeck({
      cards: [
        { id: "card_a", suit: "threat", title: "A", body: undefined },
        { id: "card_b", suit: "threat", title: "B", body: 42 },
        { id: "card_c", suit: "threat", title: "C" },
      ],
    });

    expect(deck?.cards).toEqual([
      { id: "card_a", suit: "threat", title: "A", body: "" },
      { id: "card_b", suit: "threat", title: "B", body: "" },
      { id: "card_c", suit: "threat", title: "C", body: "" },
    ]);
  });

  test("trims id and title, keeps the body verbatim", () => {
    const deck = normalizeStoryDeck({
      cards: [{ id: "  card_1  ", suit: "threat", title: "  Padded  ", body: "  keep  " }],
    });

    expect(deck?.cards[0]).toEqual({ id: "card_1", suit: "threat", title: "Padded", body: "  keep  " });
  });

  test("drops non-object cards and keeps the valid ones", () => {
    const deck = normalizeStoryDeck({
      cards: ["a card", 7, null, ["nope"], CARD],
    });

    expect(deck?.cards).toEqual([CARD]);
  });

  test("a missing or non-array cards key reads as the empty deck", () => {
    expect(normalizeStoryDeck({})).toEqual({ cards: [] });
    expect(normalizeStoryDeck({ cards: "nope" })).toEqual({ cards: [] });
    expect(normalizeStoryDeck({ cards: 42 })).toEqual({ cards: [] });
  });

  test("a raw value that is not a plain object reads as null", () => {
    for (const bad of ["deck", 7, true, null, [CARD], undefined]) {
      expect(normalizeStoryDeck(bad)).toBeNull();
    }
  });

  test("preserves a 100,000-character card body", () => {
    const body = "x".repeat(100_000);
    const deck = normalizeStoryDeck({ cards: [{ ...CARD, body }] });

    expect(deck?.cards[0]?.body).toBe(body);
  });
});

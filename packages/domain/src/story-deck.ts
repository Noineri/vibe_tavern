import { isRecord } from "./is-record.js";

/** The five suits a story deck's twist cards are filed under (DK-3's fixed
 * set). `as const` object + derived type — never a TS enum. */
export const STORY_CARD_SUIT = {
  threat: "threat",
  encounter: "encounter",
  discovery: "discovery",
  mystery: "mystery",
  change: "change",
} as const;

export type StoryCardSuit = typeof STORY_CARD_SUIT[keyof typeof STORY_CARD_SUIT];

/** One twist card in a chat branch's story deck. */
export interface StoryCard {
  id: string;
  suit: StoryCardSuit;
  title: string;
  body: string;
}

/** The one story deck each chat branch may own: an ordered set of twist
 * cards (DIRECTOR_DECK_CALENDAR_PLAN DK-3). */
export interface StoryDeck {
  cards: StoryCard[];
}

export const EMPTY_STORY_DECK: StoryDeck = { cards: [] };

function isStoryCardSuit(value: unknown): value is StoryCardSuit {
  return Object.values(STORY_CARD_SUIT).some((suit) => suit === value);
}

/**
 * Normalizes a story deck loaded from persisted JSON without imposing product
 * length limits (the same tolerance philosophy as normalizeAgentPlan). A card
 * survives when it is a plain object with a non-empty trimmed `id`, a
 * non-empty trimmed `title`, and a known `suit`; a missing/non-string `body`
 * reads as "" and unknown extra keys are dropped — invalid cards are dropped
 * while the valid ones keep their order. A raw value that is not a plain
 * object (a bare array, a string, null) is not a deck at all and reads as
 * null — normalizeAgentPlan's exact contract; the read paths above the store
 * map null to the empty deck.
 */
export function normalizeStoryDeck(raw: unknown): StoryDeck | null {
  if (!isRecord(raw)) return null;

  const cards: StoryCard[] = [];
  const rawCards = Array.isArray(raw.cards) ? raw.cards : [];
  for (const candidate of rawCards) {
    if (!isRecord(candidate)) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!id || !title) continue;
    if (!isStoryCardSuit(candidate.suit)) continue;
    cards.push({
      id,
      suit: candidate.suit,
      title,
      body: typeof candidate.body === "string" ? candidate.body : "",
    });
  }

  return { cards };
}

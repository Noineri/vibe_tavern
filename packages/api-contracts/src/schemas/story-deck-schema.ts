import { STORY_CARD_SUIT } from "@vibe-tavern/domain";
import { z } from "zod";

/**
 * One persisted twist card in a chat branch's story deck (DK-3). A STRICT
 * mirror of the domain card shape — `suit` one of the five fixed suits, no
 * extra keys, and deliberately no length limits (the domain normalizer
 * imposes none either; mirrors agent-plan-schema.ts's strict style).
 */
export const storyCardSchema = z
  .object({
    id: z.string(),
    suit: z.enum(Object.values(STORY_CARD_SUIT)),
    title: z.string(),
    body: z.string(),
  })
  .strict();
export type StoryCard = z.infer<typeof storyCardSchema>;

/** The full per-branch deck carried by the deck routes (DK-3). */
export const storyDeckSchema = z
  .object({
    cards: z.array(storyCardSchema),
  })
  .strict();
export type StoryDeck = z.infer<typeof storyDeckSchema>;

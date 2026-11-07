import type { StoryDeckRuntimeApi } from "../contract/story-deck-contracts.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { EMPTY_STORY_DECK, type StoryDeck } from "@vibe-tavern/domain";
import { requireChatBranch } from "../../domain/chat/chat-branch-ownership.js";

/**
 * Thin adapter between the `StoryDeckRuntimeApi` contract and the
 * `@vibe-tavern/db` `storyDecks` store (DIRECTOR_DECK_CALENDAR_PLAN DK-3).
 * Mirrors the agent-plan adapter's branch arm: routes stay thin, the store
 * stays a dumb row layer, and the ownership rule lives here — the (chat,
 * branch) pair must exist (404 otherwise, the same requireChatBranch check
 * the plan routes run), and a missing row reads as the empty deck. Unlike the
 * plan PUT there is no normalize-or-422: the wire validates through the
 * strict `storyDeckSchema` at the route, so this adapter receives an
 * already-valid deck and saves it verbatim (no model tool feeds this surface
 * in DK-3 — serving the deck to models is DK-4+).
 */
export class StoryDeckAdapter implements StoryDeckRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	getStoryBranchDeck = async (chatId: string, branchId: string): Promise<StoryDeck> => {
		await requireChatBranch(this.stores.chats, chatId, branchId);
		return (await this.stores.storyDecks.get(chatId, branchId)) ?? EMPTY_STORY_DECK;
	};

	updateStoryBranchDeck = async (chatId: string, branchId: string, deck: StoryDeck): Promise<StoryDeck> => {
		await requireChatBranch(this.stores.chats, chatId, branchId);
		await this.stores.storyDecks.save(chatId, branchId, deck);
		return deck;
	};
}

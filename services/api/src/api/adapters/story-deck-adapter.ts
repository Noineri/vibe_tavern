import type { StoryDeckRuntimeApi } from "../contract/story-deck-contracts.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { EMPTY_STORY_DECK, brandId, type AgentPlanTask, type ChatBranchId, type ChatId, type StoryDeck } from "@vibe-tavern/domain";
import { requireChatBranch } from "../../domain/chat/chat-branch-ownership.js";
import type { StoryPlanSync } from "../../domain/director/story-plan-sync.js";
import { notFound } from "../../shared/errors.js";

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
 *
 * DK-4a adds the play route: `playStoryDeckCard` delegates to StoryPlanSync
 * (the plan machinery — deck removal + plan event + projection — is the
 * sync's business, not a store write). The sync is optional so deck-only
 * harnesses keep the GET/PUT surface without wiring it; the play route then
 * answers the same unavailability 404 the proposal seams use
 * (runtime-api-adapter's insertNextStoryEvent/applyStoryPlan closures).
 * Production always injects the real sync. Branded ids enter at this seam,
 * exactly like those closures.
 */
export class StoryDeckAdapter implements StoryDeckRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		private readonly storyPlanSync?: Pick<StoryPlanSync, "playCard">,
	) {}

	getStoryBranchDeck = async (chatId: string, branchId: string): Promise<StoryDeck> => {
		await requireChatBranch(this.stores.chats, chatId, branchId);
		return (await this.stores.storyDecks.get(chatId, branchId)) ?? EMPTY_STORY_DECK;
	};

	updateStoryBranchDeck = async (chatId: string, branchId: string, deck: StoryDeck): Promise<StoryDeck> => {
		await requireChatBranch(this.stores.chats, chatId, branchId);
		await this.stores.storyDecks.save(chatId, branchId, deck);
		return deck;
	};

	playStoryDeckCard = async (
		chatId: string,
		branchId: string,
		cardId: string,
		options?: { replaceForeignGoals?: boolean },
	): Promise<{ deck: StoryDeck; event: AgentPlanTask }> => {
		if (!this.storyPlanSync) {
			throw notFound("StoryPlanSync", "Story deck card play is unavailable (no story plan sync wired).");
		}
		return this.storyPlanSync.playCard(
			brandId<ChatId>(chatId),
			brandId<ChatBranchId>(branchId),
			cardId,
			options,
		);
	};
}

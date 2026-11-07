/**
 * Story deck contract (DIRECTOR_DECK_CALENDAR_PLAN DK-3). One story deck per
 * (chat, branch) pair — the per-branch twin of the agent-plan contract
 * (agent-plan-contracts.ts, same split-out module pattern for the file-size
 * ratchet). Reads return the empty deck when nothing is stored; writes are
 * full-replace and validated at the wire by the strict `storyDeckSchema`.
 */
export interface StoryDeckRuntimeApi {
	/** The branch's stored deck, or the empty deck when the branch has none yet
	 *  (the plan routes' no-plan-yet convention — consistency over invention). */
	getStoryBranchDeck: (chatId: string, branchId: string) => Promise<import("@vibe-tavern/api-contracts").StoryDeck>;
	/** Full-replace write. Throws NotFound for an unknown chat or a branch not
	 *  belonging to that chat (the plan routes' requireChatBranch ownership
	 *  check — 404, never a cross-owner leak). */
	updateStoryBranchDeck: (chatId: string, branchId: string, deck: import("@vibe-tavern/api-contracts").StoryDeck) => Promise<import("@vibe-tavern/api-contracts").StoryDeck>;
}

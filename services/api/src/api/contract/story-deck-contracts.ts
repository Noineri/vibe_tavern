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
	/** DK-4a: play one deck card into the branch's plan — the card leaves the
	 *  deck exactly once and enters the plan as a NEW event promoted to the
	 *  current event through the ordinary plan machinery (a plan-less branch
	 *  gets the born one-event plan, K6); the ACTIVE branch's tracker is
	 *  projected exactly as a plan PUT projects. The response is the played
	 *  event plus the deck after the removal. Throws NotFound for an unknown
	 *  chat, branch, or card (no write on any 404) and the typed Conflict 409
	 *  (`details.code = "story_deck_foreign_goals"`) when the branch has no
	 *  plan and the chat's tracker holds goals not from a plan, unless
	 *  `options.replaceForeignGoals` is set. */
	playStoryDeckCard: (chatId: string, branchId: string, cardId: string, options?: { replaceForeignGoals?: boolean }) => Promise<{ deck: import("@vibe-tavern/api-contracts").StoryDeck; event: import("@vibe-tavern/api-contracts").AgentPlanTask }>;
}

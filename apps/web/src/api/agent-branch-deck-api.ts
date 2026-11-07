/**
 * Chat-branch-owned story deck client (DIRECTOR_DECK_CALENDAR_PLAN DK-6) —
 * the typed twin of the branch plan client (`agent-branch-plan-api.ts`),
 * against the DK-3/DK-4a routes:
 *
 *   GET  /api/agent/chats/:chatId/branches/:branchId/deck
 *   PUT  /api/agent/chats/:chatId/branches/:branchId/deck
 *   POST /api/agent/chats/:chatId/branches/:branchId/deck/:cardId/play
 *
 * The deck content shape is shared (never re-declared here): both read/write
 * routes carry the `{ deck }` envelope whose content the server validates
 * against the single `storyDeckSchema` source — this client only forwards
 * it. No-deck-yet reads return the empty deck (the plan route's
 * no-plan-yet convention). The play route (DK-4a) returns `{ deck, event }`:
 * the deck after the card's removal plus the promoted plan event; the play
 * body is `{ replaceForeignGoals?: boolean }` (the caller sends `{}` for a
 * plain play — its absence accepts the foreign-goals refusal).
 */
import type { AgentPlanTask, StoryDeck } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

/** `GET /api/agent/chats/:chatId/branches/:branchId/deck` — the empty deck when the branch has none stored yet. */
export async function getAgentBranchDeck(chatId: string, branchId: string): Promise<StoryDeck> {
	const response = await client.api.agent.chats[":chatId"].branches[":branchId"].deck.$get({
		param: { chatId, branchId },
	});
	const data = await unwrapRpc(response);
	return data.deck;
}

/** `PUT /api/agent/chats/:chatId/branches/:branchId/deck` — full-replace write, returns the deck as saved. */
export async function updateAgentBranchDeck(chatId: string, branchId: string, deck: StoryDeck): Promise<StoryDeck> {
	const response = await client.api.agent.chats[":chatId"].branches[":branchId"].deck.$put({
		param: { chatId, branchId },
		json: { deck },
	});
	const data = await unwrapRpc(response);
	return data.deck;
}

/** `POST /api/agent/chats/:chatId/branches/:branchId/deck/:cardId/play` (DK-4a) — the deck after the removal + the played (promoted) plan event. */
export async function playAgentBranchDeckCard(
	chatId: string,
	branchId: string,
	cardId: string,
	options?: { replaceForeignGoals?: boolean },
): Promise<{ deck: StoryDeck; event: AgentPlanTask }> {
	const response = await client.api.agent.chats[":chatId"].branches[":branchId"].deck[":cardId"].play.$post({
		param: { chatId, branchId, cardId },
		json: options ?? {},
	});
	return unwrapRpc(response);
}

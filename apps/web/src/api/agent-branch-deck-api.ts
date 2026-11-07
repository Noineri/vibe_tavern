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
 *
 * Typed 409 (DK-7): a play whose branch has no plan while the goal tracker
 * holds foreign goals refuses with `details.code =
 * "story_deck_foreign_goals"` — read-once interception (the
 * `agent-feed-api.ts` unwrapFeedRpc shape) turns it into
 * {@link StoryDeckForeignGoalsError} so the card dialog can offer the
 * replace-goals confirm and retry; every other failure rides the shared
 * `unwrapRpc` mapping.
 */
import type { AgentPlanTask, StoryDeck } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { errorFromBody, unwrapRpc } from "./unwrap.js";
import type { RpcBody, RpcErrorBody, RpcResponse } from "./unwrap.js";

/** The server's typed refusal code (story-plan-sync.ts's
 * `STORY_DECK_FOREIGN_GOALS_CODE` — a string literal here because the web
 * package cannot import the server's domain module). */
export const STORY_DECK_FOREIGN_GOALS_CODE = "story_deck_foreign_goals";

/** The play route's typed 409: the branch's goal tracker holds goals not
 * from a plan, and playing would replace them. The dialog shows the
 * replace-goals confirm and retries with `{ replaceForeignGoals: true }`. */
export class StoryDeckForeignGoalsError extends Error {
	constructor(message: string, readonly foreignGoalCount: number) {
		super(message);
		this.name = "StoryDeckForeignGoalsError";
	}
}

/** Read-once 409 handling for the play route: the typed foreign-goals
 * outcome (the body is consumed HERE), everything else falls through to the
 * shared error mapping over the SAME already-read body — the
 * `errorFromBody` seam exists for exactly this split. */
async function unwrapDeckPlayRpc<R extends RpcResponse>(response: R): Promise<RpcBody<R>> {
	if (!response.ok && response.status === 409) {
		const body = await response.json().catch(() => null) as RpcErrorBody | null;
		const error = typeof body?.error === "object" && body.error !== null ? body.error : undefined;
		const details = error?.details as { code?: unknown; foreignGoalCount?: unknown } | undefined;
		if (details?.code === STORY_DECK_FOREIGN_GOALS_CODE && typeof details?.foreignGoalCount === "number") {
			throw new StoryDeckForeignGoalsError(
				error?.message ?? "Playing this card would replace the goal tracker's goals.",
				details.foreignGoalCount,
			);
		}
		throw errorFromBody(body, response.status);
	}
	return unwrapRpc(response);
}

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
	return unwrapDeckPlayRpc(response);
}

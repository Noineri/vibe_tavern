import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { storyDeckSchema } from "@vibe-tavern/api-contracts";
import type { StoryDeckRuntimeApi } from "../contract/story-deck-contracts.js";

/**
 * Chat-branch-owned story deck routes (DIRECTOR_DECK_CALENDAR_PLAN DK-3) —
 * the deck twin of the agent-branch-plan routes:
 *
 *  - `GET /api/agent/chats/:chatId/branches/:branchId/deck` — `{ deck }` (the
 *    empty deck when the branch has none stored yet — the plan route's
 *    no-plan-yet convention).
 *  - `PUT /api/agent/chats/:chatId/branches/:branchId/deck` — body `{ deck }`,
 *    full-replace write validated by the strict `storyDeckSchema` (a bad
 *    shape is a wire 400 — unlike the plan route there is no model-tool-shared
 *    normalize-or-422 path, so the plan route's deliberately loose envelope is
 *    NOT mirrored here), returns `{ deck }` as saved. An unknown chat, an
 *    unknown branch, or a branch belonging to a different chat is a 404 (the
 *    adapter throws the `NotFound` DomainError the app-level handler maps —
 *    the same requireChatBranch pair check the plan route applies).
 */
export function createAgentBranchDeckRoutes(runtime: StoryDeckRuntimeApi) {
	return new Hono()
		.get("/api/agent/chats/:chatId/branches/:branchId/deck", async (c) => {
			const { chatId, branchId } = c.req.param();
			return c.json({ deck: await runtime.getStoryBranchDeck(chatId, branchId) });
		})
		.put(
			"/api/agent/chats/:chatId/branches/:branchId/deck",
			zValidator("json", z.object({ deck: storyDeckSchema })),
			async (c) => {
				const { chatId, branchId } = c.req.param();
				return c.json({
					deck: await runtime.updateStoryBranchDeck(chatId, branchId, c.req.valid("json").deck),
				});
			},
		);
}

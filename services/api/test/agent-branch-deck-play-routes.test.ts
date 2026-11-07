import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { hc } from "hono/client";
import { brandId, OBJECTIVE_MODE, type ChatId } from "@vibe-tavern/domain";
import { createStoreContainer, type StoreContainer, type Chat } from "@vibe-tavern/db";
import type { AppType } from "../src/api/routes/index.js";
import { createAgentBranchDeckRoutes } from "../src/api/routes/agent-branch-deck.js";
import { StoryDeckAdapter } from "../src/api/adapters/story-deck-adapter.js";
import { ObjectiveService } from "../src/domain/insights/objective-service.js";
import { StoryPlanSync } from "../src/domain/director/story-plan-sync.js";
import { unusedObjectiveDeps } from "./objective-service-fixture.js";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * The deck play route (DIRECTOR_DECK_CALENDAR_PLAN DK-4a):
 * `POST /api/agent/chats/:chatId/branches/:branchId/deck/:cardId/play` —
 * the same harness as agent-branch-deck-routes.test.ts (the real store
 * container + adapter + production DomainError mapping), with the REAL
 * StoryPlanSync wired into the adapter (production's shape). Pins: a play
 * round-trip removes the card from the deck and returns `{ deck, event }`;
 * the plan lands (the store round-trip); unknown chat / unknown branch /
 * foreign branch are 404s; an unknown card is a 404 with the deck untouched;
 * a bad body is a wire 400 (the strict storyDeckPlaySchema); the
 * foreign-goals 409 surfaces typed exactly like the plan routes' 409s
 * (`error.kind = "Conflict"`, `error.details.code`); and the web typed
 * client's play chain resolves through the mounted `AppType`.
 */

let stores: StoreContainer;
let objectiveService: ObjectiveService;
let app: Hono;
let chat: Chat;
let otherChat: Chat;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-deck-play-routes-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const character = await stores.characters.create({ name: "Deck play routes fixture" });
	chat = await stores.chats.createChat({
		characterId: character.id,
		title: "Deck play chat",
		promptPresetId: null,
	});
	otherChat = await stores.chats.createChat({
		characterId: character.id,
		title: "Other chat",
		promptPresetId: null,
	});
	objectiveService = new ObjectiveService(stores, unusedObjectiveDeps, unusedObjectiveDeps);
	const storyPlanSync = new StoryPlanSync(stores, objectiveService);
	// Mirror the production wiring (server-runtime.ts): every committed state
	// triggers the follow-back.
	objectiveService.registerStateObserver((chatId, nextState) =>
		storyPlanSync.onObjectiveStateCommitted(chatId, nextState),
	);
	const adapter = new StoryDeckAdapter(stores, storyPlanSync);
	app = new Hono().route("/", createAgentBranchDeckRoutes(adapter));
	app.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
});

const jsonHeaders = { "content-type": "application/json" };

const playUrl = (chatId: string, branchId: string, cardId: string) =>
	`/api/agent/chats/${chatId}/branches/${branchId}/deck/${cardId}/play`;
const deckUrl = (chatId: string, branchId: string) =>
	`/api/agent/chats/${chatId}/branches/${branchId}/deck`;

async function putDeck(chatId: string, branchId: string, deck: unknown) {
	return app.request(deckUrl(chatId, branchId), {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify({ deck }),
	});
}

async function postPlay(chatId: string, branchId: string, cardId: string, body: unknown) {
	return app.request(playUrl(chatId, branchId, cardId), {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(body),
	});
}

const FULL_DECK = {
	cards: [
		{ id: "card_1", suit: "threat", title: "The door won't hold", body: "Something pushes back." },
		{ id: "card_2", suit: "mystery", title: "The sealed letter", body: "Who wrote it?" },
	],
};

interface WireEvent {
	id: string;
	title: string;
	body: string;
	status: string;
}

describe("POST deck/:cardId/play — round trip", () => {
	test("playing removes the card from the deck and returns { deck, event }; the plan lands", async () => {
		await putDeck(chat.id, chat.activeBranchId, FULL_DECK);

		const res = await postPlay(chat.id, chat.activeBranchId, "card_1", {});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			deck: { cards: Array<{ id: string }> };
			event: WireEvent;
		};
		expect(body.deck.cards.map((c) => c.id)).toEqual(["card_2"]); // the deck after the removal
		expect(body.event.title).toBe("The door won't hold");
		expect(body.event.body).toBe("Something pushes back.");
		expect(body.event.status).toBe("active"); // promoted to the current event

		// GET serves the deck after the removal.
		const fetched = await app.request(deckUrl(chat.id, chat.activeBranchId));
		expect(((await fetched.json()) as { deck: { cards: Array<{ id: string }> } }).deck).toEqual(body.deck);

		// The plan landed through the ordinary machinery (the store round-trip).
		const plan = await stores.agentPlans.get({
			kind: "chatBranch",
			chatId: chat.id,
			branchId: chat.activeBranchId,
		});
		expect(plan).not.toBeNull();
		expect(plan?.tasks.map((t) => t.id)).toEqual([body.event.id]);
		expect(plan?.tasks[0]?.status).toBe("active");
	});

	test("an unknown chat → 404", async () => {
		const res = await postPlay("chat_does_not_exist", chat.activeBranchId, "card_1", {});
		expect(res.status).toBe(404);
	});

	test("an unknown branch → 404", async () => {
		const res = await postPlay(chat.id, "brnch_does_not_exist", "card_1", {});
		expect(res.status).toBe(404);
	});

	test("a branch belonging to a DIFFERENT chat → 404 (never a cross-owner leak)", async () => {
		const res = await postPlay(otherChat.id, chat.activeBranchId, "card_1", {});
		expect(res.status).toBe(404);
	});

	test("an unknown cardId → 404 and the deck is untouched", async () => {
		await putDeck(chat.id, chat.activeBranchId, FULL_DECK);
		const res = await postPlay(chat.id, chat.activeBranchId, "card_missing", {});
		expect(res.status).toBe(404);
		const fetched = await app.request(deckUrl(chat.id, chat.activeBranchId));
		expect(((await fetched.json()) as { deck: unknown }).deck).toEqual(FULL_DECK);
	});

	test("a bad body → wire 400 (strict storyDeckPlaySchema)", async () => {
		expect((await postPlay(chat.id, chat.activeBranchId, "card_1", { replaceForeignGoals: "yes" })).status).toBe(400);
		expect((await postPlay(chat.id, chat.activeBranchId, "card_1", { unexpected: true })).status).toBe(400);
	});
});

describe("POST deck/:cardId/play — the foreign-goals 409 surfaces typed like the plan routes' 409s", () => {
	test("a plan-less branch with foreign tracker goals → 409 Conflict + details.code; the override plays", async () => {
		await objectiveService.setObjectiveMode(brandId<ChatId>(otherChat.id), OBJECTIVE_MODE.goals);
		await objectiveService.addShortTermGoal(brandId<ChatId>(otherChat.id), "Foreign goal");
		await putDeck(otherChat.id, otherChat.activeBranchId, FULL_DECK);

		const refused = await postPlay(otherChat.id, otherChat.activeBranchId, "card_1", {});
		expect(refused.status).toBe(409);
		const refusedBody = (await refused.json()) as {
			error: { kind: string; details?: { code?: string } };
		};
		expect(refusedBody.error.kind).toBe("Conflict");
		expect(refusedBody.error.details?.code).toBe("story_deck_foreign_goals");

		// The refusal wrote nothing: the deck keeps both cards.
		const untouched = await app.request(deckUrl(otherChat.id, otherChat.activeBranchId));
		expect(((await untouched.json()) as { deck: unknown }).deck).toEqual(FULL_DECK);

		// The override plays through the same route.
		const played = await postPlay(otherChat.id, otherChat.activeBranchId, "card_1", {
			replaceForeignGoals: true,
		});
		expect(played.status).toBe(200);
		const playedBody = (await played.json()) as { deck: { cards: Array<{ id: string }> } };
		expect(playedBody.deck.cards.map((c) => c.id)).toEqual(["card_2"]);
	});
});

describe("typed client", () => {
	test("the web client's play chain resolves through AppType inference", () => {
		// The `AppType` import is type-only (erased at runtime): this pins at
		// compile time that the mounted router serves the play path shape.
		const typed = hc<AppType>("http://localhost");
		const play = typed.api.agent.chats[":chatId"].branches[":branchId"].deck[":cardId"].play;
		expect(typeof play.$post).toBe("function");
	});
});

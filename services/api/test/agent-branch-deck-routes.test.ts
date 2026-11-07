import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { hc } from "hono/client";
import { createStoreContainer, storyBranchDecks, type StoreContainer, type Chat } from "@vibe-tavern/db";
import type { AppType } from "../src/api/routes/index.js";
import { createAgentBranchDeckRoutes } from "../src/api/routes/agent-branch-deck.js";
import { StoryDeckAdapter } from "../src/api/adapters/story-deck-adapter.js";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * Chat-branch story deck HTTP routes (DIRECTOR_DECK_CALENDAR_PLAN DK-3) — the
 * deck twin of agent-branch-plan-routes.test.ts: the real store container +
 * adapter (the DB round-trip runs end-to-end, no mocked store) with the
 * production DomainError mapping the app mounts. Pins: PUT→GET round trip
 * returns the deck as saved; GET without a stored deck returns the EMPTY deck
 * (the plan route's no-plan-yet convention — not a 404); an EMPTY deck PUT
 * keeps the row and GET reads the empty deck back; a bad deck shape is a wire
 * 400 (the strict storyDeckSchema — the plan route's loose
 * normalize-or-422 envelope is deliberately NOT mirrored); an unknown chat,
 * an unknown branch, and a branch belonging to a DIFFERENT chat are 404s on
 * both routes and a rejected write never lands on the branch's real owner.
 * A final type-level test pins that the web typed client's exact chains
 * resolve through the mounted `AppType` inference.
 */

let stores: StoreContainer;
let app: Hono;
let chat: Chat;
let otherChat: Chat;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-branch-deck-routes-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const character = await stores.characters.create({ name: "Branch deck routes fixture" });
	chat = await stores.chats.createChat({
		characterId: character.id,
		title: "Branch deck chat",
		promptPresetId: null,
	});
	otherChat = await stores.chats.createChat({
		characterId: character.id,
		title: "Other chat",
		promptPresetId: null,
	});
	const adapter = new StoryDeckAdapter(stores);
	app = new Hono().route("/", createAgentBranchDeckRoutes(adapter));
	app.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
});

const jsonHeaders = { "content-type": "application/json" };

interface WireDeck {
	cards: Array<{ id: string; suit: string; title: string; body: string }>;
}

function deckUrl(chatId: string, branchId: string): string {
	return `/api/agent/chats/${chatId}/branches/${branchId}/deck`;
}

async function putDeck(chatId: string, branchId: string, deck: unknown) {
	return app.request(deckUrl(chatId, branchId), {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify({ deck }),
	});
}

const FULL_DECK = {
	cards: [
		{ id: "card_1", suit: "threat", title: "The door won't hold", body: "Something pushes back." },
		{ id: "card_2", suit: "mystery", title: "The sealed letter", body: "Who wrote it?" },
	],
};

describe("PUT /api/agent/chats/:chatId/branches/:branchId/deck → GET round trip", () => {
	test("PUT then GET returns the deck as saved", async () => {
		const res = await putDeck(chat.id, chat.activeBranchId, FULL_DECK);
		expect(res.status).toBe(200);
		const saved = ((await res.json()) as { deck: WireDeck }).deck;
		expect(saved).toEqual(FULL_DECK);

		const fetched = await app.request(deckUrl(chat.id, chat.activeBranchId));
		expect(fetched.status).toBe(200);
		expect(((await fetched.json()) as { deck: WireDeck }).deck).toEqual(saved);
	});

	test("GET without a stored deck → the empty deck (the plan route convention)", async () => {
		const res = await app.request(deckUrl(otherChat.id, otherChat.activeBranchId));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { deck: WireDeck }).deck).toEqual({ cards: [] });
	});

	test("an EMPTY deck PUT keeps the row; GET reads the empty deck back", async () => {
		const putRes = await putDeck(otherChat.id, otherChat.activeBranchId, { cards: [] });
		expect(putRes.status).toBe(200);
		expect(((await putRes.json()) as { deck: WireDeck }).deck).toEqual({ cards: [] });

		const fetched = await app.request(deckUrl(otherChat.id, otherChat.activeBranchId));
		expect(((await fetched.json()) as { deck: WireDeck }).deck).toEqual({ cards: [] });

		// The named representation: the row is KEPT (no special empty case —
		// the plan store's convention), so the store really holds it.
		const rows = await stores.db.select().from(storyBranchDecks).all();
		expect(rows.some((row) => row.branchId === otherChat.activeBranchId)).toBe(true);
	});
});

describe("PUT validation (strict storyDeckSchema at the wire)", () => {
	test("an unknown suit → 400", async () => {
		const res = await putDeck(chat.id, chat.activeBranchId, {
			cards: [{ id: "card_1", suit: "plot_twist", title: "T", body: "" }],
		});
		expect(res.status).toBe(400);
	});

	test("a card missing its title → 400", async () => {
		const res = await putDeck(chat.id, chat.activeBranchId, {
			cards: [{ id: "card_1", suit: "threat", body: "" }],
		});
		expect(res.status).toBe(400);
	});

	test("a deck that is not an object → 400", async () => {
		const res = await putDeck(chat.id, chat.activeBranchId, "garbage");
		expect(res.status).toBe(400);
	});

	test("an extra key on a card → 400 (strict schema, no extra keys)", async () => {
		const res = await putDeck(chat.id, chat.activeBranchId, {
			cards: [{ ...FULL_DECK.cards[0], bonus: true }],
		});
		expect(res.status).toBe(400);
	});

	test("a rejected write never lands — GET still serves the previous deck", async () => {
		const getRes = await app.request(deckUrl(chat.id, chat.activeBranchId));
		expect(((await getRes.json()) as { deck: WireDeck }).deck).toEqual(FULL_DECK);
	});
});

describe("unknown or foreign owners are 404s on both routes", () => {
	test("GET/PUT for an unknown chat → 404", async () => {
		const getRes = await app.request(deckUrl("chat_does_not_exist", chat.activeBranchId));
		expect(getRes.status).toBe(404);

		const putRes = await putDeck("chat_does_not_exist", chat.activeBranchId, { cards: [] });
		expect(putRes.status).toBe(404);
	});

	test("GET/PUT for an unknown branch → 404", async () => {
		const getRes = await app.request(deckUrl(chat.id, "brnch_does_not_exist"));
		expect(getRes.status).toBe(404);

		const putRes = await putDeck(chat.id, "brnch_does_not_exist", { cards: [] });
		expect(putRes.status).toBe(404);
	});

	test("a branch belonging to a DIFFERENT chat → 404 (never a cross-owner leak)", async () => {
		// chat's branch id under otherChat's path: exists, but not there.
		const getRes = await app.request(deckUrl(otherChat.id, chat.activeBranchId));
		expect(getRes.status).toBe(404);

		const putRes = await putDeck(otherChat.id, chat.activeBranchId, {
			cards: [{ id: "card_x", suit: "change", title: "Should not land", body: "" }],
		});
		expect(putRes.status).toBe(404);
		// And the rejected write never landed on the branch's real owner.
		const untouched = ((await (
			await app.request(deckUrl(chat.id, chat.activeBranchId))
		).json()) as { deck: WireDeck }).deck;
		expect(untouched).toEqual(FULL_DECK);
	});
});

describe("typed client", () => {
	test("the web client's exact chains resolve through AppType inference", () => {
		// The `AppType` import is type-only (erased at runtime): this pins at
		// compile time that the mounted router actually serves the branch-deck
		// path shape (DK-5's web client will drive it).
		const typed = hc<AppType>("http://localhost");
		const branch = typed.api.agent.chats[":chatId"].branches[":branchId"].deck;
		expect(typeof branch.$get).toBe("function");
		expect(typeof branch.$put).toBe("function");
	});
});

/**
 * DK-6 — branch-deck client: GET/PUT `/api/agent/chats/:chatId/branches/:branchId/deck`
 * and POST `.../deck/:cardId/play`.
 *
 * Pins the URLs, methods and bodies against the DK-3/DK-4a routes (the deck
 * twin of the branch-plan client). Harness: the agent-branch-plan-api.test.ts
 * mockFetch pattern (fetch restored after each).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let branchDeckApi: typeof import("./agent-branch-deck-api.js");

beforeAll(async () => {
	branchDeckApi = await import("./agent-branch-deck-api.js");
});

const originalFetch = globalThis.fetch;

type FetchImplementation = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let capturedUrl = "";
let capturedInit: RequestInit | undefined;

function respondWith(status: number, body: unknown): void {
	capturedUrl = "";
	capturedInit = undefined;
	globalThis.fetch = Object.assign(
		mock<FetchImplementation>(async (input, init) => {
			capturedUrl = input.toString();
			capturedInit = init;
			return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		}),
		{ preconnect: originalFetch.preconnect },
	);
}

function deckWire(): Record<string, unknown> {
	return {
		deck: {
			cards: [{ id: "card_1", suit: "threat", title: "Vet visit", body: "The neighbor rings." }],
		},
	};
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	jest.restoreAllMocks();
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

describe("agent-branch-deck-api — branch-owned deck (DK-6)", () => {
	it("getAgentBranchDeck GETs the branch deck route and returns the deck", async () => {
		respondWith(200, deckWire());
		const deck = await branchDeckApi.getAgentBranchDeck("chat-1", "branch-1");
		expect(capturedUrl).toContain("/api/agent/chats/chat-1/branches/branch-1/deck");
		expect(capturedInit?.method ?? "GET").toBe("GET");
		expect(deck.cards[0]!.id).toBe("card_1");
	});

	it("updateAgentBranchDeck PUTs the branch deck route with the { deck } envelope", async () => {
		respondWith(200, deckWire());
		const deck = await branchDeckApi.updateAgentBranchDeck("chat-1", "branch-1", {
			cards: [{ id: "card_2", suit: "mystery", title: "Purring", body: "At 3 a.m." }],
		});
		expect(capturedUrl).toContain("/api/agent/chats/chat-1/branches/branch-1/deck");
		expect(capturedUrl).not.toContain("/play");
		expect(capturedInit?.method).toBe("PUT");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			deck: { cards: [{ id: "card_2", suit: "mystery", title: "Purring", body: "At 3 a.m." }] },
		});
		expect(deck.cards[0]!.id).toBe("card_1");
	});

	it("playAgentBranchDeckCard POSTs the card's play route with the options body ({ } plain)", async () => {
		respondWith(200, {
			deck: { cards: [] },
			event: { id: "ev_new", title: "Vet visit", body: "", status: "active" },
		});
		const result = await branchDeckApi.playAgentBranchDeckCard("chat-1", "branch-1", "card_1");
		expect(capturedUrl).toContain("/api/agent/chats/chat-1/branches/branch-1/deck/card_1/play");
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({});
		expect(result.deck.cards).toEqual([]);
		expect(result.event.id).toBe("ev_new");
	});

	it("playAgentBranchDeckCard forwards the replaceForeignGoals override", async () => {
		respondWith(200, { deck: { cards: [] }, event: { id: "ev_new", title: "T", body: "", status: "active" } });
		await branchDeckApi.playAgentBranchDeckCard("chat-1", "branch-1", "card_1", { replaceForeignGoals: true });
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ replaceForeignGoals: true });
	});

	it("a 409 story_deck_foreign_goals body becomes the typed StoryDeckForeignGoalsError (DK-7)", async () => {
		respondWith(409, {
			error: {
				kind: "Conflict",
				message: "The branch has no plan, and the goal tracker holds goals not from a plan.",
				details: { code: "story_deck_foreign_goals", foreignGoalCount: 2 },
			},
		});
		let caught: unknown = null;
		try {
			await branchDeckApi.playAgentBranchDeckCard("chat-1", "branch-1", "card_1");
		} catch (error) {
			caught = error;
		}
		expect(caught instanceof branchDeckApi.StoryDeckForeignGoalsError).toBe(true);
		const typed = caught as InstanceType<typeof branchDeckApi.StoryDeckForeignGoalsError>;
		expect(typed.foreignGoalCount).toBe(2);
		expect(typed.message).toContain("goal tracker");
	});

	it("a 409 with a different typed code stays a plain error (not the foreign-goals type)", async () => {
		respondWith(409, { error: { kind: "Conflict", message: "Other conflict", details: { code: "something_else" } } });
		let caught: unknown = null;
		try {
			await branchDeckApi.playAgentBranchDeckCard("chat-1", "branch-1", "card_1");
		} catch (error) {
			caught = error;
		}
		expect(caught instanceof branchDeckApi.StoryDeckForeignGoalsError).toBe(false);
		expect((caught as Error).message).toBe("Other conflict");
	});
});

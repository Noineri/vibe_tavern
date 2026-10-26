/**
 * Co-Author module API client tests (ML-5): pins that
 * `reorderCoauthorModules` mirrors `reorderProxies` — PATCH on the typed
 * reorder endpoint with the full `{ updates: [{ id, sortOrder }] }` payload —
 * and unwraps the `{ modules }` envelope the route shares with
 * `listCoauthorModules`. Harness: the stt-api.test.ts mockFetch pattern
 * (fetch restored after each).
 */

import { afterEach, beforeAll, describe, expect, it, jest, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let chatApi: typeof import("./coauthor-module-api.js");

beforeAll(async () => {
	chatApi = await import("./coauthor-module-api.js");
});

const originalFetch = globalThis.fetch;

type FetchImplementation = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function mockFetch(implementation: FetchImplementation): typeof fetch {
	return Object.assign(mock<FetchImplementation>(implementation), {
		preconnect: originalFetch.preconnect,
	});
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	jest.restoreAllMocks();
});

describe("reorderCoauthorModules client (ML-5)", () => {
	const MODULE_B = {
		id: "m2",
		name: "B",
		description: "",
		basePrompt: "You are B.",
		openingMessage: "",
		skillIds: [],
		toolSet: {},
		maxSteps: 5,
		isBuiltIn: false,
	};
	const MODULE_A = { ...MODULE_B, id: "m1", name: "A", basePrompt: "You are A." };

	it("patches the typed reorder endpoint with the full sort-order payload and unwraps the modules envelope", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (_input, init) => {
			capturedInit = init;
			return new Response(
				JSON.stringify({ modules: [MODULE_B, MODULE_A] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const modules = await chatApi.reorderCoauthorModules([
			{ id: "m2", sortOrder: 0 },
			{ id: "m1", sortOrder: 1 },
		]);

		expect(capturedInit?.method).toBe("PATCH");
		expect(capturedInit?.body).toBe(JSON.stringify({ updates: [{ id: "m2", sortOrder: 0 }, { id: "m1", sortOrder: 1 }] }));
		expect(modules).toEqual([MODULE_B, MODULE_A]);
	});

	it("builds the /api/coauthor/modules/reorder URL (not swallowed by the :moduleId PATCH)", async () => {
		let capturedUrl = "";
		globalThis.fetch = mockFetch(async (input) => {
			capturedUrl = String(input);
			return new Response(JSON.stringify({ modules: [] }), { status: 200 });
		});

		await chatApi.reorderCoauthorModules([{ id: "m1", sortOrder: 0 }]);

		expect(capturedUrl.endsWith("/api/coauthor/modules/reorder")).toBe(true);
	});
});

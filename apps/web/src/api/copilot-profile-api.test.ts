/**
 * Copilot profile API client tests (ML-6): pins that
 * `reorderCopilotProfiles` mirrors `reorderCoauthorModules` — PATCH on the
 * typed reorder endpoint with the full `{ updates: [{ id, sortOrder }] }`
 * payload, the kind riding the query param like `listCopilotProfiles` — and
 * unwraps the `{ profiles }` envelope the route shares with the GET. Harness:
 * the stt-api.test.ts mockFetch pattern (fetch restored after each).
 */

import { afterEach, beforeAll, describe, expect, it, jest, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let profileApi: typeof import("./copilot-profile-api.js");

beforeAll(async () => {
	profileApi = await import("./copilot-profile-api.js");
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

describe("reorderCopilotProfiles client (ML-6)", () => {
	const PROFILE_B = {
		id: "p2",
		name: "B",
		isBuiltIn: false,
		basePrompt: "You are B.",
		toolSet: {},
		agentKind: "script",
	};
	const PROFILE_A = { ...PROFILE_B, id: "p1", name: "A", basePrompt: "You are A." };

	it("patches the typed reorder endpoint with the kind query and the full sort-order payload, unwrapping the profiles envelope", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (_input, init) => {
			capturedInit = init;
			return new Response(
				JSON.stringify({ profiles: [PROFILE_B, PROFILE_A] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const profiles = await profileApi.reorderCopilotProfiles("script", [
			{ id: "p2", sortOrder: 0 },
			{ id: "p1", sortOrder: 1 },
		]);

		expect(capturedInit?.method).toBe("PATCH");
		expect(capturedInit?.body).toBe(JSON.stringify({ updates: [{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }] }));
		expect(profiles).toEqual([PROFILE_B, PROFILE_A]);
	});

	it("builds the /api/copilot/profiles/reorder URL with the kind query (not swallowed by the :profileId PATCH)", async () => {
		let capturedUrl = "";
		globalThis.fetch = mockFetch(async (input) => {
			capturedUrl = String(input);
			return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
		});

		await profileApi.reorderCopilotProfiles("experience", [{ id: "p1", sortOrder: 0 }]);

		expect(capturedUrl.endsWith("/api/copilot/profiles/reorder?kind=experience")).toBe(true);
	});
});

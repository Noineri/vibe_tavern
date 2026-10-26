/**
 * Copilot skill API client tests (ML-7): pins that `reorderCopilotSkills`
 * mirrors `reorderCopilotProfiles` — PATCH on the typed reorder endpoint with
 * the full `{ updates: [{ id, sortOrder }] }` payload, the kind riding the
 * query param like `listCopilotSkills` (the reorder route's query validator
 * lets the typed hono client send `query` on a PATCH) — and unwraps the
 * catalog envelope (`{ entries, errors }`) the route shares with the GET.
 * Harness: the stt-api.test.ts / copilot-profile-api.test.ts mockFetch
 * pattern (fetch restored after each).
 */

import { afterEach, beforeAll, describe, expect, it, jest, mock } from "bun:test";
import type { SkillCatalog } from "@vibe-tavern/api-contracts";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let copilotSkillApi: typeof import("./copilot-skill-api.js");

beforeAll(async () => {
	copilotSkillApi = await import("./copilot-skill-api.js");
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

describe("reorderCopilotSkills client (ML-7)", () => {
	const CATALOG: SkillCatalog = {
		entries: [
			{ id: "beta", source: "user", name: "Beta", description: "", manifestPath: "beta/SKILL.md", shadowsBuiltin: false },
			{ id: "alpha", source: "builtin", name: "Alpha", description: "", manifestPath: "alpha/SKILL.md", shadowsBuiltin: false },
		],
		errors: [],
	};

	it("patches the typed reorder endpoint with the kind query and the full sort-order payload, unwrapping the catalog envelope", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (_input, init) => {
			capturedInit = init;
			return new Response(JSON.stringify(CATALOG), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const catalog = await copilotSkillApi.reorderCopilotSkills("script", [
			{ id: "beta", sortOrder: 0 },
			{ id: "alpha", sortOrder: 1 },
		]);

		expect(capturedInit?.method).toBe("PATCH");
		expect(capturedInit?.body).toBe(JSON.stringify({ updates: [{ id: "beta", sortOrder: 0 }, { id: "alpha", sortOrder: 1 }] }));
		expect(catalog).toEqual(CATALOG);
	});

	it("builds the /api/copilot/skills/reorder URL with the kind query (not swallowed by the :id routes)", async () => {
		let capturedUrl = "";
		globalThis.fetch = mockFetch(async (input) => {
			capturedUrl = String(input);
			return new Response(JSON.stringify({ entries: [], errors: [] }), { status: 200 });
		});

		await copilotSkillApi.reorderCopilotSkills("experience", [{ id: "alpha", sortOrder: 0 }]);

		expect(capturedUrl.endsWith("/api/copilot/skills/reorder?kind=experience")).toBe(true);
	});
});

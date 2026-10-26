/**
 * SC-0i — branch-plan client: GET/PUT `/api/agent/chats/:chatId/branches/:branchId/plan`.
 *
 * Pins the URL, method and PUT body against the SC-0h routes (the branch twin
 * of the script plan endpoints). Harness: the chat-api-send-error.test.ts
 * mockFetch pattern (fetch restored after each).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let branchPlanApi: typeof import("./agent-branch-plan-api.js");

beforeAll(async () => {
	branchPlanApi = await import("./agent-branch-plan-api.js");
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

function planWire(): Record<string, unknown> {
	return {
		plan: {
			goal: "Branch the story",
			constraints: [],
			tasks: [{ id: "task_1", title: "Outline", body: "", status: "active" }],
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

describe("agent-branch-plan-api — branch-owned plan (SC-0i)", () => {
	it("getAgentBranchPlan GETs the branch plan route and returns the plan", async () => {
		respondWith(200, planWire());
		const plan = await branchPlanApi.getAgentBranchPlan("chat-1", "branch-1");
		expect(capturedUrl).toContain("/api/agent/chats/chat-1/branches/branch-1/plan");
		expect(capturedInit?.method ?? "GET").toBe("GET");
		expect(plan.goal).toBe("Branch the story");
	});

	it("updateAgentBranchPlan PUTs the branch plan route with the { plan } envelope", async () => {
		respondWith(200, planWire());
		const plan = await branchPlanApi.updateAgentBranchPlan("chat-1", "branch-1", {
			goal: "Branch the story",
			constraints: [],
			tasks: [],
		});
		expect(capturedUrl).toContain("/api/agent/chats/chat-1/branches/branch-1/plan");
		expect(capturedInit?.method).toBe("PUT");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ plan: { goal: "Branch the story", constraints: [], tasks: [] } });
		expect(plan.goal).toBe("Branch the story");
	});

	it("a branch write never touches the script plan route", async () => {
		respondWith(200, planWire());
		await branchPlanApi.updateAgentBranchPlan("chat-9", "branch-9", {
			goal: "Other branch",
			constraints: [],
			tasks: [],
		});
		expect(capturedUrl).not.toContain("/api/scripts/");
		expect(capturedUrl).toContain("/api/agent/chats/chat-9/branches/branch-9/plan");
	});
});

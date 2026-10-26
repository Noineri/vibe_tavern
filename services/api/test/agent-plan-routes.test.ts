import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hc } from "hono/client";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import type { AppType } from "../src/api/routes/index.js";
import { createAgentPlanRoutes } from "../src/api/routes/agent-plan.js";
import { AgentPlanAdapter } from "../src/api/adapters/agent-plan-adapter.js";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * Agent plan HTTP routes (EXPERIENCE_COPILOT_PLAN_MODE_PLAN, PM-4).
 *
 * Mirrors the small-resource route test pattern
 * (ai-instruction-template-routes.test.ts): the real store container +
 * adapter, so the DB round-trip runs end-to-end (no mocked store), with the
 * same production DomainError mapping the app mounts. Pins: PUT→GET round
 * trip returns the normalized plan; two active tasks 422 with
 * `agent_plan_multiple_active`; garbage 422s with `agent_plan_invalid`;
 * unknown scripts 404 on both routes; GET without a stored plan returns the
 * empty plan. A final type-level test pins that the web typed client's exact
 * chains resolve through the mounted `AppType` inference.
 */

let stores: StoreContainer;
let app: ReturnType<typeof createAgentPlanRoutes>;
let scriptId: string;
let emptyScriptId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-plan-routes-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const script = await stores.scripts.create({
		name: "Plan script",
		code: "",
		scriptKind: "interactive",
		scopeType: "global",
	});
	scriptId = script.id;
	const empty = await stores.scripts.create({
		name: "Planless script",
		code: "",
		scriptKind: "interactive",
		scopeType: "global",
	});
	emptyScriptId = empty.id;
	app = createAgentPlanRoutes(new AgentPlanAdapter(stores));
	app.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
});

const jsonHeaders = { "content-type": "application/json" };

interface WirePlan {
	goal: string;
	constraints: string[];
	tasks: Array<{ id: string; title: string; body: string; status: string }>;
}

async function putPlan(id: string, plan: unknown) {
	return app.request(`/api/scripts/${id}/agent-plan`, {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify({ plan }),
	});
}

describe("PUT /api/scripts/:scriptId/agent-plan → GET round trip", () => {
	test("PUT then GET returns the normalized plan", async () => {
		const res = await putPlan(scriptId, {
			goal: "Ship the demo",
			constraints: ["Keep it small"],
			tasks: [
				{ id: "t1", title: "Write code", body: "Do it.", status: "active" },
				// No status: normalize defaults it to pending (the shared
				// validation path — the model's `plan` tool behaves the same).
				{ id: "t2", title: "Write docs", body: "" },
			],
		});
		expect(res.status).toBe(200);
		const saved = ((await res.json()) as { plan: WirePlan }).plan;
		expect(saved.goal).toBe("Ship the demo");
		expect(saved.tasks.map((t) => t.status)).toEqual(["active", "pending"]);

		const fetched = await app.request(`/api/scripts/${scriptId}/agent-plan`);
		expect(fetched.status).toBe(200);
		expect(((await fetched.json()) as { plan: WirePlan }).plan).toEqual(saved);
	});
});

describe("PUT /api/scripts/:scriptId/agent-plan validation", () => {
	test("two active tasks → 422 agent_plan_multiple_active", async () => {
		const res = await putPlan(scriptId, {
			goal: "Ambiguous",
			constraints: [],
			tasks: [
				{ id: "a", title: "First", body: "", status: "active" },
				{ id: "b", title: "Second", body: "", status: "active" },
			],
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error: { kind: string; details?: { code?: string } } };
		expect(body.error.details?.code).toBe("agent_plan_multiple_active");
	});

	test("garbage shape → 422 agent_plan_invalid", async () => {
		const res = await putPlan(scriptId, "garbage");
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error: { kind: string; details?: { code?: string } } };
		expect(body.error.details?.code).toBe("agent_plan_invalid");
	});
});

describe("unknown scripts and missing plans", () => {
	test("GET for an unknown script → 404", async () => {
		const res = await app.request("/api/scripts/does-not-exist/agent-plan");
		expect(res.status).toBe(404);
	});

	test("PUT for an unknown script → 404", async () => {
		const res = await putPlan("does-not-exist", { goal: "", constraints: [], tasks: [] });
		expect(res.status).toBe(404);
	});

	test("GET without a stored plan → the empty plan", async () => {
		const res = await app.request(`/api/scripts/${emptyScriptId}/agent-plan`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { plan: WirePlan }).plan).toEqual({
			goal: "",
			constraints: [],
			tasks: [],
		});
	});
});

describe("typed client", () => {
	test("the web client's exact chains resolve through AppType inference", () => {
		// The `AppType` import is type-only (erased at runtime): this pins at
		// compile time that `apps/web/src/api/agent-plan-api.ts` drives paths
		// the mounted router actually serves.
		const typed = hc<AppType>("http://localhost");
		expect(typeof typed.api.scripts[":scriptId"]["agent-plan"].$get).toBe("function");
		expect(typeof typed.api.scripts[":scriptId"]["agent-plan"].$put).toBe("function");
	});
});

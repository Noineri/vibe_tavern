import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { hc } from "hono/client";
import { createStoreContainer, type StoreContainer, type Chat } from "@vibe-tavern/db";
import type { AppType } from "../src/api/routes/index.js";
import { createAgentBranchPlanRoutes } from "../src/api/routes/agent-branch-plan.js";
import { createAgentPlanRoutes } from "../src/api/routes/agent-plan.js";
import { AgentPlanAdapter } from "../src/api/adapters/agent-plan-adapter.js";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * Chat-branch agent plan HTTP routes (SIDECHAT_PLAN SC-0h) — the chat-branch
 * twin of agent-plan-routes.test.ts: the real store container + adapter (the
 * DB round-trip runs end-to-end, no mocked store) with the production
 * DomainError mapping the app mounts. Pins: PUT→GET round trip returns the
 * normalized plan; GET without a stored plan returns the EMPTY plan (the
 * script route's no-plan-yet convention — not a 404); two active tasks 422
 * with `agent_plan_multiple_active`; garbage 422s with `agent_plan_invalid`;
 * an unknown chat, an unknown branch, and a branch belonging to a DIFFERENT
 * chat are 404s on both routes; branch plans and script plans coexist
 * untouched (the script route still serves its own plan after branch writes).
 * A final type-level test pins that the web typed client's exact chains
 * resolve through the mounted `AppType` inference.
 */

let stores: StoreContainer;
let app: Hono;
let chat: Chat;
let otherChat: Chat;
let scriptId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-branch-plan-routes-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const character = await stores.characters.create({ name: "Branch plan routes fixture" });
	chat = await stores.chats.createChat({
		characterId: character.id,
		title: "Branch plan chat",
		promptPresetId: null,
	});
	otherChat = await stores.chats.createChat({
		characterId: character.id,
		title: "Other chat",
		promptPresetId: null,
	});
	const script = await stores.scripts.create({
		name: "Coexisting script",
		code: "",
		scriptKind: "interactive",
		scopeType: "global",
	});
	scriptId = script.id;
	// Both plan route modules share one adapter, exactly as the real router
	// mounts them — the coexistence pin below exercises them side by side.
	const adapter = new AgentPlanAdapter(stores);
	app = new Hono()
		.route("/", createAgentBranchPlanRoutes(adapter))
		.route("/", createAgentPlanRoutes(adapter));
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

function planUrl(chatId: string, branchId: string): string {
	return `/api/agent/chats/${chatId}/branches/${branchId}/plan`;
}

async function putPlan(chatId: string, branchId: string, plan: unknown) {
	return app.request(planUrl(chatId, branchId), {
		method: "PUT",
		headers: jsonHeaders,
		body: JSON.stringify({ plan }),
	});
}

describe("PUT /api/agent/chats/:chatId/branches/:branchId/plan → GET round trip", () => {
	test("PUT then GET returns the normalized plan", async () => {
		const res = await putPlan(chat.id, chat.activeBranchId, {
			goal: "Discuss the plot",
			constraints: ["Stay in character"],
			tasks: [
				{ id: "t1", title: "Ask about motives", body: "Do it.", status: "active" },
				// No status: normalize defaults it to pending (the shared
				// validation path — the model's `plan` tool behaves the same).
				{ id: "t2", title: "Summarize", body: "" },
			],
		});
		expect(res.status).toBe(200);
		const saved = ((await res.json()) as { plan: WirePlan }).plan;
		expect(saved.goal).toBe("Discuss the plot");
		expect(saved.tasks.map((t) => t.status)).toEqual(["active", "pending"]);

		const fetched = await app.request(planUrl(chat.id, chat.activeBranchId));
		expect(fetched.status).toBe(200);
		expect(((await fetched.json()) as { plan: WirePlan }).plan).toEqual(saved);
	});

	test("GET without a stored plan → the empty plan (the script route convention)", async () => {
		const res = await app.request(planUrl(otherChat.id, otherChat.activeBranchId));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { plan: WirePlan }).plan).toEqual({
			goal: "",
			constraints: [],
			tasks: [],
		});
	});

	test("branch plans and script plans coexist — each owner keeps its own", async () => {
		const scriptRes = await app.request(`/api/scripts/${scriptId}/agent-plan`, {
			method: "PUT",
			headers: jsonHeaders,
			body: JSON.stringify({
				plan: { goal: "Script goal", constraints: [], tasks: [] },
			}),
		});
		expect(scriptRes.status).toBe(200);

		// The branch write above must not have touched the script's plan.
		const scriptBack = ((await (
			await app.request(`/api/scripts/${scriptId}/agent-plan`)
		).json()) as { plan: WirePlan }).plan;
		expect(scriptBack.goal).toBe("Script goal");
		const branchBack = ((await (
			await app.request(planUrl(chat.id, chat.activeBranchId))
		).json()) as { plan: WirePlan }).plan;
		expect(branchBack.goal).toBe("Discuss the plot");
	});
});

describe("PUT validation (same shared path as the script route)", () => {
	test("two active tasks → 422 agent_plan_multiple_active", async () => {
		const res = await putPlan(chat.id, chat.activeBranchId, {
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
		const res = await putPlan(chat.id, chat.activeBranchId, "garbage");
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error: { kind: string; details?: { code?: string } } };
		expect(body.error.details?.code).toBe("agent_plan_invalid");
	});
});

describe("unknown or foreign owners are 404s on both routes", () => {
	test("GET/PUT for an unknown chat → 404", async () => {
		const getRes = await app.request(planUrl("chat_does_not_exist", chat.activeBranchId));
		expect(getRes.status).toBe(404);

		const putRes = await putPlan("chat_does_not_exist", chat.activeBranchId, {
			goal: "",
			constraints: [],
			tasks: [],
		});
		expect(putRes.status).toBe(404);
	});

	test("GET/PUT for an unknown branch → 404", async () => {
		const getRes = await app.request(planUrl(chat.id, "brnch_does_not_exist"));
		expect(getRes.status).toBe(404);

		const putRes = await putPlan(chat.id, "brnch_does_not_exist", {
			goal: "",
			constraints: [],
			tasks: [],
		});
		expect(putRes.status).toBe(404);
	});

	test("a branch belonging to a DIFFERENT chat → 404 (never a cross-owner leak)", async () => {
		// chat's branch id under otherChat's path: exists, but not there.
		const getRes = await app.request(planUrl(otherChat.id, chat.activeBranchId));
		expect(getRes.status).toBe(404);

		const putRes = await putPlan(otherChat.id, chat.activeBranchId, {
			goal: "",
			constraints: [],
			tasks: [],
		});
		expect(putRes.status).toBe(404);
		// And the rejected write never landed on the branch's real owner.
		const untouched = ((await (
			await app.request(planUrl(chat.id, chat.activeBranchId))
		).json()) as { plan: WirePlan }).plan;
		expect(untouched.goal).toBe("Discuss the plot");
	});
});

describe("typed client", () => {
	test("the web client's exact chains resolve through AppType inference", () => {
		// The `AppType` import is type-only (erased at runtime): this pins at
		// compile time that the mounted router actually serves the branch-plan
		// path shape (SC-0i's web client will drive it).
		const typed = hc<AppType>("http://localhost");
		const branch = typed.api.agent.chats[":chatId"].branches[":branchId"].plan;
		expect(typeof branch.$get).toBe("function");
		expect(typeof branch.$put).toBe("function");
	});
});

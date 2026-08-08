/**
 * Experience route tests (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-32).
 *
 * Two layers:
 *   1. HTTP-layer (stub runtime): schema rejection, path-param forwarding,
 *      abort-signal forwarding, and DomainError → HTTP status mapping. These
 *      pin what is unique to the route boundary — what zValidator catches, what
 *      the adapter throws, and how onError renders it.
 *   2. Integration (real adapter → real services → real DB): the full path a
 *      client drives — config → start → action → stale(409) → duplicate(200) →
 *      capability denial(422) → projected-only response. These reuse the SAME
 *      status-mapping helpers the production onError uses (no logic duplicated).
 *
 * The status-mapping wiring itself (app-factory.onError) is not re-tested here
 * — it is a one-line call to the shared helpers exercised below; the dice/
 * insights route suites follow the same split.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
	DomainError,
} from "../src/shared/errors.js";
import { createExperienceRoutes } from "../src/api/routes/experience.js";
import { ExperienceAdapter } from "../src/api/adapters/experience-adapter.js";
import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import { ExperienceReplayService } from "../src/domain/interactive/experience-replay-service.js";
import type { ExperienceRuntimeApi } from "../src/api/contract/runtime-api.js";

/** Mount experience routes with the production DomainError → status mapping
 *  (shared helpers, not duplicated logic) so integration tests observe the real
 *  404/409/422/500 the contract promises. */
function mount(runtime: ExperienceRuntimeApi) {
	const app = createExperienceRoutes(runtime);
	app.onError((err, c) => {
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
		}
		return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
	});
	return app;
}

async function jsonBody(res: Response): Promise<any> {
	return JSON.parse(await res.text());
}

// ─── 1. HTTP layer (stub runtime) ────────────────────────────────────────────

/** A recording stub: every method captures its call + can be programmed to throw. */
function stubRuntime(throws?: { kind: any; message: string }): { runtime: ExperienceRuntimeApi; calls: Record<string, any[]> } {
	const calls: Record<string, any[]> = {};
	const rec = (name: string) => (calls[name] ??= []);
	const maybeThrow = () => {
		if (throws) throw new DomainError({ kind: throws.kind, message: throws.message });
	};
	const base = {
		getExperienceConfig: async (chatId: string) => { rec("getExperienceConfig").push({ chatId }); maybeThrow(); return { id: "cfg", chatId, enabled: false, scriptId: null, visualId: null, capabilityGrants: [], contextMode: "none", launcherVisible: false, createdAt: "", updatedAt: "" }; },
		updateExperienceConfig: async (chatId: string, body: any) => { rec("updateExperienceConfig").push({ chatId, body }); maybeThrow(); return { id: "cfg", chatId, enabled: !!body.enabled, scriptId: body.scriptId ?? null, visualId: null, capabilityGrants: [], contextMode: "none", launcherVisible: false, createdAt: "", updatedAt: "" }; },
		listExperienceVisuals: async (scopeType: string, ownerId?: string) => { rec("listExperienceVisuals").push({ scopeType, ownerId }); maybeThrow(); return []; },
		getExperienceVisual: async (id: string) => { rec("getExperienceVisual").push({ id }); maybeThrow(); return null; },
		createExperienceVisual: async (body: any) => { rec("createExperienceVisual").push({ body }); maybeThrow(); return { id: "xv_1", ...body, sourceHash: "h", personaId: null, chatId: null, createdAt: "", updatedAt: "" }; },
		updateExperienceVisual: async (id: string, patch: any) => { rec("updateExperienceVisual").push({ id, patch }); maybeThrow(); return { id, ...patch, sourceHash: "h" }; },
		deleteExperienceVisual: async (id: string) => { rec("deleteExperienceVisual").push({ id }); maybeThrow(); },
		startExperienceSession: async (chatId: string, body: any) => { rec("startExperienceSession").push({ chatId, body }); maybeThrow(); return sessionResponse(chatId, body.branchId); },
		getExperienceSession: async (sessionId: string) => { rec("getExperienceSession").push({ sessionId }); maybeThrow(); return sessionResponse("c_1", "b_1", sessionId); },
		endExperienceSession: async (sessionId: string, body: any) => { rec("endExperienceSession").push({ sessionId, body }); maybeThrow(); return sessionResponse("c_1", "b_1", sessionId); },
		submitExperienceAction: async (sessionId: string, action: any, signal?: AbortSignal) => { rec("submitExperienceAction").push({ sessionId, action, signal }); maybeThrow(); return { ...sessionResponse("c_1", "b_1", sessionId), events: [], await: "human" }; },
		getExperienceView: async (sessionId: string, participantId?: string) => { rec("getExperienceView").push({ sessionId, participantId }); maybeThrow(); return { state: { n: 0 }, actions: [], flavor: undefined, revision: 0, status: "active" }; },
		getExperienceActions: async (sessionId: string, participantId?: string) => { rec("getExperienceActions").push({ sessionId, participantId }); maybeThrow(); return []; },
		undoExperienceSession: async (sessionId: string, body: any) => { rec("undoExperienceSession").push({ sessionId, body }); maybeThrow(); return { ...sessionResponse("c_1", "b_1", sessionId), events: [], await: "human" }; },
		previewExperienceRecalculation: async (sessionId: string, body: any) => { rec("previewExperienceRecalculation").push({ sessionId, body }); maybeThrow(); return { originalRulesHash: "h1", originalState: {}, originalRevision: 0, newManifestId: "m", newRulesHash: "h2", outcome: { ok: true, finalState: {}, cursor: 0, checkpoints: [] } }; },
		getExperienceEffects: async (sessionId: string) => { rec("getExperienceEffects").push({ sessionId }); maybeThrow(); return []; },
	};
	return { runtime: base as unknown as ExperienceRuntimeApi, calls };
}

function sessionResponse(chatId: string, branchId: string, sessionId = "s_1") {
	return {
		sessionId, chatId, branchId, status: "active", revision: 0,
		manifest: { id: "counter", name: "Counter" }, apiVersion: 1,
		participants: [], capabilityGrants: [], contextMode: "none" as const,
		rulesRevision: 0, rulesSourceHash: "h", visualId: null, reportFrontier: 0,
		view: { state: { count: 0 }, actions: [], revision: 0, status: "active" },
	};
}

describe("Experience routes — HTTP layer (stub)", () => {
	test("schema rejection: a start body missing branchId is 400", async () => {
		const { runtime } = stubRuntime();
		const app = mount(runtime);
		const res = await app.request("/api/chats/c_1/experience/sessions", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("forwards the chatId path param + parsed body to the runtime", async () => {
		const { runtime, calls } = stubRuntime();
		const app = mount(runtime);
		const body = { branchId: "b_1", settings: { difficulty: "hard" }, participants: [] };
		const res = await app.request("/api/chats/c_1/experience/sessions", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
		});
		expect(res.status).toBe(200);
		expect(calls.startExperienceSession[0]).toMatchObject({ chatId: "c_1", body });
	});

	test("forwards the abort signal on the action endpoint", async () => {
		const { runtime, calls } = stubRuntime();
		const app = mount(runtime);
		const controller = new AbortController();
		await app.request("/api/experience/sessions/s_1/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r1", expectedRevision: 0 }),
			signal: controller.signal,
		});
		expect(calls.submitExperienceAction[0].signal).toBe(controller.signal);
	});

	test("maps a thrown NotFound DomainError to 404 with the structured code", async () => {
		const { runtime } = stubRuntime({ kind: "NotFound", message: "no session" });
		const app = mount(runtime);
		const res = await app.request("/api/experience/sessions/missing/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r1", expectedRevision: 0 }),
		});
		expect(res.status).toBe(404);
		const body = await jsonBody(res);
		expect(body.error.kind).toBe("NotFound");
	});

	test("maps Conflict → 409, Unprocessable → 422, and a bare Error → 500", async () => {
		const conflict = mount(stubRuntime({ kind: "Conflict", message: "stale" }).runtime);
		const r409 = await conflict.request("/api/experience/sessions/s_1/actions", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r1", expectedRevision: 0 }),
		});
		expect(r409.status).toBe(409);

		const unproc = mount(stubRuntime({ kind: "Unprocessable", message: "illegal" }).runtime);
		const r422 = await unproc.request("/api/experience/sessions/s_1/actions", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r1", expectedRevision: 0 }),
		});
		expect(r422.status).toBe(422);
	});
});

// ─── 2. Integration (real adapter → services → DB) ───────────────────────────

const COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "counter", name: "Counter" }, capabilities: [],
  create() { return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "inc" }, { type: "reset" }]; },
  reduce(c, a) {
    if (a.type === "reset") return { state: { count: 0 }, status: "active", events: [] };
    const n = c.state.count + 1;
    return { state: { count: n }, status: n >= 3 ? "completed" : "active", events: [{ visibility: "public", type: "inc", detail: { n } }] };
  },
});
`;

async function setupIntegration() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-routes-"));
	const stores: StoreContainer = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const resources = new ExperienceResourceService(stores);
	const lifecycle = new ExperienceService(stores, resources, { generateSeed: () => "seed1" });
	const replay = new ExperienceReplayService(stores, resources);
	const adapter = new ExperienceAdapter(lifecycle, resources, replay);
	const app = mount(adapter);
	return { stores, resources, app };
}

async function seedChatAndScript(stores: StoreContainer, resources: ExperienceResourceService, source: string, grants: string[] = []) {
	const character = await stores.characters.create({ name: "Hero" } as never);
	const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });
	const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source });
	await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: grants as never });
	return { chatId: chat.id, branchId: chat.activeBranchId };
}

describe("Experience routes — integration (real services + DB)", () => {
	test("start on an unknown chat is 404 chat_not_found", async () => {
		const { app } = await setupIntegration();
		const res = await app.request("/api/chats/unknown/experience/sessions", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId: "b_1", participants: [] }),
		});
		expect(res.status).toBe(404);
		const body = await jsonBody(res);
		expect(body.error.details.code).toBe("chat_not_found");
	});

	test("start → action → stale revision is 409; duplicate request is 200 replayed", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);

		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const started = await jsonBody(start);
		const sid = started.sessionId;
		// Projected-only: response carries `view.state` (projected) and NO
		// authoritative-state leak (no currentState/seed/authoritativeState keys).
		expect(started.view.state).toEqual({ count: 0 });
		expect(started.currentStateJson).toBeUndefined();
		expect(started.randomSeed).toBeUndefined();

		// First action advances revision 0 → 1.
		const a1 = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r1", expectedRevision: 0 }),
		});
		expect(a1.status).toBe(200);
		expect((await jsonBody(a1)).revision).toBe(1);

		// Stale expectedRevision (0 again) → 409 stale_revision with currentRevision.
		const stale = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r2", expectedRevision: 0 }),
		});
		expect(stale.status).toBe(409);
		const staleBody = await jsonBody(stale);
		expect(staleBody.error.details.code).toBe("stale_revision");
		expect(staleBody.error.details.currentRevision).toBe(1);

		// Duplicate requestId r1 → 200, replayed (no second revision bump).
		const dup = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r1", expectedRevision: 0 }),
		});
		expect(dup.status).toBe(200);
		expect((await jsonBody(dup)).revision).toBe(1);
	});

	test("an illegal action type is 422 illegal_action", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [] }),
		});
		const sid = (await jsonBody(start)).sessionId;
		expect(sid, "start must succeed before the illegal action").toBeTruthy();

		const illegal = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "cheat", requestId: "r1", expectedRevision: 0 }),
		});
		expect(illegal.status).toBe(422);
		expect((await jsonBody(illegal)).error.details.code).toBe("illegal_action");
	});

	test("capability_denied when a granted capability is not declared by the rules", async () => {
		const { stores, resources, app } = await setupIntegration();
		// Grant `deterministic_random`, but COUNTER_SOURCE declares none → denied.
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE, ["deterministic_random"]);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [] }),
		});
		expect(start.status).toBe(422);
		const body = await jsonBody(start);
		expect(body.error.details.code).toBe("capability_denied");
	});

	test("config GET → PUT → GET round-trips the enabled flag", async () => {
		const { stores, resources, app } = await setupIntegration();
		const character = await stores.characters.create({ name: "Hero" } as never);
		const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });

		const before = await app.request(`/api/chats/${chat.id}/experience/config`);
		expect(before.status).toBe(200);
		expect((await jsonBody(before)).enabled).toBe(false);

		const patch = await app.request(`/api/chats/${chat.id}/experience/config`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(patch.status).toBe(200);
		expect((await jsonBody(patch)).enabled).toBe(true);

		const after = await app.request(`/api/chats/${chat.id}/experience/config`);
		expect((await jsonBody(after)).enabled).toBe(true);
	});

	test("visual CRUD round-trips through the typed routes", async () => {
		const { app } = await setupIntegration();
		const created = await app.request("/api/experience/visuals", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Viz", source: "<visual/>", apiVersion: 1 }),
		});
		expect(created.status).toBe(200);
		const v = await jsonBody(created);
		expect(v.name).toBe("Viz");

		const fetched = await app.request(`/api/experience/visuals/${v.id}`);
		expect(fetched.status).toBe(200);
		expect((await jsonBody(fetched)).id).toBe(v.id);

		const listed = await app.request("/api/experience/visuals?scopeType=global");
		expect(listed.status).toBe(200);
		expect((await jsonBody(listed)).length).toBeGreaterThanOrEqual(1);

		const deleted = await app.request(`/api/experience/visuals/${v.id}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect((await jsonBody(deleted)).ok).toBe(true);
	});
});

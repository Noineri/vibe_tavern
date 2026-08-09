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

import { createStoreContainer, type StoreContainer, type ExperienceVisualRow } from "@vibe-tavern/db";
import type { ExperienceCapability } from "@vibe-tavern/domain";
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
import { ExperienceContextService, type ExperienceChatLifecycleSeam } from "../src/domain/interactive/experience-context-service.js";
import { ExperienceModelEffectService } from "../src/domain/interactive/experience-model-effect-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
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
		endExperienceSession: async (sessionId: string, body: any) => { rec("endExperienceSession").push({ sessionId, body }); maybeThrow(); return null; },
		submitExperienceAction: async (sessionId: string, action: any, signal?: AbortSignal) => { rec("submitExperienceAction").push({ sessionId, action, signal }); maybeThrow(); return { ...sessionResponse("c_1", "b_1", sessionId), events: [], await: "human" }; },
		getExperienceView: async (sessionId: string, participantId?: string) => { rec("getExperienceView").push({ sessionId, participantId }); maybeThrow(); return { state: { n: 0 }, actions: [], flavor: undefined, revision: 0, status: "active" }; },
		getExperienceActions: async (sessionId: string, participantId?: string) => { rec("getExperienceActions").push({ sessionId, participantId }); maybeThrow(); return []; },
		getActiveExperienceSession: async (chatId: string, branchId: string) => { rec("getActiveExperienceSession").push({ chatId, branchId }); maybeThrow(); return sessionResponse(chatId, branchId); },
		getExperienceQueuedAttachment: async (sessionId: string) => { rec("getExperienceQueuedAttachment").push({ sessionId }); maybeThrow(); return null; },
		queueExperienceReport: async (sessionId: string, body: any) => { rec("queueExperienceReport").push({ sessionId, body }); maybeThrow(); return { id: "xa_1", sessionId, chatId: "c_1", branchId: "b_1", sessionRevision: body.expectedRevision, queueRevision: 1, kind: "report", publicReport: { title: "T", events: [] }, rulesSourceHash: "h", visualSourceHash: null, createdAt: "", updatedAt: "" }; },
		getExperienceReportStatus: async (sessionId: string) => { rec("getExperienceReportStatus").push({ sessionId }); maybeThrow(); return { revision: 0, reportFrontier: 0, pendingPublicEventCount: 0, queuedAttachment: null }; },
		undoExperienceSession: async (sessionId: string, body: any) => { rec("undoExperienceSession").push({ sessionId, body }); maybeThrow(); return { ...sessionResponse("c_1", "b_1", sessionId), events: [], await: "human" }; },
		previewExperienceRecalculation: async (sessionId: string, body: any) => { rec("previewExperienceRecalculation").push({ sessionId, body }); maybeThrow(); return { originalRulesHash: "h1", originalState: {}, originalRevision: 0, newManifestId: "m", newRulesHash: "h2", outcome: { ok: true, finalState: {}, cursor: 0, checkpoints: [] } }; },
		getExperienceEffects: async (sessionId: string) => { rec("getExperienceEffects").push({ sessionId }); maybeThrow(); return []; },
		captureExperienceContext: async (sessionId: string, body: any, signal?: AbortSignal) => { rec("captureExperienceContext").push({ sessionId, body, signal }); maybeThrow(); return { sessionId, mode: body.mode ?? "none", branchFrontierRevision: null, messageFrontierPosition: null, providerProfileId: null, modelId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" }; },
		getExperienceContextStatus: async (sessionId: string) => { rec("getExperienceContextStatus").push({ sessionId }); maybeThrow(); return null; },
		getExperiencePromptOverrides: async (sessionId: string) => { rec("getExperiencePromptOverrides").push({ sessionId }); maybeThrow(); return { global: null, character: null }; },
		updateExperienceGlobalOverride: async (sessionId: string, body: any) => { rec("updateExperienceGlobalOverride").push({ sessionId, body }); maybeThrow(); return { global: { scope: "global", content: body.content, characterId: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" }, character: null }; },
		updateExperienceCharacterOverride: async (sessionId: string, body: any) => { rec("updateExperienceCharacterOverride").push({ sessionId, body }); maybeThrow(); return { global: null, character: { scope: "character", content: body.content, characterId: "c_1", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" } }; },
	};
	return { runtime: base as unknown as ExperienceRuntimeApi, calls };
}

function sessionResponse(chatId: string, branchId: string, sessionId = "s_1") {
	return {
		sessionId, chatId, branchId, status: "active", revision: 0,
		manifest: { id: "counter", name: "Counter" }, apiVersion: 1,
		participants: [], capabilityGrants: [], contextMode: "none" as const,
		rulesRevision: 0, rulesSourceHash: "h",
		visualId: null, visualSource: null, visualSourceHash: null, reportFrontier: 0,
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

	test("context capture forwards the request abort signal", async () => {
		const { runtime, calls } = stubRuntime();
		const app = mount(runtime);
		const controller = new AbortController();
		const res = await app.request("/api/experience/sessions/s_1/context/capture", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "compact_summary" }),
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		expect(calls.captureExperienceContext[0].signal).toBe(controller.signal);
	});

	test("context capture rejects blank model, out-of-range window, and unknown fields", async () => {
		const { runtime } = stubRuntime();
		const app = mount(runtime);
		for (const body of [
			{ model: "" },
			{ recentMessageLimit: 0 },
			{ recentMessageLimit: 1.5 },
			{ mode: "none", unexpected: true },
		]) {
			const res = await app.request("/api/experience/sessions/s_1/context/capture", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(400);
		}
	});

	test("prompt override writes reject oversized content and unknown keys", async () => {
		const { runtime } = stubRuntime();
		const app = mount(runtime);
		for (const body of [
			{ content: "x".repeat(100_001) },
			{ content: "valid", characterId: "c_other" },
		]) {
			const res = await app.request("/api/experience/sessions/s_1/prompt-overrides/global", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(400);
		}
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

	test("session discovery: a missing branchId query is 400 (strict query)", async () => {
		const { runtime } = stubRuntime();
		const app = mount(runtime);
		const res = await app.request("/api/chats/c_1/experience/session");
		expect(res.status).toBe(400);
	});

	test("session discovery: forwards chatId path param + branchId query to the runtime", async () => {
		const { runtime, calls } = stubRuntime();
		const app = mount(runtime);
		const res = await app.request("/api/chats/c_1/experience/session?branchId=b_1");
		expect(res.status).toBe(200);
		expect(calls.getActiveExperienceSession[0]).toEqual({ chatId: "c_1", branchId: "b_1" });
	});

	test("queued attachment read: forwards the sessionId path param", async () => {
		const { runtime, calls } = stubRuntime();
		const app = mount(runtime);
		const res = await app.request("/api/experience/sessions/s_1/attachment");
		expect(res.status).toBe(200);
		expect(calls.getExperienceQueuedAttachment[0]).toEqual({ sessionId: "s_1" });
		const body = await jsonBody(res);
		expect(body).toBeNull();
	});

	test("end rejects the legacy status payload or missing revision and forwards only expectedRevision", async () => {
		const { runtime, calls } = stubRuntime();
		const app = mount(runtime);
		const legacy = await app.request("/api/experience/sessions/s_1/end", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "completed", expectedRevision: 0 }),
		});
		expect(legacy.status).toBe(400);
		const missing = await app.request("/api/experience/sessions/s_1/end", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);
		const valid = await app.request("/api/experience/sessions/s_1/end", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 2 }),
		});
		expect(valid.status).toBe(200);
		expect(calls.endExperienceSession[0]).toEqual({ sessionId: "s_1", body: { expectedRevision: 2 } });
	});

	test("report queue is strict and report endpoints forward their exact contract", async () => {
		const { runtime, calls } = stubRuntime();
		const app = mount(runtime);
		const malformed = await app.request("/api/experience/sessions/s_1/reports/queue", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
		});
		expect(malformed.status).toBe(400);
		const queued = await app.request("/api/experience/sessions/s_1/reports/queue", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 2 }),
		});
		expect(queued.status).toBe(200);
		expect(calls.queueExperienceReport[0]).toEqual({ sessionId: "s_1", body: { expectedRevision: 2 } });
		const status = await app.request("/api/experience/sessions/s_1/reports/status");
		expect(status.status).toBe(200);
		expect(calls.getExperienceReportStatus[0]).toEqual({ sessionId: "s_1" });
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

// Source that declares both rp_context and model (IR-70D shared test fixture).
const CONTEXT_MODEL_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "cm", name: "Cm" },
  capabilities: [{ capability: "rp_context", reason: "test" }, { capability: "model", reason: "test" }],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: "inc" }]; },
  reduce(c, a) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
  choose(ctx, { legal }) { return legal[0]; },
});
`;

const CONTEXT_ONLY_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "co", name: "Co" },
  capabilities: [{ capability: "rp_context", reason: "test" }],
  create() { return { n: 0 }; },
  project(c) { return { n: c.state.n }; },
  actions() { return [{ type: "inc" }]; },
  reduce(c, a) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
  choose(ctx, { legal }) { return legal[0]; },
});
`;

const REPORT_SOURCE = `
context.experience.register({
  apiVersion: 1, manifest: { id: "report", name: "Report" }, capabilities: [],
  create() { return { publicSetup: "ready", secret: "AUTHORITATIVE_MARKER_70C", n: 0 }; },
  project(c) { return { setup: c.state.publicSetup, n: c.state.n }; },
  actions() { return [{ type: "advance" }, { type: "double" }, { type: "private" }]; },
  reduce(c, a) {
    const n = c.state.n + 1;
    if (a.type === "private") return { state: { ...c.state, n }, status: "active", events: [{ visibility: "private", type: "secret", detail: "PRIVATE_MARKER_70C" }] };
    if (a.type === "double") return { state: { ...c.state, n }, status: "active", events: [
      { visibility: "public", type: "advanced", detail: { n } },
      { visibility: "public", type: "bonus", detail: { n } },
    ] };
    return { state: { ...c.state, n }, status: "active", events: [
      { visibility: "public", type: "advanced", detail: { n } },
      { visibility: "private", type: "secret", detail: "PRIVATE_MARKER_70C" },
    ] };
  },
});
`;

async function setupIntegration() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-xp-routes-"));
	const stores: StoreContainer = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const resources = new ExperienceResourceService(stores);
	const lifecycle = new ExperienceService(stores, resources, { generateSeed: () => "seed1" });
	const replay = new ExperienceReplayService(stores, resources);
	const providerProfiles = createProviderProfileService(stores.providers, stores.proxies);
	const chatLifecycle: ExperienceChatLifecycleSeam = {
		assembleSummaryPrompt: async () => {
			throw new Error("Compact-summary execution is outside this route fixture.");
		},
	};
	const contextService = new ExperienceContextService({ stores, providerProfiles, chatLifecycle });
	const modelEffect = new ExperienceModelEffectService({
		stores,
		experienceService: lifecycle,
		contextService,
		providerProfiles,
	});
	const adapter = new ExperienceAdapter(lifecycle, resources, replay, modelEffect, contextService);
	const app = mount(adapter);
	return { stores, resources, app };
}

async function seedChatAndScript(
	stores: StoreContainer,
	resources: ExperienceResourceService,
	source: string,
	grants: ExperienceCapability[] = [],
	visualSource?: string,
): Promise<{ chatId: string; branchId: string; visual: ExperienceVisualRow | null }> {
	const character = await stores.characters.create({ name: "Hero" } as never);
	const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });
	const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: source });
	let visualRow: ExperienceVisualRow | null = null;
	if (visualSource !== undefined) {
		const created = await resources.createVisual({ name: "Viz", source: visualSource, apiVersion: 1 });
		if (created.ok) visualRow = created.data;
	}
	await resources.updateConfig(chat.id, {
		enabled: true,
		scriptId: script.id,
		capabilityGrants: grants,
		...(visualRow !== null ? { visualId: visualRow.id } : {}),
	});
	return { chatId: chat.id, branchId: chat.activeBranchId, visual: visualRow };
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

// ─── 3. IR-70A: branch-scoped discovery + queued-attachment read ──────────────

describe("Experience routes — IR-70A session discovery (integration)", () => {
	test("discovers the active session by chatId + branchId and returns the projected view", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;

		const found = await app.request(`/api/chats/${chatId}/experience/session?branchId=${branchId}`);
		expect(found.status).toBe(200);
		const body = await jsonBody(found);
		expect(body.sessionId).toBe(sid);
		expect(body.chatId).toBe(chatId);
		expect(body.branchId).toBe(branchId);
		expect(body.status).toBe("active");
		expect(body.view.state).toEqual({ count: 0 });
	});

	test("unknown chat is 404 chat_not_found", async () => {
		const { app } = await setupIntegration();
		const res = await app.request("/api/chats/unknown/experience/session?branchId=b_1");
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error.details.code).toBe("chat_not_found");
	});

	test("wrong branch (belongs to another chat) is 404 branch_not_found", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const otherChar = await stores.characters.create({ name: "O" } as never);
		const otherChat = await stores.chats.createChat({ characterId: otherChar.id, title: "O" });
		const res = await app.request(`/api/chats/${chatId}/experience/session?branchId=${otherChat.activeBranchId}`);
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error.details.code).toBe("branch_not_found");
	});

	test("valid chat+branch with no active session is 404 no_active_session", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const res = await app.request(`/api/chats/${chatId}/experience/session?branchId=${branchId}`);
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error.details.code).toBe("no_active_session");
	});

	test("missing branchId query is 400", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const res = await app.request(`/api/chats/${chatId}/experience/session`);
		expect(res.status).toBe(400);
	});
});

describe("Experience routes — IR-70C report lifecycle (real VM + DB + HTTP)", () => {
	test("starts atomically with a projected public setup report and no checkpoint leak", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, REPORT_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const sid = (await jsonBody(start)).sessionId;
		const attachment = await app.request(`/api/experience/sessions/${sid}/attachment`);
		const raw = await attachment.text();
		expect(raw).not.toContain("hiddenStateCheckpointJson");
		expect(raw).not.toContain("AUTHORITATIVE_MARKER_70C");
		expect(raw).not.toContain("PRIVATE_MARKER_70C");
		const body = JSON.parse(raw);
		expect(body.sessionRevision).toBe(0);
		expect(body.publicReport.events[0].detail.projection).toEqual({ setup: "ready", n: 0 });
		expect((await stores.experiences.getSessionById(sid))?.reportFrontier).toBe(0);
	});

	test("queues only public journal events, counts exactly, and explicitly replaces the same attachment", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, REPORT_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;
		const original = await jsonBody(await app.request(`/api/experience/sessions/${sid}/attachment`));

		const firstAction = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "advance", requestId: "report-a1", expectedRevision: 0 }),
		});
		expect(firstAction.status).toBe(200);
		let status = await jsonBody(await app.request(`/api/experience/sessions/${sid}/reports/status`));
		expect(status.pendingPublicEventCount).toBe(1);

		const queued = await app.request(`/api/experience/sessions/${sid}/reports/queue`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }),
		});
		expect(queued.status).toBe(200);
		const firstQueue = await jsonBody(queued);
		expect(firstQueue.id).toBe(original.id);
		expect(firstQueue.queueRevision).toBe(2);
		expect(JSON.stringify(firstQueue.publicReport)).not.toContain("PRIVATE_MARKER_70C");
		expect(firstQueue.publicReport.events.map((event: { type: string }) => event.type)).toEqual(["experience_started", "advanced"]);
		const retry = await app.request(`/api/experience/sessions/${sid}/reports/queue`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }),
		});
		expect(await jsonBody(retry)).toEqual(firstQueue);

		const secondAction = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "double", requestId: "report-a2", expectedRevision: 1 }),
		});
		expect(secondAction.status).toBe(200);
		status = await jsonBody(await app.request(`/api/experience/sessions/${sid}/reports/status`));
		expect(status.pendingPublicEventCount).toBe(2);
		expect(status.queuedAttachment.id).toBe(firstQueue.id);
		expect(status.queuedAttachment.queueRevision).toBe(2);
		const later = await app.request(`/api/experience/sessions/${sid}/reports/queue`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 2 }),
		});
		const laterBody = await jsonBody(later);
		expect(laterBody.id).toBe(firstQueue.id);
		expect(laterBody.queueRevision).toBe(3);
		expect(laterBody.publicReport.events.map((event: { type: string }) => event.type)).toEqual(["experience_started", "advanced", "advanced", "bonus"]);
		const stale = await app.request(`/api/experience/sessions/${sid}/reports/queue`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }),
		});
		expect(stale.status).toBe(409);
		status = await jsonBody(await app.request(`/api/experience/sessions/${sid}/reports/status`));
		expect(status.revision).toBe(2);
		expect(status.queuedAttachment.queueRevision).toBe(3);
	});

	test("queues only schema-valid public journal events", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, REPORT_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;
		const injected = await stores.experiences.applyTransition({
			sessionId: sid, expectedRevision: 0, requestId: "strict-filter", kind: "system",
			actorSnapshotJson: null, inputJson: null,
			emittedEventsJson: JSON.stringify([
				{ visibility: "public", type: "" },
				{ visibility: "private", type: "private_event" },
				{ visibility: "public", type: "valid_event", detail: { n: 1 } },
			]),
			emittedEffectsJson: "[]", stateHash: null, message: null,
			newCurrentStateJson: JSON.stringify({ publicSetup: "ready", secret: "AUTHORITATIVE_MARKER_70C", n: 0 }),
			newStatus: "active", newRandomCursor: 0,
		});
		expect(injected.ok).toBe(true);
		const status = await app.request(`/api/experience/sessions/${sid}/reports/status`);
		expect((await jsonBody(status)).pendingPublicEventCount).toBe(1);
		const queued = await app.request(`/api/experience/sessions/${sid}/reports/queue`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }),
		});
		expect((await jsonBody(queued)).publicReport.events.map((event: { type: string }) => event.type)).toEqual(["experience_started", "valid_event"]);
	});

	test("rejects a queue with no unbound report and no public events without writing", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, REPORT_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;
		const initial = await jsonBody(await app.request(`/api/experience/sessions/${sid}/attachment`));
		const message = await stores.messages.addMessage({ chatId, branchId, role: "user", authorType: "user", content: "bind" });
		await stores.experiences.bindAttachment(initial.id, message.id);
		const privateAction = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "private", requestId: "report-private", expectedRevision: 0 }),
		});
		expect(privateAction.status).toBe(200);
		const queue = await app.request(`/api/experience/sessions/${sid}/reports/queue`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }),
		});
		expect(queue.status).toBe(422);
		expect((await jsonBody(queue)).error.details.code).toBe("no_public_events");
		const status = await jsonBody(await app.request(`/api/experience/sessions/${sid}/reports/status`));
		expect(status.queuedAttachment).toBeNull();
		expect(status.pendingPublicEventCount).toBe(0);
		expect(status.reportFrontier).toBe(0);
	});

	test("finish appends its durable public event, releases the slot, is idempotent, and rolls back an injected store failure", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, REPORT_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;
		const stale = await app.request(`/api/experience/sessions/${sid}/end`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1 }),
		});
		expect(stale.status).toBe(409);
		expect((await stores.experiences.getSessionById(sid))?.status).toBe("active");
		expect((await stores.experiences.getSteps(sid)).filter((step) => step.kind === "system")).toHaveLength(0);

		const finish = await app.request(`/api/experience/sessions/${sid}/end`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0 }),
		});
		expect(finish.status).toBe(200);
		const finishRaw = await finish.text();
		expect(finishRaw).not.toContain("hiddenStateCheckpointJson");
		expect(finishRaw).not.toContain("AUTHORITATIVE_MARKER_70C");
		const final = JSON.parse(finishRaw);
		expect(final.sessionRevision).toBe(1);
		expect(final.publicReport.events.at(-1)).toEqual({ type: "experience_finished", detail: "The user decided to end the game." });
		expect((await stores.experiences.getSessionById(sid))?.status).toBe("interrupted");
		expect(await stores.experiences.getActiveSessionForBranch(branchId)).toBeNull();
		const retry = await app.request(`/api/experience/sessions/${sid}/end`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0 }),
		});
		expect(await jsonBody(retry)).toEqual(final);
		expect((await stores.experiences.getSteps(sid)).filter((step) => step.kind === "system")).toHaveLength(1);

		const { chatId: rollbackChat, branchId: rollbackBranch } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const rollbackStart = await app.request(`/api/chats/${rollbackChat}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branchId: rollbackBranch, participants: [], settings: {} }),
		});
		const rollbackSid = (await jsonBody(rollbackStart)).sessionId;
		expect(() => stores.experiences.finishSessionWithFinalReport(rollbackSid, 0, {
			kind: "report", publicEventsJson: '{"title":"x","events":[]}', hiddenStateCheckpointJson: '{"hidden":true}', rulesSourceHash: "h",
		}, () => { throw new Error("injected finish failure"); })).toThrow("injected finish failure");
		const rolledBack = await stores.experiences.getSessionById(rollbackSid);
		expect(rolledBack?.status).toBe("active");
		expect(rolledBack?.revision).toBe(0);
	});
});

describe("Experience routes — IR-70A queued-attachment read (integration)", () => {
	test("returns the automatic revision-zero setup attachment", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;

		const res = await app.request(`/api/experience/sessions/${sid}/attachment`);
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(body.sessionRevision).toBe(0);
		expect(body.publicReport.events[0].type).toBe("experience_started");
	});

	test("returns the queued attachment with public fields, NEVER the hidden checkpoint (privacy)", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;

		await stores.experiences.queueAttachment({
			chatId, branchId, sessionId: sid,
			sessionRevision: 0, queueRevision: 2, kind: "report",
			publicEventsJson: JSON.stringify({ title: "Round", events: [{ type: "inc" }] }),
			hiddenStateCheckpointJson: JSON.stringify({ secret: "ROUTE_PRIVACY_MARKER_99" }),
			rulesSourceHash: "h", visualSourceHash: null,
		});

		const res = await app.request(`/api/experience/sessions/${sid}/attachment`);
		expect(res.status).toBe(200);
		const raw = await res.text();
		// Negative privacy assertion: the hidden marker and key must NOT appear.
		expect(raw).not.toContain("ROUTE_PRIVACY_MARKER_99");
		expect(raw).not.toContain("hiddenStateCheckpointJson");
		const body = JSON.parse(raw);
		expect(body).not.toBeNull();
		expect(body.kind).toBe("report");
		expect(body.queueRevision).toBe(2);
		expect(body.publicReport).toEqual({ title: "Round", events: [{ type: "inc" }] });
	});

	test("unknown session is 404 session_not_found", async () => {
		const { app } = await setupIntegration();
		const res = await app.request("/api/experience/sessions/nonexistent/attachment");
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error.details.code).toBe("session_not_found");
	});
});

// ─── IR-70D: Context capture + status (integration) ──────────────────────────

describe("Experience routes — IR-70D context capture (integration)", () => {
	test("context status is null before capture", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, CONTEXT_ONLY_SOURCE, ["rp_context"]);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const sid = (await jsonBody(start)).sessionId;

		const status = await app.request(`/api/experience/sessions/${sid}/context/status`);
		expect(status.status).toBe(200);
		// Before capture, status is null. Hono returns null body as empty text, not
		// a JSON-parsable string — but c.json(null) renders "null".
		const text = await status.text();
		expect(text).toBe("null");
	});

	test("successful noncompact capture returns metadata with no payload leakage", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, CONTEXT_ONLY_SOURCE, ["rp_context"]);
		// Add some messages so the bundle has material.
		for (let i = 0; i < 3; i++) {
			await stores.messages.addMessage({ chatId, branchId, role: i % 2 === 0 ? "user" : "assistant", authorType: i % 2 === 0 ? "user" : "character", content: `msg-${i}` });
		}
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const sid = (await jsonBody(start)).sessionId;

		// Capture with current_branch mode.
		const capture = await app.request(`/api/experience/sessions/${sid}/context/capture`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "current_branch" }),
		});
		expect(capture.status).toBe(200);
		const captureRaw = await capture.text();
		expect(captureRaw).not.toContain("variantsJson");
		expect(captureRaw).not.toContain("compactSummaryJson");
		expect(captureRaw).not.toContain("msg-0");
		const body = JSON.parse(captureRaw);
		expect(body.sessionId).toBe(sid);
		expect(body.mode).toBe("current_branch");
		expect(body).toHaveProperty("branchFrontierRevision");
		expect(body.branchFrontierRevision === null || Number.isInteger(body.branchFrontierRevision)).toBe(true);
		expect(typeof body.messageFrontierPosition).toBe("number");
		expect(body.providerProfileId).toBeNull();
		expect(body.modelId).toBeNull();
		expect(body.createdAt).toBeTruthy();
		expect(body.updatedAt).toBeTruthy();

		// Negative: forbidden payload fields are absent.
		expect(body.variantsJson).toBeUndefined();
		expect(body.compactSummaryJson).toBeUndefined();
		expect(body.characterSnapshotJson).toBeUndefined();
		expect(body.personaSnapshotJson).toBeUndefined();
		expect(body.sourceHashesJson).toBeUndefined();

		// Status now reflects the captured bundle.
		const status = await app.request(`/api/experience/sessions/${sid}/context/status`);
		expect(status.status).toBe(200);
		const statusBody = await jsonBody(status);
		expect(statusBody).not.toBeNull();
		expect(statusBody.sessionId).toBe(sid);
		expect(statusBody.mode).toBe("current_branch");
	});

	test("missing rp_context grant → 422 capability_denied, no bundle row", async () => {
		const { stores, resources, app } = await setupIntegration();
		// COUNTER_SOURCE declares no capabilities; grants are empty → session has no rp_context.
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE, []);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const sid = (await jsonBody(start)).sessionId;

		// Capture is blocked.
		const capture = await app.request(`/api/experience/sessions/${sid}/context/capture`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "none" }),
		});
		expect(capture.status).toBe(422);
		const body = await jsonBody(capture);
		expect(body.error.details.code).toBe("capability_denied");

		// Status is also blocked.
		const status = await app.request(`/api/experience/sessions/${sid}/context/status`);
		expect(status.status).toBe(422);
		expect((await jsonBody(status)).error.details.code).toBe("capability_denied");
	});

	test("request with unknown fields is 400 (strict schema)", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, CONTEXT_ONLY_SOURCE, ["rp_context"]);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const sid = (await jsonBody(start)).sessionId;

		const res = await app.request(`/api/experience/sessions/${sid}/context/capture`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "none", unknownField: true }),
		});
		expect(res.status).toBe(400);
	});
});

// ─── IR-70D: Prompt overrides (integration) ──────────────────────────────────

describe("Experience routes — IR-70D prompt overrides (integration)", () => {
	async function seedSessionWithModelGrant(app: any, stores: any, resources: any) {
		const { chatId, branchId } = await seedChatAndScript(stores, resources, CONTEXT_MODEL_SOURCE, ["rp_context", "model"]);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		return { sessionId: (await jsonBody(start)).sessionId, chatId };
	}

	test("GET returns independent global + character layers (both null initially)", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { sessionId: sid } = await seedSessionWithModelGrant(app, stores, resources);

		const res = await app.request(`/api/experience/sessions/${sid}/prompt-overrides`);
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(body.global).toBeNull();
		expect(body.character).toBeNull();
	});

	test("global write and character write round-trip independently", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { sessionId: sid } = await seedSessionWithModelGrant(app, stores, resources);

		// Write global override.
		const gRes = await app.request(`/api/experience/sessions/${sid}/prompt-overrides/global`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "global instruction" }),
		});
		expect(gRes.status).toBe(200);
		const gBody = await jsonBody(gRes);
		expect(gBody.global).not.toBeNull();
		expect(gBody.global.content).toBe("global instruction");
		expect(gBody.global.scope).toBe("global");
		expect(gBody.global.characterId).toBeNull();
		expect(gBody.character).toBeNull();

		// Write character override.
		const cRes = await app.request(`/api/experience/sessions/${sid}/prompt-overrides/character`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "character instruction" }),
		});
		expect(cRes.status).toBe(200);
		const cBody = await jsonBody(cRes);
		expect(cBody.global).not.toBeNull();
		expect(cBody.global.content).toBe("global instruction");
		expect(cBody.character).not.toBeNull();
		expect(cBody.character.content).toBe("character instruction");
		expect(cBody.character.scope).toBe("character");
		expect(cBody.character.characterId).toBeTruthy();

		// GET returns both layers independently.
		const getRes = await app.request(`/api/experience/sessions/${sid}/prompt-overrides`);
		expect(getRes.status).toBe(200);
		const getBody = await jsonBody(getRes);
		expect(getBody.global.content).toBe("global instruction");
		expect(getBody.character.content).toBe("character instruction");
	});

	test("character write derives character from session → chat (not from request body)", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { sessionId: sid } = await seedSessionWithModelGrant(app, stores, resources);

		// The PUT body only has {content}; characterId is NOT accepted.
		const res = await app.request(`/api/experience/sessions/${sid}/prompt-overrides/character`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "char prompt", characterId: "other" }),
		});
		// The strict schema rejects unknown keys → 400.
		expect(res.status).toBe(400);
	});

	test("missing model grant rejects GET and both PUTs with 422, no writes", async () => {
		const { stores, resources, app } = await setupIntegration();
		// CONTEXT_ONLY_SOURCE has rp_context but NOT model.
		const { chatId, branchId } = await seedChatAndScript(stores, resources, CONTEXT_ONLY_SOURCE, ["rp_context"]);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const sid = (await jsonBody(start)).sessionId;

		// GET denied.
		const getRes = await app.request(`/api/experience/sessions/${sid}/prompt-overrides`);
		expect(getRes.status).toBe(422);
		expect((await jsonBody(getRes)).error.details.code).toBe("capability_denied");

		// PUT global denied.
		const gRes = await app.request(`/api/experience/sessions/${sid}/prompt-overrides/global`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "x" }),
		});
		expect(gRes.status).toBe(422);

		// PUT character denied.
		const cRes = await app.request(`/api/experience/sessions/${sid}/prompt-overrides/character`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "x" }),
		});
		expect(cRes.status).toBe(422);
	});

	test("empty content is a valid override write", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { sessionId: sid } = await seedSessionWithModelGrant(app, stores, resources);

		const res = await app.request(`/api/experience/sessions/${sid}/prompt-overrides/global`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "" }),
		});
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(body.global.content).toBe("");
	});
});

// ─── IR-70G: pinned visual source in session responses (integration) ─────────

	describe("Experience routes — IR-70G pinned visual source (integration)", () => {
	test("start, get, and active-session responses include the exact pinned source/hash; no private fields leak", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId, visual } = await seedChatAndScript(stores, resources, COUNTER_SOURCE, [], "<board id='v1'/>");
		expect(visual).not.toBeNull();
		if (visual === null) return;

		// Start — response carries the pinned visual snapshot.
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const startedRaw = await start.text();
		expect(startedRaw).not.toContain('"rulesSource":');
		expect(startedRaw).not.toContain('"currentStateJson"');
		expect(startedRaw).not.toContain('"participantsJson"');
		expect(startedRaw).not.toContain('"capabilityGrantsJson"');
		expect(startedRaw).not.toContain('"randomSeed"');
		const started = JSON.parse(startedRaw);
		const sid = started.sessionId;
		expect(started.visualId).toBe(visual.id);
		expect(started.visualSource).toBe("<board id='v1'/>");
		expect(started.visualSourceHash).toBe(visual.sourceHash);

		// GET session — same pinned snapshot.
		const got = await app.request(`/api/experience/sessions/${sid}`);
		expect(got.status).toBe(200);
		const gotBody = await jsonBody(got);
		expect(gotBody.visualSource).toBe("<board id='v1'/>");
		expect(gotBody.visualSourceHash).toBe(visual.sourceHash);
		expect(gotBody.visualId).toBe(visual.id);

		// Active-session discovery — same pinned snapshot.
		const found = await app.request(`/api/chats/${chatId}/experience/session?branchId=${branchId}`);
		expect(found.status).toBe(200);
		const foundBody = await jsonBody(found);
		expect(foundBody.visualSource).toBe("<board id='v1'/>");
		expect(foundBody.visualSourceHash).toBe(visual.sourceHash);
		expect(foundBody.visualId).toBe(visual.id);
	});

	test("a no-visual session responds with explicit null source/hash on all paths", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId } = await seedChatAndScript(stores, resources, COUNTER_SOURCE);
		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		expect(start.status).toBe(200);
		const started = await jsonBody(start);
		expect(started.visualId).toBeNull();
		expect(started.visualSource).toBeNull();
		expect(started.visualSourceHash).toBeNull();
		const sid = started.sessionId;

		const got = await app.request(`/api/experience/sessions/${sid}`);
		const gotBody = await jsonBody(got);
		expect(gotBody.visualId).toBeNull();
		expect(gotBody.visualSource).toBeNull();
		expect(gotBody.visualSourceHash).toBeNull();
	});

	test("action response inherits the pinned visual source fields", async () => {
		const { stores, resources, app } = await setupIntegration();
		const { chatId, branchId, visual } = await seedChatAndScript(stores, resources, COUNTER_SOURCE, [], "<board id='v1'/>");
		expect(visual).not.toBeNull();
		if (visual === null) return;

		const start = await app.request(`/api/chats/${chatId}/experience/sessions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ branchId, participants: [], settings: {} }),
		});
		const sid = (await jsonBody(start)).sessionId;

		const action = await app.request(`/api/experience/sessions/${sid}/actions`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "inc", requestId: "r1", expectedRevision: 0 }),
		});
		expect(action.status).toBe(200);
		const body = await jsonBody(action);
		expect(body.visualSource).toBe("<board id='v1'/>");
		expect(body.visualSourceHash).toBe(visual.sourceHash);
		expect(body.visualId).toBe(visual.id);
	});
});

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDb, QuotaStore, ProviderStore, type AppDb } from "@vibe-tavern/db";
import {
	DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
	EventBus,
	PROVIDER_QUOTA_ERROR_KIND,
	PROVIDER_QUOTA_EVENT_KIND,
	PROVIDER_QUOTA_EVENT_NAME,
	PROVIDER_QUOTA_KIND,
	PROVIDER_QUOTA_WINDOW_KIND,
	QUOTA_LOW_REMAINING_CROSSING,
	type ProviderQuotaLowRemainingEvent,
	type StoredProviderProfileRecord,
	type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import { createQuotaFeature, createQuotaRoutes } from "../src/domain/quota/quota-feature.js";
import type { QuotaService } from "../src/domain/quota/quota-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { isDomainError } from "../src/shared/errors.js";

const BASE_CREATE = {
	endpoint: "https://api.z.ai/api/paas/v4",
	apiKey: "sk-test",
	defaultModel: "glm-4.6",
	contextBudget: null as null,
	temperature: 1, topP: 1, minP: 0, topK: 0, topA: 0,
	typicalP: 1, tfsZ: 1, repeatLastN: 0,
	mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
	dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2,
	drySequenceBreakers: null as null,
	xtcThreshold: 0.1, xtcProbability: 0,
	frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
	maxTokens: 2000,
	stopSequences: null as null, logitBias: null as null, seed: null as null,
	reasoningEffort: "auto" as const,
	showReasoning: false, streamResponse: true, customSamplers: false,
};

const WINDOWED_CONFIG = {
	kind: PROVIDER_QUOTA_KIND.windowed,
	displayEnabled: true,
	lowQuotaEnabled: true,
	lowQuotaRemainingPercent: 25,
	resetNotifyEnabled: true,
	pollIntervalMinutes: 2,
};

function profileServiceFor(profiles: Map<string, StoredProviderProfileRecord>): ProviderProfileService {
	return { getProviderProfile: async (id: string) => profiles.get(id) ?? null } as unknown as ProviderProfileService;
}

describe("quota routes", () => {
	let db: AppDb;
	let quota: QuotaStore;
	let profiles: Map<string, StoredProviderProfileRecord>;
	let zaiId: string;
	let deepseekId: string;
	let groqId: string;
	let resyncs: string[];
	let app: Hono;

	beforeEach(async () => {
		db = await createDb(":memory:");
		quota = new QuotaStore(db);
		const providers = new ProviderStore(db);
		resyncs = [];

		const zai = await providers.create({ name: "ZAI", providerPreset: "zai", ...BASE_CREATE });
		const deepseek = await providers.create({
			name: "DeepSeek", providerPreset: "deepseek", ...BASE_CREATE, endpoint: "https://api.deepseek.com",
		});
		const groq = await providers.create({
			name: "Groq", providerPreset: "groq", ...BASE_CREATE, endpoint: "https://api.groq.com/openai/v1",
		});
		zaiId = zai.id;
		deepseekId = deepseek.id;
		groqId = groq.id;

		profiles = new Map();
		for (const id of [zaiId, deepseekId, groqId]) {
			profiles.set(id, (await providers.getById(id))!);
		}

		const quotaService = {
			resyncProfile: async (profileId: string) => { resyncs.push(profileId); },
		} as unknown as QuotaService;

		// Mirrors app-factory: domain errors become their HTTP status.
		app = new Hono();
		app.onError((err, c) => {
			if (isDomainError(err)) {
				const status = err.kind === "NotFound" ? 404 : err.kind === "Validation" ? 400 : 500;
				return c.json({ error: err.message, kind: err.kind }, status);
			}
			return c.json({ error: String(err) }, 500);
		});
		app.route("/", createQuotaRoutes({ quota, profiles: profileServiceFor(profiles), quotaService }));
	});

	// ─── Capability ───────────────────────────────────────────────────────────

	test("GET quota-capability reports the adapter for a supported provider", async () => {
		const res = await app.request(`/api/providers/${zaiId}/quota-capability`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			providerProfileId: zaiId,
			kind: PROVIDER_QUOTA_KIND.windowed,
			capabilityId: "zai",
			capabilityVersion: 1,
			pollIntervalMs: 300_000,
			reason: null,
		});
	});

	test("GET quota-capability reports a reason for an unsupported provider", async () => {
		const res = await app.request(`/api/providers/${groqId}/quota-capability`);
		expect(await res.json()).toMatchObject({
			kind: PROVIDER_QUOTA_KIND.none,
			capabilityId: null,
			pollIntervalMs: null,
			reason: "not_exposed",
		});
	});

	test("GET quota-capability 404s for an unknown profile", async () => {
		const res = await app.request("/api/providers/prov_missing/quota-capability");
		expect(res.status).toBe(404);
	});

	// ─── Read ─────────────────────────────────────────────────────────────────

	test("GET quota returns the kind defaults when nothing is configured", async () => {
		const res = await app.request(`/api/providers/${zaiId}/quota`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			providerProfileId: zaiId,
			config: {
				kind: PROVIDER_QUOTA_KIND.windowed,
				displayEnabled: false,
				lowQuotaEnabled: false,
				lowQuotaRemainingPercent: 10,
				resetNotifyEnabled: false,
				pollIntervalMinutes: DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
			},
			snapshot: null,
			lastError: null,
			updatedAt: null,
		});
	});

	test("GET quota returns the persisted config, snapshot and error", async () => {
		const snapshot: WindowedProviderQuotaSnapshot = {
			kind: PROVIDER_QUOTA_KIND.windowed,
			providerProfileId: zaiId,
			capabilityId: "zai",
			capabilityVersion: 1,
			observedAt: "2026-08-07T10:00:00.000Z",
			windows: [{ kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "5h", usedPercent: 80, resetsAt: "2026-08-07T14:00:00.000Z" }],
		};
		await quota.upsertSettings(zaiId, WINDOWED_CONFIG);
		await quota.upsertSnapshot(zaiId, {
			snapshot,
			transitionState: null,
			lastError: PROVIDER_QUOTA_ERROR_KIND.http,
		});

		const body = await (await app.request(`/api/providers/${zaiId}/quota`)).json();
		expect(body.config).toEqual(WINDOWED_CONFIG);
		expect(body.snapshot).toEqual(snapshot);
		expect(body.lastError).toBe(PROVIDER_QUOTA_ERROR_KIND.http);
		expect(body.updatedAt).toBeTruthy();
	});

	test("GET quota never leaks the transition state or any credential", async () => {
		await quota.upsertSettings(zaiId, WINDOWED_CONFIG);
		const raw = await (await app.request(`/api/providers/${zaiId}/quota`)).text();
		expect(raw).not.toContain("transitionState");
		expect(raw).not.toContain("apiKey");
		expect(raw).not.toContain("sk-test");
		expect(raw).not.toContain("endpoint");
	});

	test("a stored config of the wrong kind falls back to the capability's defaults", async () => {
		await quota.upsertSettings(deepseekId, WINDOWED_CONFIG);
		const body = await (await app.request(`/api/providers/${deepseekId}/quota`)).json();
		expect(body.config).toEqual({
			kind: PROVIDER_QUOTA_KIND.balance,
			displayEnabled: false,
			pollIntervalMinutes: DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
		});
	});

	// ─── Write ────────────────────────────────────────────────────────────────

	test("PUT quota-config round-trips and triggers a resync", async () => {
		const res = await app.request(`/api/providers/${zaiId}/quota-config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(WINDOWED_CONFIG),
		});

		expect(res.status).toBe(200);
		expect((await res.json()).config).toEqual(WINDOWED_CONFIG);
		expect((await quota.getSettings(zaiId))?.config).toEqual(WINDOWED_CONFIG);
		expect(resyncs).toEqual([zaiId]);
	});

	test("PUT a balance config on a balance provider is accepted", async () => {
		const res = await app.request(`/api/providers/${deepseekId}/quota-config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				kind: PROVIDER_QUOTA_KIND.balance,
				displayEnabled: true,
				pollIntervalMinutes: 3,
			}),
		});
		expect(res.status).toBe(200);
	});

	test("PUT a windowed config on a balance provider is rejected", async () => {
		const res = await app.request(`/api/providers/${deepseekId}/quota-config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(WINDOWED_CONFIG),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("does not match");
		expect(resyncs).toEqual([]);
	});

	test.each([0, 101, 10.5])("PUT with threshold %p is a 400", async (value) => {
		const res = await app.request(`/api/providers/${zaiId}/quota-config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...WINDOWED_CONFIG, lowQuotaRemainingPercent: value }),
		});
		expect(res.status).toBe(400);
		expect(await quota.getSettings(zaiId)).toBeNull();
	});

	test("PUT with an unknown extra field is a 400 (strict schema)", async () => {
		const res = await app.request(`/api/providers/${zaiId}/quota-config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...WINDOWED_CONFIG, endpoint: "https://evil.example" }),
		});
		expect(res.status).toBe(400);
	});

	test("there is no refresh route", async () => {
		for (const path of [`/api/providers/${zaiId}/quota/refresh`, "/api/quota/refresh"]) {
			for (const method of ["GET", "POST"]) {
				expect((await app.request(path, { method })).status).toBe(404);
			}
		}
	});
});

describe("quota SSE channel", () => {
	function lowRemainingEvent(): ProviderQuotaLowRemainingEvent {
		return {
			kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
			eventId: "prov_1:zai:session:low_remaining:2026-08-07T14:00:00.000Z",
			providerProfileId: "prov_1",
			capabilityId: "zai",
			windowKind: PROVIDER_QUOTA_WINDOW_KIND.session,
			windowLabel: "5h",
			usedPercent: 95,
			remainingPercent: 5,
			thresholdPercent: 10,
			resetsAt: "2026-08-07T14:00:00.000Z",
			crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
			observedAt: "2026-08-07T10:00:00.000Z",
		};
	}

	function mountSse(events: EventBus): Hono {
		const router = new Hono();
		const feature = createQuotaFeature({
			quota: {} as unknown as QuotaStore,
			profiles: {} as unknown as ProviderProfileService,
			quotaService: {} as unknown as QuotaService,
		});
		feature.activate({ events, router });
		return router;
	}

	test("delivers a bus-emitted event with the bus name as the SSE event field", async () => {
		const events = new EventBus();
		const router = mountSse(events);
		const controller = new AbortController();

		const res = await router.request("/api/quota/events", { signal: controller.signal });
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		const ready = decoder.decode((await reader.read()).value);
		expect(ready).toContain("event: ready");

		const event = lowRemainingEvent();
		events.emit(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, event);

		const chunk = decoder.decode((await reader.read()).value);
		expect(chunk).toContain(`event: ${PROVIDER_QUOTA_EVENT_NAME.lowRemaining}`);
		expect(chunk).toContain(event.eventId);
		expect(JSON.parse(chunk.split("data: ")[1]!.split("\n")[0]!)).toEqual(event);

		controller.abort();
		await reader.cancel().catch(() => {});
	});

	test("a disconnect unsubscribes both handlers — no listener leak", async () => {
		const events = new EventBus();
		const router = mountSse(events);
		const controller = new AbortController();

		const res = await router.request("/api/quota/events", { signal: controller.signal });
		const reader = res.body!.getReader();
		await reader.read();

		expect(events.listenerCount(PROVIDER_QUOTA_EVENT_NAME.lowRemaining)).toBe(1);
		expect(events.listenerCount(PROVIDER_QUOTA_EVENT_NAME.windowReset)).toBe(1);

		await reader.cancel();
		controller.abort();
		for (let i = 0; i < 20; i++) await Promise.resolve();

		expect(events.listenerCount(PROVIDER_QUOTA_EVENT_NAME.lowRemaining)).toBe(0);
		expect(events.listenerCount(PROVIDER_QUOTA_EVENT_NAME.windowReset)).toBe(0);
	});
});

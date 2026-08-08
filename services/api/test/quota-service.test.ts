import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { join } from "node:path";
import { createDb, QuotaStore, ProviderStore, type AppDb } from "@vibe-tavern/db";
import {
	EventBus,
	PROVIDER_QUOTA_ERROR_KIND,
	PROVIDER_QUOTA_EVENT_NAME,
	PROVIDER_QUOTA_KIND,
	type ProviderQuotaLowRemainingEvent,
	type ProviderQuotaWindowResetEvent,
	type StoredProviderProfileRecord,
} from "@vibe-tavern/domain";
import { QuotaService } from "../src/domain/quota/quota-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";

const FIXTURES = join(import.meta.dir, "fixtures", "quota");

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

/**
 * The service only ever calls `getProviderProfile`. A narrow stub keeps the
 * test honest about that instead of dragging the whole profile service in.
 */
function profileServiceFor(profiles: Map<string, StoredProviderProfileRecord>): ProviderProfileService {
	const service = {
		getProviderProfile: async (id: string) => profiles.get(id) ?? null,
	};
	return service as unknown as ProviderProfileService;
}

async function zaiBody(usedFraction: number, resetsAtMs: number): Promise<string> {
	return JSON.stringify({
		code: 200,
		success: true,
		data: {
			limits: [{
				type: "TOKENS_LIMIT",
				unit: 3,
				number: 5,
				usage: 100,
				currentValue: usedFraction * 100,
				nextResetTime: resetsAtMs,
				planName: "GLM Coding Pro",
			}],
		},
	});
}

const RESET_A = Date.parse("2026-08-07T14:00:00.000Z");
const RESET_B = Date.parse("2026-08-07T19:00:00.000Z");

describe("QuotaService", () => {
	let db: AppDb;
	let quota: QuotaStore;
	let providers: ProviderStore;
	let events: EventBus;
	let profiles: Map<string, StoredProviderProfileRecord>;
	let profileId: string;
	let fetchCalls: string[];
	let respond: (url: string) => Response | Promise<Response>;
	let clockMs: number;
	/** Every service a test builds, stopped in afterEach so a failed assertion
	 *  before `stop()` cannot leak a live timer into the next test. */
	let services: QuotaService[];

	beforeEach(async () => {
		jest.useFakeTimers();
		db = await createDb(":memory:");
		quota = new QuotaStore(db);
		providers = new ProviderStore(db);
		events = new EventBus();
		fetchCalls = [];
		services = [];
		clockMs = Date.parse("2026-08-07T10:00:00.000Z");

		const created = await providers.create({ name: "ZAI", providerPreset: "zai", ...BASE_CREATE });
		profileId = created.id;
		const stored = await providers.getById(profileId);
		profiles = new Map([[profileId, stored!]]);

		respond = async () => new Response(await zaiBody(0.5, RESET_A), { status: 200 });
	});

	afterEach(() => {
		for (const service of services) service.stop();
		jest.useRealTimers();
	});

	function makeService(overrides: { random?: () => number } = {}): QuotaService {
		const service = new QuotaService({
			quota,
			profiles: profileServiceFor(profiles),
			events,
			resolveFetch: async () => (async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				fetchCalls.push(url);
				return respond(url);
			}) as typeof fetch,
			now: () => new Date(clockMs),
			random: overrides.random ?? (() => 0.5),
		});
		services.push(service);
		return service;
	}

	async function enableWindowed(overrides: Partial<{ lowQuotaRemainingPercent: number }> = {}): Promise<void> {
		await quota.upsertSettings(profileId, {
			kind: PROVIDER_QUOTA_KIND.windowed,
			displayEnabled: true,
			lowQuotaEnabled: true,
			lowQuotaRemainingPercent: overrides.lowQuotaRemainingPercent ?? 10,
			resetNotifyEnabled: true,
		});
	}

	/** Let the poll's awaits settle — fake timers do not advance microtasks. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	}

	test("start() polls nothing when no profile has a settings row", async () => {
		const service = makeService();
		await service.start();
		expect(service.pendingTimerCount).toBe(0);

		jest.advanceTimersByTime(600_000);
		await settle();
		expect(fetchCalls).toEqual([]);
		service.stop();
	});

	test("start() skips a profile whose toggles are all off", async () => {
		await quota.upsertSettings(profileId, {
			kind: PROVIDER_QUOTA_KIND.windowed,
			displayEnabled: false,
			lowQuotaEnabled: false,
			lowQuotaRemainingPercent: 10,
			resetNotifyEnabled: false,
		});
		const service = makeService();
		await service.start();
		expect(service.pendingTimerCount).toBe(0);
		service.stop();
	});

	test("a successful poll persists the normalized snapshot", async () => {
		await enableWindowed();
		const service = makeService();
		await service.start();

		jest.advanceTimersByTime(0);
		await settle();

		expect(fetchCalls).toEqual(["https://api.z.ai/api/monitor/usage/quota/limit"]);
		const stored = await quota.getSnapshot(profileId);
		expect(stored?.lastError).toBeNull();
		expect(stored?.snapshot).toMatchObject({
			kind: PROVIDER_QUOTA_KIND.windowed,
			capabilityId: "zai",
			observedAt: "2026-08-07T10:00:00.000Z",
			windows: [{ kind: "session", usedPercent: 50, resetsAt: "2026-08-07T14:00:00.000Z" }],
		});
		service.stop();
	});

	test("reschedules on the adapter's interval and keeps polling", async () => {
		await enableWindowed();
		const service = makeService();
		await service.start();

		jest.advanceTimersByTime(0);
		await settle();
		expect(fetchCalls).toHaveLength(1);

		// random() === 0.5 puts the jitter at exactly the declared interval.
		jest.advanceTimersByTime(300_000);
		await settle();
		expect(fetchCalls).toHaveLength(2);
		service.stop();
	});

	test("jitter stays inside ±10% of the declared interval", async () => {
		await enableWindowed();
		const service = makeService({ random: () => 0 });
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		// Lowest jitter is interval - 10%.
		jest.advanceTimersByTime(269_999);
		await settle();
		expect(fetchCalls).toHaveLength(1);
		jest.advanceTimersByTime(1);
		await settle();
		expect(fetchCalls).toHaveLength(2);
		service.stop();
	});

	test("crossing the threshold emits exactly one bus event, and never again on replay", async () => {
		await enableWindowed();
		const received: ProviderQuotaLowRemainingEvent[] = [];
		events.on(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, (event) => { received.push(event); });

		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();
		expect(received).toHaveLength(0);

		respond = async () => new Response(await zaiBody(0.95, RESET_A), { status: 200 });
		clockMs += 300_000;
		jest.advanceTimersByTime(300_000);
		await settle();
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ remainingPercent: 5, thresholdPercent: 10 });

		clockMs += 300_000;
		jest.advanceTimersByTime(300_000);
		await settle();
		expect(received).toHaveLength(1);
		service.stop();
	});

	test("a restart replaying the same reading emits nothing (event-ledger dedupe)", async () => {
		await enableWindowed();
		respond = async () => new Response(await zaiBody(0.95, RESET_A), { status: 200 });

		const first = makeService();
		await first.start();
		jest.advanceTimersByTime(0);
		await settle();
		first.stop();

		const received: ProviderQuotaLowRemainingEvent[] = [];
		events.on(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, (event) => { received.push(event); });

		clockMs += 600_000;
		const second = makeService();
		await second.start();
		jest.advanceTimersByTime(0);
		await settle();

		expect(received).toEqual([]);
		second.stop();
	});

	test("a window reset emits a reset event", async () => {
		await enableWindowed();
		const resets: ProviderQuotaWindowResetEvent[] = [];
		events.on(PROVIDER_QUOTA_EVENT_NAME.windowReset, (event) => { resets.push(event); });

		const service = makeService();
		await service.start();
		respond = async () => new Response(await zaiBody(0.95, RESET_A), { status: 200 });
		jest.advanceTimersByTime(0);
		await settle();

		respond = async () => new Response(await zaiBody(0.03, RESET_B), { status: 200 });
		clockMs += 300_000;
		jest.advanceTimersByTime(300_000);
		await settle();

		expect(resets).toHaveLength(1);
		expect(resets[0]).toMatchObject({ resetsAt: "2026-08-07T19:00:00.000Z" });
		service.stop();
	});

	test("a 401 records an auth error and backs off to the cap", async () => {
		await enableWindowed();
		respond = () => new Response("nope", { status: 401 });

		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		expect((await quota.getSnapshot(profileId))?.lastError).toBe(PROVIDER_QUOTA_ERROR_KIND.auth);

		// Anything short of the cap must not retry a rejected key.
		jest.advanceTimersByTime(3_599_999);
		await settle();
		expect(fetchCalls).toHaveLength(1);
		jest.advanceTimersByTime(1);
		await settle();
		expect(fetchCalls).toHaveLength(2);
		service.stop();
	});

	test("repeated 500s double the backoff and emit nothing", async () => {
		await enableWindowed();
		respond = () => new Response("boom", { status: 500 });
		const received: ProviderQuotaLowRemainingEvent[] = [];
		events.on(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, (event) => { received.push(event); });

		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();
		expect((await quota.getSnapshot(profileId))?.lastError).toBe(PROVIDER_QUOTA_ERROR_KIND.http);

		jest.advanceTimersByTime(30_000);
		await settle();
		expect(fetchCalls).toHaveLength(2);

		// Second failure doubles: 60s, not another 30s.
		jest.advanceTimersByTime(30_000);
		await settle();
		expect(fetchCalls).toHaveLength(2);
		jest.advanceTimersByTime(30_000);
		await settle();
		expect(fetchCalls).toHaveLength(3);

		expect(received).toEqual([]);
		service.stop();
	});

	test("a malformed body is a schema error and keeps the previous snapshot", async () => {
		await enableWindowed();
		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();
		const good = await quota.getSnapshot(profileId);

		respond = () => new Response(JSON.stringify({ code: 200 }), { status: 200 });
		clockMs += 300_000;
		jest.advanceTimersByTime(300_000);
		await settle();

		const after = await quota.getSnapshot(profileId);
		expect(after?.lastError).toBe(PROVIDER_QUOTA_ERROR_KIND.schema);
		expect(after?.snapshot).toEqual(good!.snapshot);
		service.stop();
	});

	test("a transport failure records a network error", async () => {
		await enableWindowed();
		respond = () => { throw new Error("ECONNRESET"); };

		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		expect((await quota.getSnapshot(profileId))?.lastError).toBe(PROVIDER_QUOTA_ERROR_KIND.network);
		service.stop();
	});

	test("a profile with no API key records an auth error without any request", async () => {
		await enableWindowed();
		profiles.set(profileId, { ...profiles.get(profileId)!, apiKey: null });

		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		expect(fetchCalls).toEqual([]);
		expect((await quota.getSnapshot(profileId))?.lastError).toBe(PROVIDER_QUOTA_ERROR_KIND.auth);
		service.stop();
	});

	test("an unsupported provider stores a none snapshot and cancels its timer", async () => {
		profiles.set(profileId, { ...profiles.get(profileId)!, providerPreset: "groq", endpoint: "https://api.groq.com/openai/v1" });
		await quota.upsertSettings(profileId, { kind: PROVIDER_QUOTA_KIND.balance, displayEnabled: true });

		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		expect(fetchCalls).toEqual([]);
		expect((await quota.getSnapshot(profileId))?.snapshot).toEqual({
			kind: PROVIDER_QUOTA_KIND.none,
			providerProfileId: profileId,
			reason: "not_exposed",
		});
		expect(service.pendingTimerCount).toBe(0);
		service.stop();
	});

	test("a balance provider stores balances and runs no transitions", async () => {
		profiles.set(profileId, {
			...profiles.get(profileId)!,
			providerPreset: "deepseek",
			endpoint: "https://api.deepseek.com",
		});
		await quota.upsertSettings(profileId, { kind: PROVIDER_QUOTA_KIND.balance, displayEnabled: true });
		// Read the fixture BEFORE fake timers own the loop — file I/O does not
		// settle on microtasks alone.
		const body = await Bun.file(join(FIXTURES, "deepseek.json")).text();
		respond = () => new Response(body, { status: 200 });

		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		const stored = await quota.getSnapshot(profileId);
		expect(stored?.snapshot).toMatchObject({ kind: PROVIDER_QUOTA_KIND.balance, capabilityId: "deepseek" });
		expect(stored?.transitionState).toBeNull();
		service.stop();
	});

	test("stop() leaves zero pending timers and makes no further requests", async () => {
		await enableWindowed();
		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();
		expect(fetchCalls).toHaveLength(1);

		service.stop();
		expect(service.pendingTimerCount).toBe(0);

		jest.advanceTimersByTime(3_600_000);
		await settle();
		expect(fetchCalls).toHaveLength(1);
	});

	test("turning every toggle off stops the profile at its next tick", async () => {
		await enableWindowed();
		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		await quota.upsertSettings(profileId, {
			kind: PROVIDER_QUOTA_KIND.windowed,
			displayEnabled: false,
			lowQuotaEnabled: false,
			lowQuotaRemainingPercent: 10,
			resetNotifyEnabled: false,
		});
		jest.advanceTimersByTime(300_000);
		await settle();

		expect(fetchCalls).toHaveLength(1);
		expect(service.pendingTimerCount).toBe(0);
		service.stop();
	});

	test("a deleted profile stops being polled", async () => {
		await enableWindowed();
		const service = makeService();
		await service.start();
		jest.advanceTimersByTime(0);
		await settle();

		profiles.delete(profileId);
		jest.advanceTimersByTime(300_000);
		await settle();

		expect(fetchCalls).toHaveLength(1);
		expect(service.pendingTimerCount).toBe(0);
		service.stop();
	});
});

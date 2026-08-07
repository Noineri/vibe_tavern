import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createDb, ProxyStore, QuotaStore, ProviderStore, type AppDb } from "@vibe-tavern/db";
import {
	EventBus,
	PROVIDER_QUOTA_KIND,
	PROVIDER_QUOTA_WINDOW_KIND,
	type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { QuotaService } from "../src/domain/quota/quota-service.js";

const WINDOWED_CONFIG = {
	kind: PROVIDER_QUOTA_KIND.windowed,
	displayEnabled: true,
	lowQuotaEnabled: true,
	lowQuotaRemainingPercent: 25,
	resetNotifyEnabled: true,
	pollIntervalMinutes: 2,
};

function snapshotFor(profileId: string): WindowedProviderQuotaSnapshot {
	return {
		kind: PROVIDER_QUOTA_KIND.windowed,
		providerProfileId: profileId,
		capabilityId: "zai",
		capabilityVersion: 1,
		observedAt: "2026-08-07T10:00:00.000Z",
		windows: [{ kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "5h", usedPercent: 80, resetsAt: "2026-08-07T14:00:00.000Z" }],
	};
}

describe("quota resync on provider profile lifecycle", () => {
	let db: AppDb;
	let quota: QuotaStore;
	let providers: ProviderStore;
	let events: EventBus;
	let service: QuotaService;
	let profileService: ReturnType<typeof createProviderProfileService>;
	let fetchCalls: string[];
	let profileId: string;

	beforeEach(async () => {
		jest.useFakeTimers();
		db = await createDb(":memory:");
		quota = new QuotaStore(db);
		providers = new ProviderStore(db);
		events = new EventBus();
		fetchCalls = [];

		profileService = createProviderProfileService(providers, new ProxyStore(db), events);
		service = new QuotaService({
			quota,
			profiles: profileService,
			events,
			resolveFetch: async () => (async (input: string | URL | Request) => {
				fetchCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
				return new Response("{}", { status: 500 });
			}) as typeof fetch,
			now: () => new Date("2026-08-07T10:00:00.000Z"),
			random: () => 0.5,
		});

		const created = await profileService.saveProviderProfile({
			name: "ZAI",
			providerPreset: "zai",
			endpoint: "https://api.z.ai/api/paas/v4",
			apiKey: "sk-first",
		});
		profileId = created.id;
		await quota.upsertSettings(profileId, WINDOWED_CONFIG);
		await quota.upsertSnapshot(profileId, {
			snapshot: snapshotFor(profileId),
			transitionState: {
				capabilityId: "zai",
				capabilityVersion: 1,
				thresholdPercent: 25,
				lowQuotaEnabled: true,
				observedAt: "2026-08-07T10:00:00.000Z",
				windows: {},
			},
			lastError: null,
		});
		await quota.recordEvent({
			kind: "low_remaining",
			eventId: `${profileId}:zai:session:low_remaining:2026-08-07T14:00:00.000Z`,
			providerProfileId: profileId,
			capabilityId: "zai",
			windowKind: PROVIDER_QUOTA_WINDOW_KIND.session,
			windowLabel: "5h",
			usedPercent: 80,
			remainingPercent: 20,
			thresholdPercent: 25,
			resetsAt: "2026-08-07T14:00:00.000Z",
			crossing: "observed",
			observedAt: "2026-08-07T10:00:00.000Z",
		});

		await service.start();
	});

	afterEach(() => {
		service.stop();
		jest.useRealTimers();
	});

	/** Let the event handler's awaits run — the bus is fire-and-forget. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	}

	test("a cosmetic rename keeps the snapshot and the notification history", async () => {
		await profileService.updateProviderProfile(profileId, { name: "ZAI renamed" });
		await settle();

		expect(await quota.getSnapshot(profileId)).not.toBeNull();
		expect(await quota.listEvents(profileId)).toHaveLength(1);
		expect((await quota.getSettings(profileId))?.config).toEqual(WINDOWED_CONFIG);
	});

	test("switching the preset windowed → balance drops the thresholds and the snapshot", async () => {
		await profileService.updateProviderProfile(profileId, {
			providerPreset: "deepseek",
			endpoint: "https://api.deepseek.com",
		});
		await settle();

		expect((await quota.getSettings(profileId))?.config).toEqual({
			kind: PROVIDER_QUOTA_KIND.balance,
			displayEnabled: true,
			pollIntervalMinutes: WINDOWED_CONFIG.pollIntervalMinutes,
		});
		expect(await quota.getSnapshot(profileId)).toBeNull();
	});

	test("an API-key change clears the snapshot AND the notification ledger", async () => {
		await profileService.updateProviderProfile(profileId, { apiKey: "sk-second" });
		await settle();

		expect(await quota.getSnapshot(profileId)).toBeNull();
		expect(await quota.listEvents(profileId)).toHaveLength(0);
	});

	test("a preset change within the same kind keeps the config but rebaselines the snapshot", async () => {
		await profileService.updateProviderProfile(profileId, {
			providerPreset: "kimi",
			endpoint: "https://api.kimi.com/coding/v1",
		});
		await settle();

		expect((await quota.getSettings(profileId))?.config).toEqual(WINDOWED_CONFIG);
		expect(await quota.getSnapshot(profileId)).toBeNull();
		expect(await quota.listEvents(profileId)).toHaveLength(1);
	});

	test("deleting the profile stops the timer and cascades every quota row", async () => {
		await profileService.deleteProviderProfile(profileId);
		await settle();

		expect(service.pendingTimerCount).toBe(0);
		expect(await quota.getSettings(profileId)).toBeNull();
		expect(await quota.getSnapshot(profileId)).toBeNull();
		expect(await quota.listEvents(profileId)).toHaveLength(0);

		const before = fetchCalls.length;
		jest.advanceTimersByTime(3_600_000);
		await settle();
		expect(fetchCalls).toHaveLength(before);
	});

	test("a profile edited onto an unsupported provider stops being polled", async () => {
		await profileService.updateProviderProfile(profileId, {
			providerPreset: "groq",
			endpoint: "https://api.groq.com/openai/v1",
		});
		await settle();

		expect((await quota.getSettings(profileId))?.config).toEqual({
			kind: PROVIDER_QUOTA_KIND.none,
		});
		expect(service.pendingTimerCount).toBe(0);
	});

	test("stop() unsubscribes — a later edit does not resurrect polling", async () => {
		service.stop();
		await profileService.updateProviderProfile(profileId, { apiKey: "sk-third" });
		await settle();

		expect(service.pendingTimerCount).toBe(0);
		// The subscription is gone, so nothing touched the stored snapshot.
		expect(await quota.getSnapshot(profileId)).not.toBeNull();
	});
});

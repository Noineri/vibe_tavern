import { describe, expect, test } from "bun:test";
import type { QuotaStore } from "@vibe-tavern/db";
import { EventBus } from "@vibe-tavern/domain";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { QuotaService } from "../src/domain/quota/quota-service.js";
import { strictTestDouble } from "./strict-test-double.js";

// Regression pin (incident 2026-08-21): the poll timer callback ran
// `void this.pollProfile(profileId)` — pollProfile's internal try/catch covers
// only the fetch/apply phase, so a rejection thrown by the PRE-try store calls
// (getProviderProfile / getSettings / the no-capability upsertSnapshot) escaped
// as an unhandled promise rejection, and bun killed the whole server process
// on it (a live instance died exactly this way on SQLITE_BUSY from the quota
// snapshot insert). The timer callback must observe the rejection and log it.
//
// This test triggers exactly that pre-try rejection. bun:test fails the run on
// an unhandled rejection, so reaching the final expect() means the guard held.

function makeService(profileLookup: () => Promise<never>): QuotaService {
	// Minimal store stubs, labeled-miss strict doubles: only listSettings
	// (start) and getProviderProfile (poll, pre-try) run; everything else on
	// either seam throws a labeled miss instead of reading undefined.
	const quota = strictTestDouble<QuotaStore>(
		{
			listSettings: async () => [
				{
					providerProfileId: "prof_poll_crash",
					config: {
						kind: "windowed",
						displayEnabled: true,
						lowQuotaEnabled: true,
						lowQuotaRemainingPercent: 25,
						resetNotifyEnabled: true,
						pollIntervalMinutes: 2,
					},
					createdAt: "2026-08-21T21:07:42.000Z",
					updatedAt: "2026-08-21T21:07:42.000Z",
				},
			],
		},
		"QuotaStore (poll-crash-guard)",
	);
	const profiles = strictTestDouble<ProviderProfileService>(
		{
			getProviderProfile: profileLookup,
		},
		"ProviderProfileService (poll-crash-guard)",
	);
	return new QuotaService({
		quota,
		profiles,
		events: new EventBus(),
		now: () => new Date("2026-08-21T21:07:42.000Z"),
		random: () => 0.5,
	});
}

describe("QuotaService: poll timer crash guard", () => {
	test("a pre-try poll rejection never becomes an unhandled rejection", async () => {
		const service = makeService(async () => {
			throw new Error("SQLITE_BUSY: database is locked");
		});
		await service.start(); // listSettings → schedule(profileId, 0)
		// Let the timer fire and the rejection propagate through the (unguarded
		// on the broken build) promise chain. Without the guard bun:test dies
		// on the unhandled rejection before this line.
		await Bun.sleep(50);
		await service.stop();
		expect(true).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PROVIDER_QUOTA_KIND } from "@vibe-tavern/domain";
import { deepseekQuotaAdapter } from "../src/domain/quota/adapters/deepseek-quota.js";
import { kimiQuotaAdapter } from "../src/domain/quota/adapters/kimi-quota.js";
import { moonshotQuotaAdapter } from "../src/domain/quota/adapters/moonshot-quota.js";
import { nanogptQuotaAdapter } from "../src/domain/quota/adapters/nanogpt-quota.js";
import { openrouterQuotaAdapter } from "../src/domain/quota/adapters/openrouter-quota.js";
import { zaiQuotaAdapter } from "../src/domain/quota/adapters/zai-quota.js";
import { QUOTA_ADAPTERS } from "../src/domain/quota/quota-registry.js";
import type {
	QuotaCapabilityAdapter,
	QuotaRequestResult,
	QuotaResponseJson,
} from "../src/domain/quota/quota-capability-types.js";

const FIXTURES = join(import.meta.dir, "fixtures", "quota");

async function fixture(name: string): Promise<QuotaResponseJson> {
	const json: QuotaResponseJson = await Bun.file(join(FIXTURES, `${name}.json`)).json();
	return json;
}

/** Run an adapter exactly as the poller does: build requests, pair each with its body. */
async function normalizeWith(
	adapter: QuotaCapabilityAdapter,
	baseUrl: string,
	bodies: Readonly<Record<string, string>>,
) {
	const specs = adapter.buildRequests(baseUrl, "sk-test");
	const results: QuotaRequestResult[] = [];
	for (const spec of specs) {
		const name = bodies[spec.id];
		if (name === undefined) continue;
		results.push({ spec, json: await fixture(name) });
	}
	return adapter.normalize(results);
}

describe("zai adapter", () => {
	test("derives the monitor URL from the profile origin, not its chat path", () => {
		const specs = zaiQuotaAdapter.buildRequests("https://api.z.ai/api/coding/paas/v4", "sk-test");
		expect(specs).toHaveLength(1);
		expect(specs[0]!.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
		expect(specs[0]!.headers.Authorization).toBe("Bearer sk-test");
	});

	test("normalizes the live fixture into session / weekly / extra windows", async () => {
		const reading = await normalizeWith(zaiQuotaAdapter, "https://api.z.ai/api/paas/v4", { usage: "zai" });
		// TOKENS_LIMIT records carry ONLY `percentage`; the TIME_LIMIT record carries
		// the counted triple. Both paths are exercised here, and the plan tier stands
		// in for the `planName` the live API does not send.
		expect(reading.windows).toEqual([
			{ kind: "session", label: "pro", usedPercent: 41, resetsAt: null },
			{ kind: "weekly", label: "pro", usedPercent: 12, resetsAt: "2026-08-13T10:30:42.998Z" },
			{ kind: "extra", label: "pro", usedPercent: 25, resetsAt: "2026-08-11T10:30:42.993Z" },
		]);
		expect(reading.balances).toBeUndefined();
	});

	test("a counted TOKENS_LIMIT beats its own percentage field", () => {
		const reading = zaiQuotaAdapter.normalize([{
			spec: zaiQuotaAdapter.buildRequests("https://api.z.ai/api/paas/v4", "sk")[0]!,
			json: {
				data: {
					// The plan name is an account-level field, not a per-record one.
					planName: "GLM Coding Pro",
					limits: [{
						type: "TOKENS_LIMIT",
						unit: 3,
						number: 5,
						usage: 200,
						currentValue: 50,
						percentage: 99,
					}],
				},
			},
		}]);
		expect(reading.windows).toEqual([
			{ kind: "session", label: "GLM Coding Pro", usedPercent: 25, resetsAt: null },
		]);
	});

	test("a window with no usage figure at all is dropped, never rendered as 0%", () => {
		const reading = zaiQuotaAdapter.normalize([{
			spec: zaiQuotaAdapter.buildRequests("https://api.z.ai/api/paas/v4", "sk")[0]!,
			json: { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5 }] } },
		}]);
		expect(reading.windows).toEqual([]);
	});

	test("a response with no limits array at all is a state, not a parse failure", () => {
		const reading = zaiQuotaAdapter.normalize([{
			spec: zaiQuotaAdapter.buildRequests("https://api.z.ai/api/paas/v4", "sk")[0]!,
			json: { code: 200, success: true, data: { level: "lite" } },
		}]);
		expect(reading.windows).toEqual([]);
	});

	test("an unknown unit enum drops that window without losing the others", () => {
		const reading = zaiQuotaAdapter.normalize([{
			spec: zaiQuotaAdapter.buildRequests("https://api.z.ai/api/paas/v4", "sk")[0]!,
			json: {
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", unit: 99, number: 1, usage: 10, currentValue: 1 },
						{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 200, currentValue: 50 },
					],
				},
			},
		}]);
		// A sixth unit enum must cost that ONE window, not the whole reading.
		expect(reading.windows).toEqual([
			{ kind: "session", label: "TOKENS_LIMIT", usedPercent: 25, resetsAt: null },
		]);
	});

	test("remaining and currentValue disagreeing takes the larger consumed figure", () => {
		const reading = zaiQuotaAdapter.normalize([{
			spec: zaiQuotaAdapter.buildRequests("https://api.z.ai/api/paas/v4", "sk")[0]!,
			// remaining says 60 used, currentValue says 90 — CodexBar trusts the larger.
			json: {
				data: {
					limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 200, remaining: 140, currentValue: 90 }],
				},
			},
		}]);
		expect(reading.windows?.[0]?.usedPercent).toBe(45);
	});

	test("the plan name is taken from whichever alias the account carries", () => {
		const reading = zaiQuotaAdapter.normalize([{
			spec: zaiQuotaAdapter.buildRequests("https://api.z.ai/api/paas/v4", "sk")[0]!,
			json: {
				data: {
					packageName: "  GLM Coding Max  ",
					level: "pro",
					limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10 }],
				},
			},
		}]);
		expect(reading.windows?.[0]?.label).toBe("GLM Coding Max");
	});

	test("a missing data envelope is a zod error, not a zero reading", () => {
		expect(() => zaiQuotaAdapter.normalize([{
			spec: zaiQuotaAdapter.buildRequests("https://api.z.ai/api/paas/v4", "sk")[0]!,
			json: { code: 200 },
		}])).toThrow();
	});
});

describe("kimi adapter", () => {
	test("builds the usages URL under the profile base", () => {
		const specs = kimiQuotaAdapter.buildRequests("https://api.kimi.com/coding/v1", "sk-test");
		expect(specs[0]!.url).toBe("https://api.kimi.com/coding/v1/usages");
	});

	test("reads the top-level usage as the weekly quota and limits[] as rate windows", async () => {
		const reading = await normalizeWith(kimiQuotaAdapter, "https://api.kimi.com/coding/v1", { usages: "kimi" });
		// The live shape: `usage` has used+remaining, the rate window has ONLY
		// remaining, and both are string numerics.
		expect(reading.windows).toEqual([
			{ kind: "session", label: "5 h", usedPercent: 20, resetsAt: "2026-08-08T01:00:09.000Z" },
			{ kind: "weekly", label: "Weekly", usedPercent: 55, resetsAt: "2026-08-08T20:00:09.000Z" },
		]);
	});

	test("a response with only limits[] and no top-level usage still reads", () => {
		const reading = kimiQuotaAdapter.normalize([{
			spec: kimiQuotaAdapter.buildRequests("https://api.kimi.com/coding/v1", "sk")[0]!,
			json: {
				limits: [{
					window: { duration: "5", timeUnit: "TIME_UNIT_HOUR" },
					detail: { limit: "200", used: "50", resetAt: "2026-08-08T13:30:00Z" },
				}],
			},
		}]);
		expect(reading.windows).toEqual([
			{ kind: "session", label: "5 h", usedPercent: 25, resetsAt: "2026-08-08T13:30:00.000Z" },
		]);
	});

	test("a remaining outside 0..limit is refused rather than read as a percentage", () => {
		expect(() => kimiQuotaAdapter.normalize([{
			spec: kimiQuotaAdapter.buildRequests("https://api.kimi.com/coding/v1", "sk")[0]!,
			json: { usage: { limit: "100", remaining: "500" } },
		}])).toThrow(/usable limit\/used pair/);
	});

	test("garbage in a string numeric throws instead of reading as zero", () => {
		expect(() => kimiQuotaAdapter.normalize([{
			spec: kimiQuotaAdapter.buildRequests("https://api.kimi.com/coding/v1", "sk")[0]!,
			json: {
				limits: [{
					window: { duration: "5", timeUnit: "TIME_UNIT_HOUR" },
					detail: { limit: "", used: "n/a" },
				}],
			},
		}])).toThrow(/Not a number/);
	});
});

describe("nanogpt adapter", () => {
	test("issues both requests, the balance one with x-api-key", () => {
		const specs = nanogptQuotaAdapter.buildRequests("https://nano-gpt.com/api/v1", "sk-test");
		expect(specs.map((spec) => `${spec.method} ${spec.url}`)).toEqual([
			"GET https://nano-gpt.com/api/subscription/v1/usage",
			"POST https://nano-gpt.com/api/check-balance",
		]);
		expect(specs[1]!.headers["x-api-key"]).toBe("sk-test");
	});

	test("converts the percentUsed fraction and folds in the wallet balance", async () => {
		const reading = await normalizeWith(nanogptQuotaAdapter, "https://nano-gpt.com/api/v1", {
			usage: "nanogpt-usage",
			balance: "nanogpt-balance",
		});
		// The live plan meters weekly tokens and daily images; `dailyInputTokens` is
		// null for it, so the image window is free to take the `daily` slot.
		expect(reading.windows).toEqual([
			{
				kind: "weekly",
				label: "Weekly input tokens",
				usedPercent: 0.8578250000000001,
				resetsAt: "2026-08-10T00:00:00.000Z",
			},
			{ kind: "daily", label: "Daily images", usedPercent: 25, resetsAt: "2026-08-08T00:00:00.000Z" },
		]);
		expect(reading.balances).toEqual([
			{ kind: "available", unit: "usd", amount: "12.3456", primary: true },
		]);
	});

	test("a daily token window pushes the image window to `extra`", () => {
		const specs = nanogptQuotaAdapter.buildRequests("https://nano-gpt.com/api/v1", "sk");
		const reading = nanogptQuotaAdapter.normalize([{
			spec: specs[0]!,
			json: {
				dailyInputTokens: { percentUsed: 0.5, resetAt: 1786147200000 },
				dailyImages: { percentUsed: 0.1, resetAt: 1786147200000 },
			},
		}]);
		expect(reading.windows?.map((window) => window.kind)).toEqual(["daily", "extra"]);
	});

	test("a pay-as-you-go key with no windows still reports its wallet", () => {
		const specs = nanogptQuotaAdapter.buildRequests("https://nano-gpt.com/api/v1", "sk");
		const reading = nanogptQuotaAdapter.normalize([
			{ spec: specs[0]!, json: { active: false, dailyInputTokens: null, weeklyInputTokens: null } },
			{ spec: specs[1]!, json: { usd_balance: "3.5" } },
		]);
		expect(reading.windows).toEqual([]);
		expect(reading.balances).toEqual([{ kind: "available", unit: "usd", amount: "3.5", primary: true }]);
	});

	test("a response carrying neither a window nor a balance throws", () => {
		const spec = nanogptQuotaAdapter.buildRequests("https://nano-gpt.com/api/v1", "sk")[0]!;
		expect(() => nanogptQuotaAdapter.normalize([{ spec, json: {} }]))
			.toThrow(/neither a usage window nor a balance/);
	});
});

describe("moonshot adapter", () => {
	test("builds the balance URL under the profile base", () => {
		const specs = moonshotQuotaAdapter.buildRequests("https://api.moonshot.ai/v1", "sk-test");
		expect(specs[0]!.url).toBe("https://api.moonshot.ai/v1/users/me/balance");
	});

	test("maps available to primary and voucher/cash to breakdown rows", async () => {
		const reading = await normalizeWith(moonshotQuotaAdapter, "https://api.moonshot.ai/v1", { balance: "moonshot" });
		expect(reading.windows).toBeUndefined();
		expect(reading.balances).toEqual([
			{ kind: "available", unit: "usd", amount: "49.5", primary: true },
			{ kind: "voucher", unit: "usd", amount: "0", primary: false },
			{ kind: "cash", unit: "usd", amount: "49.5", primary: false },
		]);
	});

	test("the China host settles in yuan, the international one in dollars", async () => {
		// The payload carries no currency field — the host is the only signal.
		const china = await normalizeWith(moonshotQuotaAdapter, "https://api.moonshot.cn/v1", { balance: "moonshot" });
		expect(china.balances?.map((balance) => balance.unit)).toEqual(["cny", "cny", "cny"]);
	});

	test("a 200 response reporting failure in its envelope throws", () => {
		const spec = moonshotQuotaAdapter.buildRequests("https://api.moonshot.ai/v1", "sk")[0]!;
		expect(() => moonshotQuotaAdapter.normalize([{
			spec,
			json: { code: 40001, status: false, scode: "0x1", data: { available_balance: 0 } },
		}])).toThrow(/reported failure/);
	});
});

describe("deepseek adapter", () => {
	test("keeps vendor decimal strings byte-for-byte", async () => {
		const reading = await normalizeWith(deepseekQuotaAdapter, "https://api.deepseek.com", { balance: "deepseek" });
		expect(reading.balances).toEqual([
			{ kind: "total", unit: "cny", amount: "110.00", primary: true },
			{ kind: "granted", unit: "cny", amount: "10.00", primary: false },
			{ kind: "topped_up", unit: "cny", amount: "100.00", primary: false },
		]);
	});

	test("an unknown currency throws rather than guessing a unit", () => {
		const spec = deepseekQuotaAdapter.buildRequests("https://api.deepseek.com", "sk")[0]!;
		expect(() => deepseekQuotaAdapter.normalize([{
			spec,
			json: { balance_infos: [{ currency: "XBT", total_balance: "1.00" }] },
		}])).toThrow(/Unknown DeepSeek balance currency/);
	});
});

describe("openrouter adapter", () => {
	test("issues the key and credits requests", () => {
		const specs = openrouterQuotaAdapter.buildRequests("https://openrouter.ai/api/v1", "sk-test");
		expect(specs.map((spec) => spec.url)).toEqual([
			"https://openrouter.ai/api/v1/key",
			"https://openrouter.ai/api/v1/credits",
		]);
	});

	test("reports a spend-limit window with no reset and a float-clean credit balance", async () => {
		const reading = await normalizeWith(openrouterQuotaAdapter, "https://openrouter.ai/api/v1", {
			key: "openrouter-key",
			credits: "openrouter-credits",
		});
		expect(reading.windows).toEqual([
			{ kind: "spend_limit", label: "vibe-tavern", usedPercent: 30, resetsAt: null },
		]);
		// 25.1 - 24.8 is 0.29999999999999716 in IEEE-754; the adapter must not ship that.
		expect(reading.balances).toEqual([
			{ kind: "credits", unit: "credits", amount: "0.3", primary: true },
		]);
	});

	test("a key with no spend cap yields zero windows and still reports the balance", async () => {
		const specs = openrouterQuotaAdapter.buildRequests("https://openrouter.ai/api/v1", "sk");
		const reading = openrouterQuotaAdapter.normalize([
			{ spec: specs[0]!, json: { data: { limit: null, usage: 3 } } },
			{ spec: specs[1]!, json: await fixture("openrouter-credits") },
		]);
		expect(reading.windows).toEqual([]);
		expect(reading.balances).toHaveLength(1);
	});

	test("limit_remaining is authoritative over the cumulative usage figure", () => {
		const specs = openrouterQuotaAdapter.buildRequests("https://openrouter.ai/api/v1", "sk");
		// `usage` is lifetime spend; only `limit_remaining` describes the cap window.
		const reading = openrouterQuotaAdapter.normalize([{
			spec: specs[0]!,
			json: { data: { limit: 50, usage: 900, limit_remaining: 40 } },
		}]);
		expect(reading.windows?.[0]?.usedPercent).toBe(20);
	});

	test("without limit_remaining the usage bucket matching limit_reset is used", () => {
		const specs = openrouterQuotaAdapter.buildRequests("https://openrouter.ai/api/v1", "sk");
		// Charging a DAILY cap with lifetime usage would read as permanently exhausted.
		const reading = openrouterQuotaAdapter.normalize([{
			spec: specs[0]!,
			json: {
				data: { limit: 10, usage: 900, limit_reset: "daily", usage_daily: 2, usage_weekly: 8 },
			},
		}]);
		expect(reading.windows?.[0]?.usedPercent).toBe(20);
	});

	test("an overspent key clamps to a full bar instead of exceeding it", () => {
		const specs = openrouterQuotaAdapter.buildRequests("https://openrouter.ai/api/v1", "sk");
		const reading = openrouterQuotaAdapter.normalize([{
			spec: specs[0]!,
			json: { data: { limit: 50, limit_remaining: -12 } },
		}]);
		expect(reading.windows?.[0]?.usedPercent).toBe(100);
	});

	test("a zero limit is 'no cap configured', not a fully consumed one", () => {
		const specs = openrouterQuotaAdapter.buildRequests("https://openrouter.ai/api/v1", "sk");
		const reading = openrouterQuotaAdapter.normalize([{ spec: specs[0]!, json: { data: { limit: 0, usage: 5 } } }]);
		expect(reading.windows).toEqual([]);
	});

	test("an overspent account reports zero credits, never a negative balance", () => {
		const specs = openrouterQuotaAdapter.buildRequests("https://openrouter.ai/api/v1", "sk");
		const reading = openrouterQuotaAdapter.normalize([
			{ spec: specs[0]!, json: { data: { limit: null } } },
			{ spec: specs[1]!, json: { data: { total_credits: 10, total_usage: 14.5 } } },
		]);
		expect(reading.balances).toEqual([{ kind: "credits", unit: "credits", amount: "0", primary: true }]);
	});
});

describe("origin allowlist", () => {
	test.each([
		["zai", zaiQuotaAdapter, "https://evil.example/api/paas/v4"],
		["kimi", kimiQuotaAdapter, "https://evil.example/coding/v1"],
		["moonshot", moonshotQuotaAdapter, "https://evil.example/v1"],
		["deepseek", deepseekQuotaAdapter, "https://evil.example"],
		["openrouter", openrouterQuotaAdapter, "https://evil.example/api/v1"],
	])("%s refuses to send the key to a rewritten host", (_name, adapter, hostileBaseUrl) => {
		expect(() => adapter.buildRequests(hostileBaseUrl, "sk-secret")).toThrow(/is not allowed for this adapter/);
	});

	test("nanogpt ignores the profile endpoint entirely — its URLs are fixed", () => {
		const specs = nanogptQuotaAdapter.buildRequests("https://evil.example/api/v1", "sk-secret");
		expect(specs.every((spec) => spec.url.startsWith("https://nano-gpt.com/"))).toBe(true);
	});

	test("a non-URL endpoint throws instead of building a relative request", () => {
		expect(() => zaiQuotaAdapter.buildRequests("not a url", "sk")).toThrow(/is not a URL/);
	});
});

describe("adapter parity", () => {
	test("every shipped adapter declares the same required surface", () => {
		for (const adapter of QUOTA_ADAPTERS) {
			expect(adapter.id).toBeTruthy();
			expect(adapter.version).toBeGreaterThanOrEqual(1);
			expect([PROVIDER_QUOTA_KIND.windowed, PROVIDER_QUOTA_KIND.balance]).toContain(adapter.kind);
			expect(adapter.presetIds.length).toBeGreaterThan(0);
			expect(adapter.allowedRequestOrigins.length).toBeGreaterThan(0);
			expect(adapter.pollIntervalMs).toBeGreaterThanOrEqual(60_000);
			expect(adapter.requestTimeoutMs).toBeGreaterThan(0);
		}
	});

	test("adapter ids are unique", () => {
		const ids = QUOTA_ADAPTERS.map((adapter) => adapter.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("no built request ever carries the API key in its URL", () => {
		for (const adapter of QUOTA_ADAPTERS) {
			const baseUrl = `${adapter.allowedRequestOrigins[0]!}/v1`;
			for (const spec of adapter.buildRequests(baseUrl, "sk-secret-value")) {
				expect(spec.url).not.toContain("sk-secret-value");
			}
		}
	});
});

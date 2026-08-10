import { describe, expect, test } from "bun:test";
import {
  PROVIDER_BALANCE_KIND,
  PROVIDER_BALANCE_UNIT,
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_NONE_REASON,
  PROVIDER_QUOTA_WINDOW_KIND,
  type BalanceProviderQuotaSnapshot,
  type NoProviderQuotaSnapshot,
  type ProviderQuotaConfig,
  type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import {
  canonicalDecimalSchema,
  canonicalUtcInstantSchema,
  providerQuotaConfigSchema,
  providerQuotaSnapshotSchema,
} from "../src/schemas/provider-quota-schema.js";

// Derived from the verified vendor shapes (Z.AI monitor quota, Kimi /usages).
const ZAI_SNAPSHOT = {
  kind: "windowed",
  providerProfileId: "prov_1",
  capabilityId: "zai",
  capabilityVersion: 1,
  observedAt: "2026-08-07T10:00:00.000Z",
  windows: [
    { kind: "session", label: "GLM Coding Pro", usedPercent: 41.5, resetsAt: "2026-08-07T14:00:00.000Z" },
    { kind: "weekly", label: "GLM Coding Pro", usedPercent: 12, resetsAt: "2026-08-11T00:00:00.000Z" },
  ],
} satisfies WindowedProviderQuotaSnapshot;

const KIMI_SNAPSHOT = {
  kind: "windowed",
  providerProfileId: "prov_2",
  capabilityId: "kimi",
  capabilityVersion: 1,
  observedAt: "2026-08-07T10:00:00.000Z",
  windows: [
    { kind: "session", label: "5 hours", usedPercent: 88, resetsAt: "2026-08-07T13:30:00.000Z" },
  ],
} satisfies WindowedProviderQuotaSnapshot;

const OPENROUTER_SNAPSHOT = {
  kind: "windowed",
  providerProfileId: "prov_3",
  capabilityId: "openrouter",
  capabilityVersion: 1,
  observedAt: "2026-08-07T10:00:00.000Z",
  windows: [
    { kind: "spend_limit", label: "Key limit", usedPercent: 30, resetsAt: null },
  ],
  balances: [
    { kind: "credits", unit: "credits", amount: "12.34", primary: true },
  ],
} satisfies WindowedProviderQuotaSnapshot;

const MOONSHOT_SNAPSHOT = {
  kind: "balance",
  providerProfileId: "prov_4",
  capabilityId: "moonshot",
  capabilityVersion: 1,
  observedAt: "2026-08-07T10:00:00.000Z",
  balances: [
    { kind: "available", unit: "cny", amount: "49.50", primary: true },
    { kind: "voucher", unit: "cny", amount: "0", primary: false },
    { kind: "cash", unit: "cny", amount: "49.50", primary: false },
  ],
} satisfies BalanceProviderQuotaSnapshot;

const NONE_SNAPSHOT = {
  kind: "none",
  providerProfileId: "prov_5",
  reason: "not_exposed",
} satisfies NoProviderQuotaSnapshot;

describe("canonicalUtcInstantSchema", () => {
  test("accepts what toISOString emits", () => {
    expect(canonicalUtcInstantSchema.parse(new Date(0).toISOString())).toBe("1970-01-01T00:00:00.000Z");
  });

  test.each([
    ["2026-08-07T10:00:00Z", "no milliseconds"],
    ["2026-08-07T10:00:00.000+02:00", "offset instead of Z"],
    ["2026-08-07 10:00:00.000Z", "space separator"],
    ["1786123865000", "epoch millis"],
  ])("rejects %s (%s)", (value) => {
    expect(canonicalUtcInstantSchema.safeParse(value).success).toBe(false);
  });
});

describe("canonicalDecimalSchema", () => {
  test.each(["0", "12", "12.5", "49.50", "-3.25", "0.00000001"])("accepts %s", (value) => {
    expect(canonicalDecimalSchema.parse(value)).toBe(value);
  });

  test.each([
    ["0.30000000000000004", "float artifact — more than 8 fractional digits"],
    ["-0", "negative zero"],
    ["-0.000", "negative zero, padded"],
    ["007.5", "leading zero padding"],
    ["1e3", "exponent notation"],
    ["1.", "trailing dot"],
    ["", "empty"],
    ["12,5", "comma decimal separator"],
  ])("rejects %s (%s)", (value) => {
    expect(canonicalDecimalSchema.safeParse(value).success).toBe(false);
  });
});

describe("providerQuotaSnapshotSchema round-trip", () => {
  test("Z.AI two-window snapshot parses to the domain type", () => {
    const parsed = providerQuotaSnapshotSchema.parse(ZAI_SNAPSHOT);
    expect(parsed).toEqual(ZAI_SNAPSHOT);
    expect(ZAI_SNAPSHOT.windows).toHaveLength(2);
  });

  test("Kimi single-window snapshot parses", () => {
    expect(providerQuotaSnapshotSchema.parse(KIMI_SNAPSHOT)).toEqual(KIMI_SNAPSHOT);
  });

  test("OpenRouter spend-limit window keeps a null resetsAt and carries balances", () => {
    const parsed = providerQuotaSnapshotSchema.parse(OPENROUTER_SNAPSHOT);
    expect(parsed).toEqual(OPENROUTER_SNAPSHOT);
    expect(OPENROUTER_SNAPSHOT.windows[0].resetsAt).toBeNull();
  });

  test("Moonshot balance snapshot parses to the domain type", () => {
    const parsed = providerQuotaSnapshotSchema.parse(MOONSHOT_SNAPSHOT);
    expect(parsed).toEqual(MOONSHOT_SNAPSHOT);
    expect(MOONSHOT_SNAPSHOT.balances.filter((row) => row.primary)).toHaveLength(1);
  });

  test("none snapshot carries a reason and no timestamps", () => {
    const parsed = providerQuotaSnapshotSchema.parse(NONE_SNAPSHOT);
    expect(parsed).toEqual(NONE_SNAPSHOT);
    expect(NONE_SNAPSHOT.reason).toBe(PROVIDER_QUOTA_NONE_REASON.notExposed);
  });
});

describe("providerQuotaSnapshotSchema rejections", () => {
  function firstIssuePath(input: unknown): string {
    const result = providerQuotaSnapshotSchema.safeParse(input);
    expect(result.success).toBe(false);
    return result.success ? "" : result.error.issues[0]!.path.join(".");
  }

  test("duplicate window kinds are rejected with the offending path", () => {
    const path = firstIssuePath({
      ...ZAI_SNAPSHOT,
      windows: [
        { kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "a", usedPercent: 10, resetsAt: null },
        { kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "b", usedPercent: 20, resetsAt: null },
      ],
    });
    expect(path).toBe("windows.1.kind");
  });

  test("two primary balances are rejected", () => {
    const path = firstIssuePath({
      ...MOONSHOT_SNAPSHOT,
      balances: [
        { kind: PROVIDER_BALANCE_KIND.available, unit: PROVIDER_BALANCE_UNIT.cny, amount: "1", primary: true },
        { kind: PROVIDER_BALANCE_KIND.cash, unit: PROVIDER_BALANCE_UNIT.cny, amount: "1", primary: true },
      ],
    });
    expect(path).toBe("balances");
  });

  test("zero primary balances is rejected", () => {
    const path = firstIssuePath({
      ...MOONSHOT_SNAPSHOT,
      balances: [
        { kind: PROVIDER_BALANCE_KIND.available, unit: PROVIDER_BALANCE_UNIT.cny, amount: "1", primary: false },
      ],
    });
    expect(path).toBe("balances");
  });

  test("a float artifact in a balance amount is rejected", () => {
    const path = firstIssuePath({
      ...MOONSHOT_SNAPSHOT,
      balances: [
        { kind: PROVIDER_BALANCE_KIND.available, unit: PROVIDER_BALANCE_UNIT.usd, amount: "0.30000000000000004", primary: true },
      ],
    });
    expect(path).toBe("balances.0.amount");
  });

  test("unknown keys are rejected (strict objects)", () => {
    expect(providerQuotaSnapshotSchema.safeParse({ ...KIMI_SNAPSHOT, planName: "pro" }).success).toBe(false);
  });

  test("a windowed snapshot with no windows is accepted — a key with no cap is a real state", () => {
    expect(providerQuotaSnapshotSchema.safeParse({ ...KIMI_SNAPSHOT, windows: [] }).success).toBe(true);
  });

  test("a none snapshot may not carry an observedAt", () => {
    expect(providerQuotaSnapshotSchema.safeParse({ ...NONE_SNAPSHOT, observedAt: "2026-08-07T10:00:00.000Z" }).success).toBe(false);
  });

  test("usedPercent outside 0..100 is rejected", () => {
    expect(firstIssuePath({
      ...KIMI_SNAPSHOT,
      windows: [{ kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "x", usedPercent: 101, resetsAt: null }],
    })).toBe("windows.0.usedPercent");
  });
});

describe("providerQuotaConfigSchema", () => {
  test("the windowed config is exactly the three toggles plus the poll period", () => {
    const config = {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: 10,
      resetNotifyEnabled: false,
      pollIntervalMinutes: 5,
    };
    const parsed: ProviderQuotaConfig = providerQuotaConfigSchema.parse(config);
    expect(parsed).toEqual(config);
    expect(Object.keys(config)).toHaveLength(6);
  });

  test("the balance config has display plus the poll period — notification keys are rejected", () => {
    const config = { kind: PROVIDER_QUOTA_KIND.balance, displayEnabled: true, pollIntervalMinutes: 3 };
    expect(providerQuotaConfigSchema.parse(config)).toEqual(config);
    expect(providerQuotaConfigSchema.safeParse({ ...config, lowQuotaEnabled: true }).success).toBe(false);
  });

  test.each([0, 6, 2.5, -1])("poll period %p minutes is rejected", (value) => {
    const result = providerQuotaConfigSchema.safeParse({
      kind: PROVIDER_QUOTA_KIND.balance,
      displayEnabled: true,
      pollIntervalMinutes: value,
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]!.path.join(".")).toBe("pollIntervalMinutes");
  });

  test("the none config carries nothing at all", () => {
    expect(providerQuotaConfigSchema.parse({ kind: PROVIDER_QUOTA_KIND.none })).toEqual({ kind: PROVIDER_QUOTA_KIND.none });
    expect(providerQuotaConfigSchema.safeParse({ kind: PROVIDER_QUOTA_KIND.none, displayEnabled: true }).success).toBe(false);
  });

  test.each([0, 101, 10.5, -1])("threshold %p is rejected", (value) => {
    const result = providerQuotaConfigSchema.safeParse({
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: value,
      resetNotifyEnabled: false,
      pollIntervalMinutes: 5,
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]!.path.join(".")).toBe("lowQuotaRemainingPercent");
  });

  test("no endpoint or url field may be smuggled into a config", () => {
    for (const key of ["endpoint", "url", "baseUrl", "apiKey"]) {
      expect(providerQuotaConfigSchema.safeParse({
        kind: PROVIDER_QUOTA_KIND.balance,
        displayEnabled: true,
        pollIntervalMinutes: 5,
        [key]: "https://evil.example",
      }).success).toBe(false);
    }
  });
});

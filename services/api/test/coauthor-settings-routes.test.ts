import { describe, expect, test } from "bun:test";
import { createProviderRoutes } from "../src/api/routes/provider.js";
import type { ProviderRuntimeApi } from "../src/api/contract/runtime-api.js";
import type { CoauthorConnectionSettingsRecord } from "@vibe-tavern/api-contracts";
import { ProviderAdapter } from "../src/api/adapters/provider-adapter.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { CoauthorConnectionSettingsStore, ProviderStore, ProxyStore, createDb } from "@vibe-tavern/db";
import type { StoreContainer } from "@vibe-tavern/db";
import { httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";

/**
 * CG-1 route tests for the per-connection Co-Author settings endpoints
 * (GET/PUT /api/providers/:providerId/coauthor-settings), mirroring
 * provider-model-settings-routes.test.ts: mock-runtime tests pin routing +
 * zod wiring via app.request(); the real-adapter block pins the fail-closed
 * 404 for an unknown provider id and a full store round-trip through the
 * route → adapter → store stack.
 */

function mockRuntime(overrides: Partial<Pick<ProviderRuntimeApi,
  "getCoauthorConnectionSettings" |
  "upsertCoauthorConnectionSettings"
>> = {}): ProviderRuntimeApi {
  return { ...overrides } as unknown as ProviderRuntimeApi;
}

const RECORD: CoauthorConnectionSettingsRecord = {
  providerProfileId: "prov_1",
  modelName: "kimi-k2.5",
  settings: { maxTokens: 15_000, contextBudget: 1_048_576, temperature: 0.9 },
  createdAt: "t1",
  updatedAt: "t2",
};

const VALID_PUT_BODY = {
  modelName: "kimi-k2.5",
  settings: { maxTokens: 15_000, contextBudget: 1_048_576, pinContextBudget: true, temperature: 0.9 },
};

describe("provider coauthor-settings routes (mock runtime)", () => {
  test("GET → 200 + the stored record", async () => {
    const app = createProviderRoutes(mockRuntime({
      getCoauthorConnectionSettings: async () => RECORD,
    }));
    const res = await app.request("/api/providers/prov_1/coauthor-settings");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.providerProfileId).toBe("prov_1");
    expect(json.modelName).toBe("kimi-k2.5");
    expect(json.settings.maxTokens).toBe(15_000);
  });

  test("GET returns null passthrough when the connection has no saved set", async () => {
    const app = createProviderRoutes(mockRuntime({
      getCoauthorConnectionSettings: async () => null,
    }));
    const res = await app.request("/api/providers/prov_1/coauthor-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("PUT → upsert; providerId from the URL, body carried whole", async () => {
    let captured: { providerProfileId: string; body: unknown } | null = null;
    const app = createProviderRoutes(mockRuntime({
      upsertCoauthorConnectionSettings: async (providerProfileId, body) => {
        captured = { providerProfileId, body };
        return { ...RECORD, providerProfileId };
      },
    }));
    const res = await app.request("/api/providers/prov_1/coauthor-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_PUT_BODY),
    });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.providerProfileId).toBe("prov_1"); // from URL, not body
    expect(captured!.body).toEqual(VALID_PUT_BODY);
  });

  test("PUT without limits → 400 (the set is stored complete; limits are required)", async () => {
    const app = createProviderRoutes(mockRuntime());
    const res = await app.request("/api/providers/prov_1/coauthor-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "m", settings: { temperature: 0.9 } }),
    });
    expect(res.status).toBe(400);
  });

  test("PUT with a zero / negative / fractional limit → 400 (positive integers only)", async () => {
    const app = createProviderRoutes(mockRuntime());
    for (const settings of [
      { ...VALID_PUT_BODY.settings, maxTokens: 0 },
      { ...VALID_PUT_BODY.settings, contextBudget: -5 },
      { ...VALID_PUT_BODY.settings, maxTokens: 1.5 },
      { ...VALID_PUT_BODY.settings, contextBudget: null },
    ]) {
      const res = await app.request("/api/providers/prov_1/coauthor-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelName: "m", settings }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("PUT without modelName → 400 (null is the only 'no model' wire form)", async () => {
    const app = createProviderRoutes(mockRuntime());
    const res = await app.request("/api/providers/prov_1/coauthor-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: VALID_PUT_BODY.settings }),
    });
    expect(res.status).toBe(400);
  });

  test("PUT reuses the sampler validators — a bad logitBias is rejected, a good one passes", async () => {
    const app = createProviderRoutes(mockRuntime());
    const bad = await app.request("/api/providers/prov_1/coauthor-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelName: null,
        settings: { ...VALID_PUT_BODY.settings, logitBias: [{ tokenId: 1, bias: 999 }] },
      }),
    });
    expect(bad.status).toBe(400);

    let captured: unknown = null;
    const appOk = createProviderRoutes(mockRuntime({
      upsertCoauthorConnectionSettings: async (_p, body) => {
        captured = body;
        return RECORD;
      },
    }));
    const ok = await appOk.request("/api/providers/prov_1/coauthor-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelName: null,
        settings: { ...VALID_PUT_BODY.settings, logitBias: [{ tokenId: 1, bias: 5 }], samplerSetId: null },
      }),
    });
    expect(ok.status).toBe(200);
    expect(captured).toEqual({
      modelName: null,
      settings: { ...VALID_PUT_BODY.settings, logitBias: [{ tokenId: 1, bias: 5 }], samplerSetId: null },
    });
  });
});

describe("provider coauthor-settings via the real adapter", () => {
  test("unknown provider id fails closed: NotFound DomainError → HTTP 404", async () => {
    const db = await createDb(":memory:");
    const providers = new ProviderStore(db);
    const proxies = new ProxyStore(db);
    const adapter = new ProviderAdapter(
      { coauthorSettings: new CoauthorConnectionSettingsStore(db) } as unknown as StoreContainer,
      createProviderProfileService(providers, proxies),
    );

    for (const attempt of [
      () => adapter.getCoauthorConnectionSettings("prov_ghost"),
      () => adapter.upsertCoauthorConnectionSettings("prov_ghost", {
        modelName: null,
        settings: { maxTokens: 8_000, contextBudget: 128_000, pinContextBudget: false },
      }),
    ]) {
      const error = await attempt().then(
        () => null,
        (err: unknown) => err,
      );
      expect(isDomainError(error)).toBe(true);
      expect(error!.kind).toBe("NotFound");
      expect(httpStatusForDomainError(error!)).toBe(404);
    }
  });

  test("full stack round-trip: create profile → GET null → PUT → GET stored set", async () => {
    const db = await createDb(":memory:");
    const providers = new ProviderStore(db);
    const proxies = new ProxyStore(db);
    const profile = await providers.create({
      name: "ZAI",
      providerPreset: "zai",
      endpoint: "https://api.z.ai/api/paas/v4",
      apiKey: "sk-test",
    });
    const adapter = new ProviderAdapter(
      { coauthorSettings: new CoauthorConnectionSettingsStore(db) } as unknown as StoreContainer,
      createProviderProfileService(providers, proxies),
    );
    const app = createProviderRoutes(adapter);
    const url = `/api/providers/${profile.id}/coauthor-settings`;

    // No saved set yet — null, NOT an RP-profile fallback.
    const before = await app.request(url);
    expect(before.status).toBe(200);
    expect(await before.json()).toBeNull();

    const put = await app.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelName: "glm-4.7",
        settings: { maxTokens: 15_000, contextBudget: 1_048_576, pinContextBudget: true, temperature: 0.9 },
      }),
    });
    expect(put.status).toBe(200);
    const saved = await put.json();
    expect(saved.providerProfileId).toBe(profile.id);
    expect(saved.modelName).toBe("glm-4.7");

    const after = await app.request(url);
    expect(after.status).toBe(200);
    const stored = await after.json();
    expect(stored.modelName).toBe("glm-4.7");
    expect(stored.settings).toEqual({ maxTokens: 15_000, contextBudget: 1_048_576, pinContextBudget: true, temperature: 0.9 });
  });
});

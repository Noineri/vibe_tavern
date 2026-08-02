import { afterEach, describe, expect, test } from "bun:test";
import { createProviderRoutes } from "../src/api/routes/provider.js";
import { ProviderAdapter } from "../src/api/adapters/provider-adapter.js";
import type { ProviderRuntimeApi } from "../src/api/contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import {
  resetProviderFetchFactory,
  setProviderFetchFactory,
  type ProviderFetch,
  type ProviderProxyPolicy,
} from "../src/domain/providers/provider-fetch-factory.js";

function mockRuntime(overrides: Partial<Pick<ProviderRuntimeApi, "testProviderChatByProfile" | "testProviderDraft" | "fetchModelsByEndpoint" | "testProviderChatByEndpoint">>): ProviderRuntimeApi {
  return overrides as ProviderRuntimeApi;
}

afterEach(() => {
  resetProviderFetchFactory();
});

describe("profile Test: Hi transport routing", () => {
  test("passes an explicit Responses selection to the runtime", async () => {
    let received: { profileId: string; model: string; transport: string | undefined } | null = null;
    const app = createProviderRoutes(mockRuntime({
      testProviderChatByProfile: async (profileId, model, transport) => {
        received = { profileId, model, transport };
        return { success: true, reply: "Hi" };
      },
    }));

    const response = await app.request("/api/providers/profile_1/test-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k2.5", transport: "responses" }),
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({ profileId: "profile_1", model: "kimi-k2.5", transport: "responses" });
  });

  test("rejects an invalid transport before it reaches the runtime", async () => {
    const app = createProviderRoutes(mockRuntime({
      testProviderChatByProfile: async () => ({ success: true, reply: "unexpected" }),
    }));

    const response = await app.request("/api/providers/profile_1/test-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model", transport: "made-up" }),
    });

    expect(response.status).toBe(400);
  });

  test("threads the unsaved draft proxy policy to probe, model list, and test chat", async () => {
    const policies: Array<{ operation: string; proxyMode: string | undefined; proxyId: string | null | undefined }> = [];
    const app = createProviderRoutes(mockRuntime({
      testProviderDraft: async (body) => {
        policies.push({ operation: "probe", proxyMode: body?.proxyMode, proxyId: body?.proxyId });
        return { success: true };
      },
      fetchModelsByEndpoint: async (_baseUrl, _apiKey, _providerType, proxyMode, proxyId) => {
        policies.push({ operation: "models", proxyMode, proxyId });
        return [];
      },
      testProviderChatByEndpoint: async (input) => {
        policies.push({ operation: "chat", proxyMode: input.proxyMode, proxyId: input.proxyId });
        return { success: true, reply: "Hi" };
      },
    }));
    const body = { endpoint: "https://provider.example/v1", baseUrl: "https://provider.example/v1", apiKey: "key", model: "model", proxyMode: "proxy", proxyId: "proxy_1" };

    for (const path of ["/api/providers/test", "/api/providers/fetch-models", "/api/providers/test-chat"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }

    expect(policies).toEqual([
      { operation: "probe", proxyMode: "proxy", proxyId: "proxy_1" },
      { operation: "models", proxyMode: "proxy", proxyId: "proxy_1" },
      { operation: "chat", proxyMode: "proxy", proxyId: "proxy_1" },
    ]);
  });

  test("the adapter resolves and uses the draft policy before a profile is saved", async () => {
    const resolvedPolicies: ProviderProxyPolicy[] = [];
    const requestedUrls: string[] = [];
    const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requestedUrls.push(url);
      if (init?.method === "POST") {
        return Response.json({
          choices: [{ message: { content: "Hi" } }],
        });
      }
      return Response.json({ data: [{ id: "model-1" }] });
    }) as ProviderFetch;
    providerFetch.preconnect = () => {};
    setProviderFetchFactory({
      resolveFetch: async (policy) => {
        resolvedPolicies.push(policy);
        return providerFetch;
      },
    });

    const stores = {
      proxies: {
        getById: async (id: string) => id === "proxy_1" ? { id } : null,
      },
    } as unknown as StoreContainer;
    const adapter = new ProviderAdapter(
      stores,
      {} as ProviderProfileService,
    );
    const policy = { proxyMode: "proxy" as const, proxyId: "proxy_1" };

    expect((await adapter.testProviderDraft({ endpoint: "https://provider.example/v1", apiKey: "key", providerType: "openai", ...policy })).success).toBe(true);
    expect((await adapter.fetchModelsByEndpoint("https://provider.example/v1", "key", "openai", policy.proxyMode, policy.proxyId)).length).toBe(1);
    expect((await adapter.testProviderChatByEndpoint({ baseUrl: "https://provider.example/v1", apiKey: "key", model: "model-1", providerType: "openai", ...policy })).success).toBe(true);

    expect(resolvedPolicies).toEqual([policy, policy, policy]);
    expect(requestedUrls).toHaveLength(3);

    await expect(adapter.testProviderDraft({
      endpoint: "https://provider.example/v1",
      apiKey: "key",
      providerType: "openai",
      proxyMode: "proxy",
      proxyId: "missing",
    })).rejects.toMatchObject({ kind: "Validation" });
    expect(requestedUrls).toHaveLength(3);
  });
});

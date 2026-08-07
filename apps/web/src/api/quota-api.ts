/**
 * Provider-quota HTTP client.
 *
 * These endpoints are mounted by a FeatureModule rather than the typed route
 * chain, so they are outside the Hono RPC client's `AppType` and are called
 * with plain `fetch`. The response shapes are still compile-checked: they come
 * from `@vibe-tavern/api-contracts`, the same declarations the backend builds.
 *
 * There is no refresh call here and no endpoint field in any payload — polling
 * is automatic and endpoints live only in backend registry adapters.
 */

import type {
  ProviderQuotaCapabilityRecord,
  ProviderQuotaRecord,
} from "@vibe-tavern/api-contracts";
import type { ProviderQuotaConfig } from "@vibe-tavern/domain";
import { getGatewayBaseUrl, getMobileToken } from "./client.js";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getMobileToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getGatewayBaseUrl()}${path}`, init);
  if (!response.ok) {
    // The error body is the app's standard `{ error, kind }`; fall back to the
    // status when the response is not JSON at all (proxy error pages).
    let message = `Request failed with ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }
  return await response.json() as T;
}

export function fetchQuotaCapability(providerProfileId: string): Promise<ProviderQuotaCapabilityRecord> {
  return requestJson<ProviderQuotaCapabilityRecord>(
    `/api/providers/${encodeURIComponent(providerProfileId)}/quota-capability`,
    { headers: authHeaders() },
  );
}

export function fetchQuota(providerProfileId: string): Promise<ProviderQuotaRecord> {
  return requestJson<ProviderQuotaRecord>(
    `/api/providers/${encodeURIComponent(providerProfileId)}/quota`,
    { headers: authHeaders() },
  );
}

export function updateQuotaConfig(
  providerProfileId: string,
  config: ProviderQuotaConfig,
): Promise<ProviderQuotaRecord> {
  return requestJson<ProviderQuotaRecord>(
    `/api/providers/${encodeURIComponent(providerProfileId)}/quota-config`,
    {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(config),
    },
  );
}

import type { ProxyStore } from "@vibe-tavern/db";
import {
  isValidProxyUrl,
  PROXY_MODE,
  type CreateProxyData,
  type ProviderProxyMode,
} from "@vibe-tavern/domain";
import {
  toClientProxyRecord,
  resolveStoredPassword,
  type ClientProxyRecord,
} from "../../runtime/session/session-runtime-dto.js";
import { validation, notFound } from "../../shared/errors.js";

// ─── Public contract (duck-typed — consumers import this as `type`) ──────

export interface ProxyService {
  listProxies(): Promise<ClientProxyRecord[]>;
  getProxy(id: string): Promise<ClientProxyRecord | null>;
  saveProxy(input: Record<string, unknown>): Promise<ClientProxyRecord>;
  updateProxy(id: string, input: Record<string, unknown>): Promise<ClientProxyRecord>;
  deleteProxy(id: string): Promise<void>;
  reorderProxies(updates: Array<{ id: string; sortOrder: number }>): Promise<ClientProxyRecord[]>;
  getDefaultProxyId(): Promise<string | null>;
  setDefaultProxyId(proxyId: string | null): Promise<{ defaultProxyId: string | null }>;
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function createProxyService(proxies: ProxyStore): ProxyService {
  return {
    listProxies: async () => {
      const all = await proxies.listAll();
      return all.map(toClientProxyRecord);
    },

    getProxy: async (id) => {
      const proxy = await proxies.getById(id);
      return proxy ? toClientProxyRecord(proxy) : null;
    },

    saveProxy: async (input) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) {
        throw validation("Proxy name is required.");
      }

      const url = typeof input.url === "string" ? input.url.trim() : "";
      if (!url) {
        throw validation("Proxy URL is required.");
      }
      if (!isValidProxyUrl(url)) {
        throw validation(
          "Proxy URL must be a bare http:// or https:// URL without embedded credentials, path, query, or fragment.",
        );
      }

      const username = resolveNullableString(input.username);
      const password = Object.prototype.hasOwnProperty.call(input, "password")
        ? resolveStoredPassword(input.password, null)
        : null;

      const created = await proxies.create({ name, url, ...(username !== undefined ? { username } : {}), password });
      return toClientProxyRecord(created);
    },

    updateProxy: async (id, input) => {
      const existing = await proxies.getById(id);
      if (!existing) {
        throw notFound("ProxyProfile", `Proxy '${id}' was not found.`);
      }

      const data: Partial<CreateProxyData> = {};

      if (input.name !== undefined) {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) throw validation("Proxy name is required.");
        data.name = name;
      }

      if (input.url !== undefined) {
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (!url) throw validation("Proxy URL is required.");
        if (!isValidProxyUrl(url)) {
          throw validation(
            "Proxy URL must be a bare http:// or https:// URL without embedded credentials, path, query, or fragment.",
          );
        }
        data.url = url;
      }

      const username = resolveNullableString(input.username);
      if (username !== undefined) data.username = username;

      if (Object.prototype.hasOwnProperty.call(input, "password")) {
        data.password = resolveStoredPassword(input.password, existing.password ?? null);
      }

      await proxies.update(id, data);
      const updated = await proxies.getById(id);
      return toClientProxyRecord(updated!);
    },

    deleteProxy: async (id) => {
      try {
        await proxies.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          throw notFound("ProxyProfile", message);
        }
        throw error;
      }
    },

    reorderProxies: async (updates) => {
      const all = await proxies.reorder(updates);
      return all.map(toClientProxyRecord);
    },

    getDefaultProxyId: async () => {
      return proxies.getDefaultProxyId();
    },

    setDefaultProxyId: async (proxyId) => {
      try {
        await proxies.setDefaultProxyId(proxyId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          throw notFound("ProxyProfile", message);
        }
        throw error;
      }
      return { defaultProxyId: proxyId };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function resolveNullableString(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input === "string") return input.trim() || null;
  return undefined;
}

// ─── Provider proxy-policy validation ────────────────────────────────────

/**
 * Validate and normalize a provider's proxy-mode/proxy-id pair at the
 * service boundary. Returns the canonical `(proxyMode, proxyId)` tuple.
 *
 * Invariants:
 * - `inherit` and `direct` must have a null proxyId.
 * - `proxy` must reference an existing proxy (checked against `proxyStore`).
 */
export async function validateProviderProxyPolicy(
  proxyMode: ProviderProxyMode | undefined,
  proxyId: string | null | undefined,
  proxyStore: ProxyStore,
): Promise<{ proxyMode: ProviderProxyMode; proxyId: string | null }> {
  const mode: ProviderProxyMode = proxyMode ?? PROXY_MODE.inherit;

  if (mode === PROXY_MODE.proxy) {
    if (!proxyId) {
      throw validation("Proxy mode 'proxy' requires a selected proxy id.");
    }
    const proxy = await proxyStore.getById(proxyId);
    if (!proxy) {
      throw validation(`Selected proxy '${proxyId}' does not exist.`);
    }
    return { proxyMode: mode, proxyId };
  }

  // inherit / direct → proxyId must be null.
  if (proxyId) {
    throw validation(`Proxy mode '${mode}' must not specify a proxy id.`);
  }
  return { proxyMode: mode, proxyId: null };
}

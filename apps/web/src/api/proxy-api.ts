import type { ProxyRecord } from "./types.js";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

export async function listProxies(): Promise<ProxyRecord[]> {
  const response = await client.api.proxies.$get();
  return unwrapRpc<ProxyRecord[]>(response);
}

export async function getProxy(proxyId: string): Promise<ProxyRecord> {
  const response = await client.api.proxies[":proxyId"].$get({ param: { proxyId } });
  return unwrapRpc<ProxyRecord>(response);
}

export async function saveProxy(input: {
  name: string;
  url: string;
  username?: string | null;
  password?: string | null;
}): Promise<ProxyRecord> {
  const response = await client.api.proxies.$post({ json: input });
  return unwrapRpc<ProxyRecord>(response);
}

export async function updateProxy(
  proxyId: string,
  patch: { name?: string; url?: string; username?: string | null; password?: string | null },
): Promise<ProxyRecord> {
  const response = await client.api.proxies[":proxyId"].$patch({ param: { proxyId }, json: patch });
  return unwrapRpc<ProxyRecord>(response);
}

export async function deleteProxy(proxyId: string): Promise<{ ok: true }> {
  const response = await client.api.proxies[":proxyId"].$delete({ param: { proxyId } });
  return unwrapRpc<{ ok: true }>(response);
}

export async function reorderProxies(updates: Array<{ id: string; sortOrder: number }>): Promise<ProxyRecord[]> {
  const response = await client.api.proxies.reorder.$patch({ json: { updates } });
  return unwrapRpc<ProxyRecord[]>(response);
}

export async function getDefaultProxy(): Promise<{ defaultProxyId: string | null }> {
  const response = await client.api.proxies.default.$get();
  return unwrapRpc<{ defaultProxyId: string | null }>(response);
}

export async function setDefaultProxy(defaultProxyId: string | null): Promise<{ defaultProxyId: string | null }> {
  const response = await client.api.proxies.default.$put({ json: { defaultProxyId } });
  return unwrapRpc<{ defaultProxyId: string | null }>(response);
}

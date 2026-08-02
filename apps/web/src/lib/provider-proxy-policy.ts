import type { ProviderProxyMode } from "@vibe-tavern/domain";
import type { ProxyRecord } from "../api/types.js";

export const INHERIT_PROXY_SELECTION = "__proxy_inherit__";
export const DIRECT_PROXY_SELECTION = "__proxy_direct__";

export interface ProviderProxyPolicy {
  proxyMode: ProviderProxyMode;
  proxyId: string | null;
}

export function selectionFromProxyPolicy(policy: ProviderProxyPolicy): string {
  if (policy.proxyMode === "direct") return DIRECT_PROXY_SELECTION;
  if (policy.proxyMode === "proxy" && policy.proxyId) return policy.proxyId;
  return INHERIT_PROXY_SELECTION;
}

export function proxyPolicyFromSelection(selection: string): ProviderProxyPolicy {
  if (selection === DIRECT_PROXY_SELECTION) return { proxyMode: "direct", proxyId: null };
  if (selection === INHERIT_PROXY_SELECTION || !selection) return { proxyMode: "inherit", proxyId: null };
  return { proxyMode: "proxy", proxyId: selection };
}

export function shouldUsePersistedProviderForTest(editingId: string | null, isNew: boolean, dirty: boolean): boolean {
  return editingId !== null && !isNew && !dirty;
}

export function resolvedGlobalProxyLabel(proxies: ProxyRecord[], defaultProxyId: string | null, directLabel: string): string {
  return proxies.find((proxy) => proxy.id === defaultProxyId)?.name ?? directLabel;
}


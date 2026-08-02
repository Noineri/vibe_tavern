import { describe, expect, test } from "bun:test";
import type { ProxyRecord } from "../api/types.js";
import {
  DIRECT_PROXY_SELECTION,
  INHERIT_PROXY_SELECTION,
  proxyPolicyFromSelection,
  resolvedGlobalProxyLabel,
  selectionFromProxyPolicy,
  shouldUsePersistedProviderForTest,
} from "./provider-proxy-policy.js";

const proxies: ProxyRecord[] = [{
  id: "proxy_1", name: "Office", url: "https://proxy.example:8443", username: null,
  hasStoredPassword: false, sortOrder: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
}];

describe("provider proxy selector policy", () => {
  test("round-trips inheritance, direct override, and a named override", () => {
    expect(selectionFromProxyPolicy({ proxyMode: "inherit", proxyId: null })).toBe(INHERIT_PROXY_SELECTION);
    expect(proxyPolicyFromSelection(INHERIT_PROXY_SELECTION)).toEqual({ proxyMode: "inherit", proxyId: null });
    expect(selectionFromProxyPolicy({ proxyMode: "direct", proxyId: null })).toBe(DIRECT_PROXY_SELECTION);
    expect(proxyPolicyFromSelection(DIRECT_PROXY_SELECTION)).toEqual({ proxyMode: "direct", proxyId: null });
    expect(proxyPolicyFromSelection("proxy_1")).toEqual({ proxyMode: "proxy", proxyId: "proxy_1" });
  });

  test("resolves inherited global text without changing the provider policy", () => {
    expect(resolvedGlobalProxyLabel(proxies, "proxy_1", "Direct connection")).toBe("Office");
    expect(resolvedGlobalProxyLabel(proxies, null, "Direct connection")).toBe("Direct connection");
  });

  test("uses a draft for changed/new connection tests and the persisted profile only when unchanged", () => {
    expect(shouldUsePersistedProviderForTest("provider_1", false, false)).toBe(true);
    expect(shouldUsePersistedProviderForTest("provider_1", false, true)).toBe(false);
    expect(shouldUsePersistedProviderForTest("provider_1", true, false)).toBe(false);
    expect(shouldUsePersistedProviderForTest(null, false, false)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { buildProxyWrite, emptyProxyDraft, proxyToDraft } from "./ProxyManagerModal.js";
import type { ProxyRecord } from "../../api/types.js";

const storedProxy: ProxyRecord = {
  id: "proxy_1",
  name: "Office",
  url: "https://proxy.example:8443",
  username: "ada",
  hasStoredPassword: true,
  sortOrder: 0,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

describe("ProxyManager password write contract", () => {
  test("never hydrates a saved password into the draft and omits an untouched secret", () => {
    const draft = proxyToDraft(storedProxy);
    expect(draft.password).toBe("");
    expect(draft.hasStoredPassword).toBe(true);
    expect(buildProxyWrite(draft).password).toBeUndefined();
  });

  test("writes replacement credentials byte-for-byte while trimming display and URL fields", () => {
    const write = buildProxyWrite({ ...proxyToDraft(storedProxy), name: " Office ", username: " ada ", password: " new-secret " });
    expect(write).toEqual({ name: "Office", url: storedProxy.url, username: " ada ", password: " new-secret " });
  });

  test("explicit clear sends null while a new proxy omits an absent password", () => {
    expect(buildProxyWrite({ ...proxyToDraft(storedProxy), clearStoredPassword: true }).password).toBeNull();
    expect(buildProxyWrite({ ...emptyProxyDraft(), name: "New", url: "socks5://127.0.0.1:1080" }).password).toBeUndefined();
  });
});

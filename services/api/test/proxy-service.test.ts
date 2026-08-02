import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, ProxyStore, ProviderStore } from "@vibe-tavern/db";
import { createProxyService } from "../src/domain/providers/proxy-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ProxyAdapter } from "../src/api/adapters/proxy-adapter.js";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";

const testClock: StoreClock = { now: () => "2026-08-02T00:00:00.000Z" };
let nextId = 0;
const testIdGen: StoreIdGenerator = { next: (prefix: string) => `${prefix}_svc_${++nextId}` };

async function makeServices() {
  const dir = await mkdtemp(join(tmpdir(), "vt-proxy-svc-"));
  const db = await createDb(join(dir, "test.db"));
  const proxies = new ProxyStore(db, { clock: testClock, idGenerator: testIdGen });
  const providers = new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
  return {
    proxyService: createProxyService(proxies),
    providerService: createProviderProfileService(providers, proxies),
    proxies,
    providers,
  };
}

describe("ProxyService — password preserve/replace/clear", () => {
  beforeEach(() => { nextId = 0; });

  test("create stores password; response exposes hasStoredPassword only", async () => {
    const { proxyService } = await makeServices();
    const created = await proxyService.saveProxy({ name: "P", url: "http://p:8080", password: "secret123" });
    expect(created.hasStoredPassword).toBe(true);
    expect(JSON.stringify(created)).not.toContain("secret123");
    expect(JSON.stringify(created)).not.toContain("password");
  });

  test("update without password field preserves existing", async () => {
    const { proxyService, proxies } = await makeServices();
    const created = await proxyService.saveProxy({ name: "P", url: "http://p:8080", password: "secret" });
    await proxyService.updateProxy(created.id, { name: "Renamed" });
    const stored = await proxies.getById(created.id);
    expect(stored!.password).toBe("secret");
  });

  test("update with empty string preserves existing", async () => {
    const { proxyService, proxies } = await makeServices();
    const created = await proxyService.saveProxy({ name: "P", url: "http://p:8080", password: "secret" });
    await proxyService.updateProxy(created.id, { password: "" });
    const stored = await proxies.getById(created.id);
    expect(stored!.password).toBe("secret");
  });

  test("update with null clears stored password", async () => {
    const { proxyService, proxies } = await makeServices();
    const created = await proxyService.saveProxy({ name: "P", url: "http://p:8080", password: "secret" });
    await proxyService.updateProxy(created.id, { password: null });
    const stored = await proxies.getById(created.id);
    expect(stored!.password).toBeNull();
  });

  test("update with new value replaces", async () => {
    const { proxyService, proxies } = await makeServices();
    const created = await proxyService.saveProxy({ name: "P", url: "http://p:8080", password: "old" });
    await proxyService.updateProxy(created.id, { password: "new" });
    const stored = await proxies.getById(created.id);
    expect(stored!.password).toBe("new");
  });

  test("list never contains password material", async () => {
    const { proxyService } = await makeServices();
    await proxyService.saveProxy({ name: "A", url: "http://a:8080", password: "pw-a" });
    await proxyService.saveProxy({ name: "B", url: "http://b:8080", password: "pw-b" });
    const list = await proxyService.listProxies();
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("pw-a");
    expect(serialized).not.toContain("pw-b");
    expect(serialized).not.toContain("password");
    expect(list.every((p) => !("password" in p))).toBe(true);
  });
});

describe("ProxyAdapter — API errors", () => {
  beforeEach(() => { nextId = 0; });

  test("get missing proxy maps to a NotFound domain error", async () => {
    const { proxyService } = await makeServices();
    const adapter = new ProxyAdapter(proxyService);
    await expect(adapter.getProxy("proxy_missing")).rejects.toMatchObject({ kind: "NotFound" });
  });
});

describe("ProxyService — URL validation", () => {
  beforeEach(() => { nextId = 0; });

  test("rejects schemes other than http/https/socks5", async () => {
    const { proxyService } = await makeServices();
    await expect(proxyService.saveProxy({ name: "P", url: "socks4://p:1080" })).rejects.toMatchObject({ kind: "Validation" });
    await expect(proxyService.saveProxy({ name: "P", url: "ftp://p:21" })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("rejects URLs with embedded credentials", async () => {
    const { proxyService } = await makeServices();
    await expect(proxyService.saveProxy({ name: "P", url: "http://user:pass@p:8080" })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("rejects URLs with path/query/fragment", async () => {
    const { proxyService } = await makeServices();
    await expect(proxyService.saveProxy({ name: "P", url: "http://p:8080/path" })).rejects.toMatchObject({ kind: "Validation" });
    await expect(proxyService.saveProxy({ name: "P", url: "http://p:8080?q=1" })).rejects.toMatchObject({ kind: "Validation" });
    await expect(proxyService.saveProxy({ name: "P", url: "http://p:8080#frag" })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("accepts clean http, https, and socks5 URLs", async () => {
    const { proxyService } = await makeServices();
    const http = await proxyService.saveProxy({ name: "H", url: "http://proxy:8080" });
    expect(http.url).toBe("http://proxy:8080");
    const https = await proxyService.saveProxy({ name: "S", url: "https://proxy.secure:8443" });
    expect(https.url).toBe("https://proxy.secure:8443");
    const socks = await proxyService.saveProxy({ name: "K", url: "socks5://proxy.socks:1080" });
    expect(socks.url).toBe("socks5://proxy.socks:1080");
  });
});

describe("ProxyService — global default", () => {
  beforeEach(() => { nextId = 0; });

  test("getDefaultProxyId returns null initially", async () => {
    const { proxyService } = await makeServices();
    expect(await proxyService.getDefaultProxyId()).toBeNull();
  });

  test("setDefaultProxyId validates existence", async () => {
    const { proxyService } = await makeServices();
    await expect(proxyService.setDefaultProxyId("ghost")).rejects.toMatchObject({ kind: "NotFound" });
  });

  test("setDefaultProxyId returns the persisted setting and null clears", async () => {
    const { proxyService } = await makeServices();
    const a = await proxyService.saveProxy({ name: "A", url: "http://a:8080" });
    expect(await proxyService.setDefaultProxyId(a.id)).toEqual({ defaultProxyId: a.id });
    expect(await proxyService.getDefaultProxyId()).toBe(a.id);
    expect(await proxyService.setDefaultProxyId(null)).toEqual({ defaultProxyId: null });
    expect(await proxyService.getDefaultProxyId()).toBeNull();
  });
});

describe("ProxyService — atomic deletion", () => {
  beforeEach(() => { nextId = 0; });

  test("delete clears default and re-homes providers", async () => {
    const { proxyService, providerService, providers } = await makeServices();
    const proxy = await proxyService.saveProxy({ name: "P", url: "http://p:8080" });
    await proxyService.setDefaultProxyId(proxy.id);

    // Create a provider in proxy mode.
    const profile = await providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
      proxyMode: "proxy", proxyId: proxy.id,
    });
    expect(profile.proxyMode).toBe("proxy");

    // Delete the proxy.
    await proxyService.deleteProxy(proxy.id);

    // Provider re-homed.
    const stored = await providers.getById(profile.id);
    expect(stored!.proxyMode).toBe("inherit");
    expect(stored!.proxyId).toBeNull();

    // Default cleared.
    expect(await proxyService.getDefaultProxyId()).toBeNull();
  });
});

describe("ProviderProfileService — proxy policy validation", () => {
  beforeEach(() => { nextId = 0; });

  test("save rejects proxy mode without proxyId", async () => {
    const { providerService } = await makeServices();
    await expect(providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
      proxyMode: "proxy", proxyId: null,
    })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("save rejects proxy mode with non-existent proxyId", async () => {
    const { providerService } = await makeServices();
    await expect(providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
      proxyMode: "proxy", proxyId: "ghost",
    })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("save rejects inherit mode with a proxyId", async () => {
    const { providerService } = await makeServices();
    await expect(providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
      proxyMode: "inherit", proxyId: "some-id",
    })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("save rejects direct mode with a proxyId", async () => {
    const { providerService } = await makeServices();
    await expect(providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
      proxyMode: "direct", proxyId: "some-id",
    })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("save accepts valid proxy mode with existing proxyId", async () => {
    const { providerService, proxyService } = await makeServices();
    const proxy = await proxyService.saveProxy({ name: "P", url: "http://p:8080" });
    const profile = await providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
      proxyMode: "proxy", proxyId: proxy.id,
    });
    expect(profile.proxyMode).toBe("proxy");
    expect(profile.proxyId).toBe(proxy.id);
  });

  test("update validates proxy policy", async () => {
    const { providerService } = await makeServices();
    const profile = await providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
    });
    await expect(providerService.updateProviderProfile(profile.id, {
      proxyMode: "proxy", proxyId: null,
    })).rejects.toMatchObject({ kind: "Validation" });
  });

  test("changing from a named proxy to direct clears the stale proxy id", async () => {
    const { providerService, proxyService } = await makeServices();
    const proxy = await proxyService.saveProxy({ name: "P", url: "http://p:8080" });
    const profile = await providerService.saveProviderProfile({
      name: "V", providerPreset: "custom", endpoint: "https://v/v1",
      proxyMode: "proxy", proxyId: proxy.id,
    });

    const updated = await providerService.updateProviderProfile(profile.id, { proxyMode: "direct" });
    expect(updated.proxyMode).toBe("direct");
    expect(updated.proxyId).toBeNull();
  });
});

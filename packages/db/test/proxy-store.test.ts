import { describe, expect, test, beforeEach } from "bun:test";

import { createDb, ProxyStore, ProviderStore, type CreateProviderData } from "../src/index.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const testClock: StoreClock = { now: () => "2026-08-02T00:00:00.000Z" };
let nextId = 0;
const testIdGen: StoreIdGenerator = { next: (prefix: string) => `${prefix}_test_${++nextId}` };

async function makeStores() {
  const db = await createDb(":memory:");
  return {
    proxies: new ProxyStore(db, { clock: testClock, idGenerator: testIdGen }),
    providers: new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null }),
  };
}

const baseProvider: CreateProviderData = {
  name: "Test",
  providerPreset: "custom",
  endpoint: "https://localhost/v1",
};

describe("ProxyStore — CRUD + ordering", () => {
  beforeEach(() => { nextId = 0; });

  test("create appends at end; listAll returns insertion order", async () => {
    const { proxies } = await makeStores();
    const a = await proxies.create({ name: "A", url: "http://proxy-a:8080" });
    const b = await proxies.create({ name: "B", url: "http://proxy-b:8080" });
    const all = await proxies.listAll();
    expect(all.map((p) => p.name)).toEqual(["A", "B"]);
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
  });

  test("update changes name and url", async () => {
    const { proxies } = await makeStores();
    const created = await proxies.create({ name: "Old", url: "http://old:8080" });
    await proxies.update(created.id, { name: "New", url: "http://new:9090" });
    const updated = await proxies.getById(created.id);
    expect(updated!.name).toBe("New");
    expect(updated!.url).toBe("http://new:9090");
  });

  test("reorder rewrites sort_order", async () => {
    const { proxies } = await makeStores();
    const a = await proxies.create({ name: "A", url: "http://a:8080" });
    const b = await proxies.create({ name: "B", url: "http://b:8080" });
    await proxies.reorder([
      { id: b.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
    ]);
    expect((await proxies.listAll()).map((p) => p.name)).toEqual(["B", "A"]);
  });

  test("delete throws for non-existent id", async () => {
    const { proxies } = await makeStores();
    await expect(proxies.delete("nonexistent")).rejects.toThrow(/not found/i);
  });
});

describe("ProxyStore — global default", () => {
  beforeEach(() => { nextId = 0; });

  test("default is null initially", async () => {
    const { proxies } = await makeStores();
    expect(await proxies.getDefaultProxyId()).toBeNull();
  });

  test("set and get default", async () => {
    const { proxies } = await makeStores();
    const a = await proxies.create({ name: "A", url: "http://a:8080" });
    await proxies.setDefaultProxyId(a.id);
    expect(await proxies.getDefaultProxyId()).toBe(a.id);
  });

  test("rejects a non-existent default proxy id", async () => {
    const { proxies } = await makeStores();
    await expect(proxies.setDefaultProxyId("proxy_missing")).rejects.toThrow(/not found/i);
    expect(await proxies.getDefaultProxyId()).toBeNull();
  });

  test("clear default with null", async () => {
    const { proxies } = await makeStores();
    const a = await proxies.create({ name: "A", url: "http://a:8080" });
    await proxies.setDefaultProxyId(a.id);
    await proxies.setDefaultProxyId(null);
    expect(await proxies.getDefaultProxyId()).toBeNull();
  });
});

describe("ProxyStore — atomic deletion fallback", () => {
  beforeEach(() => { nextId = 0; });

  test("clears global default and re-homes providers on delete", async () => {
    const { proxies, providers } = await makeStores();
    const proxy = await proxies.create({ name: "P", url: "http://p:8080" });
    await proxies.setDefaultProxyId(proxy.id);

    // Provider in 'proxy' mode referencing this proxy.
    const provider = await providers.create({ ...baseProvider, proxyMode: "proxy", proxyId: proxy.id });
    // Provider in 'direct' mode (should be unaffected).
    const directProvider = await providers.create({ ...baseProvider, name: "Direct", proxyMode: "direct", proxyId: null });

    await proxies.delete(proxy.id);

    // Proxy gone.
    expect(await proxies.getById(proxy.id)).toBeNull();
    // Global default cleared.
    expect(await proxies.getDefaultProxyId()).toBeNull();

    // Provider re-homed to inherit + null.
    const updated = await providers.getById(provider.id);
    expect(updated!.proxyMode).toBe("inherit");
    expect(updated!.proxyId).toBeNull();

    // Direct provider unaffected.
    const directUpdated = await providers.getById(directProvider.id);
    expect(directUpdated!.proxyMode).toBe("direct");
  });

  test("delete is atomic — non-existent proxy does not change providers", async () => {
    const { proxies, providers } = await makeStores();
    const provider = await providers.create({ ...baseProvider, proxyMode: "inherit" });
    await expect(proxies.delete("ghost")).rejects.toThrow(/not found/i);
    const unchanged = await providers.getById(provider.id);
    expect(unchanged!.proxyMode).toBe("inherit");
  });
});

describe("ProxyStore — password handling", () => {
  beforeEach(() => { nextId = 0; });

  test("create stores password; update preserves when absent", async () => {
    const { proxies } = await makeStores();
    const created = await proxies.create({ name: "P", url: "http://p:8080", password: "secret123" });
    expect(created.password).toBe("secret123");

    // Update without password field → preserved.
    await proxies.update(created.id, { name: "Renamed" });
    const updated = await proxies.getById(created.id);
    expect(updated!.password).toBe("secret123");
  });

  test("update with null password clears it", async () => {
    const { proxies } = await makeStores();
    const created = await proxies.create({ name: "P", url: "http://p:8080", password: "secret123" });
    await proxies.update(created.id, { password: null });
    const updated = await proxies.getById(created.id);
    expect(updated!.password).toBeNull();
  });

  test("update with new password replaces it", async () => {
    const { proxies } = await makeStores();
    const created = await proxies.create({ name: "P", url: "http://p:8080", password: "old" });
    await proxies.update(created.id, { password: "new" });
    const updated = await proxies.getById(created.id);
    expect(updated!.password).toBe("new");
  });
});

describe("ProxyStore — provider proxy policy persistence + duplication", () => {
  beforeEach(() => { nextId = 0; });

  test("create defaults to inherit + null", async () => {
    const { providers } = await makeStores();
    const created = await providers.create(baseProvider);
    expect(created.proxyMode).toBe("inherit");
    expect(created.proxyId).toBeNull();
  });

  test("create with explicit proxy mode/id", async () => {
    const { providers } = await makeStores();
    const created = await providers.create({ ...baseProvider, proxyMode: "direct", proxyId: null });
    expect(created.proxyMode).toBe("direct");
    expect(created.proxyId).toBeNull();
  });

  test("update changes proxy mode/id", async () => {
    const { providers } = await makeStores();
    const created = await providers.create(baseProvider);
    await providers.update(created.id, { proxyMode: "direct" });
    const updated = await providers.getById(created.id);
    expect(updated!.proxyMode).toBe("direct");
  });

  test("duplicate preserves proxy mode/id", async () => {
    const { providers, proxies } = await makeStores();
    const proxy = await proxies.create({ name: "P", url: "http://p:8080" });
    const created = await providers.create({ ...baseProvider, proxyMode: "proxy", proxyId: proxy.id });
    const dup = await providers.duplicate(created.id);
    expect(dup.proxyMode).toBe("proxy");
    expect(dup.proxyId).toBe(proxy.id);
  });

  test("database rejects a dangling proxy reference", async () => {
    const { providers } = await makeStores();
    await expect(providers.create({
      ...baseProvider,
      proxyMode: "proxy",
      proxyId: "proxy_missing",
    })).rejects.toThrow();
  });

  test("database rejects an invalid mode/id pair", async () => {
    const { providers, proxies } = await makeStores();
    const proxy = await proxies.create({ name: "P", url: "http://p:8080" });
    await expect(providers.create({
      ...baseProvider,
      proxyMode: "direct",
      proxyId: proxy.id,
    })).rejects.toThrow();
  });
});

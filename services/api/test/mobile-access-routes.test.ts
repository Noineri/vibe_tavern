import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMobileAccessRoutes } from "../src/api/routes/mobile-access.js";
import { MobileAccessService } from "../src/domain/mobile-access/mobile-access-service.js";
import type { MobileAccessRuntimeApi } from "../src/api/contract/runtime-api.js";

// Regression for the "mobile access broken" bug (regression of a993a4b):
// routes/index.ts used to spread class instances (`{ ...runtime.mobileAccess }`),
// which drops prototype methods → `runtime.getMobileAccessInfo is not a function`.
// createMobileAccessRoutes now takes the adapter directly (no spread), so regular
// class methods must resolve. This mock mimics the REAL adapter shape: a class with
// `async` PROTOTYPE methods (not arrow-function own properties).
class PrototypeMethodMock {
	async getMobileAccessInfo() {
		return { ips: [], port: 8788, token: "tok-1", tlsEnabled: false };
	}
	async regenerateMobileAccessToken() {
		return { token: "tok-2" };
	}
	async revokeMobileAccess() {
		return { token: null };
	}
}

describe("mobile-access routes (no-spread regression)", () => {
	test("GET /api/settings/mobile-access: prototype method resolves → 200 + info", async () => {
		const app = createMobileAccessRoutes(new PrototypeMethodMock() as unknown as MobileAccessRuntimeApi);
		const res = await app.request("/api/settings/mobile-access");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ips: [], port: 8788, token: "tok-1", tlsEnabled: false });
	});

	test("POST /api/settings/mobile-access/regenerate: prototype method resolves → 200 + {token}", async () => {
		const app = createMobileAccessRoutes(new PrototypeMethodMock() as unknown as MobileAccessRuntimeApi);
		const res = await app.request("/api/settings/mobile-access/regenerate", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: "tok-2" });
	});

	test("DELETE /api/settings/mobile-access: prototype method resolves → 200 + {token: null}", async () => {
		const app = createMobileAccessRoutes(new PrototypeMethodMock() as unknown as MobileAccessRuntimeApi);
		const res = await app.request("/api/settings/mobile-access", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: null });
	});

	test("the three methods are actually invoked (not silently stubbed)", async () => {
		const calls: string[] = [];
		class RecordingMock {
			async getMobileAccessInfo() { calls.push("info"); return { ips: [], port: 1, token: null, tlsEnabled: false }; }
			async regenerateMobileAccessToken() { calls.push("regen"); return { token: "x" }; }
			async revokeMobileAccess() { calls.push("revoke"); return { token: null }; }
		}
		const app = createMobileAccessRoutes(new RecordingMock() as unknown as MobileAccessRuntimeApi);
		await app.request("/api/settings/mobile-access");
		await app.request("/api/settings/mobile-access/regenerate", { method: "POST" });
		await app.request("/api/settings/mobile-access", { method: "DELETE" });
		expect(calls).toEqual(["info", "regen", "revoke"]);
	});
});


describe("mobile access config-file characterization", () => {
  let configDir = "";

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "vt-mobile-access-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  test("a missing config file initializes with no token", async () => {
    const service = await MobileAccessService.create(join(configDir, "missing-parent"));

    expect(service.getToken()).toBeNull();
  });

  test("corrupt JSON initializes with no token instead of propagating a parse error", async () => {
    await Bun.write(join(configDir, "mobile-access.json"), "{not-json");

    const service = await MobileAccessService.create(configDir);

    expect(service.getToken()).toBeNull();
  });

  test("a generated token survives a fresh service instance and a persisted revocation", async () => {
    const first = await MobileAccessService.create(configDir);
    const generatedToken = await first.generateToken();

    const reloaded = await MobileAccessService.create(configDir);
    expect(reloaded.getToken()).toBe(generatedToken);

    await reloaded.revokeToken();
    const afterRevocation = await MobileAccessService.create(configDir);
    expect(afterRevocation.getToken()).toBeNull();
  });

  test("a valid JSON config with mixed-case Token does not normalize its key", async () => {
    await Bun.write(join(configDir, "mobile-access.json"), JSON.stringify({ Token: "MiXeD-Token" }));

    const service = await MobileAccessService.create(configDir);

    // OBSERVED CONFIG-SHAPE GAP: load() trusts JSON.parse() without validating
    // the key, so getToken() returns undefined despite its string | null type.
    expect(service.getToken()).toBeUndefined();
  });

  test("concurrent generate/revoke mutations stay ordered and leave disk consistent with memory", async () => {
    const service = await MobileAccessService.create(configDir);
    const configPath = join(configDir, "mobile-access.json");
    // Delay the first config write and start the second mutation only after
    // the first has computed its payload: without mutation serialization the
    // stale write lands last and persists a token memory believes was revoked.
    const originalWrite = Bun.write;
    let intercepted = 0;
    Bun.write = (async (...args: Parameters<typeof Bun.write>) => {
      const [destination] = args;
      if (destination === configPath) {
        intercepted += 1;
        if (intercepted === 1) await Bun.sleep(50);
      }
      return originalWrite(...args);
    }) as typeof Bun.write;

    try {
      const generation = service.generateToken();
      while (intercepted === 0) await Bun.sleep(1);
      const revocation = service.revokeToken();
      await Promise.all([generation, revocation]);
    } finally {
      Bun.write = originalWrite;
    }

    expect(service.getToken()).toBeNull();
    const persisted = JSON.parse(await Bun.file(configPath).text());
    expect(persisted.token).toBeNull();
  });
});

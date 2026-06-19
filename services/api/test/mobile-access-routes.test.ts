import { describe, expect, test } from "bun:test";
import { createMobileAccessRoutes } from "../src/api/routes/mobile-access.js";
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

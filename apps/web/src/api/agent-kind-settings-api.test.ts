/**
 * SC-0e — per-kind settings client: GET/PATCH `/api/agent/kinds/:kind/settings`.
 *
 * Pins the URL, method and PATCH body against the SC-0d routes (the kind's
 * remembered model binding + profile default). Harness: the
 * chat-api-send-error.test.ts mockFetch pattern (fetch restored after each).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let kindSettingsApi: typeof import("./agent-kind-settings-api.js");

beforeAll(async () => {
	kindSettingsApi = await import("./agent-kind-settings-api.js");
});

const originalFetch = globalThis.fetch;

type FetchImplementation = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let capturedUrl = "";
let capturedInit: RequestInit | undefined;

function respondWith(status: number, body: unknown): void {
	capturedUrl = "";
	capturedInit = undefined;
	globalThis.fetch = Object.assign(
		mock<FetchImplementation>(async (input, init) => {
			capturedUrl = input.toString();
			capturedInit = init;
			return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		}),
		{ preconnect: originalFetch.preconnect },
	);
}

function settingsWire(kind: string): Record<string, unknown> {
	return { agentKind: kind, providerProfileId: "p1", modelName: "m1", defaultProfileId: null, updatedAt: "" };
}

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	jest.restoreAllMocks();
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

describe("agent-kind-settings-api — per-kind model settings (SC-0e)", () => {
	it("getAgentKindSettings GETs the kind settings route and returns the wire", async () => {
		respondWith(200, settingsWire("experience"));
		const settings = await kindSettingsApi.getAgentKindSettings("experience");
		expect(capturedUrl).toContain("/api/agent/kinds/experience/settings");
		expect(capturedInit?.method ?? "GET").toBe("GET");
		expect(settings.providerProfileId).toBe("p1");
		expect(settings.modelName).toBe("m1");
	});

	it("patchAgentKindSettings PATCHes the kind settings route with the partial body", async () => {
		respondWith(200, settingsWire("script"));
		const settings = await kindSettingsApi.patchAgentKindSettings("script", { providerProfileId: "p2", modelName: "m2" });
		expect(capturedUrl).toContain("/api/agent/kinds/script/settings");
		expect(capturedInit?.method).toBe("PATCH");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ providerProfileId: "p2", modelName: "m2" });
		expect(settings.agentKind).toBe("script");
	});

	it("a partial PATCH body carries only the fields present", async () => {
		respondWith(200, { ...settingsWire("script"), modelName: null });
		await kindSettingsApi.patchAgentKindSettings("script", { modelName: null });
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ modelName: null });
	});
});

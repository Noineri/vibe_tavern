/**
 * SC-0g — per-(chat, kind) settings client: GET/PATCH
 * `/api/agent/chats/:chatId/:kind/settings`.
 *
 * Pins the URL, method and PATCH body against the SC-0f routes (the chat
 * row's own profile choice — "use here"). Harness: the
 * chat-api-send-error.test.ts mockFetch pattern (fetch restored after each).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let chatSettingsApi: typeof import("./agent-chat-settings-api.js");

beforeAll(async () => {
	chatSettingsApi = await import("./agent-chat-settings-api.js");
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

function settingsWire(chatId: string, kind: string): Record<string, unknown> {
	return { chatId, agentKind: kind, profileId: "cprof_1", updatedAt: "" };
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

describe("agent-chat-settings-api — per-(chat, kind) profile settings (SC-0g)", () => {
	it("getAgentChatSettings GETs the chat settings route and returns the wire", async () => {
		respondWith(200, settingsWire("chat-1", "sidechat"));
		const settings = await chatSettingsApi.getAgentChatSettings("chat-1", "sidechat");
		expect(capturedUrl).toContain("/api/agent/chats/chat-1/sidechat/settings");
		expect(capturedInit?.method ?? "GET").toBe("GET");
		expect(settings.profileId).toBe("cprof_1");
	});

	it("patchAgentChatSettings PATCHes the chat settings route with the partial body", async () => {
		respondWith(200, settingsWire("chat-1", "sidechat"));
		const settings = await chatSettingsApi.patchAgentChatSettings("chat-1", "sidechat", { profileId: "cprof_2" });
		expect(capturedUrl).toContain("/api/agent/chats/chat-1/sidechat/settings");
		expect(capturedInit?.method).toBe("PATCH");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ profileId: "cprof_2" });
		expect(settings.agentKind).toBe("sidechat");
	});

	it("a null profileId clears the chat row's choice", async () => {
		respondWith(200, { ...settingsWire("chat-1", "sidechat"), profileId: null });
		await chatSettingsApi.patchAgentChatSettings("chat-1", "sidechat", { profileId: null });
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ profileId: null });
	});
});

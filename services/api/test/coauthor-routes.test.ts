import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/api/routes/chat.js";
import type { ChatRuntimeApi } from "../src/api/contract/runtime-api.js";

function mockChat(overrides: Partial<ChatRuntimeApi> = {}): ChatRuntimeApi {
	return { ...overrides } as unknown as ChatRuntimeApi;
}

describe("CS-12 Coauthor module routes", () => {
	test("GET /api/coauthor/modules returns list of modules", async () => {
		const runtime = mockChat({
			listCoauthorModules: async () => [{
				id: "test",
				name: "Test Module",
				description: "",
				basePrompt: "You are a test module.",
				openingMessage: "",
				skillIds: [],
				toolSet: {},
				maxSteps: 5,
				isBuiltIn: false,
			}],
		});
		const app = createChatRoutes(runtime);
		const res = await app.request("/api/coauthor/modules");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			modules: [{
				id: "test",
				name: "Test Module",
				description: "",
				basePrompt: "You are a test module.",
				openingMessage: "",
				skillIds: [],
				toolSet: {},
				maxSteps: 5,
				isBuiltIn: false,
			}]
		});
	});

	test("PATCH /api/chats/:chatId/coauthor-module updates module", async () => {
		let updatedChatId = "";
		let updatedModuleId: string | null = "wrong";
		const runtime = mockChat({
			setCoauthorModule: async (chatId, moduleId) => {
				updatedChatId = chatId;
				updatedModuleId = moduleId;
				return {} as any;
			},
		});
		const app = createChatRoutes(runtime);
		const res = await app.request("/api/chats/chat_1/coauthor-module", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ moduleId: "test-module" }),
		});
		expect(res.status).toBe(200);
		expect(updatedChatId).toBe("chat_1");
		expect(updatedModuleId).toBe("test-module");
	});

	test("PATCH /api/chats/:chatId/coauthor-module clears module with null", async () => {
		let updatedModuleId: string | null = "wrong";
		const runtime = mockChat({
			setCoauthorModule: async (chatId, moduleId) => {
				updatedModuleId = moduleId;
				return {} as any;
			},
		});
		const app = createChatRoutes(runtime);
		const res = await app.request("/api/chats/chat_1/coauthor-module", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ moduleId: null }),
		});
		expect(res.status).toBe(200);
		expect(updatedModuleId).toBe(null);
	});
});

describe("ML-5 coauthor module reorder route", () => {
	test("PATCH /api/coauthor/modules/reorder passes parsed updates through and returns the merged list envelope", async () => {
		let captured: Array<{ id: string; sortOrder: number }> | null = null;
		let updateCoauthorModuleCalled = false;
		const runtime = mockChat({
			reorderCoauthorModules: async (updates) => {
				captured = updates;
				return [{
					id: "test",
					name: "Test Module",
					description: "",
					basePrompt: "You are a test module.",
					openingMessage: "",
					skillIds: [],
					toolSet: {},
					maxSteps: 5,
					isBuiltIn: false,
				}];
			},
			updateCoauthorModule: async () => {
				updateCoauthorModuleCalled = true;
				throw new Error("must not be reached: reorder is not a :moduleId PATCH");
			},
		});
		const app = createChatRoutes(runtime);
		const res = await app.request("/api/coauthor/modules/reorder", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ updates: [{ id: "m2", sortOrder: 0 }, { id: "m1", sortOrder: 1 }] }),
		});
		expect(res.status).toBe(200);
		expect(captured).toEqual([{ id: "m2", sortOrder: 0 }, { id: "m1", sortOrder: 1 }]);
		expect(updateCoauthorModuleCalled).toBe(false);
		expect(await res.json()).toEqual({
			modules: [{
				id: "test",
				name: "Test Module",
				description: "",
				basePrompt: "You are a test module.",
				openingMessage: "",
				skillIds: [],
				toolSet: {},
				maxSteps: 5,
				isBuiltIn: false,
			}],
		});
	});

	test("rejects a body without the updates array (zValidator 400)", async () => {
		let called = false;
		const runtime = mockChat({
			reorderCoauthorModules: async () => {
				called = true;
				return [];
			},
		});
		const app = createChatRoutes(runtime);
		const res = await app.request("/api/coauthor/modules/reorder", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(called).toBe(false);
	});
});

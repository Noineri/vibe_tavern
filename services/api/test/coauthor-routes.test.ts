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
				basePromptFile: "default",
				skillIds: [],
				toolSet: {},
				maxSteps: 5,
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
				basePromptFile: "default",
				skillIds: [],
				toolSet: {},
				maxSteps: 5,
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

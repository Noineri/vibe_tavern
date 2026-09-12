import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { listLlamaCppModels } from "../src/domain/providers/llamacpp-adapter.js";
import { listProviderModels } from "../src/domain/providers/provider-gateway.js";

// Fetch mock per the vibe-tavern-testing skill: restore in BOTH beforeEach
// and afterAll — a mock left installed after the last test poisons every
// later network suite in the shared bun process.
const originalFetch = globalThis.fetch;

let route: (url: string) => Response | undefined;

function mockFetch(url: string | URL | Request): Response {
	const urlStr = typeof url === "string" ? url : url.toString();
	const response = route(urlStr);
	if (response) return response;
	return new Response("Not Found", { status: 404 });
}

beforeEach(() => {
	route = () => undefined;
	globalThis.fetch = mock(mockFetch) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

describe("listLlamaCppModels — LS-7 backend context auto-detect", () => {
	it("enriches models with the server's launch context from GET /props (root, not /v1)", async () => {
		route = (urlStr) => {
			if (urlStr.endsWith("/v1/models")) {
				return new Response(JSON.stringify({ data: [{ id: "qwen05b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (urlStr === "http://localhost:8801/props") {
				return new Response(
					JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return undefined;
		};

		const models = await listLlamaCppModels({ baseUrl: "http://localhost:8801", apiKey: "" });

		expect(models).toEqual([{ id: "qwen05b", label: "qwen05b", contextLength: 32768 }]);
	});

	it("keeps an existing per-model contextLength over the server-wide n_ctx", async () => {
		route = (urlStr) => {
			if (urlStr.endsWith("/v1/models")) {
				return new Response(JSON.stringify({ data: [{ id: "m", context_length: 4096 }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (urlStr === "http://localhost:8801/props") {
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return undefined;
		};

		const models = await listLlamaCppModels({ baseUrl: "http://localhost:8801", apiKey: "" });
		expect(models[0]?.contextLength).toBe(4096);
	});

	it("is graceful when /props is absent (404) — models returned without context", async () => {
		route = (urlStr) => {
			if (urlStr.endsWith("/v1/models")) {
				return new Response(JSON.stringify({ data: [{ id: "qwen05b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return undefined;
		};

		const models = await listLlamaCppModels({ baseUrl: "http://localhost:8801", apiKey: "" });
		expect(models).toEqual([{ id: "qwen05b", label: "qwen05b" }]);
	});

	it("is graceful when /props returns a shape without n_ctx", async () => {
		route = (urlStr) => {
			if (urlStr.endsWith("/v1/models")) {
				return new Response(JSON.stringify({ data: [{ id: "qwen05b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (urlStr === "http://localhost:8801/props") {
				return new Response(JSON.stringify({ total_slots: 4 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return undefined;
		};

		const models = await listLlamaCppModels({ baseUrl: "http://localhost:8801", apiKey: "" });
		expect(models[0]?.contextLength).toBeUndefined();
	});

	it("still throws when the model list itself fails (auth errors surface)", async () => {
		route = () => new Response("Unauthorized", { status: 401 });
		expect(listLlamaCppModels({ baseUrl: "http://localhost:8801", apiKey: "" })).rejects.toThrow();
	});
});

describe("LM Studio max_context_length extraction (LS-7)", () => {
	it("reads max_context_length from /v1/models records", async () => {
		route = (urlStr) => {
			if (urlStr.endsWith("/v1/models")) {
				return new Response(
					JSON.stringify({
						data: [{ id: "qwen05b", max_context_length: 32768 }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return undefined;
		};

		const models = await listProviderModels({ baseUrl: "http://localhost:1234/v1", apiKey: "", providerType: "openai_compat" });
		expect(models).toEqual([{ id: "qwen05b", label: "qwen05b", contextLength: 32768 }]);
	});
});

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { listProviderModels, probeProviderConnection, testProviderChat } from "../src/providers/provider-gateway.js";

const originalFetch = globalThis.fetch;

function mockFetch(url: string | URL | Request, init?: RequestInit): Response {
	const urlStr = typeof url === "string" ? url : url.toString();

	if (urlStr.endsWith("/models")) {
		// OpenAI-compat / Anthropic
		if (init?.headers) {
			const headers = init.headers as Record<string, string>;
			if (headers["x-api-key"]) {
				// Anthropic
				return new Response(
					JSON.stringify({
						data: [
							{ id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" },
							{ id: "claude-opus-4-20250514" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
		}
		// OpenAI-compat
		return new Response(
			JSON.stringify({
				data: [
					{ id: "gpt-4o", owned_by: "openai" },
					{ id: "gpt-4o-mini", owned_by: "openai" },
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (urlStr.endsWith("/chat/completions")) {
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "hello from local" } }] }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (urlStr.endsWith("/api/chat")) {
		return new Response(
			JSON.stringify({ message: { role: "assistant", content: "hello from ollama native" }, done: true }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (urlStr.endsWith("/api/tags")) {
		// Ollama
		return new Response(
			JSON.stringify({
				models: [
					{ name: "llama3:8b" },
					{ name: "mistral:7b" },
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (urlStr.endsWith("/api/v1/model")) {
		return new Response(
			JSON.stringify({ result: "koboldcpp/qwen2.5-3b-instruct-q4_k_m" }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (urlStr.endsWith("/api/v1/generate")) {
		return new Response(
			JSON.stringify({ results: [{ text: "hello from koboldcpp native" }] }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	return new Response("Not Found", { status: 404 });
}

beforeEach(() => {
	globalThis.fetch = mock(mockFetch);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("provider gateway", () => {
	const baseInput = { baseUrl: "http://localhost:11434/v1", apiKey: "test-key" };

	describe("connection probes", () => {
		it("probes Ollama via native /api/tags", async () => {
			const result = await probeProviderConnection({
				baseUrl: "http://localhost:11434",
				apiKey: "",
				providerType: "ollama",
			});

			expect(result).toEqual({ success: true, modelCount: 2 });
			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:11434/api/tags");
		});

		it("probes KoboldCPP via native /api/v1/model", async () => {
			const result = await probeProviderConnection({
				baseUrl: "http://localhost:5001",
				apiKey: "",
				providerType: "koboldcpp",
			});

			expect(result).toEqual({ success: true, modelCount: 1 });
			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:5001/api/v1/model");
		});
	});

	describe("testProviderChat", () => {
		it("uses Ollama native /api/chat endpoint when base URL is root", async () => {
			const result = await testProviderChat({
				baseUrl: "http://localhost:11434",
				apiKey: "",
				model: "llama3:8b",
				providerType: "ollama",
			});

			expect(result).toEqual({ success: true, reply: "hello from ollama native" });
			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:11434/api/chat");
			const body = JSON.parse(callArgs[1]?.body as string);
			expect(body).toMatchObject({ model: "llama3:8b", stream: false, options: { num_predict: 64 } });
		});

		it("uses KoboldCPP native /api/v1/generate endpoint", async () => {
			const result = await testProviderChat({
				baseUrl: "http://localhost:5001/api/v1",
				apiKey: "",
				model: "",
				providerType: "koboldcpp",
			});

			expect(result).toEqual({ success: true, reply: "hello from koboldcpp native" });
			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:5001/api/v1/generate");
			const body = JSON.parse(callArgs[1]?.body as string);
			expect(body).toMatchObject({ prompt: "User: Hi\nAssistant:", max_length: 64, temperature: 0.7, stream: false });
		});
	});

	describe("listProviderModels", () => {
	const baseInput = { baseUrl: "http://localhost:11434/v1", apiKey: "test-key" };

	// ─── Dispatch logic ─────────────────────────────────────────────────

	it("defaults to openai_compat when providerType is undefined", async () => {
		const models = await listProviderModels(baseInput);
		expect(models).toEqual([
			{ id: "gpt-4o", label: "gpt-4o" },
			{ id: "gpt-4o-mini", label: "gpt-4o-mini" },
		]);
	});

	it("routes to openai_compat for unknown providerType", async () => {
		const models = await listProviderModels({ ...baseInput, providerType: "unknown_type" });
		expect(models[0].id).toBe("gpt-4o");
	});

	// ─── OpenAI-compat ──────────────────────────────────────────────────

	describe("openai_compat", () => {
		it("fetches /models with Bearer auth and returns sorted results", async () => {
			const models = await listProviderModels({ ...baseInput, providerType: "openai_compat" });

			expect(models).toEqual([
				{ id: "gpt-4o", label: "gpt-4o" },
				{ id: "gpt-4o-mini", label: "gpt-4o-mini" },
			]);

			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:11434/v1/models");
			const headers = callArgs[1]?.headers as Record<string, string>;
			expect(headers["Authorization"]).toBe("Bearer test-key");
		});

		it("throws on non-OK response", async () => {
			globalThis.fetch = mock(() => new Response("Bad Gateway", { status: 502 }));
			expect(
				listProviderModels({ ...baseInput, providerType: "openai_compat" }),
			).rejects.toThrow("Model list request failed: 502");
		});
	});

	// ─── Anthropic ──────────────────────────────────────────────────────

	describe("anthropic", () => {
		it("fetches /models with x-api-key header", async () => {
			const models = await listProviderModels({
				baseUrl: "https://api.anthropic.com",
				apiKey: "sk-ant-key",
				providerType: "anthropic",
			});

			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("https://api.anthropic.com/models");
			const headers = callArgs[1]?.headers as Record<string, string>;
			expect(headers["x-api-key"]).toBe("sk-ant-key");
			expect(headers["anthropic-version"]).toBe("2023-06-01");
			expect(headers["Authorization"]).toBeUndefined();
		});

		it("returns sorted models with display_name as label", async () => {
			const models = await listProviderModels({
				baseUrl: "https://api.anthropic.com",
				apiKey: "sk-ant-key",
				providerType: "anthropic",
			});

			expect(models).toEqual([
				{ id: "claude-opus-4-20250514", label: "claude-opus-4-20250514" },
				{ id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
			]);
		});

		it("omits x-api-key when apiKey is empty", async () => {
			await listProviderModels({
				baseUrl: "https://api.anthropic.com",
				apiKey: "",
				providerType: "anthropic",
			});

			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			const headers = callArgs[1]?.headers as Record<string, string>;
			expect(headers["x-api-key"]).toBeUndefined();
			expect(headers["anthropic-version"]).toBeUndefined();
		});

		it("throws on non-OK response", async () => {
			globalThis.fetch = mock(() => new Response("Unauthorized", { status: 401 }));
			expect(
				listProviderModels({ baseUrl: "https://api.anthropic.com", apiKey: "key", providerType: "anthropic" }),
			).rejects.toThrow("Anthropic model list failed: 401");
		});
	});

	// ─── Google ─────────────────────────────────────────────────────────

	describe("google", () => {
		it("fetches models from Google API and returns chat-capable models", async () => {
			globalThis.fetch = mock(() => new Response(JSON.stringify({
				models: [
					{ name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/text-embedding-004", displayName: "Text Embedding", supportedGenerationMethods: ["embedContent"] },
				],
			}), { status: 200, headers: { "Content-Type": "application/json" } }));

			const models = await listProviderModels({
				baseUrl: "https://generativelanguage.googleapis.com",
				apiKey: "google-key",
				providerType: "google",
			});

			// Only chat-capable models (generateContent), not embeddings
			expect(models).toEqual([
				{ id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
				{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
			]);
		});
	});

	// ─── llama.cpp ──────────────────────────────────────────────────────

	describe("llamacpp", () => {
		it("uses OpenAI-compatible /v1 model endpoint when base URL is root", async () => {
			await listProviderModels({
				baseUrl: "http://localhost:8080",
				apiKey: "",
				providerType: "llamacpp",
			});

			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:8080/v1/models");
		});
	});

	// ─── KoboldCPP ──────────────────────────────────────────────────────

	describe("koboldcpp", () => {
		it("strips API suffixes and fetches /api/v1/model", async () => {
			const models = await listProviderModels({
				baseUrl: "http://localhost:5001/api/v1",
				apiKey: "",
				providerType: "koboldcpp",
			});

			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:5001/api/v1/model");
			expect(models).toEqual([
				{ id: "koboldcpp/qwen2.5-3b-instruct-q4_k_m", label: "koboldcpp/qwen2.5-3b-instruct-q4_k_m" },
			]);
		});

		it("throws on non-OK response", async () => {
			globalThis.fetch = mock(() => new Response("Not Found", { status: 404 }));
			expect(
				listProviderModels({ baseUrl: "http://localhost:5001", apiKey: "", providerType: "koboldcpp" }),
			).rejects.toThrow("KoboldCPP model list failed: 404");
		});
	});

	// ─── Ollama ─────────────────────────────────────────────────────────

	describe("ollama", () => {
		it("strips /v1 suffix and fetches /api/tags", async () => {
			const models = await listProviderModels({
				baseUrl: "http://localhost:11434/v1",
				apiKey: "",
				providerType: "ollama",
			});

			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:11434/api/tags");
			const headers = callArgs[1]?.headers as Record<string, string>;
			expect(headers["Authorization"]).toBeUndefined();

			expect(models).toEqual([
				{ id: "llama3:8b", label: "llama3:8b" },
				{ id: "mistral:7b", label: "mistral:7b" },
			]);
		});

		it("works without /v1 suffix", async () => {
			await listProviderModels({
				baseUrl: "http://localhost:11434",
				apiKey: "",
				providerType: "ollama",
			});

			const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
			expect(callArgs[0]).toBe("http://localhost:11434/api/tags");
		});

		it("throws on non-OK response", async () => {
			globalThis.fetch = mock(() => new Response("Not Found", { status: 404 }));
			expect(
				listProviderModels({ baseUrl: "http://localhost:11434", apiKey: "", providerType: "ollama" }),
			).rejects.toThrow("Ollama model list failed: 404");
		});
	});
	});
});

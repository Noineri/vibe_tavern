import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { generateText, streamText } from "ai";
import {
	normalizeProviderType,
	PROXY_MODE,
	type StoredProxyRecord,
} from "@vibe-tavern/domain";
import {
	listProviderModels,
	probeProviderConnection,
	testProviderChat,
} from "../src/domain/providers/provider-gateway.js";
import { resolveProtocol } from "../src/domain/providers/protocol-registry.js";
import {
	createProviderFetchFactory,
	resetProviderFetchFactory,
	resolveProviderFetchForProfile,
	setProviderFetchFactory,
	type ProxyLookup,
} from "../src/domain/providers/provider-fetch-factory.js";
import { resolveModel } from "../src/infrastructure/ai/provider-executor-utils.js";

const PROXIED_TARGET = "http://203.0.113.10:8080";
const TEST_PROXY_CERTIFICATE = Bun.file(new URL("./fixtures/provider-proxy-cert.pem", import.meta.url));
const TEST_PROXY_PRIVATE_KEY = Bun.file(new URL("./fixtures/provider-proxy-key.pem", import.meta.url));

interface ProxyHit {
	readonly method: string;
	readonly url: string;
	readonly proxyAuthorization: string | null;
}

/**
 * `Bun.serve` rebuilds `request.url` from the *listener's* scheme, so the TLS
 * mock proxy reports an absolute-form `http://target/...` request-target as
 * `https://target/...`. The wire request line is unchanged on Bun 1.4 —
 * captured directly off a raw TLS socket as
 * `GET http://203.0.113.10:8080/models HTTP/1.1` — so the rewrite is the mock
 * server's reconstruction, not the client. Assert on the authority and path
 * the proxy was told to reach: that is what proves the request traversed the
 * proxy toward the target instead of being rewritten to the proxy's own
 * origin, and it is the part no scheme reconstruction can fake.
 */
function reachesProxiedTarget(hit: ProxyHit): boolean {
	const target = new URL(PROXIED_TARGET);
	const seen = new URL(hit.url);
	return seen.host === target.host && seen.pathname.startsWith(target.pathname);
}

interface Fixture {
	readonly directTargetUrl: string;
	readonly proxyUrl: string;
	readonly proxyHits: ProxyHit[];
	readonly httpsProxyUrl: string;
	readonly httpsProxyHits: ProxyHit[];
	stop(): void;
}

function providerResponse(request: Request): Response | Promise<Response> {
	const path = new URL(request.url).pathname;
	if (request.method === "GET") {
		if (path.includes("/v1beta/models")) {
			return Response.json({ models: [{ name: "models/gemini-test", displayName: "Gemini Test", supportedGenerationMethods: ["generateContent"] }] });
		}
		if (path.endsWith("/api/tags")) return Response.json({ models: [{ name: "ollama-test", model: "ollama-test" }] });
		if (path.endsWith("/api/v1/model")) return Response.json({ result: "kobold-test" });
		if (path.endsWith("/models")) return Response.json({ data: [{ id: "test-model", display_name: "Test model" }] });
	}

	return request.text().then((body) => {
		const wantsStream = /"stream"\s*:\s*true/.test(body);
		if (path.endsWith("/responses")) {
			return Response.json({ id: "resp_1", object: "response", model: "test-model", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "response reply", annotations: [] }] }] });
		}
		if (path.endsWith("/chat/completions")) {
			if (wantsStream) return openAiStreamResponse();
			return Response.json({ id: "chat_1", object: "chat.completion", created: 0, model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "chat reply" }, finish_reason: "stop" }] });
		}
		if (path.endsWith("/api/chat")) {
			if (wantsStream) return ollamaStreamResponse();
			return Response.json({ model: "ollama-test", created_at: "2026-01-01T00:00:00Z", message: { role: "assistant", content: "ollama reply" }, done: true, done_reason: "stop" });
		}
		if (path.endsWith("/api/v1/generate")) return Response.json({ results: [{ text: "kobold reply" }] });
		if (path.endsWith("/messages")) return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "anthropic reply" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
		if (path.includes(":generateContent")) return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "google reply" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
		return new Response("Not found", { status: 404 });
	});
}

function openAiStreamResponse(): Response {
	const chunks = [
		`data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "streamed reply" }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	];
	return new Response(new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	}), { headers: { "Content-Type": "text/event-stream" } });
}

function ollamaStreamResponse(): Response {
	const chunks = [
		`${JSON.stringify({ model: "ollama-test", created_at: "2026-01-01T00:00:00Z", message: { role: "assistant", content: "streamed reply" }, done: false })}\n`,
		`${JSON.stringify({ model: "ollama-test", created_at: "2026-01-01T00:00:00Z", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`,
	];
	return new Response(new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	}), { headers: { "Content-Type": "application/x-ndjson" } });
}

function startFixture(): Fixture {
	const proxyHits: ProxyHit[] = [];
	const httpsProxyHits: ProxyHit[] = [];
	const directTarget = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: providerResponse });
	const proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			proxyHits.push({
				method: request.method,
				url: request.url,
				proxyAuthorization: request.headers.get("proxy-authorization"),
			});
			return providerResponse(request);
		},
	});
	const httpsProxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: {
			cert: TEST_PROXY_CERTIFICATE,
			key: TEST_PROXY_PRIVATE_KEY,
		},
		fetch(request) {
			httpsProxyHits.push({
				method: request.method,
				url: request.url,
				proxyAuthorization: request.headers.get("proxy-authorization"),
			});
			return providerResponse(request);
		},
	});
	return {
		directTargetUrl: `http://127.0.0.1:${directTarget.port}`,
		proxyUrl: `http://127.0.0.1:${proxy.port}`,
		proxyHits,
		httpsProxyUrl: `https://127.0.0.1:${httpsProxy.port}`,
		httpsProxyHits,
		stop: () => {
			directTarget.stop(true);
			proxy.stop(true);
			httpsProxy.stop(true);
		},
	};
}

function createTestCaFetch(): typeof fetch {
	const trustedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		fetch(input, {
			...init,
			tls: { ca: [TEST_PROXY_CERTIFICATE] },
		})) as typeof fetch;
	trustedFetch.preconnect = () => {};
	return trustedFetch;
}

function lookupFor(proxyUrl: string, defaultId: string | null = "proxy"): ProxyLookup {
	const record: StoredProxyRecord = {
		id: "proxy",
		name: "Test proxy",
		url: proxyUrl,
		username: null,
		password: null,
		sortOrder: 0,
		createdAt: "",
		updatedAt: "",
	};
	return {
		getById: async (id) => id === record.id ? record : null,
		getDefaultProxyId: async () => defaultId,
	};
}

async function proxiedFetch(fixture: Fixture) {
	setProviderFetchFactory(createProviderFetchFactory(lookupFor(fixture.proxyUrl)));
	const fetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "proxy" });
	if (!fetch) throw new Error("Expected a proxy-aware fetch.");
	return fetch;
}

const protocols = [
	"openai",
	"anthropic",
	"google",
	"ollama",
	"koboldcpp",
	"llamacpp",
	"unsloth",
] as const;

function modelFor(providerType: string): string {
	return providerType === "google" ? "gemini-test" : providerType === "ollama" ? "ollama-test" : providerType === "koboldcpp" ? "kobold-test" : "test-model";
}

describe("provider proxy traversal", () => {
	let fixture: Fixture;

	beforeAll(() => {
		fixture = startFixture();
	});
	afterAll(() => {
		resetProviderFetchFactory();
		fixture.stop();
	});
	beforeEach(() => {
		resetProviderFetchFactory();
		fixture.proxyHits.length = 0;
		fixture.httpsProxyHits.length = 0;
	});

	for (const providerType of protocols) {
		it(`${providerType} probe, model list, and test chat traverse the canned proxy`, async () => {
			const fetch = await proxiedFetch(fixture);
			const probe = await probeProviderConnection({ baseUrl: PROXIED_TARGET, apiKey: "key", providerType, fetch });
			const models = await listProviderModels({ baseUrl: PROXIED_TARGET, apiKey: "key", providerType, fetch });
			const test = await testProviderChat({ baseUrl: PROXIED_TARGET, apiKey: "key", model: modelFor(providerType), providerType, fetch });
			expect(probe.success).toBe(true);
			expect(models.length).toBeGreaterThan(0);
			expect(test.success).toBe(true);
			expect(fixture.proxyHits.length).toBeGreaterThanOrEqual(3);
			expect(fixture.proxyHits.every((hit) => hit.url.startsWith(PROXIED_TARGET))).toBe(true);
		});

		it(`${providerType} direct policy bypasses the proxy for loopback operations`, async () => {
			setProviderFetchFactory(createProviderFetchFactory(lookupFor(fixture.proxyUrl)));
			const fetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.direct, proxyId: null });
			expect(fetch).toBeUndefined();
			const probe = await probeProviderConnection({ baseUrl: fixture.directTargetUrl, apiKey: "key", providerType });
			const models = await listProviderModels({ baseUrl: fixture.directTargetUrl, apiKey: "key", providerType });
			const test = await testProviderChat({ baseUrl: fixture.directTargetUrl, apiKey: "key", model: modelFor(providerType), providerType });
			expect(probe.success).toBe(true);
			expect(models.length).toBeGreaterThan(0);
			expect(test.success).toBe(true);
			expect(fixture.proxyHits).toHaveLength(0);
		});
	}

	it("inherit uses the current global default and direct bypasses it", async () => {
		setProviderFetchFactory(createProviderFetchFactory(lookupFor(fixture.proxyUrl)));
		const inherited = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.inherit, proxyId: null });
		if (!inherited) throw new Error("Expected inherit to resolve the global proxy.");
		await listProviderModels({ baseUrl: PROXIED_TARGET, apiKey: "key", providerType: "openai", fetch: inherited });
		expect(fixture.proxyHits).toHaveLength(1);

		fixture.proxyHits.length = 0;
		const direct = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.direct, proxyId: null });
		expect(direct).toBeUndefined();
		await listProviderModels({ baseUrl: fixture.directTargetUrl, apiKey: "key", providerType: "openai" });
		expect(fixture.proxyHits).toHaveLength(0);
	});

	it("AI SDK factories use the injected fetch for OpenAI-compatible chat and streaming", async () => {
		const fetch = await proxiedFetch(fixture);
		const model = resolveModel({ providerPreset: "openai", endpoint: PROXIED_TARGET, apiKey: "key" }, "test-model", undefined, fetch);
		const generated = await generateText({ model, prompt: "Hi", maxOutputTokens: 16, maxRetries: 0 });
		expect(generated.text).toBe("chat reply");

		const streamed = streamText({ model, prompt: "Hi", maxOutputTokens: 16, maxRetries: 0 });
		let text = "";
		for await (const chunk of streamed.textStream) text += chunk;
		expect(text).toContain("streamed reply");
		expect(fixture.proxyHits).toHaveLength(2);
	});

	it("stored credentials are used for proxy authentication without entering the target URL", async () => {
		const record: StoredProxyRecord = {
			id: "credentialed",
			name: "Credentialed proxy",
			url: fixture.proxyUrl,
			username: "alice",
			password: "secret",
			sortOrder: 0,
			createdAt: "",
			updatedAt: "",
		};
		setProviderFetchFactory(createProviderFetchFactory({
			getById: async (id) => id === record.id ? record : null,
			getDefaultProxyId: async () => null,
		}));
		const authenticatedFetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: record.id });
		if (!authenticatedFetch) throw new Error("Expected an authenticated proxy fetch.");
		await authenticatedFetch(`${PROXIED_TARGET}/models`);
		expect(fixture.proxyHits).toHaveLength(1);
		expect(fixture.proxyHits[0]?.proxyAuthorization).toBe(`Basic ${btoa("alice:secret")}`);
		expect(fixture.proxyHits[0]?.url).toBe(`${PROXIED_TARGET}/models`);
	});

	it("rejects an HTTPS proxy whose certificate is not trusted", async () => {
		setProviderFetchFactory(createProviderFetchFactory(lookupFor(fixture.httpsProxyUrl)));
		const providerFetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "proxy" });
		if (!providerFetch) throw new Error("Expected an HTTPS proxy-aware fetch.");
		await expect(providerFetch(`${PROXIED_TARGET}/models`)).rejects.toThrow();
		expect(fixture.httpsProxyHits).toHaveLength(0);
	});

	it("traverses a trusted HTTPS proxy for gateway and AI SDK requests", async () => {
		setProviderFetchFactory(createProviderFetchFactory(
			lookupFor(fixture.httpsProxyUrl),
			createTestCaFetch(),
		));
		const providerFetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "proxy" });
		if (!providerFetch) throw new Error("Expected an HTTPS proxy-aware fetch.");

		const models = await listProviderModels({
			baseUrl: PROXIED_TARGET,
			apiKey: "key",
			providerType: "openai",
			fetch: providerFetch,
		});
		expect(models).toHaveLength(1);

		const model = resolveModel(
			{ providerPreset: "openai", endpoint: PROXIED_TARGET, apiKey: "key" },
			"test-model",
			undefined,
			providerFetch,
		);
		const generated = await generateText({ model, prompt: "Hi", maxOutputTokens: 16, maxRetries: 0 });
		expect(generated.text).toBe("chat reply");
		expect(fixture.httpsProxyHits).toHaveLength(2);
		expect(fixture.httpsProxyHits.every(reachesProxiedTarget)).toBe(true);
	});

	for (const providerType of ["anthropic", "google", "ollama", "koboldcpp", "llamacpp", "unsloth"] as const) {
		it(`${providerType} AI SDK or native generation uses the injected fetch`, async () => {
			const fetch = await proxiedFetch(fixture);
			const model = resolveProtocol(normalizeProviderType(providerType)).resolveModel(
				{ providerPreset: providerType, endpoint: PROXIED_TARGET, apiKey: "key" },
				modelFor(providerType),
				fetch,
			);
			const result = await generateText({ model, prompt: "Hi", maxOutputTokens: 16, maxRetries: 0 });
			expect(result.text.length).toBeGreaterThan(0);
			expect(fixture.proxyHits).toHaveLength(1);
		});
	}

	it("Ollama native streaming uses the injected fetch", async () => {
		const fetch = await proxiedFetch(fixture);
		const model = resolveProtocol(normalizeProviderType("ollama")).resolveModel(
			{ providerPreset: "ollama", endpoint: PROXIED_TARGET, apiKey: "" },
			"ollama-test",
			fetch,
		);
		const streamed = streamText({ model, prompt: "Hi", maxOutputTokens: 16, maxRetries: 0 });
		let text = "";
		for await (const chunk of streamed.textStream) text += chunk;
		expect(text).toContain("streamed reply");
		expect(fixture.proxyHits).toHaveLength(1);
	});
});

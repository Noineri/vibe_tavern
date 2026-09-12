/**
 * llama.cpp adapter — tokenize capability fixtures (LOCAL_SUPPORT_PLAN LS-1a/LS-1e).
 *
 * V1f-probed endpoint shape (LOCAL_SAMPLERS_ADDITION_REPORT): llama-server's
 * native `POST /tokenize` takes `{"content"}` and returns `{"tokens": [...]}` —
 * exact, no special tokens. The endpoint lives at the server ROOT (next to
 * /v1, not under it), so a profile endpoint carrying /v1 must be stripped.
 * Doubles enter at the adapter boundary (`TokenizeInput.fetch`) — no global
 * mutation, per the testing skill's tier policy.
 */
import { describe, it, expect } from "bun:test";
import { tokenizeLlamaCpp } from "../src/domain/providers/llamacpp-adapter.js";

interface CapturedCall {
	url: string;
	body: Record<string, unknown>;
}

function injectedFetch(
	respond: (url: string, body: Record<string, unknown>) => { status: number; json?: unknown },
	calls: CapturedCall[],
): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ url: urlText, body });
		const r = respond(urlText, body);
		return new Response(r.json !== undefined ? JSON.stringify(r.json) : "error", {
			status: r.status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

describe("llama.cpp adapter — tokenize (LS-1a)", () => {
	it("posts {content} to the server root /tokenize and returns tokens.length", async () => {
		const calls: CapturedCall[] = [];
		const count = await tokenizeLlamaCpp({
			baseUrl: "http://127.0.0.1:9401/v1",
			apiKey: null,
			text: "Hello world",
			fetch: injectedFetch(
				() => ({ status: 200, json: { tokens: [1, 2, 3, 4, 5] } }),
				calls,
			),
		});

		expect(count).toBe(5);
		expect(calls).toHaveLength(1);
		// /tokenize is a root endpoint — the /v1 suffix must be stripped.
		expect(calls[0]!.url).toBe("http://127.0.0.1:9401/tokenize");
		expect(calls[0]!.body).toEqual({ content: "Hello world" });
	});

	it("accepts a root endpoint without /v1 unchanged", async () => {
		const calls: CapturedCall[] = [];
		await tokenizeLlamaCpp({
			baseUrl: "http://127.0.0.1:9402",
			apiKey: null,
			text: "hi",
			fetch: injectedFetch(
				() => ({ status: 200, json: { tokens: [1, 2] } }),
				calls,
			),
		});
		expect(calls[0]!.url).toBe("http://127.0.0.1:9402/tokenize");
	});

	it("throws on HTTP error (endpoint absent — the counting layer falls back)", async () => {
		await expect(tokenizeLlamaCpp({
			baseUrl: "http://127.0.0.1:9403",
			apiKey: null,
			text: "hi",
			fetch: injectedFetch(() => ({ status: 404 }), []),
		})).rejects.toThrow("404");
	});

	it("throws on an unexpected response shape", async () => {
		await expect(tokenizeLlamaCpp({
			baseUrl: "http://127.0.0.1:9404",
			apiKey: null,
			text: "hi",
			fetch: injectedFetch(() => ({ status: 200, json: { nope: true } }), []),
		})).rejects.toThrow("tokens");
	});
});

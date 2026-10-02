import { describe, expect, it } from "bun:test";

import {
	extractProviderErrorBodyText,
	readProviderErrorBody,
} from "../src/infrastructure/ai/provider-error-body.js";

function jsonResponse(body: unknown, status = 500): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("extractProviderErrorBodyText", () => {
	it("unwraps {error:{message}} (OpenAI/OpenRouter shape)", () => {
		expect(
			extractProviderErrorBodyText({ error: { message: "Usage limit reached" } }),
		).toBe("Usage limit reached");
	});

	it("unwraps {error:'text'} string envelope", () => {
		expect(extractProviderErrorBodyText({ error: "Invalid API key" })).toBe("Invalid API key");
	});

	it("unwraps {detail} (A1111/FastAPI shape)", () => {
		expect(extractProviderErrorBodyText({ detail: "Sampler not found" })).toBe("Sampler not found");
	});

	it("unwraps {err_msg} (Deepgram shape) over unused candidates", () => {
		expect(extractProviderErrorBodyText({ err_code: "BAD_REQUEST", err_msg: "Malformed audio" })).toBe(
			"BAD_REQUEST: Malformed audio",
		);
	});

	it("composes Deepgram err_code + request_id when present", () => {
		expect(
			extractProviderErrorBodyText({ err_code: "QUOTA", err_msg: "Limit hit", request_id: "abc-123" }),
		).toBe("QUOTA: Limit hit (request abc-123)");
	});

	it("composes ElevenLabs {detail:{status,message}} shape", () => {
		expect(
			extractProviderErrorBodyText({ detail: { status: "insufficient_quota", message: "Character limit reached" } }),
		).toBe("insufficient_quota: Character limit reached");
	});

	it("unwraps flat {message}", () => {
		expect(extractProviderErrorBodyText({ message: "Model overloaded" })).toBe("Model overloaded");
	});

	it("composes OAuth {error, error_description} shape", () => {
		expect(
			extractProviderErrorBodyText({ error: "invalid_grant", error_description: "Invalid JWT Signature" }),
		).toBe("invalid_grant: Invalid JWT Signature");
	});

	it("joins string arrays (FastAPI validation {detail:[...]} shape)", () => {
		expect(
			extractProviderErrorBodyText({ detail: ["Field required: prompt", "Not a valid integer"] }),
		).toBe("Field required: prompt; Not a valid integer");
	});

	it("returns null for envelope keys that are not strings", () => {
		expect(extractProviderErrorBodyText({ error: { code: 401 } })).toBeNull();
	});

	it("returns null for non-object JSON", () => {
		expect(extractProviderErrorBodyText("plain string")).toBe("plain string");
		expect(extractProviderErrorBodyText(42)).toBeNull();
	});
});

describe("readProviderErrorBody", () => {
	it("extracts the provider message from a JSON envelope response", async () => {
		const detail = await readProviderErrorBody(
			jsonResponse({ error: { message: "Rate limited: free tier" } }, 429),
		);
		expect(detail).toBe("Rate limited: free tier");
	});

	it("returns the raw body verbatim when it is not JSON", async () => {
		const detail = await readProviderErrorBody(new Response("gateway exploded loudly", { status: 502 }));
		expect(detail).toBe("gateway exploded loudly");
	});

	it("does NOT truncate long provider messages (owner 2026-09-14)", async () => {
		const long = "x".repeat(600);
		const detail = await readProviderErrorBody(jsonResponse({ error: { message: long } }));
		expect(detail.length).toBe(600);
	});

	it("falls back to raw JSON text when no known key matches", async () => {
		const detail = await readProviderErrorBody(jsonResponse({ unexpected: { nested: true } }));
		expect(detail).toBe('{"unexpected":{"nested":true}}');
	});

	it("returns a placeholder for an empty body", async () => {
		const detail = await readProviderErrorBody(new Response("", { status: 500 }));
		expect(detail).toBe("(empty error body)");
	});
});

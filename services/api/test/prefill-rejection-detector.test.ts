import { describe, it, expect } from "bun:test";
import {
	PREFILL_REJECTION_PATTERNS,
	detectPrefillRejection,
} from "../src/infrastructure/ai/prefill-rejection-detector.js";

const MULTIAI_GEMINI_MESSAGE =
	"The conversation cannot end with a model response. Add a user or tool message before continuing.";
const GOOGLE_NATIVE_MESSAGE =
	"Please ensure that multiturn requests ends with a user role or a function role";
const GEMINI_MODEL_TURN_MESSAGE = "Requests ending with a model turn are not supported.";
/** A local gateway (agy-proxy) relaying the Gemini rejection: it answers
 *  HTTP 502 and wraps the upstream status + body into its own message. */
const GATEWAY_WRAPPED_MESSAGE = `upstream 400: ${JSON.stringify(
	{ error: { code: 400, message: GEMINI_MODEL_TURN_MESSAGE, status: "INVALID_ARGUMENT" } },
	null,
	2,
)}\n`;

describe("PREFILL_REJECTION_PATTERNS", () => {
	it("is seeded with exactly the three known provider texts", () => {
		expect(PREFILL_REJECTION_PATTERNS).toHaveLength(3);
	});
});

describe("detectPrefillRejection", () => {
	// ─── Positives: known texts ──────────────────────────────────────────

	it("matches the multiai/Gemini rejection in message", () => {
		expect(detectPrefillRejection({ status: 400, message: MULTIAI_GEMINI_MESSAGE })).toBe(true);
	});

	it("matches the Google native rejection in message", () => {
		expect(detectPrefillRejection({ status: 400, message: GOOGLE_NATIVE_MESSAGE })).toBe(true);
	});

	it("matches the Gemini model-turn rejection in message", () => {
		expect(detectPrefillRejection({ status: 400, message: GEMINI_MODEL_TURN_MESSAGE })).toBe(true);
		expect(detectPrefillRejection({ status: 400, message: GATEWAY_WRAPPED_MESSAGE })).toBe(true);
	});

	it("matches a gateway 5xx that explicitly wraps an upstream 4xx rejection", () => {
		expect(detectPrefillRejection({ status: 502, message: GATEWAY_WRAPPED_MESSAGE })).toBe(true);
		expect(
			detectPrefillRejection({ status: 502, responseBody: `upstream 422: ${MULTIAI_GEMINI_MESSAGE}` }),
		).toBe(true);
	});

	it("matches when only responseBody carries the known text", () => {
		expect(
			detectPrefillRejection({ status: 400, responseBody: MULTIAI_GEMINI_MESSAGE }),
		).toBe(true);
	});

	it("matches case-insensitively", () => {
		expect(
			detectPrefillRejection({ message: MULTIAI_GEMINI_MESSAGE.toUpperCase() }),
		).toBe(true);
	});

	it("matches despite whitespace variance (newlines, double spaces)", () => {
		expect(
			detectPrefillRejection({
				message:
					"The  conversation\ncannot  end with\ta model response. Add a user message.",
			}),
		).toBe(true);
		expect(
			detectPrefillRejection({
				message:
					"Please ensure that multiturn  requests\nends with a user role or a function role.",
			}),
		).toBe(true);
	});

	it("matches without any status present", () => {
		expect(detectPrefillRejection({ message: MULTIAI_GEMINI_MESSAGE })).toBe(true);
	});

	// ─── Negatives: strict matching, no heuristics ───────────────────────

	it("rejects an unrelated 400 message", () => {
		expect(
			detectPrefillRejection({ status: 400, message: "Invalid request: max_tokens must be positive." }),
		).toBe(false);
	});

	it("rejects a bare 400/422 without a known pattern", () => {
		expect(detectPrefillRejection({ status: 400 })).toBe(false);
		expect(detectPrefillRejection({ status: 422, message: "Unprocessable entity." })).toBe(false);
	});

	it("rejects missing message and responseBody", () => {
		expect(detectPrefillRejection({})).toBe(false);
		expect(detectPrefillRejection({ status: 400 })).toBe(false);
	});

	it("returns false for 500+ status even with a matching text (server-side errors are never prefill rejections)", () => {
		expect(
			detectPrefillRejection({ status: 500, message: MULTIAI_GEMINI_MESSAGE }),
		).toBe(false);
		expect(
			detectPrefillRejection({ status: 503, responseBody: GOOGLE_NATIVE_MESSAGE }),
		).toBe(false);
		expect(
			detectPrefillRejection({ status: 502, message: GEMINI_MODEL_TURN_MESSAGE }),
		).toBe(false);
	});

	it("returns false for a gateway 5xx unless it wraps an upstream 4xx AND carries a known text", () => {
		// Wrapped upstream 4xx, unrelated text.
		expect(
			detectPrefillRejection({ status: 502, message: "upstream 400: Invalid request: max_tokens must be positive." }),
		).toBe(false);
		// Known text, but the wrapped upstream status is itself a 5xx.
		expect(
			detectPrefillRejection({ status: 502, message: `upstream 503: ${GEMINI_MODEL_TURN_MESSAGE}` }),
		).toBe(false);
	});
});

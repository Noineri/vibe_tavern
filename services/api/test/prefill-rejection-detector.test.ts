import { describe, it, expect } from "bun:test";
import {
	PREFILL_REJECTION_PATTERNS,
	detectPrefillRejection,
} from "../src/infrastructure/ai/prefill-rejection-detector.js";

const MULTIAI_GEMINI_MESSAGE =
	"The conversation cannot end with a model response. Add a user or tool message before continuing.";
const GOOGLE_NATIVE_MESSAGE =
	"Please ensure that multiturn requests ends with a user role or a function role";

describe("PREFILL_REJECTION_PATTERNS", () => {
	it("is seeded with exactly the two known provider texts", () => {
		expect(PREFILL_REJECTION_PATTERNS).toHaveLength(2);
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
	});
});

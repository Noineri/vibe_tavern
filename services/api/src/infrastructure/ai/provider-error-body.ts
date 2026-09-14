/**
 * Shared provider HTTP-error body reader: normalizes the failure body of a
 * provider API response into a human-readable message WITHOUT truncation.
 *
 * Providers wrap their errors in JSON envelopes with vendor-specific keys
 * (`{error:{message}}` OpenAI/OpenRouter, `{detail}` A1111/FastAPI,
 * `{err_code, err_msg}` Deepgram, …). This module unwraps the common shapes
 * and falls back to the raw body text; it never slices or ellipsizes —
 * the diagnostic tail is frequently the informative part (owner 2026-09-14:
 * normalize, don't trim).
 */

type JsonRecord = Record<string, unknown>;

const MESSAGE_KEY_CANDIDATES = [
	"message",
	"detail",
	"err_msg",
	"error_message",
	"errorMessage",
] as const;

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function readStringOrList(value: unknown): string | null {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		const parts = value
			.map((entry) => (typeof entry === "string" ? entry : null))
			.filter((entry): entry is string => entry !== null);
		return parts.length > 0 ? parts.join("; ") : null;
	}
	return null;
}

/**
 * Extract the human-readable message from a parsed provider error envelope.
 * Handles one nesting level (`error: {message}` / `error: "text"`) plus the
 * flat key candidates; returns null when nothing string-like is found.
 */
export function extractProviderErrorBodyText(parsed: unknown): string | null {
	const root = asRecord(parsed);
	if (root === null) {
		return readStringOrList(parsed);
	}
	// Deepgram vendor shape: `{err_code, err_msg, request_id}`.
	const errCode = root["err_code"];
	const errMsg = root["err_msg"];
	if (typeof errCode === "string" && typeof errMsg === "string") {
		const requestId =
			typeof root["request_id"] === "string" ? ` (request ${root["request_id"]})` : "";
		return `${errCode}: ${errMsg}${requestId}`;
	}
	// ElevenLabs vendor shape: `{detail: {status, message}}`.
	const detail = asRecord(root["detail"]);
	if (detail !== null) {
		const status = detail["status"];
		const message = detail["message"];
		if (typeof status === "string" && typeof message === "string") {
			return `${status}: ${message}`;
		}
	}
	const nested = asRecord(root["error"]);
	if (nested !== null) {
		for (const key of MESSAGE_KEY_CANDIDATES) {
			const hit = readStringOrList(nested[key]);
			if (hit !== null && hit.trim().length > 0) {
				return hit;
			}
		}
	}
	const nestedError = readStringOrList(root["error"]);
	if (nestedError !== null && nestedError.trim().length > 0) {
		return nestedError;
	}
	for (const key of MESSAGE_KEY_CANDIDATES) {
		const hit = readStringOrList(root[key]);
		if (hit !== null && hit.trim().length > 0) {
			return hit;
		}
	}
	return null;
}

/** Read and normalize a failed provider HTTP response body. */
export async function readProviderErrorBody(response: Response): Promise<string> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return "(unreadable error body)";
	}
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return "(empty error body)";
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		const extracted = extractProviderErrorBodyText(parsed);
		if (extracted !== null) {
			return extracted.trim();
		}
	} catch {
		// Not JSON — the raw body text is the message.
	}
	return trimmed;
}

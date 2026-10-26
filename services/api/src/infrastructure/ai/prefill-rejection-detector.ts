/**
 * Conservative detector for provider rejections of a trailing-assistant
 * (prefill) message.
 *
 * Continue rides the variant text as a trailing assistant prefill. Some
 * backends refuse a last-assistant-turn request outright (Gemini via
 * aggregators, Google native generateContent); the fallback path must only
 * trigger on those known rejections — a generic 400 must NOT trigger it,
 * or unrelated client errors would be retried as continuations.
 *
 * Matching is strict on purpose: a bare 4xx status without a known pattern
 * match is never a prefill rejection, and 5xx statuses are never prefill
 * rejections (server-side errors) — EXCEPT a gateway 5xx whose text
 * explicitly wraps an upstream 4xx ("upstream 400: …") that itself carries a
 * known pattern: a local gateway relaying Gemini answers 502 for the
 * upstream's 400 rejection. The pattern list exists to be extended one line
 * at a time as new provider texts are met.
 */

export const PREFILL_REJECTION_PATTERNS: readonly RegExp[] = [
	/conversation\s+cannot\s+end\s+with\s+a\s+model\s+response/i,
	/multiturn\s+requests?\s+ends?\s+with\s+a\s+user\s+role\s+or\s+a\s+function\s+role/i,
	/requests?\s+ending\s+with\s+a\s+model\s+turn\s+(?:is|are)\s+not\s+supported/i,
];

/** A gateway's own 5xx relaying an upstream client error, e.g.
 *  `upstream 400: {"error":{…}}` (the local agy-proxy convention). */
const WRAPPED_UPSTREAM_4XX = /\bupstream\s+4\d\d\b/i;

export interface PrefillRejectionInput {
	status?: number;
	message?: string;
	responseBody?: string;
}

/**
 * Returns true ONLY when one of the known patterns matches `message`
 * and/or `responseBody`. `status` is corroboration only: a present status
 * >= 500 forces false (server-side errors are never prefill rejections)
 * unless the SAME text also carries an explicit wrapped upstream 4xx.
 */
export function detectPrefillRejection(input: PrefillRejectionInput): boolean {
	const { status, message, responseBody } = input;
	const serverStatus = status !== undefined && status >= 500;
	const haystacks = [message, responseBody];
	return haystacks.some(
		(haystack) =>
			typeof haystack === "string" &&
			(!serverStatus || WRAPPED_UPSTREAM_4XX.test(haystack)) &&
			PREFILL_REJECTION_PATTERNS.some((pattern) => pattern.test(haystack)),
	);
}

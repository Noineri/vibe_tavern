/**
 * Shared tokenizer singleton for the frontend.
 * Uses cl100k_base (GPT-4 class) — same as backend's countTokensDefault().
 * Lazy-loaded on first use.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";

let instance: Tiktoken | null = null;

export function getTokenizer(): Tiktoken {
	if (!instance) {
		instance = getEncoding("cl100k_base");
	}
	return instance;
}

export function countTokens(text: string): number {
	if (!text || typeof text !== "string") return 0;
	return getTokenizer().encode(text).length;
}

/**
 * Tokenizer service — maps model names to real tokenizers.
 *
 * Uses:
 * - js-tiktoken for OpenAI models (GPT-4, GPT-4o, etc.)
 * - @agnai/web-tokenizers for Claude, Llama3, Qwen2, DeepSeek, etc.
 * - Byte-based fallback for unknown models
 */

import { join, resolve } from "node:path";
import { getEncoding, type Tiktoken, type TiktokenEncoding } from "js-tiktoken";
import { Tokenizer as WebTokenizer } from "@agnai/web-tokenizers";

// ── Byte-based fallback ──────────────────────────────────────────────────

const BYTES_PER_TOKEN = 3.35;

function guesstimate(text: string): number {
	const byteLen = new TextEncoder().encode(text).length;
	return Math.ceil(byteLen / BYTES_PER_TOKEN);
}

// ── Paths ────────────────────────────────────────────────────────────────

async function resolveTokenizerDir(): Promise<string> {
	const candidates = [
		process.env.RP_PLATFORM_TOKENIZER_DIR,
		// Standalone binary/release artifact: dist/tokenizers next to executable.
		join(resolve(process.execPath, ".."), "tokenizers"),
		// Flat bundled services/api output: services/api/dist/tokenizers.
		join(import.meta.dir, "tokenizers"),
		// Preserved module output: dist/services/api/src/tokenizers.
		join(import.meta.dir, "..", "tokenizers"),
		// Source checkout/dev fallback when running from repo root.
		join(process.cwd(), "services", "api", "src", "tokenizers"),
	].filter(Boolean) as string[];

	for (const dir of candidates) {
		if (await Bun.file(join(dir, "claude.json")).exists()) {
			return dir;
		}
	}

	return candidates[candidates.length - 1];
}

let TOKENIZER_DIR: string | undefined;

async function ensureTokenizerDir(): Promise<string> {
	if (!TOKENIZER_DIR) {
		TOKENIZER_DIR = await resolveTokenizerDir();
	}
	return TOKENIZER_DIR;
}

// ── Tokenizer caches (lazy singletons) ──────────────────────────────────

const tiktokenCache = new Map<string, Tiktoken>();
const webTokenizerCache = new Map<string, WebTokenizer>();

function getTiktoken(encoding: string): Tiktoken {
	let instance = tiktokenCache.get(encoding);
	if (instance) return instance;
	instance = getEncoding(encoding as TiktokenEncoding);
	tiktokenCache.set(encoding, instance);
	return instance;
}

async function getWebTokenizer(file: string): Promise<WebTokenizer> {
	let instance = webTokenizerCache.get(file);
	if (instance) return instance;
	const dir = await ensureTokenizerDir();
	const buf = await Bun.file(join(dir, file)).arrayBuffer();
	instance = await WebTokenizer.fromJSON(buf);
	webTokenizerCache.set(file, instance);
	return instance;
}

// ── Model → tokenizer mapping ───────────────────────────────────────────

type TokenizerFamily =
	| { type: "tiktoken"; encoding: string }
	| { type: "web"; file: string }
	| { type: "fallback" };

const OPENAI_TIKTOKEN: Array<[RegExp, string]> = [
	[/^o[134]/, "o200k_base"],
	[/^gpt-5/, "o200k_base"],
	[/^gpt-4\.?1/, "o200k_base"],
	[/^gpt-4\.?5/, "o200k_base"],
	[/^gpt-4o/, "o200k_base"],
	[/^chatgpt-4o/, "o200k_base"],
	[/^gpt-4-32k/, "cl100k_base"],
	[/^gpt-4/, "cl100k_base"],
	[/^gpt-3\.5-turbo-0301/, "p50k_base"],
	[/^gpt-3\.5-turbo/, "cl100k_base"],
	[/^gpt-3\.5/, "cl100k_base"],
];

const WEB_TOKENIZERS: Array<[RegExp, string]> = [
	[/claude/, "claude.json"],
	[/llama[-_]?3/, "llama3.json"],
	[/qwen/, "llama3.json"],
	[/deepseek/, "llama3.json"],
	[/mistral|mixtral|codestral/, "llama3.json"],
	[/gemini|gemma/, "llama3.json"],
	[/command/, "llama3.json"],
	[/nemo/, "llama3.json"],
	[/llama/, "llama3.json"],
	[/yi[-_]/, "llama3.json"],
	[/jamba/, "llama3.json"],
	[/phi/, "llama3.json"],
	[/glm/, "llama3.json"],
	[/hermes/, "llama3.json"],
	[/dolphin/, "llama3.json"],
	[/mythomax/, "llama3.json"],
	[/magnum/, "llama3.json"],
	[/anthracite/, "llama3.json"],
	[/toppy/, "llama3.json"],
	[/noromaid/, "llama3.json"],
	[/openchat/, "llama3.json"],
	[/nous/, "llama3.json"],
];

function resolveTokenizerFamily(model: string): TokenizerFamily {
	const m = model.toLowerCase();

	for (const [re, encoding] of OPENAI_TIKTOKEN) {
		if (re.test(m)) return { type: "tiktoken", encoding };
	}

	for (const [re, file] of WEB_TOKENIZERS) {
		if (re.test(m)) return { type: "web", file };
	}

	return { type: "fallback" };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Count tokens for a string. Synchronous (web-tokenizers are pre-loaded).
 * Falls back to byte estimation if no model or tokenizer fails.
 */
export function countTokens(text: string, model?: string): number {
	if (!text) return 0;

	// When no model is specified, use cl100k_base as a universal default.
	// It's more accurate than byte estimation for all languages.
	if (!model) return countTokensDefault(text);

	const family = resolveTokenizerFamily(model);

	try {
		switch (family.type) {
			case "tiktoken": {
				const tokenizer = getTiktoken(family.encoding);
				return tokenizer.encode(text).length;
			}
			case "web": {
				const cached = webTokenizerCache.get(family.file);
				if (cached) return cached.encode(text).length;
				// Not loaded yet — fallback to cl100k_base
				return countTokensDefault(text);
			}
		}
	} catch {
		// ignore — fallback below
	}

	return countTokensDefault(text);
}

/**
 * Count tokens using cl100k_base (GPT-4 class tokenizer).
 * Good universal default for prompt pipeline — much more accurate than
 * byte estimation for all languages, even for non-OpenAI models.
 */
export function countTokensDefault(text: string): number {
	if (!text) return 0;
	try {
		return getTiktoken("cl100k_base").encode(text).length;
	} catch {
		return guesstimate(text);
	}
}

/**
 * Pre-load all web-tokenizer models so countTokens() can stay synchronous.
 * Call once at server startup.
 */
export async function warmupTokenizers(): Promise<void> {
	const files = new Set(WEB_TOKENIZERS.map(([, f]) => f));
	for (const file of files) {
		try {
			await getWebTokenizer(file);
		} catch (e) {
			console.warn(`[tokenizer] Failed to load ${file}:`, e instanceof Error ? e.message : e);
		}
	}
	console.info(`[tokenizer] Warmed up ${tiktokenCache.size + webTokenizerCache.size} tokenizer(s)`);
}

/**
 * Count tokens for an array of chat messages (role + content).
 */
export function countMessageTokens(
	messages: Array<{ role: string; content: string }>,
	model?: string,
): number {
	const overhead = 4;
	let total = 0;
	for (const msg of messages) {
		total += overhead + countTokens(msg.content, model);
	}
	total += 3; // priming tokens
	return total;
}

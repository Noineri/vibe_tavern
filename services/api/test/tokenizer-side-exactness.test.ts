/**
 * Separator-side exactness — TOKEN_COUNT_ONCE_PLAN TC-3.
 *
 * The contract behind the per-message history decomposition: for every
 * tokenizer listed in the side table, the decomposed count equals the joined
 * count TO THE TOKEN — on the side the table names — across fixture sizes
 * and content classes (ASCII, Cyrillic, emoji, multiline, punctuation
 * endings, single characters, tool-result JSON). A tokenizer without a
 * fixture rail here must answer null and keep the joined count.
 *
 * This file also carries the TC-3 spy evidence (one encode per message per
 * assembly on a cold cache, zero on a warm one) and the compaction-boundary
 * proof (decomposed counter and joined counter produce identical plans).
 *
 * Process-sharing (services/api tests share one process): NO file-order
 * guarantee exists — discovery order is readdir-order on Linux CI and
 * alphabetical on Windows dev, so this file cannot "sort after"
 * tokenizer-service.test.ts. When it runs FIRST its warmup leaves the cache
 * full; the service file's cold describe snapshots + clears + restores its
 * own precondition, so both orders hold. This file warms only the rails it
 * exercises (see WARM_MODELS below). The injected pipeline state set here is
 * fully restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	countTokens,
	warmupTokenizers,
	resolveTokenizerId,
	separatorSide,
	setPersistentTokenCountStore,
	getTokenCountLayerStatsForTests,
	resetTokenCountLayerForTests,
} from "../src/infrastructure/ai/tokenizer-service.js";
import {
	countHistoryTokens,
	formatRecentMessages,
	planHistoryCompaction,
	setModelHint,
	setSeparatorSideFn,
	setTokenCountFn,
} from "@vibe-tavern/prompt-pipeline";
import {
	estimateCoauthorHistoryTokens,
	formatCoauthorHistoryMessages,
} from "../src/domain/chat/coauthor-prompt.js";
import type { RecentMessage } from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart, ToolResultPart } from "ai";

// ── Fixtures ────────────────────────────────────────────────────────────
// Content classes chosen to stress the separator-merge boundary: pieces
// ending in punctuation (., ?, …, !, :), pieces with none, Cyrillic
// (byte-level pieces), emoji (multi-byte), internal blank lines (an in-piece
// "\n\n"), whitespace runs, and a one-character piece.

const CONTENTS: string[] = [
	"Hello there!",
	"How are you today?",
	"no trailing punctuation",
	"Привет! Как твои дела? Это проверка — кириллица, тире и многоточие…",
	"Emoji mix 🎭🔥👍🏽 with ZWJ family 👨‍👩‍👧‍👦 and a checkered flag 🏁",
	"Line one\nLine two\n\nLine four after a blank",
	"Trailing spaces  	and a tab	",
	"«Ну и что ты мне сделаешь?» — ухмыльнулась она.",
	"a",
	"Съешь ещё этих мягких французских булок, да выпей же чаю.",
	"Mixed языки text with English words and русские слова вместе.",
	"...",
	"🤖",
	"A long paragraph: " + "tok ".repeat(40),
	"Done.",
	"What if it ends with a colon:",
];

function rpMessages(n: number): RecentMessage[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `msg_${i}`,
		role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
		content: CONTENTS[i % CONTENTS.length]!,
	}));
}

/** RP history with EMPTY messages: the piece is "ROLE: " — the role label's
 *  own trailing space makes these the whitespace-ending guarded class even
 *  though the RP formatter trims content. */
function rpMessagesWithEmpty(n: number): RecentMessage[] {
	return rpMessages(n).map((m, i) => (i % 6 === 5 ? { ...m, content: "" } : m));
}

type CoauthorFixture =
	| { role: "user" | "assistant"; content: string; toolCalls?: ToolCallPart[] }
	| { role: "tool"; content: ToolResultPart[] };

function coauthorMessages(n: number): CoauthorFixture[] {
	const toolResult = (i: number): ToolResultPart => ({
		type: "tool-result",
		toolCallId: `tc_${i}`,
		toolName: "propose_edit",
		output: { type: "text", value: `Привет! Result text ${i} — с кириллицей и пунктуацией…` },
	});
	const toolCall = (i: number): ToolCallPart => ({
		type: "tool-call",
		toolCallId: `tc_${i}`,
		toolName: "propose_edit",
		input: { section: "greetings", index: i },
	});
	return Array.from({ length: n }, (_, i): CoauthorFixture => {
		if (i % 5 === 4) return { role: "tool", content: [toolResult(i)] };
		if (i % 5 === 3) {
			return { role: "assistant", content: `Calling the editor tool ${i}.`, toolCalls: [toolCall(i + 1)] };
		}
		// i % 7 === 6: an EMPTY co-author message — "ROLE: " guarded class;
		// CONTENTS[6] carries a verbatim trailing tab — the other guarded class
		// (co-author content is never trimmed).
		if (i % 7 === 6) return { role: i % 2 === 0 ? "user" : "assistant", content: "" };
		return { role: i % 2 === 0 ? "user" : "assistant", content: CONTENTS[i % CONTENTS.length]! };
	});
}

/** Rails of the side table, each with the model that selects its tokenizer. */
const RAILS: Array<{ label: string; model?: string; side: "after" | "before" }> = [
	{ label: "tiktoken:cl100k_base", model: undefined, side: "after" },
	{ label: "tiktoken:o200k_base", model: "gpt-4o", side: "after" },
	{ label: "tiktoken:p50k_base", model: "gpt-3.5-turbo-0301", side: "before" },
	{ label: "web:llama3.json", model: "gemini-2.0-flash", side: "after" },
	{ label: "web:claude.json", model: "claude-sonnet-4-5", side: "before" },
];

/** Tokenizers deliberately NOT in the table (measured: qwen binds after,
 *  mistral has no exact side — both stay null until deliberately added). */
const NULL_RAILS: Array<{ label: string; model: string }> = [
	{ label: "web:qwen2.json", model: "qwen2.5-instruct" },
	{ label: "web:mistral.json", model: "mistral-large-2411" },
];

/** The models warmed here — DERIVED from RAILS and NULL_RAILS, never a second
 *  list: every distinct model the rails exercise. warmupTokenizers resolves
 *  each through resolveTokenizerFamily, so exactly this file's four REAL web
 *  tokenizers load (llama3, claude, qwen2, mistral); the tiktoken rails load
 *  lazily and were never part of the hook's cost. Including NULL_RAILS keeps
 *  Qwen2/Mistral on real tokenizers — coverage must not narrow to cold
 *  cl100k fallbacks. */
const WARM_MODELS: string[] = [
	...new Set(
		[...RAILS, ...NULL_RAILS]
			.map((rail) => rail.model)
			.filter((model): model is string => model !== undefined),
	),
];

beforeAll(async () => {
	// Scoped warmup — only this file's four real web tokenizers load here
	// (see WARM_MODELS); previously this hook warmed all 10 files (~5.9 s,
	// over bun's 5 s default hook timeout) although only four rails are
	// exercised. The budget stays the measured all-10 figure on purpose: the
	// hook got cheaper, not the guarantee weaker.
	await warmupTokenizers(WARM_MODELS);
	setTokenCountFn(countTokens);
	setSeparatorSideFn((model) => separatorSide(resolveTokenizerId(model)));
	setPersistentTokenCountStore(null);
}, 30_000);

afterAll(() => {
	setSeparatorSideFn(null);
	setTokenCountFn(() => 0);
	setModelHint(undefined);
	setPersistentTokenCountStore(null);
	resetTokenCountLayerForTests();
});

describe("side table routing", () => {
	test("every rail resolves to the id and side the fixture rail pins", () => {
		for (const rail of RAILS) {
			expect(resolveTokenizerId(rail.model)).toBe(rail.label);
			expect(separatorSide(resolveTokenizerId(rail.model))).toBe(rail.side);
		}
	});

	test("tokenizers without a fixture rail answer null", () => {
		for (const rail of NULL_RAILS) {
			expect(separatorSide(resolveTokenizerId(rail.model))).toBeNull();
		}
		expect(separatorSide("tiktoken:r50k_base")).toBeNull();
		expect(separatorSide("web:totally-new.json")).toBeNull();
	});
});

describe("decomposed == joined, to the token (real tokenizers)", () => {
	for (const rail of RAILS) {
		test(`${rail.label} (${rail.side}) — RP history pieces, 2 / 10 / 55 messages`, () => {
			setModelHint(rail.model);
			for (const n of [2, 10, 55]) {
				const messages = rpMessages(n);
				expect(countHistoryTokens(messages))
					.toBe(countTokens(formatRecentMessages(messages), rail.model));
			}
		});

		test(`${rail.label} (${rail.side}) — co-author pieces incl. tool JSON, 2 / 10 / 55 messages`, () => {
			setModelHint(rail.model);
			for (const n of [2, 10, 55]) {
				const messages = coauthorMessages(n);
				expect(estimateCoauthorHistoryTokens(messages))
					.toBe(countTokens(formatCoauthorHistoryMessages(messages), rail.model));
			}
		});
	}

	for (const rail of NULL_RAILS) {
		test(`${rail.label} (null side) keeps exactly the joined count`, () => {
			setModelHint(rail.model);
			for (const n of [2, 10, 55]) {
				const messages = rpMessages(n);
				expect(countHistoryTokens(messages))
					.toBe(countTokens(formatRecentMessages(messages), rail.model));
			}
		});
	}
});

/** Spy fixtures need DISTINCT pieces: the layered cache dedups identical
 *  texts (correctly — that is its job), so a repeated-content history encodes
 *  fewer times than it has messages. Uniqueness isolates the asserted
 *  property: one encode per DISTINCT message piece, once. */
function spyMessages(n: number, model: string): RecentMessage[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `msg_${i}`,
		role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
		content: `${model} turn ${i}: ${CONTENTS[i % CONTENTS.length]}`,
	}));
}

describe("guarded classes: whitespace-ending pieces keep exactly the joined count (before side)", () => {
	test("claude: RP history with empty messages — joined count, provably via the joined fallback", () => {
		setModelHint("claude-sonnet-4-5");
		for (const n of [2, 10, 55]) {
			const messages = rpMessagesWithEmpty(n);
			expect(countHistoryTokens(messages))
				.toBe(countTokens(formatRecentMessages(messages), "claude-sonnet-4-5"));
		}
		// Routing proof, not coincidence: the whole guarded assembly encodes
		// exactly ONE text — the joined string.
		resetTokenCountLayerForTests();
		countHistoryTokens(rpMessagesWithEmpty(10));
		expect(getTokenCountLayerStatsForTests().encodes).toBe(1);
	});

	test("p50k: RP history with empty messages — joined count via the fallback", () => {
		setModelHint("gpt-3.5-turbo-0301");
		for (const n of [2, 10, 55]) {
			const messages = rpMessagesWithEmpty(n);
			expect(countHistoryTokens(messages))
				.toBe(countTokens(formatRecentMessages(messages), "gpt-3.5-turbo-0301"));
		}
		resetTokenCountLayerForTests();
		countHistoryTokens(rpMessagesWithEmpty(10));
		expect(getTokenCountLayerStatsForTests().encodes).toBe(1);
	});

	test("claude: co-author verbatim whitespace/empty content — joined count via the fallback", () => {
		setModelHint("claude-sonnet-4-5");
		for (const n of [7, 10, 55]) {
			const messages = coauthorMessages(n);
			expect(estimateCoauthorHistoryTokens(messages))
				.toBe(countTokens(formatCoauthorHistoryMessages(messages), "claude-sonnet-4-5"));
		}
		resetTokenCountLayerForTests();
		estimateCoauthorHistoryTokens(coauthorMessages(10));
		expect(getTokenCountLayerStatsForTests().encodes).toBe(1);
	});

	test("after side: the SAME empty-message history stays decomposed and exact", () => {
		setModelHint("gpt-4o");
		for (const n of [2, 10, 55]) {
			const messages = rpMessagesWithEmpty(n);
			expect(countHistoryTokens(messages))
				.toBe(countTokens(formatRecentMessages(messages), "gpt-4o"));
		}
		// Still one encode per message — no guard on the "after" side.
		resetTokenCountLayerForTests();
		const messages = rpMessagesWithEmpty(10);
		countHistoryTokens(messages);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(10);
	});
});

describe("encode spy (TC-2 layerStats) — one encode per message, once", () => {
	test("after side: cold cache encodes 55 texts for 55 messages, warm encodes none", () => {
		resetTokenCountLayerForTests();
		setModelHint("gpt-4o");
		const messages = spyMessages(55, "gpt-4o");
		countHistoryTokens(messages);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(55);
		countHistoryTokens(messages);
		countHistoryTokens(messages);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(55);
	});

	test("before side: cold cache encodes 55 texts for 55 messages, warm encodes none", () => {
		resetTokenCountLayerForTests();
		setModelHint("claude-sonnet-4-5");
		const messages = spyMessages(55, "claude");
		countHistoryTokens(messages);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(55);
		countHistoryTokens(messages);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(55);
	});

	test("co-author pieces ride the same one-encode-per-piece contract", () => {
		resetTokenCountLayerForTests();
		setModelHint("claude-sonnet-4-5");
		// n=5: clean pieces only (the i%7===6 empty message and the verbatim
		// trailing-tab content appear from i=6 on — those are the guarded-class
		// rails above, which correctly encode ONE joined text instead).
		const messages = coauthorMessages(5);
		estimateCoauthorHistoryTokens(messages);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(5);
		estimateCoauthorHistoryTokens(messages);
		expect(getTokenCountLayerStatsForTests().encodes).toBe(5);
	});
});

describe("compaction boundaries are identical under the decomposition (cl100k)", () => {
	test("decomposed and joined counters produce identical plans across budget sweep", () => {
		setModelHint(undefined); // cl100k — the "after" side
		const messages = rpMessages(40);
		const full = countTokens(formatRecentMessages(messages));
		const joinedCounter = (msgs: ReadonlyArray<RecentMessage>) => countTokens(formatRecentMessages(msgs));
		// Sweep budgets that force cuts at different depths plus the two
		// extremes (everything kept, everything-but-the-pair dropped).
		for (const budget of [
			Math.ceil(full * 0.25),
			Math.ceil(full * 0.5),
			Math.ceil(full * 0.8),
			full + 1,
			1,
		]) {
			const decomposedPlan = planHistoryCompaction({
				messages,
				nonHistoryTokens: 0,
				contextBudget: budget,
				responseReserve: 0,
				countHistoryTokens,
			});
			const joinedPlan = planHistoryCompaction({
				messages,
				nonHistoryTokens: 0,
				contextBudget: budget,
				responseReserve: 0,
				countHistoryTokens: joinedCounter,
			});
			expect(decomposedPlan).toEqual(joinedPlan);
		}
	});

	test("the sweep really crossed a boundary (some budgets cut, one keeps everything)", () => {
		setModelHint(undefined);
		const messages = rpMessages(40);
		const full = countTokens(formatRecentMessages(messages));
		const tight = planHistoryCompaction({
			messages,
			nonHistoryTokens: 0,
			contextBudget: Math.ceil(full * 0.25),
			countHistoryTokens,
		});
		const loose = planHistoryCompaction({
			messages,
			nonHistoryTokens: 0,
			contextBudget: full + 1,
			countHistoryTokens,
		});
		expect(tight).not.toBeNull();
		expect(tight?.messages.length).toBeLessThan(messages.length);
		expect(loose).toBeNull();
	});

	describe("guarded compaction (claude, empty-message history)", () => {
		test("cut boundaries are identical to the joined counter — guarded assemblies ARE today's count", () => {
			setModelHint("claude-sonnet-4-5");
			const messages = rpMessagesWithEmpty(40);
			const full = countTokens(formatRecentMessages(messages), "claude-sonnet-4-5");
			const joinedCounter = (msgs: ReadonlyArray<RecentMessage>) =>
				countTokens(formatRecentMessages(msgs), "claude-sonnet-4-5");
			for (const budget of [Math.ceil(full * 0.25), Math.ceil(full * 0.5), Math.ceil(full * 0.8), full + 1, 1]) {
				const guardedPlan = planHistoryCompaction({
					messages,
					nonHistoryTokens: 0,
					contextBudget: budget,
					responseReserve: 0,
					countHistoryTokens,
				});
				const joinedPlan = planHistoryCompaction({
					messages,
					nonHistoryTokens: 0,
					contextBudget: budget,
					responseReserve: 0,
					countHistoryTokens: joinedCounter,
				});
				expect(guardedPlan).toEqual(joinedPlan);
			}
		});

		test("suffix costs stay non-decreasing while guarded and decomposed probes interleave", () => {
			setModelHint("claude-sonnet-4-5");
			// Short suffixes that exclude the empty messages are decomposed;
			// longer ones include them and are guarded-joined — the interleave.
			const messages = rpMessagesWithEmpty(30);
			let previous = 0;
			for (let start = messages.length - 1; start >= 0; start -= 1) {
				const cost = countHistoryTokens(messages.slice(start));
				expect(cost).toBeGreaterThanOrEqual(previous);
				previous = cost;
			}
		});
	});
});

describe("suffix cost never decreases when older messages are prepended (real tokenizers)", () => {
	test("before side (claude): growing suffixes are monotonically non-decreasing", () => {
		setModelHint("claude-sonnet-4-5");
		const messages = rpMessages(30);
		let previous = 0;
		for (let start = messages.length - 1; start >= 0; start -= 1) {
			const cost = countHistoryTokens(messages.slice(start));
			expect(cost).toBeGreaterThanOrEqual(previous);
			previous = cost;
		}
	});

	test("after side (o200k): growing suffixes are monotonically non-decreasing", () => {
		setModelHint("gpt-4o");
		const messages = rpMessages(30);
		let previous = 0;
		for (let start = messages.length - 1; start >= 0; start -= 1) {
			const cost = countHistoryTokens(messages.slice(start));
			expect(cost).toBeGreaterThanOrEqual(previous);
			previous = cost;
		}
	});
});

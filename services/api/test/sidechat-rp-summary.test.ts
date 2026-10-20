import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreContainer } from "@vibe-tavern/db";
import { createStoreContainer } from "@vibe-tavern/db";
import {
	brandId,
	type ChatBranchId,
	type ChatId,
	type ExperienceCopilotThreadId,
} from "@vibe-tavern/domain";
import { estimateTokens, setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { estimateHistoryTokens } from "../src/domain/agent/agent-prompt.js";
import { syncBeforeUserMessage, type RpSyncDeps } from "../src/domain/sidechat/rp-sync.js";
import {
	assembleSidechatPrompt,
} from "../src/domain/sidechat/sidechat-stream.js";
import {
	loadSidechatContext,
	type SidechatContextDeps,
	type SidechatContextPackage,
} from "../src/domain/sidechat/sidechat-context.js";

/**
 * SC-6 — the RP summary layer over the frozen timeline, on REAL rows (the
 * same in-memory store container + StaticPromptResolver + PromptAssemblyService
 * seam the other sidechat tests drive). The loader reads the branch's
 * summaries LIVE every turn and decides coverage through the RP's own one
 * source (`buildChatSummaryContext`); nothing is ever written. Pins the
 * plan's named cases:
 *
 * 1. covered span → one summary row, uncovered tail → raw;
 * 2. `excludeSummarized` off → the row PLUS the covered messages raw;
 * 3. `includeInContext` off → ignored, everything raw;
 * 4. the off-by-one pin — «T2–T3» hides exactly positions 1 and 2;
 * 5. a summary disabled after the first sync → its messages render IN PLACE;
 * 6. a half-covered batch → one stored event split by coverage;
 * 7. empty content → ignored, everything raw;
 * 8. overflow — the shell's budget trim drops the OLDEST merged flow entry
 *    whatever its kind, in time order.
 */

let stores: StoreContainer;
let contextDeps: SidechatContextDeps;
let syncDeps: RpSyncDeps;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-rp-summary-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const persona = await stores.personas.create({
		name: "Sable",
		description: "A wandering cartographer.",
		defaultForNewChats: true,
	});
	expect(persona.name).toBe("Sable");
	const character = await stores.characters.create({ name: "Theron" });
	characterId = character.id;
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	const assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	contextDeps = {
		chats: stores.chats,
		characters: stores.characters,
		messages: stores.messages,
		traces: stores.traces,
		chatSummaries: stores.chatSummaries,
		experienceCopilot: stores.experienceCopilot,
		assembly,
	};
	syncDeps = {
		chats: stores.chats,
		messages: stores.messages,
		assembly,
		experienceCopilot: stores.experienceCopilot,
	};
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

interface RpMessage {
	role: "user" | "assistant";
	text: string;
}

/** A chat + a sidechat thread on its active branch, with the RP messages
 *  added and FROZEN through the real SC-2c sync (one rp_sync event). */
async function makeFrozenThread(messages: RpMessage[]): Promise<{
	threadId: ExperienceCopilotThreadId;
	chatId: ChatId;
	branchId: ChatBranchId;
}> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-6 fixture chat",
		promptPresetId: null,
	});
	const chatId = brandId<ChatId>(chat.id);
	const branchId = brandId<ChatBranchId>(chat.activeBranchId);
	for (const message of messages) {
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: message.role,
			authorType: message.role,
			content: message.text,
		});
	}
	const thread = await stores.experienceCopilot.startNewChatSession(chat.id, chat.activeBranchId, "sidechat-ooc");
	await syncBeforeUserMessage(syncDeps, thread.id);
	return { threadId: thread.id, chatId, branchId };
}

interface SummaryFixture {
	from: number;
	to: number;
	includeInContext: boolean;
	excludeSummarized: boolean;
	content: string;
}

async function createSummary(
	chatId: ChatId,
	branchId: ChatBranchId,
	summary: SummaryFixture,
): Promise<string> {
	const row = await stores.chatSummaries.create({
		chatId,
		branchId,
		label: "SC-6 chapter",
		summarizedFrom: summary.from,
		summarizedTo: summary.to,
		includeInContext: summary.includeInContext,
		excludeSummarized: summary.excludeSummarized,
		content: summary.content,
	});
	return row.id;
}

/** The standard four-message RP branch (positions 0–3). */
const FOUR_MESSAGES: RpMessage[] = [
	{ role: "user", text: "Turn zero: we enter the tavern." },
	{ role: "assistant", text: "Turn one: the keeper greets you." },
	{ role: "user", text: "Turn two: we take a table." },
	{ role: "assistant", text: "Turn three: a bard starts playing." },
];

/** The expected rendered `<rp_sync>` block for surviving entries (the exact
 *  SC-3a byte shape — brackets over the run, author per role). */
function syncBlock(entries: Array<{ position: number; role: "user" | "assistant"; text: string }>): string {
	if (entries.length === 0) throw new Error("fixture: empty sync block");
	const from = entries[0]!.position;
	const to = entries[entries.length - 1]!.position;
	const lines = entries.map(
		(entry) =>
			`<rp_message position="${entry.position}" role="${entry.role}" author="${entry.role === "assistant" ? "Theron" : "Sable"}">${entry.text}</rp_message>`,
	);
	return [`<rp_sync from="${from}" to="${to}">`, ...lines, "</rp_sync>"].join("\n");
}

/** The expected `<rp_summary>` row. The content store normalizes
 *  file-backed text with a trailing newline (content-store `writeText`), and
 *  the RP prompt feeds summary content VERBATIM to the model — so the
 *  sidechat's live row carries the same trailing newline. */
function summaryRow(from: number, to: number, text: string): string {
	return `<rp_summary from="${from}" to="${to}">${text}\n</rp_summary>`;
}

function bodies(pkg: SidechatContextPackage): string[] {
	return pkg.eventMessages.map((event) => event.content);
}

// ─── The named cases (1–7: coverage over the frozen timeline) ────────────────

describe("loadSidechatContext RP summary coverage (SC-6)", () => {
	it("a covered span renders ONE summary row; the uncovered tail stays raw", async () => {
		const fixture = await makeFrozenThread(FOUR_MESSAGES);
		await createSummary(fixture.chatId, fixture.branchId, {
			from: 1,
			to: 2,
			includeInContext: true,
			excludeSummarized: true,
			content: "Chapter one: the meeting at the tavern.",
		});

		const pkg = await loadSidechatContext(contextDeps, fixture.threadId);

		expect(bodies(pkg)).toEqual([
			summaryRow(0, 1, "Chapter one: the meeting at the tavern."),
			syncBlock([
				{ position: 2, role: "user", text: "Turn two: we take a table." },
				{ position: 3, role: "assistant", text: "Turn three: a bard starts playing." },
			]),
		]);
		// The covered messages' text reaches the model NOWHERE — only the
		// summary speaks for them.
		expect(bodies(pkg).join("\n")).not.toContain("we enter the tavern");
		expect(bodies(pkg).join("\n")).not.toContain("the keeper greets you");
	});

	it("excludeSummarized off → the summary row PLUS every covered message raw after it", async () => {
		const fixture = await makeFrozenThread(FOUR_MESSAGES);
		await createSummary(fixture.chatId, fixture.branchId, {
			from: 1,
			to: 2,
			includeInContext: true,
			excludeSummarized: false,
			content: "Chapter one: the meeting at the tavern.",
		});

		const pkg = await loadSidechatContext(contextDeps, fixture.threadId);

		expect(bodies(pkg)).toEqual([
			summaryRow(0, 1, "Chapter one: the meeting at the tavern."),
			syncBlock(FOUR_MESSAGES.map((message, position) => ({ position, role: message.role, text: message.text }))),
		]);
	});

	it("includeInContext off → the summary is ignored and everything renders raw", async () => {
		const fixture = await makeFrozenThread(FOUR_MESSAGES);
		await createSummary(fixture.chatId, fixture.branchId, {
			from: 1,
			to: 2,
			includeInContext: false,
			excludeSummarized: true,
			content: "Chapter one: the meeting at the tavern.",
		});

		const pkg = await loadSidechatContext(contextDeps, fixture.threadId);

		expect(bodies(pkg)).toEqual([
			syncBlock(FOUR_MESSAGES.map((message, position) => ({ position, role: message.role, text: message.text }))),
		]);
		expect(bodies(pkg).join("\n")).not.toContain("<rp_summary");
	});

	it("the off-by-one pin: a «T2–T3» summary hides exactly positions 1 and 2 (1-based range over 0-based positions)", async () => {
		const fixture = await makeFrozenThread(FOUR_MESSAGES);
		// «T2–T3» in the UI's 1-based turn numbers.
		await createSummary(fixture.chatId, fixture.branchId, {
			from: 2,
			to: 3,
			includeInContext: true,
			excludeSummarized: true,
			content: "The first exchange.",
		});

		const pkg = await loadSidechatContext(contextDeps, fixture.threadId);

		// Exactly positions 1 and 2 drop; 0 and 3 stay; the row's bracket is in
		// the timeline's 0-based position language (from=1, to=2).
		expect(bodies(pkg)).toEqual([
			syncBlock([{ position: 0, role: "user", text: "Turn zero: we enter the tavern." }]),
			summaryRow(1, 2, "The first exchange."),
			syncBlock([{ position: 3, role: "assistant", text: "Turn three: a bard starts playing." }]),
		]);
	});

	it("a summary disabled after the first sync shows its messages IN PLACE (and nothing is written)", async () => {
		const fixture = await makeFrozenThread(FOUR_MESSAGES);
		const summaryId = await createSummary(fixture.chatId, fixture.branchId, {
			from: 1,
			to: 2,
			includeInContext: true,
			excludeSummarized: true,
			content: "Chapter one: the meeting at the tavern.",
		});

		// Load 1 — coverage active: the covered messages drop, the row renders.
		const first = await loadSidechatContext(contextDeps, fixture.threadId);
		expect(bodies(first)).toEqual([
			summaryRow(0, 1, "Chapter one: the meeting at the tavern."),
			syncBlock([
				{ position: 2, role: "user", text: "Turn two: we take a table." },
				{ position: 3, role: "assistant", text: "Turn three: a bard starts playing." },
			]),
		]);

		// The user disables the summary in the RP chat (includeInContext off).
		await stores.chatSummaries.update(summaryId, { includeInContext: false });

		const second = await loadSidechatContext(contextDeps, fixture.threadId);
		// The messages render raw IN PLACE — inside the SAME frozen event, in
		// position order — never as a "new" delta appended at the end (the
		// Wave 1 defect: the freeze had dropped covered messages, so a later
		// disable re-synced them as fresh rp_sync rows after everything else).
		expect(bodies(second)).toEqual([
			syncBlock(FOUR_MESSAGES.map((message, position) => ({ position, role: message.role, text: message.text }))),
		]);
		// Summaries are read, never created: the timeline still carries exactly
		// the ONE rp_sync event the sync wrote — no rp_summary event kind
		// exists, and no second sync fired for the re-revealed messages.
		const timeline = await stores.experienceCopilot.listTimeline(fixture.threadId);
		const eventKinds = timeline
			.filter((entry) => entry.rowType === "event")
			.map((entry) => (entry as { kind: string }).kind);
		expect(eventKinds).toEqual(["rp_sync"]);
	});

	it("a half-covered batch: one stored event splits by coverage into runs and the summary row", async () => {
		const messages: RpMessage[] = [
			{ role: "user", text: "Turn zero." },
			{ role: "assistant", text: "Turn one." },
			{ role: "user", text: "Turn two: covered middle." },
			{ role: "assistant", text: "Turn three: covered middle." },
			{ role: "user", text: "Turn four." },
			{ role: "assistant", text: "Turn five." },
		];
		const fixture = await makeFrozenThread(messages);
		// Covers 0-based positions 2–3 (T3–T4) — the middle of the ONE batch.
		await createSummary(fixture.chatId, fixture.branchId, {
			from: 3,
			to: 4,
			includeInContext: true,
			excludeSummarized: true,
			content: "The covered middle.",
		});

		const pkg = await loadSidechatContext(contextDeps, fixture.threadId);

		// One stored rp_sync event (positions 0–5, one batch) → three rendered
		// flow rows, each bracketed to its own surviving run.
		expect(bodies(pkg)).toEqual([
			syncBlock([
				{ position: 0, role: "user", text: "Turn zero." },
				{ position: 1, role: "assistant", text: "Turn one." },
			]),
			summaryRow(2, 3, "The covered middle."),
			syncBlock([
				{ position: 4, role: "user", text: "Turn four." },
				{ position: 5, role: "assistant", text: "Turn five." },
			]),
		]);
		// All three rows sit at the same merged-timeline placement (the one
		// stored event's position — same OOC-row count before each).
		expect(pkg.eventMessages.map((event) => event.precedingMessages)).toEqual([0, 0, 0]);
	});

	it("empty content → the summary is ignored and everything renders raw", async () => {
		const fixture = await makeFrozenThread(FOUR_MESSAGES);
		await createSummary(fixture.chatId, fixture.branchId, {
			from: 1,
			to: 2,
			includeInContext: true,
			excludeSummarized: true,
			content: "   ",
		});

		const pkg = await loadSidechatContext(contextDeps, fixture.threadId);

		expect(bodies(pkg)).toEqual([
			syncBlock(FOUR_MESSAGES.map((message, position) => ({ position, role: message.role, text: message.text }))),
		]);
		expect(bodies(pkg).join("\n")).not.toContain("<rp_summary");
	});

	it("a summary whose range sits beyond the frozen frontier renders as a trailing row — never silently dropped", async () => {
		const fixture = await makeFrozenThread(FOUR_MESSAGES);
		// T9–T12: no frozen message carries those positions (the range was
		// never anchored by a covered message) — the row still renders, at the
		// end of the event flow.
		await createSummary(fixture.chatId, fixture.branchId, {
			from: 9,
			to: 12,
			includeInContext: true,
			excludeSummarized: true,
			content: "A chapter of the future frontier.",
		});

		const pkg = await loadSidechatContext(contextDeps, fixture.threadId);

		expect(bodies(pkg)).toEqual([
			syncBlock(FOUR_MESSAGES.map((message, position) => ({ position, role: message.role, text: message.text }))),
			summaryRow(8, 11, "A chapter of the future frontier."),
		]);
	});
});

// ─── Case 8: the overflow trim over the merged flow ──────────────────────────

describe("assembleSidechatPrompt overflow (SC-6)", () => {
	// A deterministic counter (1 char = 1 token) so the trim boundary is
	// computed exactly; restored after the file (the suite shares one process).
	beforeAll(() => {
		setTokenCountFn((text) => text.length);
	});
	afterAll(() => {
		setTokenCountFn(() => 0);
	});

	const OOC_ROW = "First OOC question about the story";
	const TURN_ROW = "Current turn question";
	const SUMMARY_ROW = summaryRow(0, 1, "Chapter one: the opening beats.");
	const RP_BLOCK = syncBlock([
		{ position: 2, role: "user", text: "Turn two: we take a table." },
		{ position: 3, role: "assistant", text: "Turn three: a bard starts playing." },
	]);

	function contextPackage(): SidechatContextPackage {
		return {
			staticPackage: "",
			// Merged flow order (oldest first): the rp_summary row, the OOC
			// row, the rp_message block, the turn's own user message (pushed
			// by the loop).
			eventMessages: [
				{ precedingMessages: 0, content: SUMMARY_ROW },
				{ precedingMessages: 1, content: RP_BLOCK },
			],
			messageCount: 1,
		};
	}

	function assemble(contextBudgetTokens: number, responseReserveTokens: number) {
		return assembleSidechatPrompt({
			basePrompt: "base prompt text",
			context: contextPackage(),
			history: [
				{ role: "user", content: OOC_ROW },
				{ role: "user", content: TURN_ROW },
			],
			hasUserPush: true,
			attachedContextBlock: "",
			recencyAnchorText: "",
			model: "sc6-trim-model",
			contextBudgetTokens,
			responseReserveTokens,
		});
	}

	it("drops the OLDEST merged flow entry first, whatever its kind — the rp_summary row before the OOC row", async () => {
		// Budget for exactly the last THREE flow entries: system + the OOC
		// row + the rp_message block + the turn. The oldest entry (the
		// rp_summary row) drops.
		const systemTokens = estimateTokens(["base prompt text", "", ""].join("\n"));
		const keepThree = estimateHistoryTokens([
			{ role: "user", content: OOC_ROW },
			{ role: "user", content: RP_BLOCK },
			{ role: "user", content: TURN_ROW },
		]);
		const assembled = assemble(systemTokens + keepThree, 0);

		expect(assembled.messages.map((message) => message.content)).toEqual([
			["base prompt text", "", ""].join("\n"),
			OOC_ROW,
			RP_BLOCK,
			TURN_ROW,
		]);
		expect(JSON.stringify(assembled.messages)).not.toContain("<rp_summary");
		expect(assembled.compactionSummary).toContain("Kept 3 of 4");
		// The meter reports what left: history counts the trimmed flow.
		expect(assembled.tokenAccounting.history).toBe(keepThree);
	});

	it("a tighter budget drops the OOC row too while the NEWER RP block survives — kind-blind, time order", async () => {
		// Budget for exactly the last TWO (the shell's minimum preserved
		// pair): the rp_message block + the turn. The oldest OOC row drops
		// while the newer RP row survives — RP and discussion recede
		// together, oldest first, never by kind.
		const systemTokens = estimateTokens(["base prompt text", "", ""].join("\n"));
		const keepTwo = estimateHistoryTokens([
			{ role: "user", content: RP_BLOCK },
			{ role: "user", content: TURN_ROW },
		]);
		const assembled = assemble(systemTokens + keepTwo, 0);

		expect(assembled.messages.map((message) => message.content)).toEqual([
			["base prompt text", "", ""].join("\n"),
			RP_BLOCK,
			TURN_ROW,
		]);
		expect(assembled.compactionSummary).toContain("Kept 2 of 4");
		expect(assembled.tokenAccounting.history).toBe(keepTwo);
	});
});

// Fork provenance: none — this file is SC-6's own; the harness mirrors
// sidechat-context.test.ts (SC-3b) by construction, no code copied.

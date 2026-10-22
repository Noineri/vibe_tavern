import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { brandId, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import {
	buildSidechatPromptReadTools,
	runGrantedPromptRead,
	SIDECHAT_PROMPT_READ_TOOL_NAME,
	sidechatPromptReadInputSchema,
	type SidechatPromptReadMarkerResult,
	type SidechatPromptReadUnknownResult,
	type SidechatPromptReadUnresolvedResult,
} from "../src/domain/agent/kinds/sidechat/sidechat-prompt-read-tools.js";

/**
 * SC-23e — the `read_message_prompt` resolver and executor at the tool's own
 * boundary (real stores, real assembly-seeded traces, no stream loop): the
 * selected-vs-numbered variant resolution, the marker's card data (first
 * line, variant number, preset name, ≈N tokens), the granted re-run's real
 * `<rp_prompt>` view, the no-guess unknown for a reply with no linked trace,
 * and the unresolved reference answers. The turn-stop/resume flow is pinned
 * in sidechat-ooc-stream.test.ts; the wire rendering in
 * agent-split-turn.test.ts.
 */

let stores: StoreContainer;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-prompt-read-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const persona = await stores.personas.create({
		name: "Sable",
		description: "A wandering cartographer.",
		pronouns: "she/her",
		defaultForNewChats: true,
	});
	expect(persona.name).toBe("Sable");
	const character = await stores.characters.create({
		name: "Theron",
		description: "A brooding ranger.",
	});
	characterId = character.id;
	// Deterministic token counts: the pipeline's test sentinel (4 chars per
	// token) — the marker's estimate is assertable exactly. Restored in
	// afterAll (process-global state, the shared services/api worker).
	setTokenCountFn((text) => Math.ceil(text.length / 4));
});

afterAll(() => {
	setTokenCountFn(() => 0);
});

/** A chat + active branch with one user message and one assistant reply (the
 *  tool's subject), plus the deps/state pair over the real stores. */
async function makeFixture(replyText: string): Promise<{
	chatId: ChatId;
	branchId: ChatBranchId;
	replyId: string;
}> {
	const chat = await stores.chats.createChat({ characterId, title: "SC-23e fixture" });
	const branchId = chat.activeBranchId;
	await stores.messages.addMessage({
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
		role: "user",
		authorType: "user",
		content: "We enter the tavern.",
	});
	const reply = await stores.messages.addMessage({
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
		role: "assistant",
		authorType: "assistant",
		content: replyText,
	});
	return { chatId: brandId<ChatId>(chat.id), branchId: brandId<ChatBranchId>(branchId), replyId: reply.id };
}

/** The real send-path trace for the reply's SELECTED variant, through the
 *  assembly service's own draft (the exact shape the RP send freezes). */
async function saveLinkedTrace(chatId: ChatId, branchId: ChatBranchId, messageId: string, variantId: string): Promise<void> {
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	const assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	const assembled = await assembly.assembleForChat({ chatId, branchId, model: "sc23e-model" });
	await stores.traces.saveTrace({
		...assembled.promptTraceDraft,
		presetName: assembled.promptTraceDraft.presetName ?? "(none)",
		messageId,
		variantId,
	});
}

/** The id of the message's currently selected variant. */
async function selectedVariantOf(messageId: string): Promise<string> {
	const variants = await stores.messages.getVariants(messageId);
	const selected = variants.find((variant) => variant.isSelected);
	if (!selected) throw new Error(`fixture: message ${messageId} has no selected variant`);
	return selected.id;
}

/** The tool family over the real stores with ALL toggles on. */
function tools(state: { chatId: ChatId; branchId: ChatBranchId; heldLoreEntryIds?: ReadonlySet<string> }) {
	return buildSidechatPromptReadTools({
		toolSet: { [SIDECHAT_PROMPT_READ_TOOL_NAME]: true },
		deps: { messages: stores.messages, traces: stores.traces },
		state: { chatId: state.chatId, branchId: state.branchId, heldLoreEntryIds: state.heldLoreEntryIds ?? new Set() },
	});
}

function deps() {
	return { messages: stores.messages, traces: stores.traces };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildSidechatPromptReadTools (SC-23e)", () => {
	it("is served only when the toggle is on (the toggle gates availability, never the permission)", () => {
		const { chatId, branchId } = { chatId: brandId<ChatId>("c"), branchId: brandId<ChatBranchId>("b") };
		expect(Object.keys(tools({ chatId, branchId }))).toEqual([SIDECHAT_PROMPT_READ_TOOL_NAME]);
		const off = buildSidechatPromptReadTools({
			toolSet: {},
			deps: deps(),
			state: { chatId, branchId, heldLoreEntryIds: new Set() },
		});
		expect(Object.keys(off)).toEqual([]);
	});

	it("the marker carries the card's data: reply first line, variant number, preset name, ≈N tokens of the exact view", async () => {
		const { chatId, branchId, replyId } = await makeFixture("Theron pours two cups.\nThe fire crackles.");
		const variantId = await selectedVariantOf(replyId);
		await saveLinkedTrace(chatId, branchId, replyId, variantId);

		const result = (await tools({ chatId, branchId })[SIDECHAT_PROMPT_READ_TOOL_NAME]!.execute(
			{ position: 1 },
			{ toolCallId: "tc_test_1" },
		)) as SidechatPromptReadMarkerResult;

		expect(result.status).toBe("awaiting_permission");
		expect(result.position).toBe(1);
		expect(result.variantNumber).toBe(1);
		expect(result.replyFirstLine).toBe("Theron pours two cups.");
		// The marker NEVER carries prompt text — only its size.
		expect(JSON.stringify(result)).not.toContain("<rp_prompt");
		expect(result.promptTokens).toBeGreaterThan(0);
		// The estimate counts the EXACT rendered view: re-deriving it through
		// the granted run pins the number against the same text.
		const granted = await runGrantedPromptRead(
			deps(),
			{ chatId, branchId, heldLoreEntryIds: new Set() },
			{ position: 1 },
		);
		if (granted.status !== "granted") throw new Error("fixture: expected the granted view");
		expect(result.promptTokens).toBe(granted.promptTokens);
		expect(result.presetName).toBe(granted.presetName);
	});

	it("a named variant (the <variant number>) resolves by number, the selected one by absence", async () => {
		const { chatId, branchId, replyId } = await makeFixture("First draft reply.");
		// A second swipe: addVariant selects the NEW one; the first draft
		// stays at number 1, the new one becomes number 2 (selected).
		const second = await stores.messages.addVariant(replyId, "Second draft reply.", "stop", null, null, "model-x", "Preset Y");
		const selected = await selectedVariantOf(replyId);
		expect(selected).toBe(second.id);
		// Trace links the OLD draft (number 1) — asking for number 1 must
		// resolve THAT variant, not the selected one.
		const variants = await stores.messages.getVariants(replyId);
		const first = variants.find((variant) => variant.variantIndex === 0)!;
		await saveLinkedTrace(chatId, branchId, replyId, first.id);

		const named = (await tools({ chatId, branchId })[SIDECHAT_PROMPT_READ_TOOL_NAME]!.execute(
			{ position: 1, variant: 1 },
			{ toolCallId: "tc_test_2" },
		)) as SidechatPromptReadMarkerResult;
		expect(named.status).toBe("awaiting_permission");
		expect(named.variantNumber).toBe(1);
		expect(named.replyFirstLine).toBe("First draft reply.");

		// Absent variant → the SELECTED one (number 2), which has NO linked
		// trace → the honest unknown (never the numbered draft's prompt).
		const selectedAnswer = (await tools({ chatId, branchId })[SIDECHAT_PROMPT_READ_TOOL_NAME]!.execute(
			{ position: 1 },
			{ toolCallId: "tc_test_3" },
		)) as SidechatPromptReadUnknownResult;
		expect(selectedAnswer.status).toBe("unknown_prompt");
		expect(selectedAnswer.variantNumber).toBe(2);
	});

	it("no linked trace → unknown_prompt (the SC-23b no-guess rule), never a marker or a time-based guess", async () => {
		const { chatId, branchId, replyId } = await makeFixture("A reply with no trace link.");
		// A trace EXISTS for the branch (another message's), but the reply's
		// own variant is unlinked — an old swipe.
		const other = await makeFixture("Another reply.");
		await saveLinkedTrace(other.chatId, other.branchId, other.replyId, await selectedVariantOf(other.replyId));

		const result = (await tools({ chatId, branchId })[SIDECHAT_PROMPT_READ_TOOL_NAME]!.execute(
			{ position: 1 },
			{ toolCallId: "tc_test_4" },
		)) as SidechatPromptReadUnknownResult;
		expect(result.status).toBe("unknown_prompt");
		expect(result.note).toContain("not recorded");
		expect(replyId).toBeTruthy();
	});

	it("an unresolvable reference answers unresolved (self-correction, never a permission ask)", async () => {
		const { chatId, branchId } = await makeFixture("Any reply.");
		const tool = tools({ chatId, branchId })[SIDECHAT_PROMPT_READ_TOOL_NAME]!;

		const badPosition = (await tool.execute({ position: 99 }, { toolCallId: "tc_test_5" })) as SidechatPromptReadUnresolvedResult;
		expect(badPosition.status).toBe("unresolved");
		expect(badPosition.note).toContain("position 99");

		const badVariant = (await tool.execute({ position: 1, variant: 7 }, { toolCallId: "tc_test_6" })) as SidechatPromptReadUnresolvedResult;
		expect(badVariant.status).toBe("unresolved");
		expect(badVariant.note).toContain("variant number 7");
	});
});

describe("runGrantedPromptRead (the allow half)", () => {
	it("returns the real <rp_prompt> view of the linked trace against the CURRENT held set", async () => {
		const { chatId, branchId, replyId } = await makeFixture("The granted reply text.");
		await saveLinkedTrace(chatId, branchId, replyId, await selectedVariantOf(replyId));

		const granted = await runGrantedPromptRead(
			deps(),
			{ chatId, branchId, heldLoreEntryIds: new Set() },
			{ position: 1 },
		);
		expect(granted.status).toBe("granted");
		// The view is the shared renderer's grammar over the TRACE's frozen
		// payload: the wrapper names the trace's preset; held material
		// collapses to placeholders (the default assembly merges persona into
		// the card entry — the payload-faithful `persona+character` label).
		expect(granted.prompt).toContain("<rp_prompt");
		expect(granted.prompt).toContain('<known layer="persona+character" role="system"/>');
		expect(granted.prompt).toContain('<known layer="history" positions="0–1"/>');
		expect(granted.prompt).toContain("</rp_prompt>");
		expect(granted.promptTokens).toBeGreaterThan(0);
		expect(granted.variantNumber).toBe(1);
	});

	it("a vanished link at answer time degrades to the honest unknown — never a denial the user did not choose", async () => {
		const { chatId, branchId } = await makeFixture("A reply whose trace never existed.");
		const granted = await runGrantedPromptRead(
			deps(),
			{ chatId, branchId, heldLoreEntryIds: new Set() },
			{ position: 1 },
		);
		expect(granted.status).toBe("unknown_prompt");
		expect(granted.variantNumber).toBe(1);
	});

	it("a corrupted recorded input is refused, never re-run on guessed args", async () => {
		const { chatId, branchId } = await makeFixture("Any reply.");
		await expect(
			runGrantedPromptRead(deps(), { chatId, branchId, heldLoreEntryIds: new Set() }, { position: "one" }),
		).rejects.toThrow("not the tool's input shape");
	});
});

describe("sidechatPromptReadInputSchema", () => {
	it("accepts a position alone or with a positive-int variant; rejects the rest", () => {
		expect(sidechatPromptReadInputSchema.safeParse({ position: 0 }).success).toBe(true);
		expect(sidechatPromptReadInputSchema.safeParse({ position: 3, variant: 2 }).success).toBe(true);
		expect(sidechatPromptReadInputSchema.safeParse({}).success).toBe(false);
		expect(sidechatPromptReadInputSchema.safeParse({ position: -1 }).success).toBe(false);
		expect(sidechatPromptReadInputSchema.safeParse({ position: 1.5 }).success).toBe(false);
		expect(sidechatPromptReadInputSchema.safeParse({ position: 1, variant: 0 }).success).toBe(false);
	});
});

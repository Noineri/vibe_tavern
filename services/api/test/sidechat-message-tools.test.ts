import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { brandId, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import {
	DIRECTOR_MESSAGE_TOOLS,
	directorMessageEditProposalSchema,
	directorMessageVariantProposalSchema,
	directorSwipePermissionMarkerSchema,
	type DirectorSwipePermissionMarker,
	type RecordProposal,
} from "@vibe-tavern/api-contracts";
import {
	buildSidechatMessageTools,
	type DirectorMessageEditorDelegateFn,
	type SidechatMessageToolsInput,
} from "../src/domain/agent/kinds/sidechat/sidechat-message-tools.js";
import type { DirectorMessageEditorDelegateInput, DirectorMessageEditorDelegateResult } from "../src/domain/director/director-message-editor-delegate.js";
import type { DirectorMessageTargetDeps } from "../src/domain/director/director-message-target.js";
// Shared zod input-schema probe over a built ToolSet (takes any ToolSet —
// no per-suite fork).
import { coauthorToolInputSchema as toolInputSchema } from "./provider-boundary-test-builders.js";

/**
 * DMT-21 — the Director's three message tools at their own boundary (real
 * stores, no stream loop; the delegate is a T1 stub FUNCTION — its real
 * behavior is the DMT-14 delegate suite's boundary):
 *
 * - profile gating: only the resolved set's keys are served;
 * - `propose_message_edit`: the delegate's candidate + ACTUAL provenance
 *   frozen into a `message-edit` proposal over the NAMED swipe's stored
 *   text; unconfigured/cancelled/failed delegate outcomes are model-facing
 *   text, never a proposal;
 * - `propose_message_variant`: the Director-authored content verbatim, ONE
 *   source accepted, NO delegate call (no generation, no merge);
 * - `request_message_swipe`: the awaiting_permission marker with the frozen
 *   identity + the instruction in full — no generation, no writes;
 * - refusals: wrong-branch position, user message, nonexistent swipe,
 *   missing variant set — each the precise model-correctable error with
 *   NOTHING written and no delegate call.
 */

let stores: StoreContainer;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-message-tools-"));
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
});

// ─── Fixture + wiring helpers ────────────────────────────────────────────────

/** A chat + branch with one user message and one assistant reply; every
 *  entry in `extraSwipes` appends a variant (addVariant SELECTS the new
 *  swipe, so the reply's last swipe is the selected one). */
async function makeReply(
	replyText: string,
	extraSwipes: readonly string[] = [],
): Promise<{ chatId: string; branchId: string; replyId: string }> {
	const chat = await stores.chats.createChat({ characterId, title: "DMT-21 fixture" });
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
	for (const swipe of extraSwipes) {
		await stores.messages.addVariant(reply.id, swipe, "stop", null, null, "model-x", "Preset Y");
	}
	return { chatId: chat.id, branchId, replyId: reply.id };
}

/** The id of a message's variant at a one-based number. */
async function variantAt(messageId: string, number: number): Promise<string> {
	const variants = await stores.messages.getVariants(messageId);
	const found = variants.find((variant) => variant.variantIndex === number - 1);
	if (!found) throw new Error(`fixture: message ${messageId} has no variant number ${number}`);
	return found.id;
}

/** Everything a tool call must NOT touch — the no-write pin (messages,
 *  variants, traces; tool rows live in the copilot store and the stream
 *  writes them, which is DMT-23's boundary). */
async function persistedSnapshot(chatId: string, branchId: string) {
	return {
		messages: (await stores.messages.getMessages(branchId)).map(
			(message) => `${message.id}:${message.position}:${message.role}:${message.state}:${message.content}`,
		),
		variants: [...(await stores.messages.getVariantsByBranch(branchId)).values()]
			.flat()
			.map((variant) => `${variant.id}:${variant.variantIndex}:${variant.isSelected}:${variant.content}`),
		traces: (await stores.traces.getTracesByChat(chatId)).map((trace) => trace.id),
	};
}

/** The canned completed delegate outcome — a candidate + the ACTUAL editor
 *  provenance the proposal must freeze verbatim. */
const COMPLETED_OUTCOME: DirectorMessageEditorDelegateResult = {
	status: "completed",
	candidate: "Theron sets down two cups.",
	editor: { modelId: "editor-model", presetName: "Preset Y", finishReason: "stop" },
};

const ALL_KEYS_ON: Record<string, boolean> = {
	[DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit]: true,
	[DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant]: true,
	[DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe]: true,
};

/** The tool family over the real stores with a RECORDING delegate stub (the
 *  canned outcome unless a per-call `delegate` overrides it). */
function makeTools(opts: {
	toolSet?: Record<string, boolean>;
	owner?: { chatId: string; branchId: string };
	outcome?: DirectorMessageEditorDelegateResult;
	delegate?: (input: DirectorMessageEditorDelegateInput) => Promise<DirectorMessageEditorDelegateResult>;
	messages?: DirectorMessageTargetDeps;
}) {
	const delegateCalls: DirectorMessageEditorDelegateInput[] = [];
	const editorDelegate: DirectorMessageEditorDelegateFn = async (call) => {
		delegateCalls.push(call);
		if (opts.delegate) return opts.delegate(call);
		return opts.outcome ?? COMPLETED_OUTCOME;
	};
	const input: SidechatMessageToolsInput = {
		toolSet: opts.toolSet ?? ALL_KEYS_ON,
		owner: opts.owner ?? { chatId: "chat_unset", branchId: "branch_unset" },
		messages: opts.messages ?? stores.messages,
		editorDelegate,
	};
	return { tools: buildSidechatMessageTools(input), delegateCalls };
}

/** The execute-options stub, TYPED from the tool's own signature (the
 *  director-tools suite's idiom: derive the real type, never cast). */
type MessageTools = ReturnType<typeof buildSidechatMessageTools>;
type EditExecuteOptions = Parameters<NonNullable<MessageTools["propose_message_edit"]["execute"]>>[1];
const ctx = (toolCallId: string, signal?: AbortSignal): EditExecuteOptions =>
	signal ? { messages: [], toolCallId, abortSignal: signal } : { messages: [], toolCallId };

/** Narrow a mixed tool result to the proposal arm (a string is a failure the
 *  proposal pins must never see). */
function expectProposal(result: RecordProposal | string): RecordProposal {
	if (typeof result === "string") throw new Error(`expected a proposal, got error text: ${result}`);
	return result;
}

// ─── Profile gating ──────────────────────────────────────────────────────────

describe("buildSidechatMessageTools (DMT-21) — profile gating", () => {
	it("serves the three message tools only when the resolved set enables them", () => {
		const { tools } = makeTools({ owner: { chatId: "c", branchId: "b" } });
		expect(Object.keys(tools).sort()).toEqual([
			DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
			DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
			DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe,
		]);
	});

	it("a partial set serves only its own key; an empty set serves nothing", () => {
		const editOnly = makeTools({
			toolSet: { [DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit]: true },
			owner: { chatId: "c", branchId: "b" },
		}).tools;
		expect(Object.keys(editOnly)).toEqual([DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit]);
		const none = makeTools({ toolSet: {}, owner: { chatId: "c", branchId: "b" } }).tools;
		expect(none).toEqual({});
	});
});

// ─── propose_message_edit ────────────────────────────────────────────────────

describe("propose_message_edit (DMT-21)", () => {
	it("freezes the delegate's candidate + provenance into a pending message-edit proposal over the NAMED swipe's stored text", async () => {
		const fixture = await makeReply("Theron pours two cups.\nThe fire crackles.", ["Theron pours one cup."]);
		const firstVariantId = await variantAt(fixture.replyId, 1);
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		const result = expectProposal(
			await tools.propose_message_edit.execute(
				{ position: 1, variant: 1, instruction: "Fix the cup count" },
				ctx("call_edit_1"),
			),
		);

		expect(result).toEqual({
			kind: "record",
			id: "call_edit_1",
			recordType: "message-edit",
			op: "update",
			targetId: fixture.replyId,
			payload: {
				source: { messageId: fixture.replyId, variantId: firstVariantId, position: 1, variantNumber: 1 },
				sourceText: "Theron pours two cups.\nThe fire crackles.",
				instruction: "Fix the cup count",
				candidate: "Theron sets down two cups.",
				editor: { modelId: "editor-model", presetName: "Preset Y", finishReason: "stop" },
			},
			status: "pending",
		} satisfies RecordProposal);
		// The payload is the DMT-11 contract shape, exactly.
		expect(directorMessageEditProposalSchema.safeParse(result.payload).success).toBe(true);
		// The delegate ran against the thread's own chat/branch pair and the
		// frozen source identity.
		expect(delegateCalls).toHaveLength(1);
		expect(delegateCalls[0]).toEqual({
			chatId: fixture.chatId,
			branchId: fixture.branchId,
			targetMessageId: fixture.replyId,
			sourceVariantId: firstVariantId,
			instruction: "Fix the cup count",
			signal: undefined,
		});

		// NO canonical RP writes: the proposal is the only output.
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("an omitted variant resolves the currently SELECTED swipe (its identity and its text)", async () => {
		const fixture = await makeReply("First draft reply.", ["Second draft reply."]);
		const selectedVariantId = await variantAt(fixture.replyId, 2); // addVariant selects the new swipe
		const { tools } = makeTools({ owner: fixture });

		const result = expectProposal(
			await tools.propose_message_edit.execute(
				{ position: 1, instruction: "Tighten the wording" },
				ctx("call_edit_2"),
			),
		);
		if (result.kind !== "record" || result.recordType !== "message-edit") throw new Error("expected an edit proposal");
		const payload = directorMessageEditProposalSchema.parse(result.payload);
		expect(payload.source).toEqual({
			messageId: fixture.replyId,
			variantId: selectedVariantId,
			position: 1,
			variantNumber: 2,
		});
		expect(payload.sourceText).toBe("Second draft reply.");
	});

	it("propagates the caller's AbortSignal into the delegate", async () => {
		const fixture = await makeReply("A reply to correct.");
		const controller = new AbortController();
		const { tools, delegateCalls } = makeTools({ owner: fixture });

		await tools.propose_message_edit.execute(
			{ position: 1, instruction: "Fix the name" },
			ctx("call_edit_sig", controller.signal),
		);
		expect(delegateCalls[0].signal).toBe(controller.signal);
	});

	it("refuses a position beyond the branch with the precise note — no delegate call, nothing written", async () => {
		const fixture = await makeReply("A reply in branch A.");
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		await expect(
			tools.propose_message_edit.execute({ position: 99, instruction: "Fix" }, ctx("call_edit_3")),
		).rejects.toThrow("propose_message_edit: no message at position 99 in this branch");
		expect(delegateCalls).toHaveLength(0);
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("resolves against the thread's OWN branch — a same-position reply in another chat is never picked up", async () => {
		const a = await makeReply("Branch A reply.");
		const b = await makeReply("Branch B reply.");
		const { tools } = makeTools({ owner: a });

		const result = expectProposal(
			await tools.propose_message_edit.execute({ position: 1, instruction: "Fix" }, ctx("call_edit_4")),
		);
		if (result.kind !== "record" || result.recordType !== "message-edit") throw new Error("expected an edit proposal");
		const payload = directorMessageEditProposalSchema.parse(result.payload);
		expect(payload.source.messageId).toBe(a.replyId);
		expect(payload.source.messageId).not.toBe(b.replyId);
		expect(payload.sourceText).toBe("Branch A reply.");
	});

	it("refuses a USER message (not an assistant reply) with the precise note — nothing written", async () => {
		const fixture = await makeReply("The assistant reply.");
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		await expect(
			tools.propose_message_edit.execute({ position: 0, instruction: "Fix" }, ctx("call_edit_5")),
		).rejects.toThrow("propose_message_edit: the message at position 0 is a user message — corrections, alternatives and regeneration target a committed assistant reply");
		expect(delegateCalls).toHaveLength(0);
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("refuses a nonexistent swipe number (deleted/nonexistent source) with the precise note", async () => {
		const fixture = await makeReply("A reply with one swipe.");
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		await expect(
			tools.propose_message_edit.execute({ position: 1, variant: 7, instruction: "Fix" }, ctx("call_edit_6")),
		).rejects.toThrow("propose_message_edit: message at position 1 has no variant number 7");
		expect(delegateCalls).toHaveLength(0);
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("an editor_not_configured delegate outcome is model-facing TEXT, never a proposal and never a crash", async () => {
		const fixture = await makeReply("A reply to correct.");
		const { tools, delegateCalls } = makeTools({ owner: fixture, outcome: { status: "editor_not_configured" } });

		const result = await tools.propose_message_edit.execute(
			{ position: 1, instruction: "Fix" },
			ctx("call_edit_7"),
		);
		expect(typeof result).toBe("string");
		expect(result).toContain("no message editor is configured");
		expect(delegateCalls).toHaveLength(1);

		const failed = await tools.propose_message_edit.execute(
			{ position: 1, instruction: "Fix" },
			ctx("call_edit_8"),
		);
		expect(typeof failed).toBe("string");
	});

	it("cancelled and failed delegate outcomes are model-facing text and write nothing", async () => {
		const fixture = await makeReply("A reply to correct.");
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);
		const { tools, delegateCalls } = makeTools({ owner: fixture, outcome: { status: "cancelled" } });

		const cancelled = await tools.propose_message_edit.execute(
			{ position: 1, instruction: "Fix" },
			ctx("call_edit_9"),
		);
		expect(cancelled).toContain("cancelled");

		const failedTools = makeTools({
			owner: fixture,
			outcome: { status: "failed", reason: "provider unreachable" },
		});
		const failed = await failedTools.tools.propose_message_edit.execute(
			{ position: 1, instruction: "Fix" },
			ctx("call_edit_10"),
		);
		expect(failed).toContain("provider unreachable");
		expect(delegateCalls.every((call) => call.targetMessageId === fixture.replyId)).toBe(true);

		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("an UNWIRED delegate (host wiring gap) refuses loudly at call time, the tracker seam's shape", async () => {
		const fixture = await makeReply("A reply to correct.");
		const unwired = buildSidechatMessageTools({
			toolSet: { [DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit]: true },
			owner: fixture,
			messages: stores.messages,
		});
		await expect(
			unwired.propose_message_edit.execute({ position: 1, instruction: "Fix" }, ctx("call_edit_11")),
		).rejects.toThrow("propose_message_edit: message editor generation is not configured");
	});
});

// ─── propose_message_variant ─────────────────────────────────────────────────

describe("propose_message_variant (DMT-21)", () => {
	it("proposes the Director-authored content VERBATIM with ONE frozen source — no delegate call, nothing written", async () => {
		const fixture = await makeReply("Theron pours two cups.", ["Theron pours one cup."]);
		const firstVariantId = await variantAt(fixture.replyId, 1);
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		const result = expectProposal(
			await tools.propose_message_variant.execute(
				{ position: 1, sourceVariants: [1], content: "Theron silently leaves the tavern." },
				ctx("call_variant_1"),
			),
		);

		expect(result).toEqual({
			kind: "record",
			id: "call_variant_1",
			recordType: "message-variant",
			op: "create",
			targetId: fixture.replyId,
			payload: {
				sources: [{ messageId: fixture.replyId, variantId: firstVariantId, position: 1, variantNumber: 1 }],
				content: "Theron silently leaves the tavern.",
			},
			status: "pending",
		} satisfies RecordProposal);
		expect(directorMessageVariantProposalSchema.safeParse(result.payload).success).toBe(true);
		// ONE source is valid; NO generation and NO merge/synthesis call exists
		// behind this tool.
		expect(delegateCalls).toHaveLength(0);
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("freezes several sources in the GIVEN order (the basis the model declared)", async () => {
		const fixture = await makeReply("First draft.", ["Second draft.", "Third draft."]);
		const variant1 = await variantAt(fixture.replyId, 1);
		const variant3 = await variantAt(fixture.replyId, 3);
		const { tools } = makeTools({ owner: fixture });

		const result = expectProposal(
			await tools.propose_message_variant.execute(
				{ position: 1, sourceVariants: [3, 1], content: "A blend the Director wrote." },
				ctx("call_variant_2"),
			),
		);
		if (result.kind !== "record" || result.recordType !== "message-variant") throw new Error("expected a variant proposal");
		const payload = directorMessageVariantProposalSchema.parse(result.payload);
		expect(payload.sources.map((source) => source.variantId)).toEqual([variant3, variant1]);
		expect(payload.sources.map((source) => source.variantNumber)).toEqual([3, 1]);
	});

	it("refuses a nonexistent source swipe number with the precise note — no proposal, nothing written", async () => {
		const fixture = await makeReply("A reply.");
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		await expect(
			tools.propose_message_variant.execute(
				{ position: 1, sourceVariants: [1, 9], content: "Text." },
				ctx("call_variant_3"),
			),
		).rejects.toThrow("propose_message_variant: message at position 1 has no variant number 9");
		expect(delegateCalls).toHaveLength(0);
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("refuses a user message position with the precise note", async () => {
		const fixture = await makeReply("The assistant reply.");
		const { tools } = makeTools({ owner: fixture });

		await expect(
			tools.propose_message_variant.execute(
				{ position: 0, sourceVariants: [1], content: "Text." },
				ctx("call_variant_4"),
			),
		).rejects.toThrow("propose_message_variant: the message at position 0 is a user message");
	});
});

// ─── request_message_swipe ───────────────────────────────────────────────────

describe("request_message_swipe (DMT-21)", () => {
	it("returns the awaiting_permission marker with the frozen target identity, the card's reply identification, and the instruction IN FULL — no generation, no writes", async () => {
		const fixture = await makeReply("First draft.", ["Second draft reply line.\nIts body."]);
		const selectedVariantId = await variantAt(fixture.replyId, 2);
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		const marker: DirectorSwipePermissionMarker = await tools.request_message_swipe.execute(
			{ position: 1, instruction: "Rewrite this reply with more tension, keeping the same facts" },
			ctx("call_swipe_1"),
		);

		expect(marker).toEqual({
			status: "awaiting_permission",
			messageId: fixture.replyId,
			variantId: selectedVariantId,
			position: 1,
			variantNumber: 2,
			replyFirstLine: "Second draft reply line.",
			instruction: "Rewrite this reply with more tension, keeping the same facts",
		});
		expect(directorSwipePermissionMarkerSchema.safeParse(marker).success).toBe(true);
		// NO RP provider call, NO delegate call, NO write of any kind.
		expect(delegateCalls).toHaveLength(0);
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});

	it("refuses an unresolved target with the precise model-correctable error — never a marker that stops the turn for nothing", async () => {
		const fixture = await makeReply("A reply.");
		const { tools, delegateCalls } = makeTools({ owner: fixture });
		const before = await persistedSnapshot(fixture.chatId, fixture.branchId);

		await expect(
			tools.request_message_swipe.execute({ position: 42, instruction: "Rewrite" }, ctx("call_swipe_2")),
		).rejects.toThrow("request_message_swipe: no message at position 42 in this branch");
		expect(delegateCalls).toHaveLength(0);
		expect(await persistedSnapshot(fixture.chatId, fixture.branchId)).toEqual(before);
	});
});

// ─── Incomplete variant set (the corrupt-state refusal, through a stub seam) ─

describe("incomplete variant set refusal (DMT-21)", () => {
	it("all three tools refuse a committed reply whose variant rows are missing — the corrupt-set note", async () => {
		const fixture = await makeReply("A reply whose variants vanished.");
		// T1 stub at the DI seam: real rows, but the variant map is empty —
		// the store's own invariant (a message always has ≥1 variant) broken
		// underneath the resolver.
		const messagesWithEmptyVariants: DirectorMessageTargetDeps = {
			getMessages: (branchId) => stores.messages.getMessages(branchId),
			getVariantsByBranch: async () => new Map(),
		};
		const { tools } = makeTools({ owner: fixture, messages: messagesWithEmptyVariants });

		await expect(
			tools.propose_message_edit.execute({ position: 1, instruction: "Fix" }, ctx("call_corrupt_1")),
		).rejects.toThrow("propose_message_edit: the message at position 1 carries no swipes");
		await expect(
			tools.propose_message_variant.execute(
				{ position: 1, sourceVariants: [1], content: "Text." },
				ctx("call_corrupt_2"),
			),
		).rejects.toThrow("propose_message_variant: the message at position 1 carries no swipes");
		await expect(
			tools.request_message_swipe.execute({ position: 1, instruction: "Rewrite" }, ctx("call_corrupt_3")),
		).rejects.toThrow("request_message_swipe: the message at position 1 carries no swipes");
	});
});

// ─── Input schemas ride the DMT-11 contract (one source) ─────────────────────

describe("tool input schemas (DMT-11 contract, one source)", () => {
	it("the tools enforce the contract's input schemas", () => {
		const { tools } = makeTools({ owner: { chatId: "c", branchId: "b" } });
		// Shared zod input-schema probe (takes any ToolSet — no per-suite fork).
		const edit = toolInputSchema(tools, "propose_message_edit");
		const variant = toolInputSchema(tools, "propose_message_variant");
		const swipe = toolInputSchema(tools, "request_message_swipe");
		// propose_message_edit: optional variant, positive-int only.
		expect(edit.safeParse({ position: 1, instruction: "Fix" }).success).toBe(true);
		expect(edit.safeParse({ position: 1.5, instruction: "Fix" }).success).toBe(false);
		expect(edit.safeParse({ position: 1 }).success).toBe(false);
		// propose_message_variant: at least one source, non-empty content.
		expect(variant.safeParse({ position: 1, sourceVariants: [2], content: "Text." }).success).toBe(true);
		expect(variant.safeParse({ position: 1, sourceVariants: [], content: "Text." }).success).toBe(false);
		expect(variant.safeParse({ position: 1, sourceVariants: [2], content: "" }).success).toBe(false);
		// request_message_swipe: position + non-empty instruction.
		expect(swipe.safeParse({ position: 1, instruction: "Rewrite" }).success).toBe(true);
		expect(swipe.safeParse({ position: 1 }).success).toBe(false);
	});
});

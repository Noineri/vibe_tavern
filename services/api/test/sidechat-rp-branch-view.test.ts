import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { brandId, REGEX_PLACEMENT, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import {
	ATTACHED_VARIANT_NOT_IN_BRANCH_CODE,
	readBranchAsModelSees,
	type RpBranchViewDeps,
} from "../src/domain/sidechat/rp-branch-view.js";
import { isDomainError, type DomainError } from "../src/shared/errors.js";

/**
 * SC-2a — readBranchAsModelSees: the branch exactly as the RP model is given
 * it, on REAL rows (in-memory store container, real StaticPromptResolver +
 * PromptAssemblyService — the same seam a chat turn goes through). Pins the
 * unit's seven scenarios:
 *
 * 1. a greeting stored with a raw `{{user}}` macro arrives RESOLVED (stored
 *    text is NOT what the model sees);
 * 2. a prompt-placement regex preset transforms the view's text; a
 *    display-only one does not (RX-13 mode matrix crossing the whole-branch
 *    seam);
 * 3. bound Dice rolls appear inside the message text in the RP prompt's own
 *    wording (the `[Dice]` block), not as raw roll rows;
 * 4. a message inside an enabled excludeSummarized summary range is FROZEN
 *    TOO (SC-6: the view freezes every message — coverage is applied when
 *    the sidechat assembles over the frozen timeline, never at the freeze;
 *    was: hidden here like the RP prompt hides it, which stranded covered
 *    messages when a summary was disabled later);
 * 5. the SELECTED variant's text is used (swipes never leak through);
 * 6. variant reasoning is never present anywhere in the view;
 * 7. a foreign branch (and a missing one) resolves to null through the SC-0l
 *    ownership module — never a cross-owner leak.
 */

let stores: StoreContainer;
let deps: RpBranchViewDeps;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-rp-branch-view-"));
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
	deps = { chats: stores.chats, messages: stores.messages, assembly };
});

async function makeChat(): Promise<{ chatId: ChatId; branchId: ChatBranchId }> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-2a fixture chat",
		promptPresetId: null,
	});
	return { chatId: brandId<ChatId>(chat.id), branchId: brandId<ChatBranchId>(chat.activeBranchId) };
}

describe("readBranchAsModelSees (SC-2a)", () => {
	it("resolves a greeting's raw {{user}} macro — the view is the model's text, not the stored text", async () => {
		const { chatId, branchId } = await makeChat();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open. Well met, {{user}}!",
		});

		const view = await readBranchAsModelSees(deps, chatId, branchId);
		expect(view).not.toBeNull();
		expect(view!.messages).toHaveLength(1);
		const greeting = view!.messages[0]!;
		expect(greeting.role).toBe("assistant");
		expect(greeting.text).toContain("Well met, Sable!");
		expect(greeting.text).not.toContain("{{user}}");
		// Speaker names follow the ST rule the lore-scan prefix uses.
		expect(greeting.authorName).toBe("Theron");
		expect(greeting.variantId).not.toBeNull();
	});

	it("applies a prompt-placement regex preset and leaves a display-only one unapplied", async () => {
		await stores.regex.create({
			name: "prompt redaction",
			findRegex: "/spoiler:/g",
			replaceString: "[redacted]",
			trimStrings: [],
			substituteRegex: 0,
			disabled: false,
			promptOnly: true,
			markdownOnly: false,
			runOnEdit: false,
			minDepth: null,
			maxDepth: null,
			placement: [REGEX_PLACEMENT.UserInput],
			isGlobal: true,
			sortOrder: 0,
		});
		await stores.regex.create({
			name: "display-only hush",
			findRegex: "/whisper:/g",
			replaceString: "[hushed]",
			trimStrings: [],
			substituteRegex: 0,
			disabled: false,
			promptOnly: false,
			markdownOnly: true,
			runOnEdit: false,
			minDepth: null,
			maxDepth: null,
			placement: [REGEX_PLACEMENT.UserInput],
			isGlobal: true,
			sortOrder: 1,
		});

		const { chatId, branchId } = await makeChat();
		const msg = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "spoiler: the butler did it. whisper: meet at dawn.",
		});

		const view = await readBranchAsModelSees(deps, chatId, branchId);
		expect(view).not.toBeNull();
		const entry = view!.messages.find((m) => m.id === msg.id)!;
		// Prompt-mode preset transformed the RAW text before macros.
		expect(entry.text).toContain("[redacted] the butler did it");
		expect(entry.text).not.toContain("spoiler:");
		// Display-only preset belongs to the client render seam, not the prompt.
		expect(entry.text).toContain("whisper: meet at dawn");
		expect(entry.text).not.toContain("[hushed]");
		expect(entry.authorName).toBe("Sable");
	});

	it("renders bound Dice rolls in the RP prompt's [Dice] wording", async () => {
		const { chatId, branchId } = await makeChat();
		await stores.diceRolls.createRoll({
			chatId,
			branchId,
			mode: "normal",
			requestId: "req_sc2a_stealth",
			actorType: "character",
			actorId: characterId,
			actorLabel: "Theron",
			scriptId: "script_sc2a",
			scriptLabel: "Combat",
			scriptRevision: 1,
			checkId: "check_sc2a_stealth",
			checkLabel: "Stealth Check",
			notation: "2d6+1",
			faceShape: "d6",
			resolution: "strict",
			attemptsJson: JSON.stringify([{ attemptId: "att_sc2a", faces: [3, 5], modifier: 1, subtotal: 8, total: 9 }]),
			finalJson: JSON.stringify({ total: 9, outcome: "success", degree: "hard", constraint: "must remain unseen" }),
		});
		const pending = await stores.diceRolls.listPending(chatId, branchId);
		const msg = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "I sneak past the guards.",
		});
		await stores.diceRolls.bindActiveAndReset(chatId, branchId, "normal", pending.normal.revision, msg.id);

		const view = await readBranchAsModelSees(deps, chatId, branchId);
		expect(view).not.toBeNull();
		const entry = view!.messages.find((m) => m.id === msg.id)!;
		// The exact block the RP prompt appends: [Dice] header + compact line.
		expect(entry.text).toContain("I sneak past the guards.\n[Dice]\nStealth Check (2d6+1) — Theron: [3,5]+1 = 9. Adjudication: success (hard). Binding constraint: must remain unseen.");
	});

	it("freezes a message inside an enabled excludeSummarized range (SC-6) — coverage moved to the sidechat assembly", async () => {
		const { chatId, branchId } = await makeChat();
		const early = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "Early turn that gets summarized away.",
		});
		const middle = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "Later reply that stays.",
		});
		const later = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "Final user turn.",
		});
		// Enabled summary covering ONLY position 0 (one-based 1..1) with the
		// summarized range excluded — the RP prompt's hiding.
		await stores.chatSummaries.create({
			chatId,
			branchId,
			label: "Chapter 1",
			summarizedFrom: 1,
			summarizedTo: 1,
			includeInContext: true,
			excludeSummarized: true,
			content: "Summary: the early turn happened away from the table.",
		});

		const view = await readBranchAsModelSees(deps, chatId, branchId);
		expect(view).not.toBeNull();
		// WAS (before SC-6): the covered message was absent from the view — the
		// same exclusion the RP prompt applies, applied at the FREEZE. A message
		// covered at the first sync was then never frozen, and disabling the
		// summary later made its messages arrive as "new" at the END of the
		// timeline, out of order (Wave 1 review, 2026-10-19). NOW: the freeze
		// keeps EVERY message; the sidechat's own assembly drops covered
		// messages at read time over this frozen timeline
		// (sidechat-rp-summary.test.ts pins that side).
		expect(view!.messages.map((m) => m.id)).toEqual([early.id, middle.id, later.id]);
		expect(view!.messages.map((m) => m.text)).toContain("Early turn that gets summarized away.");
	});

	it("uses the SELECTED variant's text after a swipe change", async () => {
		const { chatId, branchId } = await makeChat();
		const msg = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "first take",
			variants: ["first take", "second take"],
			selectedVariantIndex: 0,
		});
		await stores.messages.selectVariant(msg.id, 1);

		const view = await readBranchAsModelSees(deps, chatId, branchId);
		expect(view).not.toBeNull();
		const entry = view!.messages.find((m) => m.id === msg.id)!;
		expect(entry.text).toBe("second take");
		const variants = await stores.messages.getVariants(msg.id);
		const selected = variants.find((v) => v.isSelected)!;
		expect(entry.variantId).toBe(selected.id);
	});

	it("never leaks variant reasoning into the view", async () => {
		const { chatId, branchId } = await makeChat();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "Visible reply.",
			reasoning: "hidden deliberation marker SC2A-REASONING",
		});

		const view = await readBranchAsModelSees(deps, chatId, branchId);
		expect(view).not.toBeNull();
		expect(view!.messages[0]!.text).toBe("Visible reply.");
		expect(JSON.stringify(view)).not.toContain("SC2A-REASONING");
	});

	it("returns null for a foreign branch and a missing branch (SC-0l ownership, no cross-owner leak)", async () => {
		const own = await makeChat();
		const foreign = await makeChat();

		expect(await readBranchAsModelSees(deps, own.chatId, foreign.branchId)).toBeNull();
		expect(await readBranchAsModelSees(deps, own.chatId, brandId<ChatBranchId>("brnch_does_not_exist"))).toBeNull();

		// The own pair still resolves — the reader reads the whole branch.
		const view = await readBranchAsModelSees(deps, own.chatId, own.branchId);
		expect(view).not.toBeNull();
		expect(view!.chatId).toBe(own.chatId);
		expect(view!.branchId).toBe(own.branchId);
		expect(Array.isArray(view!.messages)).toBe(true);
	});
});

describe("readBranchAsModelSees named variants (SC-17)", () => {
	it("returns a named variant's text through the SAME transform — a raw {{user}} arrives resolved, never raw", async () => {
		const { chatId, branchId } = await makeChat();
		const msg = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "first take greets {{user}}",
			variants: ["first take greets {{user}}", "second take greets {{user}}"],
			selectedVariantIndex: 0,
		});
		await stores.messages.selectVariant(msg.id, 1);
		const variants = await stores.messages.getVariants(msg.id);
		// The NON-selected alternative (index 0 after the swipe) is the named
		// pair — the case the attach flow exists for.
		const alternative = variants.find((v) => !v.isSelected)!;

		const view = await readBranchAsModelSees(deps, chatId, branchId, [
			{ messageId: msg.id, variantId: alternative.id },
		]);
		expect(view).not.toBeNull();
		expect(view!.namedVariants).toHaveLength(1);
		const named = view!.namedVariants![0]!;
		expect(named.messageId).toBe(msg.id);
		expect(named.variantId).toBe(alternative.id);
		expect(named.position).toBe(0);
		// The SAME per-message transform the selected text gets — the macro is
		// resolved, the raw {{user}} never leaves the reader.
		expect(named.text).toBe("first take greets Sable");
		// The RP's own marker read from the store row (the request named only
		// the pair — there is no marker to pass).
		expect(named.selected).toBe(false);
		// The view's own messages stay the SELECTED-variant read (SC-2a
		// unchanged — the named arm adds, never rewrites).
		expect(view!.messages[0]!.text).toBe("second take greets Sable");
		// Without named pairs the view carries no namedVariants at all.
		const plain = await readBranchAsModelSees(deps, chatId, branchId);
		expect(plain!.namedVariants).toBeUndefined();
	});

	it("throws the typed validation for a foreign message and for a foreign variant — nothing partial returned", async () => {
		const own = await makeChat();
		const other = await makeChat();
		const ownMsg = await stores.messages.addMessage({
			chatId: own.chatId,
			branchId: own.branchId,
			role: "assistant",
			authorType: "assistant",
			content: "own message",
			variants: ["own message", "own alternative"],
			selectedVariantIndex: 0,
		});
		const otherMsg = await stores.messages.addMessage({
			chatId: other.chatId,
			branchId: other.branchId,
			role: "assistant",
			authorType: "assistant",
			content: "other chat's message",
		});
		const ownVariants = await stores.messages.getVariants(ownMsg.id);
		const otherVariants = await stores.messages.getVariants(otherMsg.id);

		const expectRefusal = async (pair: { messageId: string; variantId: string }): Promise<DomainError> => {
			let thrown: unknown;
			try {
				await readBranchAsModelSees(deps, own.chatId, own.branchId, [pair]);
			} catch (err) {
				thrown = err;
			}
			expect(isDomainError(thrown)).toBe(true);
			const error = thrown as DomainError;
			expect(error.kind).toBe("Validation");
			expect(error.details?.code).toBe(ATTACHED_VARIANT_NOT_IN_BRANCH_CODE);
			return error;
		};

		// A message of ANOTHER chat's branch.
		const foreignMessage = await expectRefusal({
			messageId: otherMsg.id,
			variantId: otherVariants[0]!.id,
		});
		expect(foreignMessage.details?.messageId).toBe(otherMsg.id);
		// A variant of ANOTHER message in the SAME branch (attached under the
		// wrong message id).
		await expectRefusal({ messageId: ownMsg.id, variantId: otherVariants[0]!.id });
		// A variant id that exists nowhere.
		await expectRefusal({ messageId: ownMsg.id, variantId: "mvar_does_not_exist" });
		// The own branch's VALID pair still resolves after the refusals (the
		// reader state is untouched — every check ran on its own read).
		const view = await readBranchAsModelSees(deps, own.chatId, own.branchId, [
			{ messageId: ownMsg.id, variantId: ownVariants[1]!.id },
		]);
		expect(view!.namedVariants![0]!.text).toBe("own alternative");
	});

	it("carries each variant's model/preset and the named variant's number source (SC-23a)", async () => {
		const { chatId, branchId } = await makeChat();
		// addMessage records model/preset on the SELECTED variant only: the
		// chosen take (index 0) has provenance, the alternative (index 1) none.
		const msg = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "first take",
			variants: ["first take", "second take"],
			selectedVariantIndex: 0,
			modelId: "flash-latest",
			presetName: "Agentic Narrator",
		});
		const variants = await stores.messages.getVariants(msg.id);
		const selected = variants.find((v) => v.isSelected)!;
		const alternative = variants.find((v) => !v.isSelected)!;

		const view = await readBranchAsModelSees(deps, chatId, branchId, [
			{ messageId: msg.id, variantId: alternative.id },
		]);
		expect(view).not.toBeNull();

		// The message arm: the SELECTED variant's provenance rides the view row
		// (the frozen rp_sync payloads' `model`/`preset`).
		const entry = view!.messages.find((m) => m.id === msg.id)!;
		expect(entry.variantId).toBe(selected.id);
		expect(entry.modelId).toBe("flash-latest");
		expect(entry.presetName).toBe("Agentic Narrator");

		// The named arm: the variant's OWN row is the source — variantIndex
		// (the +1 happens at the freeze), and this variant's own null
		// provenance (an alternative created without a model), never the
		// selected sibling's.
		const named = view!.namedVariants![0]!;
		expect(named.variantIndex).toBe(alternative.variantIndex);
		expect(named.modelId).toBeNull();
		expect(named.presetName).toBeNull();
	});
});

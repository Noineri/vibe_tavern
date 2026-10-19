import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { brandId, REGEX_PLACEMENT, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { readBranchAsModelSees, type RpBranchViewDeps } from "../src/domain/sidechat/rp-branch-view.js";

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
 * 4. a message inside an enabled excludeSummarized summary range is absent —
 *    hidden from the view the same way the RP prompt hides it;
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

	it("hides a message inside an enabled excludeSummarized range — same exclusion the RP prompt applies", async () => {
		const { chatId, branchId } = await makeChat();
		const early = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "Early turn that gets summarized away.",
		});
		await stores.messages.addMessage({
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
		// Enabled summary covering ONLY position 0 (one-based 1..1), with the
		// summarized range excluded from the prompt — the RP prompt's hiding.
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
		expect(view!.messages.map((m) => m.id)).not.toContain(early.id);
		expect(view!.messages.map((m) => m.id)).toEqual([expect.any(String), later.id]);
		expect(view!.messages.map((m) => m.text)).toContain("Later reply that stays.");
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

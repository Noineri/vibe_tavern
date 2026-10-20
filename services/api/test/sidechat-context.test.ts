import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createStoreContainer,
	type MessageVariantSceneRecord,
	type StoreContainer,
} from "@vibe-tavern/db";
import {
	brandId,
	defaultObjectiveState,
	OBJECTIVE_MODE,
	OBJECTIVE_TASK_STATUS,
	type ChatBranchId,
	type ChatId,
	type ExperienceCopilotThreadId,
	type InsightsConfig,
	type ObjectiveState,
} from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { syncBeforeUserMessage, type RpSyncDeps } from "../src/domain/sidechat/rp-sync.js";
import { loadSidechatContext, type SidechatContextDeps } from "../src/domain/sidechat/sidechat-context.js";

/**
 * SC-3b — loadSidechatContext on REAL rows (in-memory store container, the
 * same StaticPromptResolver + PromptAssemblyService seam a chat turn, the
 * SC-2a reader, and the SC-2c writer go through; traces are written through
 * the REAL send-path seam — assembleForChat's draft into
 * `stores.traces.saveTrace`, exactly what the greeting trace path does). Pins
 * the unit's scenarios:
 *
 * 1. card macros (`{{char}}`/`{{user}}` in the stored profile) and persona
 *    macros arrive RESOLVED — through the same variable context the RP send
 *    builds;
 * 2. lore text equals the TRACE's layer even after the lore entry was EDITED
 *    in the store — the RP model's text, not the current row;
 * 3. a sidechat on a NON-ACTIVE branch gets ITS OWN branch's scene record,
 *    never the active branch's;
 * 4. no trace yet → the rendered package contains no `<active_lore>`;
 * 5. no reasoning text and no preset text anywhere in the package;
 * 6. objectives: `mode` straight off the chat's state (route + goals), text
 *    in the RP prompt's own objective wording;
 * 7. SC-4d (variant A): the static package carries NO timeline — the frozen
 *    events come back as flow-ready user-message bodies placed by the merged
 *    timeline's order, and the OOC message rows render nowhere (the real
 *    history rows the stream's flow carries ARE the conversation, once).
 */

let stores: StoreContainer;
let contextDeps: SidechatContextDeps;
let syncDeps: RpSyncDeps;
let characterId: string;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-context-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const persona = await stores.personas.create({
		name: "Sable",
		description: "A wandering cartographer mapping {{char}}'s trails.",
		pronouns: "she/her",
		defaultForNewChats: true,
	});
	expect(persona.name).toBe("Sable");
	const character = await stores.characters.create({
		name: "Theron",
		description: "A brooding ranger guarding {{char}}'s forest roads for {{user}}.",
	});
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

/** A chat with its active branch and a chat-owned sidechat thread on it — the
 *  unit's standard fixture (SC-0a owner columns on the thread row). The
 *  thread lands on the chat's ACTIVE branch. */
async function makeSidechatFixture(options?: {
	promptPresetId?: string | null;
}): Promise<{
	threadId: ExperienceCopilotThreadId;
	chatId: ChatId;
	branchId: ChatBranchId;
}> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "SC-3b fixture chat",
		promptPresetId: options?.promptPresetId ?? null,
	});
	const branchId = chat.activeBranchId;
	const thread = await stores.experienceCopilot.startNewChatSession(chat.id, branchId, "sidechat-ooc");
	return {
		threadId: thread.id,
		chatId: brandId<ChatId>(chat.id),
		branchId: brandId<ChatBranchId>(branchId),
	};
}

/** The id of the message's currently selected variant. */
async function selectedVariantOf(messageId: string): Promise<string> {
	const variants = await stores.messages.getVariants(messageId);
	const selected = variants.find((variant) => variant.isSelected);
	if (!selected) throw new Error(`fixture: message ${messageId} has no selected variant`);
	return selected.id;
}

/** A minimal valid scene record pinned to one variant (the store's raw record
 *  shape — self-describing promptFormat snapshot included). */
function sceneRecord(variantId: string, place: string): MessageVariantSceneRecord {
	return {
		variantId,
		schemaHash: "sc3b-schema-hash",
		configRevision: 1,
		sourceHash: "sc3b-source-hash",
		promptFormat: "json",
		sceneState: { place },
		modelId: null,
		generatedAt: "2026-10-19T00:00:00.000Z",
	};
}

/** Write the branch's prompt trace through the REAL send-path seam: the
 *  assembled draft into `stores.traces.saveTrace` (the greeting trace's exact
 *  call shape — session-runtime-chat-lifecycle.ts). */
async function saveBranchTrace(chatId: ChatId, branchId: ChatBranchId, messageId: string): Promise<void> {
	const assembled = await contextDeps.assembly.assembleForChat({ chatId, branchId, model: "sc3b-model" });
	await stores.traces.saveTrace({
		...assembled.promptTraceDraft,
		presetName: assembled.promptTraceDraft.presetName ?? "(none)",
		messageId,
	});
}

describe("loadSidechatContext (SC-3b)", () => {
	it("resolves the card's and persona's raw macros — the RP send's own variable context", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "Hello there.",
		});

		const pkg = await loadSidechatContext(contextDeps, threadId);

		// The stored card is macro-raw; the package carries the resolved text.
		const rendered = pkg.staticPackage;
		expect(rendered).toContain("<character name=\"Theron\">");
		expect(rendered).toContain("A brooding ranger guarding Theron's forest roads for Sable.");
		expect(rendered).not.toContain("{{char}}");
		expect(rendered).not.toContain("{{user}}");
		// The chat's active persona, with its description resolved the same way
		// (pronouns ride along as the one optional attribute).
		expect(rendered).toContain("<persona name=\"Sable\" pronouns=\"she/her\">");
		expect(rendered).toContain("A wandering cartographer mapping Theron's trails.");
		// Objectives stay off in this fixture (tracker disabled, no state) —
		// the section is omitted, not rendered empty.
		expect(rendered).not.toContain("<objectives");
	});

	it("lore text equals the TRACE's layer, not the lore entry edited since", async () => {
		const lorebook = await stores.lorebooks.createLorebook({
			name: "SC-3b book",
			scopeType: "entity",
		});
		await stores.lorebooks.addLink(lorebook.id, "character", characterId);
		const entry = await stores.lorebooks.createEntry(lorebook.id, {
			title: "Silverpine",
			content: "The Silverpine forest hides an elven ruin.",
			constant: true,
		});

		const { threadId, chatId, branchId } = await makeSidechatFixture();
		const message = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "Tell me about the woods.",
		});
		await saveBranchTrace(chatId, branchId, message.id);

		// The store's row moves on AFTER the trace was frozen — the package
		// must keep showing what the RP model received at trace time.
		await stores.lorebooks.updateEntry(entry.id, {
			content: "EDITED SINCE: the ruin has collapsed.",
		});

		const pkg = await loadSidechatContext(contextDeps, threadId);
		const rendered = pkg.staticPackage;
		expect(rendered).toContain("<active_lore>");
		expect(rendered).toContain("<lore_entry title=\"Silverpine\">");
		expect(rendered).toContain("The Silverpine forest hides an elven ruin.");
		expect(rendered).not.toContain("EDITED SINCE");
	});

	it("a sidechat on a NON-ACTIVE branch gets its OWN branch's scene", async () => {
		const { chatId } = await makeSidechatFixture();
		const activeBranchId = (await stores.chats.getById(chatId))!.activeBranchId;
		const opening = await stores.messages.addMessage({
			chatId,
			branchId: brandId<ChatBranchId>(activeBranchId),
			role: "user",
			authorType: "user",
			content: "We enter the tavern.",
		});
		const activeReply = await stores.messages.addMessage({
			chatId,
			branchId: brandId<ChatBranchId>(activeBranchId),
			role: "assistant",
			authorType: "assistant",
			content: "The main hall roars.",
		});
		await stores.messages.setSceneRecord(await selectedVariantOf(activeReply.id), sceneRecord(activeReply.id, "the busy main hall"));

		// Fork BEFORE any assistant message, so the fork's own latest assistant
		// is the one added below — its scene, not the active branch's.
		const fork = await stores.chats.forkBranch(chatId, opening.id, "quiet fork");
		const forkReply = await stores.messages.addMessage({
			chatId,
			branchId: brandId<ChatBranchId>(fork.id),
			role: "assistant",
			authorType: "assistant",
			content: "The archive is silent.",
		});
		await stores.messages.setSceneRecord(await selectedVariantOf(forkReply.id), sceneRecord(forkReply.id, "the quiet archive"));
		// Sanity: the chat's active branch is still the original.
		expect((await stores.chats.getById(chatId))!.activeBranchId).toBe(activeBranchId);

		// The sidechat thread lives on the SAME chat, on the NON-ACTIVE fork.
		const thread = await stores.experienceCopilot.startNewChatSession(chatId, fork.id, "sidechat-ooc");
		const pkg = await loadSidechatContext(contextDeps, thread.id);
		const rendered = pkg.staticPackage;

		expect(rendered).toContain("<current_scene>");
		expect(rendered).toContain("the quiet archive");
		expect(rendered).not.toContain("the busy main hall");
	});

	it("no prompt trace yet → no <active_lore> section", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "user",
			authorType: "user",
			content: "No generation has happened on this branch.",
		});

		const pkg = await loadSidechatContext(contextDeps, threadId);
		const rendered = pkg.staticPackage;
		expect(rendered).not.toContain("<active_lore>");
		// The character section still renders — the package is not empty.
		expect(rendered).toContain("<character name=\"Theron\">");
	});

	it("carries no reasoning text and no preset text anywhere", async () => {
		const preset = await stores.presets.create({
			name: "SC-3b preset",
			systemPrompt: "SC3B-PRESET-MARKER You are a grim narrator.",
		});
		const { threadId, chatId, branchId } = await makeSidechatFixture({ promptPresetId: preset.id });
		const reply = await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The visible reply.",
			reasoning: "SC3B-REASONING-MARKER hidden deliberation",
		});
		// Freeze the branch (reasoning-carrying message included) into the
		// thread's timeline, so the absence pin runs over the frozen events too.
		await syncBeforeUserMessage(syncDeps, threadId);
		expect(reply.id).toBeTruthy();

		const pkg = await loadSidechatContext(contextDeps, threadId);
		// The absence pins run over EVERYTHING the prompt will carry: the static
		// package AND the frozen event bodies (they ride the message flow as
		// user messages since SC-4d).
		const everything = [pkg.staticPackage, ...pkg.eventMessages.map((event) => event.content)].join("\n");
		expect(everything).not.toContain("SC3B-PRESET-MARKER");
		expect(everything).not.toContain("SC3B-REASONING-MARKER");
		// The branch's visible text DID make it in — via the frozen rp_sync
		// event's own message body — so the absence above is not an empty load.
		expect(pkg.eventMessages).toHaveLength(1);
		expect(pkg.eventMessages[0]!.content).toContain("The visible reply.");
		expect(pkg.staticPackage).not.toContain("The visible reply.");
	});

	it("objectives render the state's mode with the RP prompt's own wording (route and goals)", async () => {
		const enabledConfig: InsightsConfig = {
			objectiveEnabled: true,
			trackerEnabled: false,
			diceEnabled: false,
			diceMode: "normal",
			diceScriptIds: null,
			diceActorBindings: null,
		};

		const routeFixture = await makeSidechatFixture();
		const routeState: ObjectiveState = {
			...defaultObjectiveState(),
			mode: OBJECTIVE_MODE.route,
			objectiveDescription: "Find the silver amulet",
			tasks: [{ id: "t1", description: "Search the Silverpine forest", status: OBJECTIVE_TASK_STATUS.pending }],
		};
		await stores.chats.replaceTrackerSetup(routeFixture.chatId, enabledConfig, routeState);
		const routeRendered = (await loadSidechatContext(contextDeps, routeFixture.threadId)).staticPackage;
		expect(routeRendered).toContain(
			"<objectives mode=\"route\">[Active objective] Search the Silverpine forest</objectives>",
		);

		const goalsFixture = await makeSidechatFixture();
		const goalsState: ObjectiveState = {
			...defaultObjectiveState(),
			mode: OBJECTIVE_MODE.goals,
			objectiveDescription: "Reclaim the ancestral hold",
			longTermGoal: { description: "Reclaim the ancestral hold", status: OBJECTIVE_TASK_STATUS.pending },
			shortTermGoals: [{ id: "g1", description: "Recruit the dwarven smith", status: OBJECTIVE_TASK_STATUS.pending }],
		};
		await stores.chats.replaceTrackerSetup(goalsFixture.chatId, enabledConfig, goalsState);
		const goalsRendered = (await loadSidechatContext(contextDeps, goalsFixture.threadId)).staticPackage;
		expect(goalsRendered).toContain(
			"<objectives mode=\"goals\">[Long-term goal] Reclaim the ancestral hold\n[Active objective] Recruit the dwarven smith</objectives>",
		);
	});

	it("the static package carries no timeline; the frozen events come back as flow-placed message bodies (SC-4d)", async () => {
		const { threadId, chatId, branchId } = await makeSidechatFixture();
		await stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: "The tavern door swings open.",
		});
		await syncBeforeUserMessage(syncDeps, threadId);
		await stores.experienceCopilot.appendMessage(threadId, { role: "user", content: "Quick OOC aside" });

		const pkg = await loadSidechatContext(contextDeps, threadId);
		// The static package: five settled sections only — no timeline section,
		// no OOC lines, no event tags (was: a timeline section carrying both).
		expect(pkg.staticPackage).not.toContain("<rp_sync");
		expect(pkg.staticPackage).not.toContain("Quick OOC aside");
		expect(pkg.staticPackage).not.toContain("User:");
		// The frozen event: one flow-ready user-message body, placed BELOW the
		// OOC message on the merged timeline (the sync froze it first).
		expect(pkg.eventMessages).toHaveLength(1);
		expect(pkg.eventMessages[0]!.precedingMessages).toBe(0);
		expect(pkg.eventMessages[0]!.content).toBe(
			[
				'<rp_sync from="0" to="0">',
				'<rp_message position="0" role="assistant" author="Theron">The tavern door swings open.</rp_message>',
				"</rp_sync>",
			].join("\n"),
		);
		// The timeline's message rows are exactly the flow's real messages: the
		// one OOC aside (its text renders nowhere in the static package).
		expect(pkg.messageCount).toBe(1);
	});
});

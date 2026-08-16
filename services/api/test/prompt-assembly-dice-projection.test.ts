/**
 * Prompt-assembly Dice projection service test (DICE_SYSTEM_BACKEND_PLAN, Wave B5 / DICE-B14).
 *
 * Drives the REAL PromptAssemblyService.buildPipelineContext (+ full
 * assembleForChat for both the chat-turn and summary paths) with a minimal mock
 * store + fake resolver, verifying that bound Dice rolls are batch-loaded via
 * DiceRollStore.getRollsForMessages (one query, no N+1), mapped into the
 * RecentMessage snapshots the pipeline formats, and projected identically by
 * every consumer (generate / summary / context preview all go through
 * buildPipelineContext). No Dice-service or sandbox is invoked on the read path.
 */
import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { DiceRoll } from "@vibe-tavern/db";
import type { ChatId } from "@vibe-tavern/domain";

/** A flat store DiceRoll row (JSON strings, unbranded) bound to msg_1. */
function makeStoreRoll(overrides: Partial<DiceRoll> = {}): DiceRoll {
	return {
		id: "roll_1",
		requestId: "req_1",
		laneId: "lane_1",
		boundMessageId: "msg_1",
		actorType: "character",
		actorId: "char_1",
		actorLabel: "Theron",
		scriptId: "script_1",
		scriptLabel: "Combat",
		scriptRevision: 1,
		checkId: "check_1",
		checkLabel: "Stealth Check",
		notation: "2d6+1",
		faceShape: "d6",
		resolution: "strict",
		mode: "normal",
		included: true,
		finalAttemptId: "att_1",
		attemptsJson: JSON.stringify([{ attemptId: "att_1", faces: [3, 5], modifier: 1, subtotal: 8, total: 9 }]),
		finalJson: JSON.stringify({ total: 9, outcome: "success", degree: "hard", constraint: "must remain unseen" }),
		retryReason: null,
		policy: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

interface DiceServiceOptions {
	/** Rolls to return from getRollsForMessages (keyed by messageId). */
	rollsByMessage?: Map<string, DiceRoll[]>;
	/** Captures how many times getRollsForMessages was called. */
	onDiceQuery?: () => void;
}

function makeDiceService(options: DiceServiceOptions = {}) {
	const { rollsByMessage = new Map<string, DiceRoll[]>(), onDiceQuery } = options;

	const stores = {
		chats: {
			getById: async () => ({
				id: "chat_1",
				characterId: "char_1",
				personaId: null,
				promptPresetId: null,
				activeBranchId: "branch_1",
				title: "T",
				summary: null,
				messageHistoryLimit: 0,
				insightsConfig: {},
				insightsObjectiveState: {},
				createdAt: "2025-01-01T00:00:00Z",
				updatedAt: "2025-01-01T00:00:00Z",
			}),
			getBranches: async () => [{ id: "branch_1", chatId: "chat_1", parentBranchId: null, label: "main" }],
			getMessages: async () => [],
		},
		messages: {
			getMessages: async () => [
				{ id: "msg_1", role: "user", content: "I sneak past the guards.", branchId: "branch_1", position: 0, authorType: "user", state: "complete", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
				{ id: "msg_2", role: "assistant", content: "You move quietly.", branchId: "branch_1", position: 1, authorType: "character", state: "complete", createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
			],
		},
		personas: { listAll: async () => [] },
		presets: { listAll: async () => [] },
		chatSummaries: { listByChatBranch: async () => [] },
		characterAssets: { listByCharacter: async () => [] },
		diceRolls: {
			getRollsForMessages: async () => {
				onDiceQuery?.();
				return new Map(rollsByMessage);
			},
		},
		experiences: { getAttachmentsForMessages: async () => new Map() },
	} as unknown as StoreContainer;

	const resolver: PromptAssemblyResolver = {
		getCharacter: async () => ({
			id: "char_1",
			name: "Aria",
			description: "A fire mage.",
			personality: "Bold.",
		}),
		getPersona: async () => null,
		getPromptPreset: async () => null,
		listActiveLoreEntries: async () => [],
		listRetrievedMemories: async () => [],
		executeScripts: async () => ({ personality: "Bold.", scenario: null, injectedMessages: [], errors: [], scriptRuns: [] }),
		getToolInstructions: () => null,
	};

	const fileStore = {
		dataRoot: "/mock",
		resolvePath: (_folder: string, relativePath: string) => `/mock/${relativePath}`,
		readJson: async <T>() => null as T,
		writeJson: async () => {},
		asyncWriteJson: async () => {},
	};

	return new PromptAssemblyService(stores, resolver, fileStore);
}

describe("PromptAssemblyService Dice projection (DICE-B14)", () => {
	it("batch-loads bound Dice rolls and attaches them to the correct user message", async () => {
		let queryCount = 0;
		const service = makeDiceService({
			rollsByMessage: new Map([["msg_1", [makeStoreRoll()]]]),
			onDiceQuery: () => { queryCount += 1; },
		});

		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });

		const userMsg = built.context.chat.recentMessages.find((m) => m.id === "msg_1");
		expect(userMsg).toBeDefined();
		expect(userMsg!.diceRolls).toBeDefined();
		expect(userMsg!.diceRolls).toHaveLength(1);
		expect(userMsg!.diceRolls![0].checkLabel).toBe("Stealth Check");
		expect(userMsg!.diceRolls![0].resolution).toBe("strict");
		expect(userMsg!.diceRolls![0].final?.outcome).toBe("success");

		// The assistant message has no diceRolls.
		const assistantMsg = built.context.chat.recentMessages.find((m) => m.id === "msg_2");
		expect(assistantMsg!.diceRolls).toBeUndefined();
	});

	it("calls getRollsForMessages exactly once (no N+1)", async () => {
		let queryCount = 0;
		const service = makeDiceService({
			rollsByMessage: new Map([["msg_1", [makeStoreRoll()]]]),
			onDiceQuery: () => { queryCount += 1; },
		});

		await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(queryCount).toBe(1);
	});

	it("projects the Dice block into the assembled chat-turn payload", async () => {
		const service = makeDiceService({
			rollsByMessage: new Map([["msg_1", [makeStoreRoll()]]]),
		});

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const userMsg = (result.prompt.finalPayload as { messages: Array<{ messageId?: string; content: string }> }).messages
			.find((m) => m.messageId === "msg_1");
		expect(userMsg).toBeDefined();
		expect(userMsg!.content).toContain("I sneak past the guards.");
		expect(userMsg!.content).toContain("[Dice]");
		expect(userMsg!.content).toContain("Stealth Check");
		expect(userMsg!.content).toContain("Adjudication: success (hard).");
	});

	it("summary path reads identical Dice values (same buildPipelineContext)", async () => {
		const service = makeDiceService({
			rollsByMessage: new Map([["msg_1", [makeStoreRoll()]]]),
		});

		// The summary path goes through the same buildPipelineContext, so the
		// Dice snapshots are read identically — the block appears in the summary
		// payload's history too.
		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m", summary: true });
		const payloadStr = JSON.stringify(result.prompt.finalPayload);
		expect(payloadStr).toContain("[Dice]");
		expect(payloadStr).toContain("Stealth Check");
		expect(payloadStr).toContain("Adjudication: success (hard).");
	});

	it("narrative rolls omit adjudication in the assembled payload", async () => {
		const narrativeRoll = makeStoreRoll({
			id: "roll_2",
			checkLabel: "Athletics",
			notation: "d20",
			faceShape: "d20",
			resolution: "narrative",
			finalAttemptId: "att_1",
			attemptsJson: JSON.stringify([{ attemptId: "att_1", faces: [14], modifier: 0, subtotal: 14, total: 14 }]),
			finalJson: null,
		});
		const service = makeDiceService({
			rollsByMessage: new Map([["msg_1", [narrativeRoll]]]),
		});

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const userMsg = (result.prompt.finalPayload as { messages: Array<{ messageId?: string; content: string }> }).messages
			.find((m) => m.messageId === "msg_1");
		expect(userMsg!.content).toContain("[Dice]");
		expect(userMsg!.content).toContain("Athletics");
		expect(userMsg!.content).toContain("[14] = 14");
		expect(userMsg!.content).not.toContain("Adjudication");
	});

	it("no Dice rolls → no Dice block in payload (absence no-op)", async () => {
		const service = makeDiceService({ rollsByMessage: new Map() });

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const payloadStr = JSON.stringify(result.prompt.finalPayload);
		expect(payloadStr).not.toContain("[Dice]");
	});

	it("multiple checks on one message are all projected in order", async () => {
		const service = makeDiceService({
			rollsByMessage: new Map([["msg_1", [
				makeStoreRoll({ id: "roll_a", checkId: "check_a", checkLabel: "Attack", notation: "d20+3", attemptsJson: JSON.stringify([{ attemptId: "att_1", faces: [12], modifier: 3, subtotal: 12, total: 15 }]) }),
				makeStoreRoll({ id: "roll_b", checkId: "check_b", checkLabel: "Stealth Check" }),
			]]]),
		});

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const userMsg = (result.prompt.finalPayload as { messages: Array<{ messageId?: string; content: string }> }).messages
			.find((m) => m.messageId === "msg_1");
		const content = userMsg!.content;
		expect(content.indexOf("Attack")).toBeLessThan(content.indexOf("Stealth Check"));
	});

	it("parses attempts and final from store JSON into domain snapshots", async () => {
		const roll = makeStoreRoll({
			mode: "immersive",
			policy: "choose",
			finalAttemptId: "att_2",
			attemptsJson: JSON.stringify([
				{ attemptId: "att_1", faces: [5], modifier: 3, subtotal: 5, total: 8 },
				{ attemptId: "att_2", faces: [12], modifier: 3, subtotal: 12, total: 15, grantReason: "Lucky Reroll", chosenFinal: true },
			]),
			finalJson: JSON.stringify({ total: 15, outcome: "hit" }),
		});
		const service = makeDiceService({
			rollsByMessage: new Map([["msg_1", [roll]]]),
		});

		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		const snapshot = built.context.chat.recentMessages.find((m) => m.id === "msg_1")!.diceRolls![0];
		expect(snapshot.attempts).toHaveLength(2);
		expect(snapshot.attempts[0].faces).toEqual([5]);
		expect(snapshot.attempts[1].grantReason).toBe("Lucky Reroll");
		expect(snapshot.attempts[1].chosenFinal).toBe(true);
		expect(snapshot.final?.outcome).toBe("hit");
		expect(snapshot.mode).toBe("immersive");
		expect(snapshot.policy).toBe("choose");
	});
});

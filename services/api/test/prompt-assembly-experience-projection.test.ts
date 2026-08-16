/**
 * Prompt-assembly experience-report projection service test (IR-52, Wave 5).
 *
 * The direct analogue of prompt-assembly-dice-projection.test.ts. Drives the
 * REAL PromptAssemblyService.buildPipelineContext (+ full assembleForChat for
 * both the chat-turn and summary paths) with a minimal mock store + fake
 * resolver, verifying that bound experience attachments are batch-loaded via
 * ExperienceStore.getAttachmentsForMessages (one query, no N+1), mapped into the
 * RecentMessage snapshots the pipeline formats, and projected identically by
 * every consumer. Two invariants are pinned hard here:
 *   1. The hidden checkpoint column is NEVER surfaced — even when the store row
 *      carries a secret in `hiddenStateCheckpointJson`, neither the snapshot nor
 *      the assembled payload contains it.
 *   2. A malformed `publicEventsJson` is skipped (no crash, no block) rather
 *      than failing the RP turn.
 * No experience service or sandbox is invoked on the read path.
 */
import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import type { StoreContainer, ExperienceAttachmentRow } from "@vibe-tavern/db";
import type { ChatId } from "@vibe-tavern/domain";

/** A flat store ExperienceAttachmentRow bound to msg_1 with a well-formed report. */
function makeStoreAttachment(overrides: Partial<ExperienceAttachmentRow> = {}): ExperienceAttachmentRow {
	return {
		id: "xa_1",
		chatId: "chat_1",
		branchId: "branch_1",
		sessionId: "xs_1",
		sessionRevision: 3,
		queueRevision: 1,
		kind: "report",
		publicEventsJson: JSON.stringify({
			title: "Tic-Tac-Toe",
			summary: "Round 3 — X to move",
			events: [{ type: "move", detail: "X played center" }],
		}),
		hiddenStateCheckpointJson: '{"secret":"deck_order_hidden"}',
		rulesSourceHash: "abc123",
		visualSourceHash: null,
		boundMessageId: "msg_1",
		createdAt: "2026-07-21T00:00:00.000Z",
		updatedAt: "2026-07-21T00:00:00.000Z",
		...overrides,
	};
}

interface ExperienceServiceOptions {
	/** Attachments to return from getAttachmentsForMessages (keyed by messageId). */
	attachmentsByMessage?: Map<string, ExperienceAttachmentRow[]>;
	/** Captures how many times getAttachmentsForMessages was called. */
	onAttachmentQuery?: () => void;
}

function makeExperienceService(options: ExperienceServiceOptions = {}) {
	const { attachmentsByMessage = new Map<string, ExperienceAttachmentRow[]>(), onAttachmentQuery } = options;

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
				{ id: "msg_1", role: "user", content: "I make my move.", branchId: "branch_1", position: 0, authorType: "user", state: "complete", createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" },
				{ id: "msg_2", role: "assistant", content: "Noted.", branchId: "branch_1", position: 1, authorType: "character", state: "complete", createdAt: "2026-07-21T00:00:01.000Z", updatedAt: "2026-07-21T00:00:01.000Z" },
			],
		},
		personas: { listAll: async () => [] },
		presets: { listAll: async () => [] },
		chatSummaries: { listByChatBranch: async () => [] },
		characterAssets: { listByCharacter: async () => [] },
		diceRolls: { getRollsForMessages: async () => new Map() },
		experiences: {
			getAttachmentsForMessages: async () => {
				onAttachmentQuery?.();
				return new Map(attachmentsByMessage);
			},
		},
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

describe("PromptAssemblyService experience-report projection (IR-52)", () => {
	it("batch-loads bound attachments and attaches experienceReports to the correct user message", async () => {
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment()]]]),
		});

		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });

		const userMsg = built.context.chat.recentMessages.find((m) => m.id === "msg_1");
		expect(userMsg).toBeDefined();
		expect(userMsg!.experienceReports).toBeDefined();
		expect(userMsg!.experienceReports).toHaveLength(1);
		expect(userMsg!.experienceReports![0].title).toBe("Tic-Tac-Toe");
		expect(userMsg!.experienceReports![0].summary).toBe("Round 3 — X to move");
		expect(userMsg!.experienceReports![0].events[0]!.type).toBe("move");

		// The assistant message has no experienceReports.
		const assistantMsg = built.context.chat.recentMessages.find((m) => m.id === "msg_2");
		expect(assistantMsg!.experienceReports).toBeUndefined();
	});

	it("calls getAttachmentsForMessages exactly once (no N+1)", async () => {
		let queryCount = 0;
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment()]]]),
			onAttachmentQuery: () => { queryCount += 1; },
		});

		await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(queryCount).toBe(1);
	});

	it("projects the report block into the assembled chat-turn payload", async () => {
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment()]]]),
		});

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const userMsg = (result.prompt.finalPayload as { messages: Array<{ messageId?: string; content: string }> }).messages
			.find((m) => m.messageId === "msg_1");
		expect(userMsg).toBeDefined();
		expect(userMsg!.content).toContain("I make my move.");
		expect(userMsg!.content).toContain("[Experience report — Tic-Tac-Toe — authoritative]");
		expect(userMsg!.content).toContain("resolved facts");
		expect(userMsg!.content).toContain("- move: X played center");
		expect(userMsg!.content).toContain("[End experience report]");
	});

	it("NEVER leaks the hidden checkpoint into the snapshot or the payload", async () => {
		// The store row carries a secret in hiddenStateCheckpointJson. Neither the
		// mapped snapshot nor the assembled payload may contain it.
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment({
				hiddenStateCheckpointJson: '{"TOP_SECRET":"the_hidden_deck_order"}',
			})]]]),
		});

		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		const snapshot = built.context.chat.recentMessages.find((m) => m.id === "msg_1")!.experienceReports![0];
		// The snapshot has no hidden field at all.
		expect(JSON.stringify(snapshot)).not.toContain("TOP_SECRET");
		expect(JSON.stringify(snapshot)).not.toContain("hidden");

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const payloadStr = JSON.stringify(result.prompt.finalPayload);
		expect(payloadStr).not.toContain("TOP_SECRET");
		expect(payloadStr).not.toContain("hidden_deck");
	});

	it("summary path reads identical report values (same buildPipelineContext)", async () => {
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment()]]]),
		});

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m", summary: true });
		const payloadStr = JSON.stringify(result.prompt.finalPayload);
		expect(payloadStr).toContain("[Experience report — Tic-Tac-Toe");
		expect(payloadStr).toContain("X played center");
	});

	it("no bound attachment → no report block in payload (absence no-op)", async () => {
		const service = makeExperienceService();

		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const userMsg = (result.prompt.finalPayload as { messages: Array<{ messageId?: string; content: string }> }).messages
			.find((m) => m.messageId === "msg_1");
		expect(userMsg!.content).toBe("I make my move.");
		expect(userMsg!.content).not.toContain("[Experience report");
	});

	it("skips a malformed publicEventsJson without crashing (graceful degradation)", async () => {
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment({
				publicEventsJson: "{not valid json",
			})]]]),
		});

		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		// Malformed → skipped: no experienceReports on the message, no crash.
		const userMsg = built.context.chat.recentMessages.find((m) => m.id === "msg_1");
		expect(userMsg!.experienceReports).toBeUndefined();
	});

	it("skips a publicEventsJson with the wrong shape (title not a string)", async () => {
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment({
				publicEventsJson: JSON.stringify({ events: [] }), // no title
			})]]]),
		});

		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(built.context.chat.recentMessages.find((m) => m.id === "msg_1")!.experienceReports).toBeUndefined();
	});

	it("parses the report envelope (title/summary/events) into the snapshot", async () => {
		const service = makeExperienceService({
			attachmentsByMessage: new Map([["msg_1", [makeStoreAttachment({
				sessionRevision: 7,
				publicEventsJson: JSON.stringify({
					title: "Durak",
					events: [
						{ type: "deal" },
						{ type: "attack", detail: { card: "Ace of Trumps" } },
					],
				}),
			})]]]),
		});

		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		const snapshot = built.context.chat.recentMessages.find((m) => m.id === "msg_1")!.experienceReports![0];
		expect(snapshot.title).toBe("Durak");
		expect(snapshot.summary).toBeUndefined();
		expect(snapshot.sessionRevision).toBe(7);
		expect(snapshot.events).toHaveLength(2);
		expect(snapshot.events[0]).toEqual({ type: "deal" });
		expect(snapshot.events[1]).toEqual({ type: "attack", detail: { card: "Ace of Trumps" } });
	});
});

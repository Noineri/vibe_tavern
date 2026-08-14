/**
 * IR-42 (Wave 4): experience context-capture service tests.
 *
 * Full-path through the REAL DB (temp SQLite via createStoreContainer) and the
 * REAL session lifecycle (ExperienceService.startSession). The provider-profile
 * resolution, the chat-lifecycle summary-prompt seam, and the provider execute
 * call are injected seams — the summary PROMPT CONSTRUCTION is ChatSummaryService's
 * boundary (tested separately), so here we verify the context service's MODE
 * orchestration, frontier capture, the compact-summary generation flow, and the
 * "summary never automatic" invariant.
 *
 * Pins (per the plan self-check): all five context modes; branch frontier;
 * cancel (aborted signal → cancelled, previous bundle intact); no-provider
 * (unresolvable provider → typed Unprocessable, no crash); and summary-never-
 * automatic (chat_summaries byte-untouched after a compact_summary capture).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import type { AssemblePromptResponse, ChatBranchId, ExperienceCapability, ExperienceContextMode, StoredProviderProfileRecord } from "@vibe-tavern/domain";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";
import {
	ExperienceContextService,
	type ExperienceChatLifecycleSeam,
} from "../src/domain/interactive/experience-context-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { DomainError } from "../src/shared/errors.js";

// ─── A no-capability counter game (only needs a startable session) ───────────
const COUNTER_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [{ capability: "rp_context", reason: "context tests" }],
  create() { return { count: 0 }; },
  project(c) { return { count: c.state.count }; },
  actions() { return [{ type: "inc" }]; },
  reduce(c, a) { return { state: { count: c.state.count + 1 }, status: "active", events: [] }; },
});
`;

// ─── Setup ───────────────────────────────────────────────────────────────────

let stores: StoreContainer;
let resources: ExperienceResourceService;
let experienceService: ExperienceService;

beforeEach(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-xctx-svc-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	resources = new ExperienceResourceService(stores);
	experienceService = new ExperienceService(stores, resources, { generateSeed: () => "seed" });
});

async function seedSession(opts: { contextMode?: ExperienceContextMode; messages?: number; summaries?: number; grants?: ExperienceCapability[] } = {}) {
	const contextMode = opts.contextMode ?? "none";
	const character = await stores.characters.create({ name: "Aria", description: "Fire mage." } as never);
	const chat = await stores.chats.createChat({ characterId: character.id, title: "T" } as never);
	const branchId = chat.activeBranchId as string;
	await stores.personas.create({ name: "Olya", description: "Scholar.", defaultForNewChats: true } as never);
	const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: COUNTER_SOURCE } as never);
	await resources.updateConfig(chat.id, {
		enabled: true,
		scriptId: script.id,
		capabilityGrants: opts.grants ?? ["rp_context"],
		contextMode,
	} as never);

	const msgCount = opts.messages ?? 4;
	for (let i = 0; i < msgCount; i++) {
		await stores.messages.addMessage({
			chatId: chat.id,
			branchId,
			role: i % 2 === 0 ? "user" : "assistant",
			authorType: i % 2 === 0 ? "user" : "character",
			content: `msg-${i}`,
		});
	}
	for (let s = 0; s < (opts.summaries ?? 0); s++) {
		await stores.chatSummaries.create({
			chatId: chat.id,
			branchId,
			label: `R${s}`,
			content: `recap-${s}`,
			summarizedFrom: 1,
			summarizedTo: 2,
			includeInContext: true,
			excludeSummarized: false,
			source: "manual",
		} as never);
	}

	const started = await experienceService.startSession({ chatId: chat.id, branchId, settings: {}, participants: [] });
	if (!started.ok) throw new Error(`startSession failed: ${started.error.code}`);
	return { chatId: chat.id, branchId, sessionId: started.data.sessionId };
}

// ─── Mock seams ──────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
	return {
		id: "pp1",
		name: "Test",
		providerPreset: "ollama",
		coauthorTransport: "openai" as never,
		endpoint: "http://x",
		apiKey: null,
		defaultModel: "test-model",
		contextBudget: 8000,
		pinContextBudget: false,
		bindPerModel: false,
		modelFreeOnly: false,
		modelGroupByOwner: false,
		maxTokens: 4096,
		temperature: 1,
		topP: 1,
		topK: 0,
		minP: 0,
		topA: 0,
		typicalP: 1,
		tfsZ: 1,
		repeatLastN: 0,
		mirostat: 0,
		mirostatTau: 5,
		mirostatEta: 0.1,
		dryMultiplier: 0,
		dryBase: 0,
		dryAllowedLength: 0,
		drySequenceBreakers: [],
		xtcThreshold: 0,
		xtcProbability: 0,
		frequencyPenalty: 0,
		presencePenalty: 0,
		repetitionPenalty: 1,
		stopSequences: [],
		logitBias: [],
		seed: null,
		reasoningEffort: "medium",
		showReasoning: false,
		streamResponse: true,
		customSamplers: false,
		proxyMode: "off" as never,
		proxyId: null,
		isActive: true,
		visionModel: null,
		createdAt: "2024-01-01T00:00:00Z",
		updatedAt: "2024-01-01T00:00:00Z",
		...overrides,
	};
}

function minimalPrompt(): AssemblePromptResponse {
	return {
		layers: [],
		tokenAccounting: {},
		activatedLoreEntries: [],
		scriptInjections: [],
		retrievedMemories: [],
		finalPayload: { messages: [] },
		prefill: null,
	};
}

interface MockSeams {
	profile?: StoredProviderProfileRecord | null;
	execute?: (input: { signal?: AbortSignal }) => Promise<{ text: string }>;
	chatLifecycle?: ExperienceChatLifecycleSeam;
}

function makeContextService(seams: MockSeams = {}) {
	const profile = seams.profile === undefined ? makeProfile() : seams.profile;
	const providerProfiles: Pick<ProviderProfileService, "resolveActiveProviderProfile" | "getProviderProfile" | "getProviderModelSettings"> = {
		resolveActiveProviderProfile: async () => profile,
		getProviderProfile: async (id: string) => (profile?.id === id ? profile : null),
		getProviderModelSettings: async () => null,
	};
	const chatLifecycle: ExperienceChatLifecycleSeam = seams.chatLifecycle ?? {
		assembleSummaryPrompt: async () => ({ prompt: minimalPrompt(), branchId: "b" as ChatBranchId }),
	};
	const execute = seams.execute ?? (async () => ({ text: "A compact recap of the scene." }));
	return new ExperienceContextService({
		stores,
		providerProfiles: providerProfiles as ProviderProfileService,
		chatLifecycle,
		execute: execute as never,
	});
}

function parseVariants(json: string | null): { messages: Array<{ id: string; role: string; content: string }>; summaries: Array<{ id: string; content: string }> } {
	return json ? JSON.parse(json) : { messages: [], summaries: [] };
}

// ─── Tests: context modes ────────────────────────────────────────────────────

describe("ExperienceContextService — context modes", () => {
	test("none → empty bundle (no messages, no identity)", async () => {
		const { sessionId } = await seedSession({ contextMode: "none", messages: 4 });
		const svc = makeContextService();
		const row = await svc.captureContext({ sessionId });
		expect(row.mode).toBe("none");
		const frozen = parseVariants(row.variantsJson);
		expect(frozen.messages).toEqual([]);
		expect(frozen.summaries).toEqual([]);
		expect(row.characterSnapshotJson).toBeNull();
		expect(row.personaSnapshotJson).toBeNull();
		expect(row.compactSummaryJson).toBeNull();
		expect(row.messageFrontierPosition).toBeNull();
	});

	test("current_branch → ALL messages + included summaries + identity", async () => {
		const { sessionId } = await seedSession({ contextMode: "current_branch", messages: 5, summaries: 2 });
		const svc = makeContextService();
		const row = await svc.captureContext({ sessionId });
		expect(row.mode).toBe("current_branch");
		const frozen = parseVariants(row.variantsJson);
		// All 5 messages (no windowing).
		expect(frozen.messages.length).toBe(5);
		expect(frozen.messages.map((m) => m.content)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
		// Both included summaries.
		expect(frozen.summaries.length).toBe(2);
		// Identity frozen.
		expect(JSON.parse(row.characterSnapshotJson!).name).toBe("Aria");
		expect(JSON.parse(row.personaSnapshotJson!).name).toBe("Olya");
	});

	test("recent → windowed messages, NO summaries, identity present", async () => {
		const { sessionId } = await seedSession({ contextMode: "recent", messages: 10, summaries: 3 });
		const svc = makeContextService();
		// Force a small window.
		const row = await svc.captureContext({ sessionId, recentMessageLimit: 3 });
		const frozen = parseVariants(row.variantsJson);
		expect(frozen.messages.length).toBe(3);
		expect(frozen.messages.map((m) => m.content)).toEqual(["msg-7", "msg-8", "msg-9"]);
		expect(frozen.summaries).toEqual([]);
		expect(row.characterSnapshotJson).not.toBeNull();
	});

	test("summaries_recent → included summaries + windowed messages + identity", async () => {
		const { sessionId } = await seedSession({ contextMode: "summaries_recent", messages: 6, summaries: 2 });
		const svc = makeContextService();
		const row = await svc.captureContext({ sessionId, recentMessageLimit: 2 });
		const frozen = parseVariants(row.variantsJson);
		expect(frozen.messages.length).toBe(2);
		expect(frozen.summaries.length).toBe(2);
	});

	test("compact_summary → generated summary + recent window + summaries + identity; provider/model recorded", async () => {
		const { sessionId } = await seedSession({ contextMode: "compact_summary", messages: 5, summaries: 1 });
		let executeCalls = 0;
		const svc = makeContextService({
			execute: async () => {
				executeCalls++;
				return { text: "  A compact recap.  " };
			},
		});
		const row = await svc.captureContext({ sessionId, recentMessageLimit: 2 });
		expect(executeCalls).toBe(1);
		const frozen = parseVariants(row.variantsJson);
		// recent window (2) + 1 existing summary + 1 generated compact summary.
		expect(frozen.messages.length).toBe(2);
		expect(frozen.summaries.length).toBe(2);
		expect(frozen.summaries.some((s) => s.content === "A compact recap.")).toBe(true);
		expect(row.compactSummaryJson).not.toBeNull();
		expect(JSON.parse(row.compactSummaryJson!).content).toBe("A compact recap.");
		expect(row.providerProfileId).toBe("pp1");
		expect(row.modelId).toBe("test-model");
	});

	test("mode override: capture with a different mode than the session default", async () => {
		const { sessionId } = await seedSession({ contextMode: "none", messages: 3 });
		const svc = makeContextService();
		const row = await svc.captureContext({ sessionId, mode: "current_branch" });
		expect(row.mode).toBe("current_branch");
		expect(parseVariants(row.variantsJson).messages.length).toBe(3);
	});
});

// ─── Tests: branch frontier ──────────────────────────────────────────────────

describe("ExperienceContextService — branch frontier", () => {
	test("messageFrontierPosition = last message position (0-based) at capture", async () => {
		const { sessionId } = await seedSession({ contextMode: "current_branch", messages: 4 });
		const svc = makeContextService();
		const row = await svc.captureContext({ sessionId });
		// 4 messages at positions 0..3 → frontier = 3.
		expect(row.messageFrontierPosition).toBe(3);
	});

	test("re-capture after new messages advances the frontier (upsert, one row)", async () => {
		const { sessionId, branchId, chatId } = await seedSession({ contextMode: "current_branch", messages: 2 });
		const svc = makeContextService();
		await svc.captureContext({ sessionId });
		await stores.messages.addMessage({ chatId, branchId, role: "user", authorType: "user", content: "msg-2" });
		const row2 = await svc.captureContext({ sessionId });
		expect(row2.messageFrontierPosition).toBe(2);
		// Still exactly one row for the session (upsert).
		const direct = await stores.experiences.getContextBundle(sessionId);
		expect(direct?.id).toBe(row2.id);
	});
});

// ─── Tests: cancel + no-provider ─────────────────────────────────────────────

describe("ExperienceContextService — compact_summary failure modes", () => {
	test("cancel: an aborted signal → cancelled error, no bundle persisted", async () => {
		const { sessionId } = await seedSession({ contextMode: "compact_summary", messages: 3 });
		const svc = makeContextService({
			execute: async () => { throw new Error("aborted"); },
		});
		const controller = new AbortController();
		controller.abort();
		let caught: unknown;
		try {
			await svc.captureContext({ sessionId, signal: controller.signal });
		} catch (e) { caught = e; }
		expect(caught).toBeInstanceOf(DomainError);
		expect((caught as DomainError).kind).toBe("Cancelled");
		// No bundle row persisted.
		expect(await stores.experiences.getContextBundle(sessionId)).toBeNull();
	});

	test("cancel: previous bundle survives a failed re-capture", async () => {
		const { sessionId } = await seedSession({ contextMode: "compact_summary", messages: 3 });
		const svc = makeContextService();
		const first = await svc.captureContext({ sessionId });
		// Re-capture with an aborted signal → previous bundle intact.
		const controller = new AbortController();
		controller.abort();
		await expect(svc.captureContext({ sessionId, signal: controller.signal })).rejects.toBeDefined();
		const after = await stores.experiences.getContextBundle(sessionId);
		expect(after?.id).toBe(first.id);
		expect(after?.updatedAt).toBe(first.updatedAt);
	});

	test("no-provider: unresolvable active provider → Unprocessable(no_provider), no crash", async () => {
		const { sessionId } = await seedSession({ contextMode: "compact_summary", messages: 3 });
		const svc = makeContextService({ profile: null });
		let caught: unknown;
		try {
			await svc.captureContext({ sessionId });
		} catch (e) { caught = e; }
		expect(caught).toBeInstanceOf(DomainError);
		expect((caught as DomainError).kind).toBe("Unprocessable");
		expect((caught as DomainError).details?.code).toBe("no_provider");
		expect(await stores.experiences.getContextBundle(sessionId)).toBeNull();
	});

	test("empty provider output → Validation error, no bundle persisted", async () => {
		const { sessionId } = await seedSession({ contextMode: "compact_summary", messages: 3 });
		const svc = makeContextService({ execute: async () => ({ text: "   " }) });
		await expect(svc.captureContext({ sessionId })).rejects.toMatchObject({ kind: "Validation" });
		expect(await stores.experiences.getContextBundle(sessionId)).toBeNull();
	});
});

// ─── Tests: summary never automatic ──────────────────────────────────────────

describe("ExperienceContextService — summary never automatic", () => {
	test("compact_summary capture does NOT write to chat_summaries", async () => {
		const { sessionId, branchId } = await seedSession({ contextMode: "compact_summary", messages: 4, summaries: 1 });
		const { chatId } = await chatIdForSession(sessionId);
		const before = await stores.chatSummaries.listByChatBranch(chatId, branchId);
		const svc = makeContextService();
		await svc.captureContext({ sessionId });
		// The chat_summaries table is byte-untouched: same rows, same contents.
		const after = await stores.chatSummaries.listByChatBranch(chatId, branchId);
		expect(after).toEqual(before);
	});

	test("non-compact modes never call the provider execute seam", async () => {
		const { sessionId } = await seedSession({ contextMode: "summaries_recent", messages: 4 });
		let executeCalls = 0;
		const svc = makeContextService({ execute: async () => { executeCalls++; return { text: "x" }; } });
		await svc.captureContext({ sessionId });
		expect(executeCalls).toBe(0);
	});
});

// ─── Tests: load round-trip ──────────────────────────────────────────────────

describe("ExperienceContextService — load + reconstruct", () => {
	test("loadBundle reconstructs the frozen bundle verbatim (no budget trim)", async () => {
		const { sessionId } = await seedSession({ contextMode: "current_branch", messages: 3, summaries: 1 });
		const svc = makeContextService();
		await svc.captureContext({ sessionId });
		const bundle = await svc.loadBundle(sessionId);
		expect(bundle).not.toBeNull();
		if (!bundle) return;
		expect(bundle.messages.length).toBe(3);
		expect(bundle.summaries.length).toBe(1);
		expect(bundle.character?.name).toBe("Aria");
		expect(bundle.persona?.name).toBe("Olya");
		// No budget applied at load → verbatim, nothing trimmed.
		expect(bundle.droppedMessages).toEqual([]);
		expect(bundle.compactionSummary).toBeNull();
	});

	test("getContextBundle returns null for a session that was never captured", async () => {
		const { sessionId } = await seedSession({ contextMode: "none", messages: 0 });
		const svc = makeContextService();
		expect(await svc.getContextBundle(sessionId)).toBeNull();
	});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function chatIdForSession(sessionId: string): Promise<{ chatId: string }> {
	const session = await stores.experiences.getSessionById(sessionId);
	if (!session) throw new Error("session not found");
	return { chatId: session.chatId };
}

// ─── Tests: user-chosen RP-context source (report item 6) ────────────────────

describe("ExperienceContextService — context source (report item 6)", () => {
	/** A second character + chat with its own branch history and one summary. */
	async function seedSourceChat(): Promise<{ characterId: string; chatId: string; branchId: string }> {
		const character = await stores.characters.create({ name: "Mila", description: "Rival spy." } as never);
		const chat = await stores.chats.createChat({ characterId: character.id, title: "Source" } as never);
		const branchId = chat.activeBranchId as string;
		for (let i = 0; i < 3; i++) {
			await stores.messages.addMessage({
				chatId: chat.id,
				branchId,
				role: i % 2 === 0 ? "user" : "assistant",
				authorType: i % 2 === 0 ? "user" : "character",
				content: `src-${i}`,
			});
		}
		await stores.chatSummaries.create({
			chatId: chat.id,
			branchId,
			label: "S0",
			content: "source-recap",
			summarizedFrom: 1,
			summarizedTo: 2,
			includeInContext: true,
			excludeSummarized: false,
			source: "manual",
		} as never);
		return { characterId: character.id, chatId: chat.id, branchId };
	}

	test("ambient capture: provenance null, host identity (baseline unchanged)", async () => {
		const { sessionId } = await seedSession({ contextMode: "recent", messages: 4 });
		const row = await makeContextService().captureContext({ sessionId });
		expect(row.sourceChatId).toBeNull();
		expect(row.sourceCharacterId).toBeNull();
		const character = row.characterSnapshotJson ? JSON.parse(row.characterSnapshotJson) : null;
		expect(character?.name).toBe("Aria");
		const persona = row.personaSnapshotJson ? JSON.parse(row.personaSnapshotJson) : null;
		expect(persona?.name).toBe("Olya");
	});

	test("config-pinned chat source: source history + summaries + its character; persona stays host", async () => {
		const source = await seedSourceChat();
		const { chatId: hostChatId, sessionId } = await seedSession({ contextMode: "summaries_recent", messages: 4 });
		await resources.updateConfig(hostChatId, { contextSourceChatId: source.chatId });
		const row = await makeContextService().captureContext({ sessionId });
		const variants = parseVariants(row.variantsJson);
		expect(variants.messages.map((m) => m.content)).toEqual(["src-0", "src-1", "src-2"]);
		expect(variants.summaries.some((s) => s.content === "source-recap")).toBe(true);
		const character = row.characterSnapshotJson ? JSON.parse(row.characterSnapshotJson) : null;
		expect(character?.name).toBe("Mila");
		const persona = row.personaSnapshotJson ? JSON.parse(row.personaSnapshotJson) : null;
		expect(persona?.name).toBe("Olya");
		expect(row.sourceChatId).toBe(source.chatId);
		expect(row.sourceCharacterId).toBe(source.characterId);
	});

	test("explicit capture override beats the config columns; explicit null clears back to ambient", async () => {
		const source = await seedSourceChat();
		const { chatId: hostChatId, sessionId } = await seedSession({ contextMode: "recent", messages: 4 });
		// Config pins a character-only source; the capture overrides with the chat source.
		await resources.updateConfig(hostChatId, { contextSourceCharacterId: source.characterId });
		const overridden = await makeContextService().captureContext({ sessionId, contextSourceChatId: source.chatId });
		expect(parseVariants(overridden.variantsJson).messages.map((m) => m.content)).toEqual(["src-0", "src-1", "src-2"]);
		expect(overridden.sourceChatId).toBe(source.chatId);

		// Explicit null on the capture clears the config source → ambient host history.
		const cleared = await makeContextService().captureContext({ sessionId, contextSourceChatId: null, contextSourceCharacterId: null });
		expect(parseVariants(cleared.variantsJson).messages.map((m) => m.content)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
		expect(cleared.sourceChatId).toBeNull();
		expect(cleared.sourceCharacterId).toBeNull();
	});

	test("character-only source: host history, overridden identity", async () => {
		const source = await seedSourceChat();
		const { sessionId } = await seedSession({ contextMode: "recent", messages: 4 });
		const row = await makeContextService().captureContext({ sessionId, contextSourceCharacterId: source.characterId });
		expect(parseVariants(row.variantsJson).messages.map((m) => m.content)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
		const character = row.characterSnapshotJson ? JSON.parse(row.characterSnapshotJson) : null;
		expect(character?.name).toBe("Mila");
		expect(row.sourceChatId).toBeNull();
		expect(row.sourceCharacterId).toBe(source.characterId);
	});

	test("explicit character beats the source chat's own card", async () => {
		const source = await seedSourceChat();
		const third = await stores.characters.create({ name: "Third", description: "Wildcard." } as never);
		const { sessionId } = await seedSession({ contextMode: "recent", messages: 4 });
		const row = await makeContextService().captureContext({
			sessionId,
			contextSourceChatId: source.chatId,
			contextSourceCharacterId: third.id,
		});
		expect(parseVariants(row.variantsJson).messages.map((m) => m.content)).toEqual(["src-0", "src-1", "src-2"]);
		const character = row.characterSnapshotJson ? JSON.parse(row.characterSnapshotJson) : null;
		expect(character?.name).toBe("Third");
		expect(row.sourceCharacterId).toBe(third.id);
	});

	test("dangling explicit source chat: NotFound, previous bundle intact", async () => {
		const { sessionId } = await seedSession({ contextMode: "recent", messages: 4 });
		const svc = makeContextService();
		const first = await svc.captureContext({ sessionId });
		let caught: unknown;
		try {
			await svc.captureContext({ sessionId, contextSourceChatId: "no-such-chat" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(DomainError);
		expect((caught as DomainError).kind).toBe("NotFound");
		const after = await stores.experiences.getContextBundle(sessionId);
		expect(after?.sourceChatId).toBe(first.sourceChatId);
		expect(after?.messageFrontierPosition).toBe(first.messageFrontierPosition);
	});

	test("compact_summary summarizes the SOURCE chat, not the host chat", async () => {
		const source = await seedSourceChat();
		const { sessionId } = await seedSession({ contextMode: "compact_summary", messages: 4 });
		const seenChatIds: string[] = [];
		const svc = makeContextService({
			chatLifecycle: {
				assembleSummaryPrompt: async (input) => {
					seenChatIds.push(input.chatId);
					return { prompt: minimalPrompt(), branchId: "b" as ChatBranchId };
				},
			},
		});
		const row = await svc.captureContext({ sessionId, contextSourceChatId: source.chatId });
		expect(seenChatIds).toEqual([source.chatId]);
		expect(row.compactSummaryJson).toBeTruthy();
		expect(row.sourceChatId).toBe(source.chatId);
	});
});

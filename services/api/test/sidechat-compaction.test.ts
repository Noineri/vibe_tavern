/**
 * Sidechat compaction (SIDECHAT_PLAN, Wave 2 / SC-8c) — the `sidechat-ooc`
 * kind's own discussion digest.
 *
 * Service level (`SidechatOocCompactionService` through the injected executor
 * seam — no `mock.module("ai")`, the script-compaction suite's pattern):
 * - the summarizer call carries the `sidechat_ooc_digest` service prompt
 *   (SC-8b's key through SC-8a's ladder: profile override else asset) and the
 *   shared digest samplers;
 * - the boundary never cuts a question from its answer (the keep side never
 *   starts on an assistant reply whose user message was summarized);
 * - the summarizer transcript carries the summarized span's frozen RP events
 *   interleaved by seq, marked as reference beside the OOC rows;
 * - the AUTO rule measures the discussion against the room left after the
 *   static context and the RP layer, reusing the shell's 80 % threshold
 *   (AUTO_COMPACT_THRESHOLD — never a re-declared number).
 *
 * Adapter level: a sidechat thread's MANUAL compaction dispatches through the
 * sidechat service (before SC-8c the route refused the kind with
 * AGENT_KIND_NOT_WIRED — the characterization this unit flips, basis: the
 * SC-8c plan row).
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { createDb, ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type {
	ExperienceCopilotMessage,
	ExperienceCopilotStore,
	ExperienceCopilotThread,
	StoreContainer,
} from "@vibe-tavern/db";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import type { AgentThreadTimelineEntry } from "@vibe-tavern/db";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { AUTO_COMPACT_THRESHOLD } from "../src/domain/agent/agent-compaction.js";
import { SidechatOocCompactionService } from "../src/domain/sidechat/sidechat-compaction.js";
import { getServicePromptAssetFile } from "../src/domain/service-prompts/service-prompt-registry.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";
import { COPILOT_COMPACT_MAX_OUTPUT_TOKENS, COPILOT_COMPACT_TEMPERATURE } from "../src/domain/interactive/copilot/copilot-limits.js";
// Side-effect imports: register the built-in agent kinds so the adapter's
// thread-kind resolution holds regardless of which test file the shared
// process loaded first.
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";
import "../src/domain/agent/kinds/sidechat-ooc-kind.js";

/** Distinctive phrases of the sidechat and script summarizer prompts. */
const SIDECHAT_PROMPT_MARKER = "You write the digest of a sidechat";
const SCRIPT_PROMPT_MARKER = "run_script_test";

type Executor = typeof nonstreamingProviderExecute;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeThread(): ExperienceCopilotThread {
	return {
		id: "thread_1",
		scriptId: null,
		draftSessionId: null,
		// A chat-owned sidechat thread (SC-0a owner triple).
		chatId: "chat_1",
		branchId: "branch_1",
		agentKind: "sidechat-ooc",
		title: "Compaction",
		archivedAt: null,
		contextMetrics: null,
		contextLinks: [],
		todo: [],
		lastProviderProfileId: "prov_1",
		lastModel: "model_1",
		autoCompact: true,
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
	};
}

function makeMessage(id: string, role: string, seq: number): ExperienceCopilotMessage {
	return {
		id,
		threadId: "thread_1",
		role,
		content: `${role === "user" ? "Question" : "Answer"} ${id}`,
		toolCallsJson: null,
		toolCallId: null,
		seq,
		createdAt: "2025-01-01T00:00:00.000Z",
	} as ExperienceCopilotMessage;
}

/** A plain user/assistant alternation of `count` messages (ids m1..mN);
 *  odd rows are user (a question), even rows its assistant reply. */
function makeTurnSequence(count: number): ExperienceCopilotMessage[] {
	const out: ExperienceCopilotMessage[] = [];
	for (let i = 1; i <= count; i++) out.push(makeMessage(`m${i}`, i % 2 === 1 ? "user" : "assistant", i * 10));
	return out;
}

/** One frozen `rp_sync` event row (SC-1 store shape) whose payload carries
 *  exactly one RP message with the given marker text — the rendered event
 *  then contains `<rp_message …>MARKER</rp_message>`. */
function makeRpSyncEvent(id: string, seq: number, marker: string) {
	return {
		id,
		threadId: "thread_1",
		seq,
		kind: "rp_sync" as const,
		payload: {
			fromPosition: 0,
			toPosition: 0,
			messages: [
				{ id: `rpm_${id}`, position: 0, role: "assistant", authorName: null, variantId: null, text: marker },
			],
		},
		createdAt: "2025-01-01T00:00:00.000Z",
		rowType: "event" as const,
	};
}

function makeStore(
	thread: ExperienceCopilotThread,
	initial: ExperienceCopilotMessage[],
	events: Array<ReturnType<typeof makeRpSyncEvent>> = [],
) {
	const messages = [...initial];
	const appended: ExperienceCopilotMessage[] = [];
	const store = {
		async getById() { return thread; },
		async listMessages() { return [...messages]; },
		async listTimeline() {
			// The merged timeline (SC-1): message + event rows interleaved by
			// seq ascending. Digest rows the service appends join as message
			// rows exactly as the real store's listTimeline does.
			const entries: Array<Record<string, unknown>> = [
				...messages.map((m) => ({ rowType: "message", ...m })),
				...events,
			];
			entries.sort((a, b) => {
				const sa = (a.seq as number | null) ?? -Infinity;
				const sb = (b.seq as number | null) ?? -Infinity;
				if (sa !== sb) return sa - sb;
				return String(a.id) < String(b.id) ? -1 : 1;
			});
			return entries as unknown as AgentThreadTimelineEntry[];
		},
		async appendMessage(_threadId: string, input: { role: string; content?: string; toolCallId?: string | null }) {
			const m = {
				...makeMessage(`digest_${appended.length + 1}`, input.role, messages.length * 10 + events.length + 1),
				content: input.content ?? "",
				toolCallId: input.toolCallId ?? null,
			};
			appended.push(m);
			messages.push(m);
			return m;
		},
		async updateContextMetrics() {},
		async getAutoCompact() { return thread.autoCompact; },
		async setAutoCompact() {},
	} as unknown as ExperienceCopilotStore;
	return { store, appended };
}

/** Full provider profile (the real executor reads sampler fields) with
 *  `bindPerModel:false` so the summary-profile resolution stays on the
 *  identity path. */
function makeProviderProfile(endpoint: string) {
	return {
		id: "prov_1",
		name: "Test",
		providerPreset: "openai",
		coauthorTransport: "chatCompletions",
		endpoint,
		apiKey: "sk-test",
		defaultModel: "model_1",
		contextBudget: null,
		pinContextBudget: false,
		bindPerModel: false,
		modelFreeOnly: false,
		modelGroupByOwner: false,
		maxTokens: 2000,
		temperature: 0.3,
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
		dryBase: 1.75,
		dryAllowedLength: 2,
		drySequenceBreakers: null,
		xtcThreshold: 0.1,
		xtcProbability: 0,
		frequencyPenalty: 0,
		presencePenalty: 0,
		repetitionPenalty: 1,
		stopSequences: [],
		logitBias: null,
		seed: null,
		reasoningEffort: "auto",
		showReasoning: false,
		streamResponse: true,
		customSamplers: false,
		proxyMode: "inherit",
		proxyId: null,
		isActive: true,
		visionModel: null,
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
	};
}

function makeProviderProfiles(endpoint = "http://127.0.0.1:1/v1") {
	const profile = makeProviderProfile(endpoint);
	return {
		getProviderProfile: async () => profile,
		getProviderModelSettings: async () => null,
	};
}

/** A capturing fake executor: records each call, answers with fixed text. */
function makeExecutor(text = "sidechat digest summary") {
	const calls: Array<Record<string, unknown>> = [];
	const execute = async (input: Record<string, unknown>) => {
		calls.push(input);
		return { text, providerResponse: {} };
	};
	return { calls, execute: execute as unknown as Executor };
}

/** Every message of the summarizer payload as one string. */
function transcriptOf(prompt: Record<string, unknown>): string {
	const payload = prompt.finalPayload as { messages: Array<{ content: string }> };
	return payload.messages.map((m) => m.content).join("\n");
}

/** The system message of a captured summarizer call (the resolved prompt). */
function systemMessageOf(prompt: Record<string, unknown>): string {
	const payload = prompt.finalPayload as { messages: Array<{ content: string }> };
	return payload.messages[0].content;
}

/** In-memory db with the Default profile, optionally an active profile
 *  carrying service-prompt overrides (the sp5-service-prompts fixture
 *  pattern). */
async function setupDb(overrides?: Record<string, string>) {
	const db = await createDb(":memory:");
	const profileStore = new ServicePromptProfileStore(db);
	const uiSettings = new UiSettingsStore(db);
	await profileStore.ensureDefaultServicePromptProfile();
	if (overrides) {
		const profile = await profileStore.createServicePromptProfile({ name: "SC-8c", overrides });
		await uiSettings.update({ activeServicePromptProfileId: profile.id });
	}
	return db;
}

beforeEach(() => {
	setTokenCountFn((text) => text.length);
});

afterAll(() => {
	setTokenCountFn(() => 0);
});

// ─── Service level: the summarizer prompt ────────────────────────────────────

describe("SidechatOocCompactionService - summarizer call", () => {
	it("carries the sidechat digest prompt (not the script one) and the shared samplers", async () => {
		const { store, appended } = makeStore(makeThread(), makeTurnSequence(20));
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		await service.compact({ threadId: "thread_1" });

		expect(executor.calls).toHaveLength(1);
		const transcript = transcriptOf(executor.calls[0].prompt as Record<string, unknown>);
		expect(transcript).toContain(SIDECHAT_PROMPT_MARKER);
		expect(transcript).not.toContain(SCRIPT_PROMPT_MARKER);
		expect(executor.calls[0].overrideTemperature).toBe(COPILOT_COMPACT_TEMPERATURE);
		expect(executor.calls[0].overrideMaxTokens).toBe(COPILOT_COMPACT_MAX_OUTPUT_TOKENS);
		// The generic mechanism is shared: the digest lands with its anchor.
		expect(appended).toHaveLength(1);
		expect(appended[0].role).toBe("digest");
		expect(appended[0].content).toBe("sidechat digest summary");
	});

	it("without a db handle the summarizer prompt is the bundled asset, byte-identical (SC-8a ladder)", async () => {
		const { store } = makeStore(makeThread(), makeTurnSequence(20));
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		await service.compact({ threadId: "thread_1" });

		expect(getServicePromptAssetFile("sidechat_ooc_digest")).toBe("agent-sidechat/ooc-digest.md");
		const asset = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_digest"));
		expect(asset.length).toBeGreaterThan(0);
		expect(systemMessageOf(executor.calls[0].prompt as Record<string, unknown>)).toBe(asset);
	});

	it("an active-profile `sidechat_ooc_digest` override replaces the summarizer prompt (SC-8a ladder)", async () => {
		const db = await setupDb({ sidechat_ooc_digest: "CUSTOM SIDECHAT DIGEST PROMPT" });
		const { store } = makeStore(makeThread(), makeTurnSequence(20));
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute, db);

		await service.compact({ threadId: "thread_1" });

		expect(systemMessageOf(executor.calls[0].prompt as Record<string, unknown>)).toBe("CUSTOM SIDECHAT DIGEST PROMPT");
	});
});

// ─── Service level: the boundary ─────────────────────────────────────────────

describe("SidechatOocCompactionService - the keep boundary", () => {
	it("never cuts a question from its answer — the keep side starts on a user row", async () => {
		// 21 messages (m1 user … m21 user): the shell's raw cursor is 13
		// (m14, an ASSISTANT reply — its question m13 would be summarized
		// while the answer stayed verbatim). The sidechat refinement walks
		// back to m13, a user row, so the pair is kept together.
		const { store, appended } = makeStore(makeThread(), makeTurnSequence(21));
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		await service.compact({ threadId: "thread_1" });

		expect(appended).toHaveLength(1);
		expect(appended[0].toolCallId).toBe("m13");
		// The summarized prefix is a whole question/answer run: m1..m12
		// (6 pairs, ending on m12's ANSWER), never m13's question without
		// its answer.
		const transcript = transcriptOf(executor.calls[0].prompt as Record<string, unknown>);
		expect(transcript).toContain("Question m11");
		expect(transcript).toContain("Answer m12");
		expect(transcript).not.toContain("Question m13");
	});
});

// ─── Service level: the summarizer transcript ────────────────────────────────

describe("SidechatOocCompactionService - the transcript carries the span's RP events", () => {
	it("interleaves the span's frozen RP events by seq, marked [rp-reference], beside the OOC rows", async () => {
		// Timeline: evt_A (before m1 — the discussion starts against it),
		// m1..m20, evt_B between m10 and m11 (inside the span), evt_C after
		// the keep boundary m13 (OUTSIDE — the verbatim tail's own event,
		// still riding the model window, never the summarizer's material).
		const events = [
			makeRpSyncEvent("evt_a", 5, "RP-EVENT-A-MARKER"),
			makeRpSyncEvent("evt_b", 105, "RP-EVENT-B-MARKER"),
			makeRpSyncEvent("evt_c", 135, "RP-EVENT-C-MARKER"),
		];
		const { store } = makeStore(makeThread(), makeTurnSequence(20), events);
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		await service.compact({ threadId: "thread_1" });

		const transcript = transcriptOf(executor.calls[0].prompt as Record<string, unknown>);
		// The span's events ride as REFERENCE rows, marked and rendered as
		// their frozen XML.
		expect(transcript).toContain("[rp-reference] <rp_sync from=");
		expect(transcript).toContain("RP-EVENT-A-MARKER");
		expect(transcript).toContain("RP-EVENT-B-MARKER");
		// Outside the span: the tail's event never reaches the summarizer.
		expect(transcript).not.toContain("RP-EVENT-C-MARKER");
		// Interleaving by seq: evt_A precedes the FIRST OOC row, evt_B sits
		// between m10's and m11's rows (not after the whole OOC block).
		const lines = transcript.split("\n");
		const idxA = lines.findIndex((l) => l.includes("RP-EVENT-A-MARKER"));
		const idxM1 = lines.findIndex((l) => l.includes("Question m1"));
		const idxB = lines.findIndex((l) => l.includes("RP-EVENT-B-MARKER"));
		const idxM10 = lines.findIndex((l) => l.includes("Answer m10"));
		const idxM11 = lines.findIndex((l) => l.includes("Question m11"));
		expect(idxA).toBeGreaterThanOrEqual(0);
		expect(idxM1).toBeGreaterThanOrEqual(0);
		expect(idxB).toBeGreaterThanOrEqual(0);
		expect(idxM10).toBeGreaterThanOrEqual(0);
		expect(idxM11).toBeGreaterThanOrEqual(0);
		expect(idxA).toBeLessThan(idxM1);
		expect(idxB).toBeGreaterThan(idxM10);
		expect(idxB).toBeLessThan(idxM11);
	});

	it("a re-compaction's span starts at the prior digest's anchor — no re-folded reference, no gap", async () => {
		// First compaction over m1..m20 with evt_A (pre-m1) folds the span
		// [timeline start, m13). The re-compaction's span starts at its
		// to-summarize head (the prior anchor) — evt_A is NOT repeated.
		const events = [makeRpSyncEvent("evt_a", 5, "RP-EVENT-A-MARKER")];
		const { store } = makeStore(makeThread(), makeTurnSequence(20), events);
		const executor = makeExecutor("first digest");
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		await service.compact({ threadId: "thread_1" });
		expect(transcriptOf(executor.calls[0].prompt as Record<string, unknown>)).toContain("RP-EVENT-A-MARKER");

		// Grow the thread past the keep window again, then re-compact: the
		// prior digest's text rides the «Prior compacted context» section and
		// evt_A (already folded as reference) is not re-fed.
		const store2 = store as unknown as {
			listMessages: () => Promise<ExperienceCopilotMessage[]>;
		};
		const grown = [...await store2.listMessages()];
		for (let i = 21; i <= 30; i++) {
			grown.push(makeMessage(`m${i}`, i % 2 === 1 ? "user" : "assistant", i * 10));
		}
		(store as unknown as { listMessages: () => Promise<ExperienceCopilotMessage[]> }).listMessages =
			async () => [...grown];
		const executor2 = makeExecutor("second digest");
		const service2 = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor2.execute);

		await service2.compact({ threadId: "thread_1" });

		const transcript = transcriptOf(executor2.calls[0].prompt as Record<string, unknown>);
		expect(transcript).toContain("first digest");
		expect(transcript).toContain("# Prior compacted context");
		expect(transcript).not.toContain("RP-EVENT-A-MARKER");
	});
});

// ─── Service level: the auto rule (the discussion against its room) ──────────

describe("SidechatOocCompactionService - auto-compaction rule (SC-8c)", () => {
	it("a large RP layer with a small discussion does not trigger auto-compaction", async () => {
		// A room of 100 left after the static context and a LARGE RP layer,
		// with a 30-token discussion: under the SHELL's whole-budget rule the
		// thread's total sits far past 80 % of the budget (the RP layer alone
		// fills it) and would fire after EVERY exchange; the sidechat rule
		// measures the discussion against the room it has and skips.
		const { store } = makeStore(makeThread(), makeTurnSequence(20));
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		await service.autoCompactAfterSidechatTurn("thread_1", { discussionTokens: 30, roomTokens: 100 });

		expect(executor.calls).toHaveLength(0);
	});

	it("fires when the discussion reaches the shell's threshold of its room", async () => {
		const { store, appended } = makeStore(makeThread(), makeTurnSequence(20));
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		// Exactly AUTO_COMPACT_THRESHOLD × room (the shell's own number,
		// imported — the test never re-declares 0.8 either): >= fires.
		await service.autoCompactAfterSidechatTurn("thread_1", {
			discussionTokens: AUTO_COMPACT_THRESHOLD * 100,
			roomTokens: 100,
		});

		expect(executor.calls).toHaveLength(1);
		expect(appended).toHaveLength(1);
		expect(appended[0].content).toBe("sidechat digest summary");
	});

	it("skips when no room is left (static + RP layer fill the budget) — the every-turn paid-call loop", async () => {
		const { store } = makeStore(makeThread(), makeTurnSequence(20));
		const executor = makeExecutor();
		const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);

		await service.autoCompactAfterSidechatTurn("thread_1", { discussionTokens: 50, roomTokens: 0 });
		await service.autoCompactAfterSidechatTurn("thread_1", { discussionTokens: 50, roomTokens: -10 });

		expect(executor.calls).toHaveLength(0);
	});

	it("skips when toggled off or with no last-used pair (the shell's own gates)", async () => {
		// Toggle off.
		{
			const thread = makeThread();
			thread.autoCompact = false;
			const { store } = makeStore(thread, makeTurnSequence(20));
			const executor = makeExecutor();
			const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);
			await service.autoCompactAfterSidechatTurn("thread_1", { discussionTokens: 90, roomTokens: 100 });
			expect(executor.calls).toHaveLength(0);
		}
		// No last-used pair.
		{
			const thread = makeThread();
			thread.lastProviderProfileId = null;
			thread.lastModel = null;
			const { store } = makeStore(thread, makeTurnSequence(20));
			const executor = makeExecutor();
			const service = new SidechatOocCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, executor.execute);
			await service.autoCompactAfterSidechatTurn("thread_1", { discussionTokens: 90, roomTokens: 100 });
			expect(executor.calls).toHaveLength(0);
		}
	});
});

// ─── Adapter level: the manual compact dispatch ──────────────────────────────

/** Local stand-in for the provider's chat-completions endpoint: records each
 *  request body and answers with a fixed non-streaming completion. */
const requestBodies: string[] = [];
const providerServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		requestBodies.push(await req.text());
		return Response.json({
			id: "chatcmpl-test",
			object: "chat.completion",
			created: 0,
			model: "model_1",
			choices: [{ index: 0, message: { role: "assistant", content: "sidechat digest from provider" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
	},
});

describe("ExperienceCopilotAdapter.experienceCopilotCompact - a sidechat thread (SC-8c)", () => {
	beforeEach(() => {
		requestBodies.length = 0;
	});

	it("manual compact dispatches through the SIDECHAT service (was: AGENT_KIND_NOT_WIRED — basis: the SC-8c plan row)", async () => {
		// Characterization BEFORE SC-8c: this exact call refused the kind
		// with AGENT_KIND_NOT_WIRED (compactionKinds had no sidechat entry).
		// Now the table carries the sidechat service and the manual «Сжать»
		// works for the kind.
		const { store } = makeStore(makeThread(), makeTurnSequence(20));
		const stores = { experienceCopilot: store } as unknown as StoreContainer;
		const providerProfiles = makeProviderProfiles(`http://127.0.0.1:${providerServer.port}/v1`);
		const adapter = new ExperienceCopilotAdapter(stores, providerProfiles as unknown as ProviderProfileService);

		const result = await adapter.experienceCopilotCompact("thread_1", {});

		expect(result.digest.role).toBe("digest");
		expect(result.digest.content).toBe("sidechat digest from provider");
		expect(requestBodies).toHaveLength(1);
		expect(requestBodies[0]).toContain(SIDECHAT_PROMPT_MARKER);
		expect(requestBodies[0]).not.toContain(SCRIPT_PROMPT_MARKER);
	});
});

afterAll(async () => {
	await providerServer.stop(true);
});

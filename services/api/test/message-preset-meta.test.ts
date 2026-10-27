import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventBus } from "@vibe-tavern/domain";
import type { ChatId, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";

/**
 * End-to-end characterization for the message-meta preset behavior.
 *
 * The ordinary send path persists the resolved model and preset name through
 * appendAssistantReply. The Resend paths use the same append boundary without
 * creating a user message, so these tests drive their real orchestrator
 * methods and assert the persisted variant metadata and prompt trace.
 */
async function createTestRuntime() {
	const tmpDir = resolve(tmpdir(), "vt-preset-meta-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "TestBot",
		description: "a probe character",
		firstMessage: "Hello there!",
	});
	return {
		runtime,
		chatId: created.activeChatId as ChatId,
		stores,
		cleanup: async () => {
			try {
				await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			} catch (error) {
				if ((error as { code?: unknown }).code !== "EBUSY") throw error;
			}
		},
	};
}

const resendProfile = {
	id: "resend-profile",
	name: "Resend profile",
	providerPreset: "openai",
	coauthorTransport: "chatCompletions",
	generationMode: "chat",
	endpoint: "https://provider.example/v1",
	apiKey: "key",
	defaultModel: "resend-model",
	contextBudget: 16000,
	pinContextBudget: false,
	tokenPadding: 0,
	bindPerModel: false,
	modelFreeOnly: false,
	modelGroupByOwner: false,
	maxTokens: 512,
	stopSequences: [],
	bannedStrings: [],
	logitBias: [],
	seed: null,
	showReasoning: false,
	streamResponse: true,
	customSamplers: false,
	proxyMode: "inherit",
	proxyId: null,
} as StoredProviderProfileRecord;

function makeResendOrchestrator(
	runtime: SessionRuntime,
	executors: {
		nonstreaming: typeof nonstreamingProviderExecute;
		stream: typeof streamProviderExecutor;
	},
): LiveChatOrchestrator {
	const strategy: ChatModeStrategy = {
		mode: "rp",
		resolveProvider: async () => ({ profile: resendProfile, model: "resend-model" }),
		onMessageAppended: () => {},
		assemble: async () => { throw new Error("Reply generation does not invoke strategy assembly"); },
	};
	return new LiveChatOrchestrator(
		runtime.chatRuntime,
		runtime.chatApp,
		null!,
		new EventBus(),
		async () => strategy,
		undefined,
		undefined,
		executors,
	);
}

async function* streamReply(text: string) {
	yield { type: "text-delta" as const, delta: text };
}

describe("message meta records resolved preset on reply paths", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterAll(async () => { await Promise.all(cleanups.map(cleanup => cleanup())); });

	it("send path records the resolved preset on the reply variant", async () => {
		const ctx = await createTestRuntime();
		const { runtime, chatId, stores } = ctx;
		cleanups.push(ctx.cleanup);
		const chat = (await stores.chats.getById(chatId))!;
		const expectedPresetId = chat.promptPresetId;
		expect(expectedPresetId).toBeTruthy();
		const expectedPresetName = (await stores.presets.getById(expectedPresetId as string))?.name;
		expect(expectedPresetName).toBeTruthy();

		await runtime.chatRuntime.prepareLiveTurn(chatId, "Hello!", "test-model");
		const appended = await runtime.chatRuntime.appendAssistantReply(chatId, "Hi there!", 42);
		const response = appended.response;
		expect(appended.branchId).toBe(chat.activeBranchId);
		expect(appended.messageId).toBeTruthy();

		const reply = response.messages[response.messages.length - 1];
		expect(appended.messageId).toBe(reply.id);
		expect(reply).toBeTruthy();
		expect(reply.role).toBe("assistant");
		const selected = (await stores.messages.getVariants(reply.id)).find(variant => variant.isSelected === 1 || variant.variantIndex === 0)!;
		expect(selected.modelId).toBe("test-model");
		expect(selected.presetName).toBe(expectedPresetName);
	});

	it("resend reply records its resolved model, preset, and prompt trace", async () => {
		const ctx = await createTestRuntime();
		const { runtime, chatId, stores } = ctx;
		cleanups.push(ctx.cleanup);
		const chat = (await stores.chats.getById(chatId))!;
		const expectedPresetName = (await stores.presets.getById(chat.promptPresetId as string))!.name;
		const orchestrator = makeResendOrchestrator(runtime, {
			nonstreaming: async () => ({ text: "Resent reply", providerResponse: {} }),
			stream: async () => { throw new Error("Streaming executor is not used by this test"); },
		});

		const result = await orchestrator.generateReply({ chatId, profile: resendProfile, model: "resend-model" });
		const reply = result.snapshot.messages[result.snapshot.messages.length - 1]!;
		const selected = (await stores.messages.getVariants(reply.id)).find(variant => variant.isSelected === 1 || variant.variantIndex === 0)!;
		const traces = await stores.traces.getTracesByChat(chatId, undefined, reply.id);

		expect(selected.modelId).toBe("resend-model");
		expect(selected.presetName).toBe(expectedPresetName);
		expect(traces).toHaveLength(1);
		expect(traces[0]!.model).toBe("resend-model");
		expect(traces[0]!.presetName).toBe(expectedPresetName);
	});

	it("streamed resend reply records its resolved model, preset, and prompt trace", async () => {
		const ctx = await createTestRuntime();
		const { runtime, chatId, stores } = ctx;
		cleanups.push(ctx.cleanup);
		const chat = (await stores.chats.getById(chatId))!;
		const expectedPresetName = (await stores.presets.getById(chat.promptPresetId as string))!.name;
		const orchestrator = makeResendOrchestrator(runtime, {
			nonstreaming: async () => { throw new Error("Non-streaming executor is not used by this test"); },
			stream: async () => ({
				stream: streamReply("Streamed resent reply"),
				finished: Promise.resolve({ finishReason: "stop" }),
				text: Promise.resolve("Streamed resent reply"),
				reasoning: Promise.resolve(undefined),
				providerResponse: {},
			}),
		});

		for await (const _event of orchestrator.generateReplyStream({ chatId, profile: resendProfile, model: "resend-model" })) {
			// Consuming the real SSE generator reaches its append-on-final boundary.
		}
		const snapshot = await runtime.getSnapshot(chatId);
		const reply = snapshot.messages[snapshot.messages.length - 1]!;
		const selected = (await stores.messages.getVariants(reply.id)).find(variant => variant.isSelected === 1 || variant.variantIndex === 0)!;
		const traces = await stores.traces.getTracesByChat(chatId, undefined, reply.id);

		expect(selected.modelId).toBe("resend-model");
		expect(selected.presetName).toBe(expectedPresetName);
		expect(traces).toHaveLength(1);
		expect(traces[0]!.model).toBe("resend-model");
		expect(traces[0]!.presetName).toBe(expectedPresetName);
	});
});

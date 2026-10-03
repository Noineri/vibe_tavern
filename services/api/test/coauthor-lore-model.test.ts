import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { CreateLoreDelegateDeps } from "../src/domain/coauthor/lore/lore-delegate.js";

function makeProfile(overrides: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
	return {
		id: "prof_active",
		name: "Active profile",
		providerPreset: "openai_compat",
		coauthorTransport: "chat_completions",
		endpoint: "https://active.example/v1",
		apiKey: null,
		defaultModel: "active-default",
		contextBudget: 16_000,
		pinContextBudget: false,
		tokenPadding: 0,
		bindPerModel: false,
		maxTokens: 2_000,
		temperature: 1,
		topP: 1,
		topK: 0,
		minP: 0,
		topA: 0,
		typicalP: 1,
		tfsZ: 1,
		adaptiveTarget: -1,
		adaptiveDecay: 0.9,
		dynatempRange: 0,
		dynatempExponent: 1,
		topNSigma: 0,
		smoothingFactor: 0,
		repeatLastN: 0,
		mirostat: 0,
		mirostatTau: 5,
		mirostatEta: 0.1,
		dryMultiplier: 0,
		dryBase: 1.75,
		dryAllowedLength: 2,
		drySequenceBreakers: [],
		dryPenaltyLastN: -1,
		bannedStrings: [],
		xtcThreshold: 0.1,
		xtcProbability: 0,
		frequencyPenalty: 0,
		presencePenalty: 0,
		repetitionPenalty: 1,
		stopSequences: [],
		logitBias: [],
		seed: null,
		reasoningEffort: "auto",
		showReasoning: false,
		streamResponse: true,
		customSamplers: false,
		proxyMode: "inherit",
		proxyId: null,
		isActive: true,
		visionModel: null,
		createdAt: "2026-10-03",
		updatedAt: "2026-10-03",
		...overrides,
	};
}

async function createTestRuntime(captures: CreateLoreDelegateDeps[]): Promise<{
	runtime: SessionRuntime;
	chatId: string;
	coauthorProfileId: string;
	stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	cleanup: () => Promise<void>;
}> {
	const dataDir = resolve(tmpdir(), `vt-coauthor-lore-model-${crypto.randomUUID()}`);
	await mkdir(dataDir, { recursive: true });
	const stores = await createRuntimeStore(dataDir);
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const activeProfile = makeProfile({
		temperature: 1.7,
		maxTokens: 9_000,
		contextBudget: 500_000,
		reasoningEffort: "high",
	});
	const coauthorProfile = await stores.providers.create({
		name: "Co-Author connection",
		providerPreset: "openai_compat",
		endpoint: "https://coauthor.example/v1",
		defaultModel: "coauthor-profile-default",
	});
	await stores.coauthorSettings.upsert(coauthorProfile.id, {
		modelName: "coauthor-connection-model",
		settings: { temperature: 0.23, maxTokens: 1_200, contextBudget: 24_000, reasoningEffort: "low" },
	});
	await stores.uiSettings.update({ coauthorProviderId: coauthorProfile.id });
	const runtime = new SessionRuntime(stores, {
		getActiveProviderProfile: async () => activeProfile,
		createLoreDelegate: (deps) => {
			captures.push(deps);
			return async () => ({ content: "unused" });
		},
	});
	const character = await runtime.character.createFromScratch({
		name: "Lore model probe",
		description: "A characterization fixture.",
		firstMessage: "Hello.",
	});
	const coauthor = await runtime.chatLifecycle.createChatForCharacter(character.snapshot.character!.id, "coauthor");
	captures.length = 0;
	return {
		runtime,
		chatId: coauthor.activeChat.id,
		coauthorProfileId: coauthorProfile.id,
		stores,
		cleanup: async () => {
			try {
				await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			} catch (error) {
				if (isResourceBusyError(error)) return;
				throw error;
			}
		},
	};
}

function isResourceBusyError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
}

async function assembleCoauthorTurn(runtime: SessionRuntime, chatId: string): Promise<void> {
	await runtime.chatRuntime.prepareLiveTurn(chatId as never, "", "coauthor-turn-model");
}

describe("Co-Author lore model delegation", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterAll(async () => {
		await Promise.all(cleanups.map((cleanup) => cleanup()));
	});

	it("unset lore pair uses the Co-Author connection settings and model", async () => {
		const captures: CreateLoreDelegateDeps[] = [];
		const ctx = await createTestRuntime(captures);
		cleanups.push(ctx.cleanup);

		await assembleCoauthorTurn(ctx.runtime, ctx.chatId);

		expect(captures).toHaveLength(1);
		expect(captures[0]!.profile.id).toBe(ctx.coauthorProfileId);
		expect(captures[0]!.model).toBe("coauthor-connection-model");
		expect(captures[0]!.profile.temperature).toBe(0.23);
		expect(captures[0]!.profile.maxTokens).toBe(1_200);
		expect(captures[0]!.profile.contextBudget).toBe(24_000);
		expect(captures[0]!.profile.reasoningEffort).toBe("low");
	});

	it("uses the lore connection's Co-Author settings with the configured lore model", async () => {
		const captures: CreateLoreDelegateDeps[] = [];
		const ctx = await createTestRuntime(captures);
		cleanups.push(ctx.cleanup);
		const loreProfile = await ctx.stores.providers.create({
			name: "Lore profile",
			providerPreset: "openai_compat",
			endpoint: "https://lore.example/v1",
			defaultModel: "lore-default",
		});
		await ctx.stores.coauthorSettings.upsert(loreProfile.id, {
			modelName: "lore-connection-model",
			settings: { temperature: 0.44, maxTokens: 2_400, contextBudget: 48_000, reasoningEffort: "medium" },
		});
		await ctx.stores.uiSettings.update({
			coauthorLoreProviderId: loreProfile.id,
			coauthorLoreModelName: "lore-model",
		});

		await assembleCoauthorTurn(ctx.runtime, ctx.chatId);

		expect(captures).toHaveLength(1);
		expect(captures[0]!.profile.id).toBe(loreProfile.id);
		expect(captures[0]!.model).toBe("lore-model");
		expect(captures[0]!.profile.temperature).toBe(0.44);
		expect(captures[0]!.profile.maxTokens).toBe(2_400);
		expect(captures[0]!.profile.contextBudget).toBe(48_000);
		expect(captures[0]!.profile.reasoningEffort).toBe("medium");
	});

	it("falls back to the Co-Author connection when the configured lore provider is gone", async () => {
		const captures: CreateLoreDelegateDeps[] = [];
		const ctx = await createTestRuntime(captures);
		cleanups.push(ctx.cleanup);
		await ctx.stores.uiSettings.update({
			coauthorLoreProviderId: "prof_deleted",
			coauthorLoreModelName: "lore-model",
		});

		await assembleCoauthorTurn(ctx.runtime, ctx.chatId);

		expect(captures).toHaveLength(1);
		expect(captures[0]!.profile.id).toBe(ctx.coauthorProfileId);
		expect(captures[0]!.model).toBe("coauthor-connection-model");
		expect(captures[0]!.profile.temperature).toBe(0.23);
		expect(captures[0]!.profile.maxTokens).toBe(1_200);
		expect(captures[0]!.profile.contextBudget).toBe(24_000);
		expect(captures[0]!.profile.reasoningEffort).toBe("low");
	});
});

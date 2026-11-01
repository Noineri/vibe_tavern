import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import {
	createStoreContainer,
	type ProviderProfile,
	type StoreContainer,
} from "@vibe-tavern/db";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { CopilotProfileResolver } from "../src/domain/interactive/copilot/copilot-profile-resolver.js";
import {
	streamSidechatTurn,
	type SidechatStreamDeps,
} from "../src/domain/sidechat/sidechat-stream.js";

/**
 * DR-2 (owner ruling M1) — the model-resolution precedence, pinned through
 * the REAL `streamSidechatTurn` over the REAL SC-0f profile chain (chat
 * choice → kind default → the kind's built-in seed), with the provider
 * boundary faked through the deps' injectable `streamText` (the same fake
 * pattern sidechat-ooc-stream.test.ts uses) and everything below it REAL.
 * The effective pair is read from the thread row's persisted last-used pair
 * (`updateContextMetrics`) — the same value the stream's compaction fallback
 * reads.
 *
 * The one-line chain: the RESOLVED profile's own model when set → the
 * request's pair (the kind binding the client derived) → the provider's
 * default model. Pinned:
 *
 * 1. no own model stored → the request's pair exactly (the characterization
 *    anchor: zero behavior change without stored data);
 * 2. own model set on the RESOLVED profile → the turn runs on the own pair,
 *    overriding the request's pair (and the null model means the OWN
 *    provider's default, never the request's model);
 * 3. a DANGLING own-model provider falls through to the request's pair
 *    (the house dangling-id policy — no error);
 * 4. the row is keyed by the profile the chain actually RESOLVED: a row on
 *    `builtin` does not apply to a thread resolving `builtin-director`, and
 *    one on `builtin-director` does — including a USER profile reached
 *    through the chat's own choice.
 */

// ─── Provider fixtures (id-keyed — the dangling test needs per-id lookups) ───

function makeProviderProfile(id: string, defaultModel: string): ProviderProfile {
	return {
		id,
		name: `Test ${id}`,
		providerPreset: "openai",
		coauthorTransport: "chatCompletions",
		endpoint: "http://test",
		apiKey: "key",
		defaultModel,
		contextBudget: null,
		pinContextBudget: false,
		bindPerModel: false,
		maxTokens: 2000,
		temperature: 0.3,
		proxyMode: "inherit",
		proxyId: null,
		isActive: true,
	} as unknown as ProviderProfile;
}

const REQUEST_PROVIDER = makeProviderProfile("prov_req", "req-default");
const OWN_PROVIDER = makeProviderProfile("prov_own", "own-default");
const PROVIDERS: Record<string, ProviderProfile> = {
	[REQUEST_PROVIDER.id]: REQUEST_PROVIDER,
	[OWN_PROVIDER.id]: OWN_PROVIDER,
	// NOTE: "prov_gone" is deliberately absent — the dangling case.

	// The request pair the turns below send (the client-derived kind binding).
};

function makeFakeStreamTextResult(parts: unknown[]): Record<string, unknown> {
	async function* gen(): AsyncGenerator<unknown, void, unknown> {
		for (const p of parts) yield p;
	}
	return {
		stream: gen(),
		finishReason: Promise.resolve("stop"),
		usage: Promise.resolve(undefined),
	};
}

// ─── Real-container harness ──────────────────────────────────────────────────

let stores: StoreContainer;
let deps: SidechatStreamDeps;
let characterId: string;

beforeAll(async () => {
	// Deterministic token counting for the assembly's estimates (the sibling
	// sidechat suite's pattern) — restored to the inert default in afterAll.
	setTokenCountFn((text) => text.length);
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-own-model-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	await stores.personas.create({
		name: "Sable",
		description: "A wandering cartographer.",
		pronouns: "she/her",
		defaultForNewChats: true,
	});
	const character = await stores.characters.create({
		name: "Theron",
		description: "A brooding ranger.",
	});
	characterId = character.id;
	const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));
	const assembly = new PromptAssemblyService(stores, resolver, stores.content.fileStore);
	const profileResolver = new CopilotProfileResolver(stores);
	deps = {
		store: stores.experienceCopilot,
		// SC-12: the shared plan store's READ seam — the stream's contract
		// requires it (the production wiring, real store).
		agentPlans: stores.agentPlans,
		sync: {
			chats: stores.chats,
			messages: stores.messages,
			assembly,
			experienceCopilot: stores.experienceCopilot,
		},
		context: {
			chats: stores.chats,
			characters: stores.characters,
			messages: stores.messages,
			traces: stores.traces,
			chatSummaries: stores.chatSummaries,
			experienceCopilot: stores.experienceCopilot,
			// DR-4b: the branch-plan read for the <story_plan> section.
			agentPlans: stores.agentPlans,
			presets: stores.presets,
			assembly,
		},
		attach: {
			chats: stores.chats,
			messages: stores.messages,
			assembly,
			experienceCopilot: stores.experienceCopilot,
		},
		// Per-id lookups over the fixture map — "prov_gone" resolves null, the
		// dangling case's whole fixture.
		getProviderProfile: async (id) => PROVIDERS[id] ?? null,
		getEffectiveProviderProfile: async (id) => {
			const profile = PROVIDERS[id];
			if (!profile) throw new Error(`test fixture: unexpected provider '${id}'`);
			return profile;
		},
		resolveModel: () => ({}) as LanguageModel,
		// The REAL SC-0f chain — no settings rows exist, so every turn resolves
		// the kind's first built-in seed unless a test pins a chat choice.
		resolveProfileForChat: (thread) =>
			profileResolver.resolveForChat(thread.chatId, thread.agentKind),
		// The adapter's provider-deps wiring verbatim (the ONE source every
		// kind's stream deps reads in production).
		getAgentOwnModel: (profile) =>
			stores.agentProfileModels.get(profile.agentKind, profile.id),
		db: stores.db,
		streamText: (() =>
			makeFakeStreamTextResult([{ type: "text-delta", text: "ok" }])) as unknown as SidechatStreamDeps["streamText"],
	};
});

beforeEach(async () => {
	// The own-model rows are keyed globally by (kind, profile id) — reset the
	// built-in keys so each test starts with no own model set (fresh chats and
	// user profiles need no reset: their ids are per-test).
	await stores.agentProfileModels.clear("sidechat-ooc", "builtin");
	await stores.agentProfileModels.clear("sidechat-ooc", "builtin-director");
});

afterAll(() => {
	// Restore the process-global token counter (shared api test process).
	setTokenCountFn(() => 0);
});

/** A fresh chat + a chat-owned sidechat thread on it. */
async function makeSidechatThread(): Promise<{ threadId: string; chatId: string }> {
	const chat = await stores.chats.createChat({
		characterId,
		title: "DR-2 model-resolution fixture",
	});
	const thread = await stores.experienceCopilot.startNewChatSession(
		chat.id,
		chat.activeBranchId,
		"sidechat-ooc",
	);
	return { threadId: thread.id, chatId: chat.id };
}

/** Run one turn with the REQUEST pair (the client-derived kind binding) and
 *  return the thread's persisted last-used provider/model — the effective
 *  pair the turn actually ran on. */
async function runTurn(threadId: string): Promise<{ provider: string | null; model: string | null }> {
	const chunks: Array<{ event: string; data: string }> = [];
	for await (const chunk of streamSidechatTurn(
		{ threadId, content: "hello", providerProfileId: REQUEST_PROVIDER.id, model: "req-model" },
		deps,
	)) {
		chunks.push(chunk);
	}
	expect(chunks.some((chunk) => chunk.event === "finish")).toBe(true);
	const thread = await stores.experienceCopilot.getById(threadId);
	if (!thread) throw new Error("fixture: thread missing after turn");
	return { provider: thread.lastProviderProfileId, model: thread.lastModel };
}

// ─── 1. No own model stored: exactly today's resolution ──────────────────────

describe("agent own model — no stored row (characterization anchor)", () => {
	it("the turn runs on the request's pair, byte-identically", async () => {
		const { threadId } = await makeSidechatThread();
		expect(await runTurn(threadId)).toEqual({ provider: "prov_req", model: "req-model" });
	});
});

// ─── 2. The own model wins ───────────────────────────────────────────────────

describe("agent own model — precedence (M1)", () => {
	it("the resolved profile's own model overrides the request's pair", async () => {
		await stores.agentProfileModels.set("sidechat-ooc", "builtin", {
			providerProfileId: OWN_PROVIDER.id,
			modelName: "own-model",
		});
		const { threadId } = await makeSidechatThread();
		expect(await runTurn(threadId)).toEqual({ provider: "prov_own", model: "own-model" });
	});

	it("a null modelName means the OWN provider's default, never the request's model", async () => {
		await stores.agentProfileModels.set("sidechat-ooc", "builtin", {
			providerProfileId: OWN_PROVIDER.id,
			modelName: null,
		});
		const { threadId } = await makeSidechatThread();
		expect(await runTurn(threadId)).toEqual({ provider: "prov_own", model: "own-default" });
	});
});

// ─── 3. Dangling provider: fall through to the chain ─────────────────────────

describe("agent own model — dangling provider id", () => {
	it("falls through to the request's pair, never errors", async () => {
		await stores.agentProfileModels.set("sidechat-ooc", "builtin", {
			providerProfileId: "prov_gone",
			modelName: "gone-model",
		});
		const { threadId } = await makeSidechatThread();
		expect(await runTurn(threadId)).toEqual({ provider: "prov_req", model: "req-model" });
	});
});

// ─── 4. The RESOLVED profile keys the row ────────────────────────────────────

describe("agent own model — keyed by the resolved profile", () => {
	it("a row on `builtin` does not apply while the chat resolves `builtin-director`", async () => {
		await stores.agentProfileModels.set("sidechat-ooc", "builtin", {
			providerProfileId: OWN_PROVIDER.id,
			modelName: "own-model",
		});
		const { threadId, chatId } = await makeSidechatThread();
		await stores.chatAgentSettings.patch(chatId, "sidechat-ooc", { profileId: "builtin-director" });
		expect(await runTurn(threadId)).toEqual({ provider: "prov_req", model: "req-model" });
	});

	it("a row on `builtin-director` applies when the chat resolves it", async () => {
		await stores.agentProfileModels.set("sidechat-ooc", "builtin-director", {
			providerProfileId: OWN_PROVIDER.id,
			modelName: "director-model",
		});
		const { threadId, chatId } = await makeSidechatThread();
		await stores.chatAgentSettings.patch(chatId, "sidechat-ooc", { profileId: "builtin-director" });
		expect(await runTurn(threadId)).toEqual({ provider: "prov_own", model: "director-model" });
	});

	it("a USER profile's own model applies through the chat's own choice", async () => {
		const profile = await stores.copilotProfiles.create({
			name: "Custom director",
			basePrompt: "You direct.",
			toolSet: {},
			agentKind: "sidechat-ooc",
		});
		await stores.agentProfileModels.set("sidechat-ooc", profile.id, {
			providerProfileId: OWN_PROVIDER.id,
			modelName: "custom-model",
		});
		const { threadId, chatId } = await makeSidechatThread();
		await stores.chatAgentSettings.patch(chatId, "sidechat-ooc", { profileId: profile.id });
		expect(await runTurn(threadId)).toEqual({ provider: "prov_own", model: "custom-model" });
	});
});

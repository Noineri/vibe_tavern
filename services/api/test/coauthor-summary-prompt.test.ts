import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { resolveSummaryPrompt, summaryPromptKeyForChatMode } from "../src/domain/prompt/summary-prompt.js";
import { ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import {
	SERVICE_PROMPT_FIELD_KEYS,
	CHAT_MODE,
	type ChatMode,
	type AssemblePromptResponse,
} from "@vibe-tavern/domain";
import { SERVICE_PROMPT_ASSET_FILES } from "../src/domain/service-prompts/service-prompt-registry.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";

/**
 * SC-8d — a summary prompt of its own for co-author chats.
 *
 * Pins, at the level the owner asked for ("a co-author chat's summary call
 * carries the new prompt, an RP chat's the old one"):
 *   - the key/asset/label-list facts (registry mapping, list placement next
 *     to coauthor_base, the asset's authoring-session rules by key phrase);
 *   - the MODE ROUTING through the real runtime: a co-author chat's ranged
 *     summary call ends with the `coauthor_summary` instruction as its final
 *     user message, an RP chat's with `summary` — byte-identical to
 *     resolveSummaryPrompt's default;
 *   - override scoping: an existing user override of `summary` keeps applying
 *     to RP chats only; a `coauthor_summary` override reaches co-author chats.
 *
 * The chat-mode strategy seam is exercised end-to-end (real SessionRuntime +
 * real strategies + real db) because the mode decision lives in the routing,
 * not in a helper a unit test could green on its own.
 */

let capturedPrompt: AssemblePromptResponse | null = null;

function makeExecute(): typeof nonstreamingProviderExecute {
	return async ({ prompt }) => {
		capturedPrompt = prompt;
		return { text: "A summary." } as Awaited<ReturnType<typeof nonstreamingProviderExecute>>;
	};
}

/** Minimal provider-profiles double for the summary executor seam — the
 *  ChatSummaryService ctor takes the ProviderProfileService class, so the
 *  test-local stub needs one structural cast (the neighboring
 *  chat-summary-assembly suite casts at the same boundary). */
function makeProfiles(): ProviderProfileService {
	return {
		getProviderProfile: async () => ({
			id: "profile_1",
			providerPreset: "openai",
			apiKey: "test-key",
			defaultModel: "summary-model",
			bindPerModel: false,
		}),
		getProviderModelSettings: async () => null,
	} as unknown as ProviderProfileService;
}

interface Env {
	runtime: SessionRuntime;
	stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	characterId: string;
	service: ChatSummaryService;
	cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
	const tmpDir = resolve(tmpdir(), "vt-sc8d-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "SummaryProbe",
		description: "a probe character",
		firstMessage: "Hi!",
	});
	const seedChat = await stores.chats.getById(created.activeChatId);
	const service = new ChatSummaryService(
		stores,
		runtime,
		makeProfiles(),
		null,
		makeExecute(),
	);
	return {
		runtime,
		stores,
		characterId: seedChat!.characterId as string,
		service,
		cleanup: async () => {
			try {
				await rm(tmpDir, { recursive: true, force: true });
			} catch {
				/* best-effort scratch cleanup */
			}
		},
	};
}

/** The final user message the summary call reshaped onto the prompt. */
function finalInstruction(captured: AssemblePromptResponse): { role: string; content: string; layerId?: string } {
	const messages = (captured.finalPayload as { messages: Array<{ role: string; content: string; layerId?: string }> })
		.messages;
	return messages[messages.length - 1]!;
}

describe("SC-8d co-author summary prompt — key/asset facts", () => {
	test("the registry maps coauthor_summary to the coauthor summary asset", () => {
		expect(SERVICE_PROMPT_ASSET_FILES.coauthor_summary).toBe("coauthor/summary.md");
	});

	test("the key sits in the shared list right after coauthor_base", () => {
		expect(SERVICE_PROMPT_FIELD_KEYS.indexOf("coauthor_summary")).toBe(
			SERVICE_PROMPT_FIELD_KEYS.indexOf("coauthor_base") + 1,
		);
	});

	test("summaryPromptKeyForChatMode: coauthor → coauthor_summary, every other mode → summary", () => {
		expect(summaryPromptKeyForChatMode(CHAT_MODE.coauthor)).toBe("coauthor_summary");
		for (const mode of ["rp", "novel", "group"] as ChatMode[]) {
			expect(summaryPromptKeyForChatMode(mode)).toBe("summary");
		}
	});

	test("the asset is authored for an authoring session, never story continuity", async () => {
		const asset = await loadPromptAsset("coauthor/summary.md");
		expect(asset).toContain("co-author working session");
		expect(asset).toContain("Decisions made");
		expect(asset).toContain("Changes and applied edits");
		expect(asset).toContain("stated preferences");
		expect(asset).toContain("Open work");
		expect(asset).toContain("Never write story continuity");
	});
});

describe("SC-8d co-author summary prompt — mode routing (real runtime)", () => {
	let env: Env | undefined;

	beforeAll(() => {
		env = undefined;
	});
	afterAll(async () => {
		if (env) await env.cleanup();
	});

	test("a co-author chat's summary call carries the coauthor_summary instruction", async () => {
		env = await setupEnv();
		const co = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, "coauthor");

		capturedPrompt = null;
		const result = await env.service.generateChatSummary({
			chatId: co.activeChat.id as string,
			providerProfileId: "profile_1",
			summarizedFrom: 1,
			summarizedTo: 1,
		});
		expect(result.summary).toBe("A summary.");

		const last = finalInstruction(capturedPrompt!);
		expect(last.role).toBe("user");
		expect(last.layerId).toBe("prompt_preset_summary");
		// The authoring prompt, not the RP continuity engine.
		expect(last.content).toContain("co-author working session");
		expect(last.content).not.toContain("continuity engine");
		// The instruction layer is visible in the trace, like the RP path's.
		expect(capturedPrompt!.layers.some((layer) => layer.id === "prompt_preset_summary")).toBe(true);
	});

	test("an RP chat's summary call carries the old summary prompt, byte-identical", async () => {
		const rp = await env!.runtime.chatLifecycle.createChatForCharacter(env!.characterId, "rp");

		capturedPrompt = null;
		await env!.service.generateChatSummary({
			chatId: rp.activeChat.id as string,
			providerProfileId: "profile_1",
			summarizedFrom: 1,
			summarizedTo: 1,
		});

		const last = finalInstruction(capturedPrompt!);
		expect(last.role).toBe("user");
		expect(last.layerId).toBe("prompt_preset_summary");
		// The pipeline's makeLayer trims the instruction; the routed text is
		// byte-identical to the resolver's default for the RP mode.
		expect(last.content).toBe((await resolveSummaryPrompt(env!.stores.db)).trim());
		expect(last.content).not.toContain("co-author working session");
	});

	test("a summary override applies to RP chats only; co-author chats start from the new default", async () => {
		const profileStore = new ServicePromptProfileStore(env!.stores.db);
		const uiSettings = new UiSettingsStore(env!.stores.db);
		const profile = await profileStore.createServicePromptProfile({
			name: "RP summary override",
			overrides: { summary: "MY-RP-SUMMARY-PROMPT" },
		});
		await uiSettings.update({ activeServicePromptProfileId: profile.id });

		// RP chat: the user's «Сводка» override keeps applying.
		const rp = await env!.runtime.chatLifecycle.createChatForCharacter(env!.characterId, "rp");
		capturedPrompt = null;
		await env!.service.generateChatSummary({
			chatId: rp.activeChat.id as string,
			providerProfileId: "profile_1",
			summarizedFrom: 1,
			summarizedTo: 1,
		});
		expect(finalInstruction(capturedPrompt!).content).toBe("MY-RP-SUMMARY-PROMPT");

		// Co-author chat: the RP override does NOT leak; the new default applies.
		const co = await env!.runtime.chatLifecycle.createChatForCharacter(env!.characterId, "coauthor");
		capturedPrompt = null;
		await env!.service.generateChatSummary({
			chatId: co.activeChat.id as string,
			providerProfileId: "profile_1",
			summarizedFrom: 1,
			summarizedTo: 1,
		});
		const coauthorInstruction = finalInstruction(capturedPrompt!).content;
		expect(coauthorInstruction).not.toBe("MY-RP-SUMMARY-PROMPT");
		expect(coauthorInstruction).toContain("co-author working session");
	});

	test("a coauthor_summary override reaches the co-author chat's summary call", async () => {
		const profileStore = new ServicePromptProfileStore(env!.stores.db);
		const uiSettings = new UiSettingsStore(env!.stores.db);
		const profile = await profileStore.createServicePromptProfile({
			name: "Coauthor summary override",
			overrides: { coauthor_summary: "MY-COAUTHOR-SUMMARY-PROMPT" },
		});
		await uiSettings.update({ activeServicePromptProfileId: profile.id });

		const co = await env!.runtime.chatLifecycle.createChatForCharacter(env!.characterId, "coauthor");
		capturedPrompt = null;
		await env!.service.generateChatSummary({
			chatId: co.activeChat.id as string,
			providerProfileId: "profile_1",
			summarizedFrom: 1,
			summarizedTo: 1,
		});
		expect(finalInstruction(capturedPrompt!).content).toBe("MY-COAUTHOR-SUMMARY-PROMPT");
	});
});

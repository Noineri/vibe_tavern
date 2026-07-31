/**
 * Characterization test for seedImportedOpening { withTrace } option
 * (MASS_IMPORT Wave 3 — server-side CPU fix).
 *
 * Pins the contract that eliminates the 68s/card freeze observed in the
 * user's mass-import (see reports/mass-import-bottleneck.md):
 *
 *   - withTrace: false (mass-import path):
 *       • the greeting message IS still seeded (variants preserved),
 *       • assemblePrompt is NOT called (no lore-activation-engine scan),
 *       • no trace is saved for the seeded message.
 *
 *   - withTrace: true (default — interactive createChat / coauthor):
 *       • assemblePrompt runs and a trace IS saved (unchanged behavior).
 *
 * The "no assemblePrompt" half is the load-bearing assertion: it is what
 * stops a single card with a pathological global-lorebook regex from
 * blocking the whole import for 68 seconds. If a refactor re-couples
 * assemblePrompt to the import path, this test fails loudly.
 */
import { describe, it, expect, beforeAll, afterAll, mock, setDefaultTimeout } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type { ChatId } from "@vibe-tavern/domain";

// Every case provisions a fresh SessionRuntime against a real on-disk SQLite
// database, so the fixture alone can outrun Bun's 5-second per-test default on
// Windows CI under parallel runner load — this test timed out at 5.66s in the
// v1.1.0 release run while passing on Linux. The assertions below are about
// call counts, never about elapsed time, so a wider budget removes the flake
// without weakening the gate. Same treatment as message-ai-editor-mutations.
setDefaultTimeout(30_000);

async function createTestRuntime() {
	const tmpDir = resolve(tmpdir(), "vt-seedtrace-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "SeedTraceProbe",
		description: "probe",
		firstMessage: "Greeting #1",
	});
	const seedChat = await stores.chats.getById(created.activeChatId);
	const characterId = seedChat!.characterId;
	return {
		runtime,
		characterId,
		stores,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

type Env = Awaited<ReturnType<typeof createTestRuntime>>;

describe("seedImportedOpening { withTrace } (MASS_IMPORT Wave 3)", () => {
	let env: Env;
	beforeAll(() => setTokenCountFn((text: string) => text.length));
	afterAll(async () => { if (env) await env.cleanup(); });

	it("withTrace: false seeds the greeting but calls NO assemblePrompt and saves NO trace", async () => {
		env = await createTestRuntime();

		// Spy on assemblePrompt via the lifecycle deps. We wrap the existing
		// method to count calls without breaking behavior elsewhere.
		const lifecycle = env.runtime.chatLifecycle as unknown as {
			deps: { assemblePrompt: (chatId: ChatId, branchId: string) => Promise<unknown> };
		};
		const realAssemble = lifecycle.deps.assemblePrompt;
		let assembleCalls = 0;
		lifecycle.deps.assemblePrompt = mock(async (chatId: ChatId, branchId: string) => {
			assembleCalls++;
			return realAssemble(chatId, branchId);
		});

		// Create a fresh chat to seed into (createFromScratch already seeded one;
		// we make a second so we aren't measuring its side effects).
		const fresh = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId);
		const chatId = fresh.activeChat.id as ChatId;
		const chat = await env.stores.chats.getById(chatId);
		const branchId = chat!.activeBranchId as string;

		await env.runtime.chatLifecycle.seedImportedOpening(
			chatId,
			"Hello {{user}}, welcome.",
			["Alt greeting two.", "Alt greeting three."],
			{ withTrace: false },
		);

		// 1. Greeting message WAS seeded.
		const msgs = await env.stores.messages.getMessages(branchId);
		const seeded = msgs.find((m) => m.role === "assistant" && m.content === "Hello {{user}}, welcome.");
		expect(seeded).toBeTruthy();
		// Variants live in a separate table; read them via the dedicated API.
		const seededVariants = await env.stores.messages.getVariants(seeded!.id);
		expect(seededVariants.map((v) => v.content)).toEqual([
			"Hello {{user}}, welcome.",
			"Alt greeting two.",
			"Alt greeting three.",
		]);

		// 2. assemblePrompt was NOT called — this is the regression gate for the
		//    68s/card freeze. If it's called, the lore-activation-engine runs and
		//    the import blows up again.
		expect(assembleCalls).toBe(0);

		// 3. No trace was saved for this seeded message.
		const traces = await env.stores.traces.getTracesByChat(chatId, branchId);
		const traceForSeeded = traces.find((t) => t.messageId === seeded!.id);
		expect(traceForSeeded).toBeUndefined();
	});

	it("withTrace: true (default) still runs assemblePrompt and saves a trace — interactive path unchanged", async () => {
		// Reset the spy from the previous test by getting a fresh runtime.
		const env2 = await createTestRuntime();
		try {
			const lifecycle = env2.runtime.chatLifecycle as unknown as {
				deps: { assemblePrompt: (chatId: ChatId, branchId: string) => Promise<unknown> };
			};
			let assembleCalls = 0;
			const realAssemble = lifecycle.deps.assemblePrompt;
			lifecycle.deps.assemblePrompt = mock(async (chatId: ChatId, branchId: string) => {
				assembleCalls++;
				return realAssemble(chatId, branchId);
			});

			const fresh = await env2.runtime.chatLifecycle.createChatForCharacter(env2.characterId);
			const chatId = fresh.activeChat.id as ChatId;
			const chat = await env2.stores.chats.getById(chatId);
			const branchId = chat!.activeBranchId as string;

			// Default behavior (no opts) — interactive callers rely on this.
			await env2.runtime.chatLifecycle.seedImportedOpening(chatId, "Default-trace greeting.");

			// assemblePrompt ran and a trace was saved.
			expect(assembleCalls).toBe(1);
			const msgs = await env2.stores.messages.getMessages(branchId);
			const seeded = msgs.find((m) => m.content === "Default-trace greeting.");
			const traces = await env2.stores.traces.getTracesByChat(chatId, branchId);
			const traceForSeeded = traces.find((t) => t.messageId === seeded!.id);
			expect(traceForSeeded).toBeTruthy();
		} finally {
			await env2.cleanup();
		}
	});
});

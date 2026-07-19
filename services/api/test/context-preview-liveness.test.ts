/**
 * Context preview liveness.
 *
 * The live context preview used to be embedded in `getSnapshot()` and was
 * historically nulled whenever any prompt trace existed (the trace "shadowed"
 * the live preview). It is now a standalone branch-scoped lazy query
 * (`SessionRuntime.getContextPreview` / POST .../context-preview), decoupled
 * from every navigation/mutation response so switching chats or branches never
 * blocks on prompt assembly. These tests prove the preview stays live,
 * reflects character edits, and rejects a branch that does not belong to the
 * chat — at the same real-runtime + temp-DB boundary as before.
 */
import { describe, it, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { brandId } from "@vibe-tavern/domain";
import type { ChatBranchId, ChatId, CharacterId } from "@vibe-tavern/domain";

/** Spins up a real SessionRuntime against an isolated temp DB and seeds one chat. */
async function createTestRuntime(): Promise<{
	runtime: SessionRuntime;
	chatId: ChatId;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-ctxpv-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "ProbeBot",
		description: "original description",
		firstMessage: "Hello there!",
	});
	return {
		runtime,
		chatId: created.activeChatId,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

describe("Context preview liveness", () => {
	it("getContextPreview is live even when a trace exists", async () => {
		const ctx = await createTestRuntime();
		try {
			const { runtime, chatId } = ctx;

			// Chat creation records a trace for the greeting message, so the
		// branch always has >= 1 trace — the condition that used to null the
		// preview (the bug). The preview is now fetched via the dedicated
		// branch-scoped method, independent of snapshot/trace state.
			const snap = await runtime.getSnapshot(chatId);
			expect(snap.promptTrace).not.toBeNull();
			expect("contextPreview" in snap).toBe(false); // no longer embedded

			const branchId = snap.activeBranch!.id as ChatBranchId;
			const preview = await runtime.getContextPreview(chatId, branchId);
			// Fixed: the preview stays live despite the trace existing.
			expect(preview).not.toBeNull();
			expect(preview!.layers.length).toBeGreaterThan(0);
		} finally {
			await ctx.cleanup();
		}
	});

	it("getContextPreview reflects character edits (liveness)", async () => {
		const ctx = await createTestRuntime();
		try {
			const { runtime, chatId } = ctx;

			const snap = await runtime.getSnapshot(chatId);
			const branchId = snap.activeBranch!.id as ChatBranchId;
			const before = await runtime.getContextPreview(chatId, branchId);
			expect(before).not.toBeNull();
			const characterId = brandId<CharacterId>(snap.character.id);

			// Edit the character's description and re-fetch.
			await runtime.character.update(characterId, {
				description: "edited description PROBE_MARKER",
			});
			const after = await runtime.getContextPreview(chatId, branchId);
			expect(after).not.toBeNull();

			// The assembled prompt must now contain the new description text.
			const beforeRendered = JSON.stringify(before!.layers);
			const afterRendered = JSON.stringify(after!.layers);
			expect(afterRendered).toContain("edited description PROBE_MARKER");
			expect(beforeRendered).not.toContain("edited description PROBE_MARKER");
		} finally {
			await ctx.cleanup();
		}
	});

	it("getContextPreview rejects a branch that does not belong to the chat", async () => {
		const ctx = await createTestRuntime();
		try {
			const { runtime, chatId } = ctx;
			const foreignBranchId = "brnch_does_not_belong" as ChatBranchId;
			// A foreign branchId must surface as a NotFound, not silently assemble
			// the chat's root branch (getChatState's dangling-branch fallback).
			await expect(runtime.getContextPreview(chatId, foreignBranchId)).rejects.toThrow();
		} finally {
			await ctx.cleanup();
		}
	});
});

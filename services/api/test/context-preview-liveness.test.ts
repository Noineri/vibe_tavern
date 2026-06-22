/**
 * Wave A — Context preview liveness.
 *
 * `getSnapshot()` historically nulled `contextPreview` whenever any prompt
 * trace existed for the active branch (the trace "shadowed" the live
 * preview). Because chat creation records a trace for the greeting message,
 * this meant `contextPreview` was null for EVERY chat — not just
 * post-generation. The fix removes the ternary in `getSnapshot`; these tests
 * prove the preview is always live and reflects character edits.
 *
 * See PROMPT_TRACE_PAYLOAD_FIX_PLAN.md, Wave A.
 */
import { describe, it, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { brandId } from "@vibe-tavern/domain";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";

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

describe("Wave A — context preview liveness", () => {
	it("contextPreview is live even when a trace exists", async () => {
		const ctx = await createTestRuntime();
		try {
			const { runtime, chatId } = ctx;

			// Chat creation records a trace for the greeting message, so the
			// branch always has >= 1 trace — the condition that used to null
			// the preview (the bug).
			const snap = await runtime.getSnapshot(chatId);
			expect(snap.promptTrace).not.toBeNull();

			// Fixed: the preview stays live despite the trace existing.
			expect(snap.contextPreview).not.toBeNull();
			expect(snap.contextPreview!.layers.length).toBeGreaterThan(0);
		} finally {
			await ctx.cleanup();
		}
	});

	it("contextPreview reflects character edits (liveness)", async () => {
		const ctx = await createTestRuntime();
		try {
			const { runtime, chatId } = ctx;

			const before = await runtime.getSnapshot(chatId);
			expect(before.contextPreview).not.toBeNull();
			const characterId = brandId<CharacterId>(before.character.id);

			// Edit the character's description and re-fetch.
			await runtime.character.update(characterId, {
				description: "edited description PROBE_MARKER",
			});
			const after = await runtime.getSnapshot(chatId);
			expect(after.contextPreview).not.toBeNull();

			// The assembled prompt must now contain the new description text.
			const beforeRendered = JSON.stringify(before.contextPreview!.layers);
			const afterRendered = JSON.stringify(after.contextPreview!.layers);
			expect(afterRendered).toContain("edited description PROBE_MARKER");
			expect(beforeRendered).not.toContain("edited description PROBE_MARKER");
		} finally {
			await ctx.cleanup();
		}
	});
});

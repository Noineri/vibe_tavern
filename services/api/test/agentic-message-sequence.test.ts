import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";
import type { ExtractedToolCall, ExtractedToolResult } from "../src/infrastructure/ai/provider-execution-types.js";

async function createTestRuntime(): Promise<{
	runtime: SessionRuntime;
	chatId: ChatId;
	stores: Awaited<ReturnType<typeof createRuntimeStore>>;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-ca-seq-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "CoAuthorProbe",
		description: "a probe character",
		firstMessage: "Hello!",
	});
	return {
		runtime,
		chatId: created.activeChatId,
		stores,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

describe("Agentic message sequence persistence (CS-3)", () => {
	let env: Awaited<ReturnType<typeof createTestRuntime>>;
	afterAll(async () => { if (env) await env.cleanup(); });

	it("persists a multi-step tool sequence as separate messages in the branch", async () => {
		env = await createTestRuntime();

		// 1. User message
		await env.runtime.chatApp.appendUserMessage(env.chatId, {
			content: "Can you fix the code and write a test?",
			mode: "reply",
		});

		// 2. Mock reasoning data for 2 tool calls
		const toolCalls: ExtractedToolCall[] = [
			{ toolCallId: "tc_1", toolName: "runCommand", args: { cmd: "fix" } },
			{ toolCallId: "tc_2", toolName: "runCommand", args: { cmd: "test" } },
		];
		const toolResults: ExtractedToolResult[] = [
			{ toolCallId: "tc_1", toolName: "runCommand", args: { cmd: "fix" }, result: "fixed", isError: false },
			{ toolCallId: "tc_2", toolName: "runCommand", args: { cmd: "test" }, result: "tested", isError: false },
		];

		// 3. Append assistant reply (simulates the end of a tool-using run)
		await env.runtime.chatRuntime.appendAssistantReply(env.chatId, "All done!", 100, {
			reasoning: undefined,
			toolCalls,
			toolResults,
		});

		// 4. Fetch the branch and assert message sequence
		const snap = await env.runtime.getSnapshot(env.chatId);
		
		// The seed character has "Hello!" as the first message (index 0).
		// So our new sequence starts at index 1.
		// Total messages: 1 (seed) + 5 = 6 messages.
		expect(snap.messages.length).toBe(6);

		const seq = snap.messages.slice(1);
		expect(seq.length).toBe(5);

		// Message 0: user
		expect(seq[0].role).toBe("user");
		expect(seq[0].content).toBe("Can you fix the code and write a test?");

		// Message 1: assistant (with tool calls)
		expect(seq[1].role).toBe("assistant");
		const assistantVariant = seq[1].variants[seq[1].selectedVariantIndex];
		expect(assistantVariant.content).toBe("");
		expect(assistantVariant.toolCalls).toBeTruthy();
		expect(assistantVariant.toolCalls!.length).toBe(2);
		expect(assistantVariant.toolCalls![0].id).toBe("tc_1");
		expect(assistantVariant.toolCalls![1].id).toBe("tc_2");

		// Message 2: tool (result 1)
		expect(seq[2].role).toBe("tool");
		const tool1Variant = seq[2].variants[seq[2].selectedVariantIndex];
		expect(tool1Variant.content).toBe("fixed");
		expect(tool1Variant.toolCallId).toBe("tc_1");

		// Message 3: tool (result 2)
		expect(seq[3].role).toBe("tool");
		const tool2Variant = seq[3].variants[seq[3].selectedVariantIndex];
		expect(tool2Variant.content).toBe("tested");
		expect(tool2Variant.toolCallId).toBe("tc_2");

		// Message 4: assistant (final text)
		expect(seq[4].role).toBe("assistant");
		const finalVariant = seq[4].variants[seq[4].selectedVariantIndex];
		expect(finalVariant.content).toBe("All done!");
		expect(finalVariant.toolCalls).toBeFalsy();
	});
});

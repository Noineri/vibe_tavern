import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import {
	streamExperienceCopilot,
	type ExperienceCopilotStreamDeps,
} from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import { makeStreamTextDouble, type StreamTextCall } from "./provider-boundary-test-builders.js";

/**
 * AP-30 (AGENT_SHELL_POLISH Wave 7) — the history pin: after an in-place
 * edit, the next real `streamExperienceCopilot` turn hands the provider the
 * edited text and drops the old one (never rebuilding history manually).
 * Exercises digest-less threads and digested threads anchored inside the
 * kept window (an edited kept row reaches the provider while the digest
 * stays lifted into the system prompt and the covered prefix stays absent).
 */

let stores: StoreContainer;
let providerProfileId: string;

beforeAll(async () => {
	setTokenCountFn((text) => text.length);
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-message-edit-history-"));
	stores = await createStoreContainer(join(dataRoot, "edit-history.db"), dataRoot);
	const profile = await stores.providers.create({
		name: "Provider",
		providerPreset: "openai",
		endpoint: "http://provider.test",
		defaultModel: "model",
	});
	providerProfileId = profile.id;
});

afterAll(() => {
	setTokenCountFn(() => 0);
});

async function runNextTurnCapture(
	threadId: string,
	content: string,
): Promise<NonNullable<StreamTextCall["messages"]>> {
	let captured: NonNullable<StreamTextCall["messages"]> = [];
	const deps: ExperienceCopilotStreamDeps = {
		store: stores.experienceCopilot,
		agentPlans: stores.agentPlans,
		getScript: (id) => stores.scripts.getById(id),
		getBoundVisualIds: (id) => stores.scripts.getBoundVisualIds(id),
		getVisual: (id) => stores.experienceResources.getVisualById(id),
		getProviderProfile: (id) => stores.providers.getById(id),
		getEffectiveProviderProfile: async (id) => {
			const profile = await stores.providers.getById(id);
			if (!profile) throw new Error(`fixture: unexpected provider '${id}'`);
			return profile;
		},
		resolveModel: () => ({}) as LanguageModel,
		streamText: makeStreamTextDouble((options) => {
			captured = options.messages ?? [];
			return { parts: [{ type: "text-delta", id: "ap30", text: "ok" }] };
		}, "agent-message-edit-history streamText"),
	};
	const events: string[] = [];
	for await (const ev of streamExperienceCopilot(
		{ threadId, content, providerProfileId, rules: "", visual: "" },
		deps,
	)) {
		events.push(ev.event);
	}
	expect(events).toContain("finish");
	return captured;
}

describe("an edited assistant row reaches the next turn's model history (AP-30)", () => {
	test("digest-less thread: the next turn sends the new text and not the old", async () => {
		const script = await stores.scripts.create({ name: "Plain", code: "", scriptKind: "interactive" });
		const thread = await stores.experienceCopilot.startNewSession(script.id, "T");
		await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		const a1 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "old answer" });

		const result = await stores.experienceCopilot.updateAssistantContent(thread.id, a1.id, "new answer");
		expect(result.status).toBe("edited");

		const sent = await runNextTurnCapture(thread.id, "follow up");
		expect(sent[0]?.role).toBe("system");
		expect(sent.slice(1)).toEqual([
			{ role: "user", content: "one" },
			{ role: "assistant", content: "new answer" },
			{ role: "user", content: "follow up" },
		]);
	});

	test("digested thread: an edited KEPT row reaches the provider window; the digest stays in system and covers the prefix", async () => {
		const script = await stores.scripts.create({ name: "Digested", code: "", scriptKind: "interactive" });
		const thread = await stores.experienceCopilot.startNewSession(script.id, "T");
		await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "one" });
		await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "covered answer" });
		const u2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "user", content: "two" });
		const a2 = await stores.experienceCopilot.appendMessage(thread.id, { role: "assistant", content: "old kept answer" });
		// The digest exactly as the compaction service persists it: the
		// anchor (u2, the first KEPT message) in toolCallId, appended at the
		// compaction moment — AFTER a2's position.
		await stores.experienceCopilot.appendMessage(thread.id, {
			role: "digest",
			content: "Summary of the early turns.",
			toolCallId: u2.id,
		});

		const result = await stores.experienceCopilot.updateAssistantContent(thread.id, a2.id, "new kept answer");
		expect(result.status).toBe("edited");

		const sent = await runNextTurnCapture(thread.id, "follow up");
		expect(sent[0]?.role).toBe("system");
		expect(typeof sent[0]?.content).toBe("string");
		const systemPrompt = String(sent[0]?.content ?? "");
		expect(systemPrompt).toContain("Summary of the early turns.");
		expect(systemPrompt).not.toContain("covered answer");
		expect(systemPrompt).not.toContain("old kept answer");
		expect(sent.slice(1)).toEqual([
			{ role: "user", content: "two" },
			{ role: "assistant", content: "new kept answer" },
			{ role: "user", content: "follow up" },
		]);
	});
});

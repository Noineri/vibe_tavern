import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assemblePrompt } from "@vibe-tavern/prompt-pipeline";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const tempDir = resolve(tmpdir(), `vt-volatile-macros-${crypto.randomUUID()}`);

async function createTestRuntime() {
	await mkdir(resolve(tempDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tempDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	return { runtime: new SessionRuntime(stores), stores };
}

describe("volatile macro storage", () => {
	it("freezes greeting variants and user messages while retaining identity macros for later assembly", async () => {
		const { runtime, stores } = await createTestRuntime();
		const created = await runtime.character.createFromScratch({
			name: "Aria",
			description: "A mage.",
			firstMessage: "Greeting {{random::sun::moon}} for {{user}}.",
			alternateGreetings: ["Alternate {{random::north::south}} for {{char}}."],
		});
		const chat = await stores.chats.getById(created.activeChatId);
		if (!chat) throw new Error("The created chat was not found.");

		await runtime.chatApp.appendUserMessage(created.activeChatId, { content: "Roll {{roll::1d20}} for {{char}}." });
		const messages = await stores.messages.getMessages(chat.activeBranchId);
		const greetingVariants = await stores.messages.getVariants(messages[0]!.id);
		const userMessage = messages[1]!;

		expect(greetingVariants.map((variant) => variant.content)).toEqual([
			expect.stringMatching(/^Greeting (sun|moon) for \{\{user}}\.$/),
			expect.stringMatching(/^Alternate (north|south) for \{\{char}}\.$/),
		]);
		expect(userMessage.content).toMatch(/^Roll (?:[1-9]|1\d|20) for \{\{char}}\.$/);

		const assemble = (personaName: string) => assemblePrompt({
			identity: { chatId: created.activeChatId },
			chat: { recentMessages: messages.map((message) => ({ id: message.id, role: message.role, content: message.content })) },
			character: { id: chat.characterId, name: "Aria", description: "A mage." },
			persona: { id: "persona", name: personaName, description: "" },
		}).layers.find((layer) => layer.id === "recent_history")?.text ?? "";
		const firstAssembly = assemble("Olya");
		const secondAssembly = assemble("Nika");

		expect(firstAssembly).toContain(userMessage.content.replace("{{char}}", "Aria"));
		expect(secondAssembly).toContain(userMessage.content.replace("{{char}}", "Aria"));
		expect(firstAssembly).toContain("Greeting");
		expect(firstAssembly).toContain("Olya");
		expect(secondAssembly).toContain("Nika");
	});

	it("freezes a user-message edit but leaves model-written content raw", async () => {
		const { runtime, stores } = await createTestRuntime();
		const created = await runtime.character.createFromScratch({
			name: "Aria",
			description: "A mage.",
			firstMessage: "Hello.",
		});
		const chat = await stores.chats.getById(created.activeChatId);
		if (!chat) throw new Error("The created chat was not found.");
		const user = await runtime.chatApp.appendUserMessage(created.activeChatId, { content: "Before." });

		await runtime.chatApp.editMessage(user.id, "Edited {{roll::1d20}} for {{char}}.");
		await stores.messages.addMessage({
			chatId: created.activeChatId,
			branchId: chat.activeBranchId,
			role: "assistant",
			authorType: "assistant",
			content: "Model {{random::kept::raw}}.",
		});
		const messages = await stores.messages.getMessages(chat.activeBranchId);

		expect(messages.find((message) => message.id === user.id)?.content).toMatch(/^Edited (?:[1-9]|1\d|20) for \{\{char}}\.$/);
		expect(messages.find((message) => message.role === "assistant" && message.content.startsWith("Model"))?.content).toBe("Model {{random::kept::raw}}.");
	});
});

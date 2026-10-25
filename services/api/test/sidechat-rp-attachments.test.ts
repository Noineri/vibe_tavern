import { beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { brandId, type Attachment, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import { PromptAssemblyService } from "../src/domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { syncBeforeUserMessage } from "../src/domain/sidechat/rp-sync.js";
import { loadSidechatContext, type SidechatContextDeps } from "../src/domain/sidechat/sidechat-context.js";
import { buildRpAttachmentBlocks } from "../src/domain/sidechat/sidechat-rp-attachments.js";

// T1: real stores, branch, sync and RP assembly. Only the asset I/O seam is
// injected; no global/module mocks, timers, network or tokenizer mutations.
let stores: StoreContainer;
let deps: SidechatContextDeps;
let characterId: string;
beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), "vt-sidechat-attachments-"));
	stores = await createStoreContainer(join(root, "test.db"), root);
	characterId = (await stores.characters.create({ name: "Theron", description: "A ranger." })).id;
	await stores.personas.create({ name: "Sable", description: "A traveler.", defaultForNewChats: true });
	const assembly = new PromptAssemblyService(stores, new StaticPromptResolver(stores, new RegexHookService(stores)), stores.content.fileStore);
	deps = {
		chats: stores.chats, characters: stores.characters, messages: stores.messages,
		traces: stores.traces, chatSummaries: stores.chatSummaries,
		experienceCopilot: stores.experienceCopilot, presets: stores.presets, assembly,
	};
});

function file(overrides: Partial<Attachment> = {}): Attachment {
	return { id: "file", assetId: "asset_file", type: "file", name: "notes.md", mimeType: "text/markdown", sizeBytes: 40, tokenCount: 10, ...overrides };
}

async function fixture(attachments: Attachment[]) {
	const chat = await stores.chats.createChat({ characterId, title: "CA-1f" });
	const chatId = brandId<ChatId>(chat.id);
	const branchId = brandId<ChatBranchId>(chat.activeBranchId);
	const message = await stores.messages.addMessage({
		chatId, branchId, role: "user", authorType: "user", content: "Frozen turn.",
		attachmentsJson: JSON.stringify(attachments),
	});
	const thread = await stores.experienceCopilot.startNewChatSession(chat.id, branchId, "sidechat-ooc");
	await syncBeforeUserMessage(deps, thread.id);
	const assetLoader = mock(async (_assetId: string) => Buffer.from("Full <map> & route."));
	return { message, thread, chatId, branchId, assetLoader, context: { ...deps, assetLoader } };
}

describe("live RP attachments in frozen sidechat events (CA-1f)", () => {
	it("a markdown file and described image render inside the frozen message, with no media byte reads", async () => {
		const image = file({ id: "image", assetId: "asset_image", type: "image", name: "trail.png", mimeType: "image/png", description: "A <tower> & trail." });
		const f = await fixture([file(), image]);
		const pkg = await loadSidechatContext(f.context, f.thread.id);
		expect(pkg.eventMessages).toEqual([{
			precedingMessages: 0, meterSegment: "rp_messages",
			content: [
				'<rp_sync from="0" to="0">',
				'<rp_message position="0" role="user" author="Sable">Frozen turn.\n\n[Attached file: notes.md]\nFull &lt;map&gt; &amp; route.\n\n[Attached image: trail.png]\nA &lt;tower&gt; &amp; trail.</rp_message>',
				"</rp_sync>",
			].join("\n"),
		}]);
		expect(f.assetLoader.mock.calls).toEqual([["asset_file"]]);
	});

	it("RP-excluded files are absent and never loaded", async () => {
		const f = await fixture([file({ includeInPrompt: false })]);
		const pkg = await loadSidechatContext(f.context, f.thread.id);
		expect(pkg.eventMessages[0]!.content).toContain('>Frozen turn.</rp_message>');
		expect(pkg.eventMessages[0]!.content).not.toContain("notes.md");
		expect(f.assetLoader).not.toHaveBeenCalled();
	});

	it("a summary replaces file text without reading the asset, including a post-sync summary edit", async () => {
		const f = await fixture([file({ description: "Summary <one>." })]);
		const first = await loadSidechatContext(f.context, f.thread.id);
		expect(first.eventMessages[0]!.content).toContain("[Attached file: notes.md]\nSummary &lt;one&gt;.");
		await stores.messages.updateMessageAttachments(f.message.id, JSON.stringify([file({ description: "Summary two." })]));
		const second = await loadSidechatContext(f.context, f.thread.id);
		expect(second.eventMessages[0]!.content).toContain("[Attached file: notes.md]\nSummary two.");
		expect(second.eventMessages[0]!.content).not.toContain("Summary &lt;one&gt;");
		expect(f.assetLoader).not.toHaveBeenCalled();
	});

	it("post-sync exclusion is live while text and stored event payloads stay frozen", async () => {
		const f = await fixture([file()]);
		const timelineBefore = await stores.experienceCopilot.listTimeline(f.thread.id);
		const first = await loadSidechatContext(f.context, f.thread.id);
		expect(first.eventMessages[0]!.content).toContain("Full &lt;map&gt; &amp; route.");
		await stores.messages.updateMessageAttachments(f.message.id, JSON.stringify([file({ includeInPrompt: false })]));
		await stores.messages.editMessage(f.message.id, "Live edit.");
		const second = await loadSidechatContext(f.context, f.thread.id);
		expect(second.eventMessages[0]!.content).toContain('>Frozen turn.</rp_message>');
		expect(second.eventMessages[0]!.content).not.toContain("notes.md");
		expect(second.eventMessages[0]!.content).not.toContain("Live edit.");
		expect(f.assetLoader).toHaveBeenCalledTimes(1);
		expect(await stores.experienceCopilot.listTimeline(f.thread.id)).toEqual(timelineBefore);
	});

	it("voice transcripts render as text; untranscribed voice and playback-only audio require no STT or asset reads", async () => {
		const voice = file({ type: "audio", mimeType: "audio/webm", name: "voice.webm", description: "Turn <left>." });
		const f = await fixture([
			voice, { ...voice, id: "old_voice", name: "old.webm", description: null },
			{ ...voice, id: "music", name: "music.webm", purpose: "music" },
		]);
		const pkg = await loadSidechatContext(f.context, f.thread.id);
		expect(pkg.eventMessages[0]!.content).toContain("[Voice message: voice.webm]\nTranscript: Turn &lt;left&gt;.");
		expect(pkg.eventMessages[0]!.content).not.toContain("old.webm");
		expect(pkg.eventMessages[0]!.content).not.toContain("music.webm");
		expect(f.assetLoader).not.toHaveBeenCalled();
	});

	it("a deleted live message leaves the frozen message text but no attachments", async () => {
		const f = await fixture([file()]);
		await stores.messages.deleteMessage(f.message.id);
		const pkg = await loadSidechatContext(f.context, f.thread.id);
		expect(pkg.eventMessages[0]!.content).toContain('>Frozen turn.</rp_message>');
		expect(pkg.eventMessages[0]!.content).not.toContain("notes.md");
		expect(f.assetLoader).not.toHaveBeenCalled();
	});

	it("repeated frozen events render from one per-load attachment read", async () => {
		const f = await fixture([file()]);
		const event = (await stores.experienceCopilot.listTimeline(f.thread.id)).find((row) => row.rowType === "event");
		if (!event || event.rowType !== "event") throw new Error("Expected a frozen sync event");
		await stores.experienceCopilot.appendContextEvent(f.thread.id, "rp_sync", event.payload);
		const pkg = await loadSidechatContext(f.context, f.thread.id);
		expect(pkg.eventMessages).toHaveLength(2);
		expect(pkg.eventMessages[0]!.content).toBe(pkg.eventMessages[1]!.content);
		expect(pkg.eventMessages[0]!.content).toContain("[Attached file: notes.md]");
		expect(f.assetLoader).toHaveBeenCalledTimes(1);
	});

	it("the sibling map omits messages with no visible attachments and renders duplicate ids once", async () => {
		const assetLoader = mock(async (_assetId: string) => Buffer.from("Full text"));
		const map = await buildRpAttachmentBlocks([
			{ id: "empty" }, { id: "filtered", attachments: [] },
			{ id: "m1", attachments: [file()] }, { id: "m1", attachments: [file()] },
		], assetLoader);
		expect([...map]).toEqual([["m1", ["[Attached file: notes.md]\nFull text"]]]);
		expect(assetLoader).toHaveBeenCalledTimes(1);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import type { Attachment } from "@vibe-tavern/domain";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import type { ChatRuntimeApi } from "../src/api/contract/runtime-api.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const noop = {} as never;

/** Distinct PNG-signatured bytes per asset so we can tell them apart on disk. */
const TAG = (b: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, b, b, b, b]);
const BYTES_A = TAG(0xa1);
const BYTES_B = TAG(0xb2);
const BYTES_C = TAG(0xc3);

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-attach-del-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(join(dataRoot, "assets"), stores.content);
	const chatApp = new ChatApplicationService(stores.chats, stores.messages);

	// Minimal sessionRuntime: chatApp is real (so removeAttachment/deleteMessage
	// hit the real store), chatRuntime.deleteMessage delegates to chatApp to
	// actually remove the row (mirroring session-runtime-chat.ts) and returns a
	// stub snapshot. ChatAdapter only needs these two for the delete paths.
	const sessionRuntime = {
		chatApp,
		chatRuntime: {
			deleteMessage: async (_chatId: string, messageId: string) => {
				await chatApp.deleteMessage(messageId);
				return {} as never;
			},
		},
	} as unknown as SessionRuntime;

	const chat = new ChatAdapter(stores, sessionRuntime, noop, noop, noop, assetService) as unknown as ChatRuntimeApi;
	return { dataRoot, stores, assetService, chatApp, chat };
}

/** Create a chat (needs a character for the FK) and return chatId + branchId. */
async function makeChat(stores: StoreContainer): Promise<{ chatId: string; branchId: string }> {
	const char = await stores.characters.create({ name: "Test" });
	const c = await stores.chats.createChat({
		characterId: char.id,
		title: "t",
		promptPresetId: null,
	});
	return { chatId: c.id, branchId: c.activeBranchId };
}

/** Upload an asset file + build an Attachment referencing it. */
async function makeAttachment(assetService: AssetService, bytes: Uint8Array, n: number): Promise<Attachment> {
	const { assetId } = await assetService.upload(new File([bytes], `a${n}.png`, { type: "image/png" }));
	return {
		id: `att_${n}`,
		assetId,
		type: "image",
		name: `a${n}.png`,
		mimeType: "image/png",
		sizeBytes: bytes.length,
		description: null,
	};
}

const assetOnDisk = async (dataRoot: string, assetId: string): Promise<boolean> => {
	try { await readFile(join(dataRoot, "assets", `${assetId}.png`)); return true; } catch { return false; }
};

/** AssetService.cleanup() is intentionally fire-and-forget (async unlink,
 *  sync void — same shape the avatar paths rely on). Poll briefly so tests
 *  observe the eventual disk state without flaking on the unlink timing. */
const waitForAssetGone = async (dataRoot: string, assetId: string, timeoutMs = 500): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await assetOnDisk(dataRoot, assetId))) return;
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe("Attachment delete (feature): removeAttachment + asset cleanup", () => {
	test("removeAttachment: removes the matching id, keeps the rest, returns the removed attachment", async () => {
		const { stores, chatApp, assetService } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const a1 = await makeAttachment(assetService, BYTES_A, 1);
		const a2 = await makeAttachment(assetService, BYTES_B, 2);
		const a3 = await makeAttachment(assetService, BYTES_C, 3);
		const msg = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "hi",
			attachmentsJson: JSON.stringify([a1, a2, a3]),
		});

		const removed = await chatApp.removeAttachment(msg.id, a2.id);

		// Returns the removed attachment (with its assetId, for file cleanup).
		expect(removed?.id).toBe(a2.id);
		expect(removed?.assetId).toBe(a2.assetId);
		// Persisted array no longer contains a2; a1 + a3 survive in order.
		const after = await stores.messages.getMessageById(msg.id);
		const remaining = JSON.parse(after!.attachmentsJson!) as Attachment[];
		expect(remaining.map((a) => a.id)).toEqual([a1.id, a3.id]);
	});

	test("removeAttachment: nulls the column when the last attachment is removed", async () => {
		const { stores, chatApp, assetService } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const a1 = await makeAttachment(assetService, BYTES_A, 1);
		const msg = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "hi",
			attachmentsJson: JSON.stringify([a1]),
		});

		const removed = await chatApp.removeAttachment(msg.id, a1.id);
		expect(removed?.id).toBe(a1.id);

		const after = await stores.messages.getMessageById(msg.id);
		// Empty → null (not "[]"), so the column stays clean and the grid hides.
		expect(after!.attachmentsJson).toBeNull();
	});

	test("removeAttachment: idempotent — returns null for a missing attachment id", async () => {
		const { stores, chatApp, assetService } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const a1 = await makeAttachment(assetService, BYTES_A, 1);
		const msg = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "hi",
			attachmentsJson: JSON.stringify([a1]),
		});

		expect(await chatApp.removeAttachment(msg.id, "att_does_not_exist")).toBeNull();
		// And for a missing message.
		expect(await chatApp.removeAttachment("msg_does_not_exist", a1.id)).toBeNull();
		// Original attachment untouched.
		const after = await stores.messages.getMessageById(msg.id);
		expect(JSON.parse(after!.attachmentsJson!).length).toBe(1);
	});

	test("adapter.deleteAttachment: removes from the message AND deletes the asset file", async () => {
		const { dataRoot, stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const a1 = await makeAttachment(assetService, BYTES_A, 1);
		const a2 = await makeAttachment(assetService, BYTES_B, 2);
		const msg = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "hi",
			attachmentsJson: JSON.stringify([a1, a2]),
		});
		expect(await assetOnDisk(dataRoot, a1.assetId)).toBe(true);

		await chat.deleteAttachment(chatId, msg.id, a1.id);

		// a1's file is gone (cleanup fired); a2's file survives.
		await waitForAssetGone(dataRoot, a1.assetId);
		expect(await assetOnDisk(dataRoot, a1.assetId)).toBe(false);
		expect(await assetOnDisk(dataRoot, a2.assetId)).toBe(true);
		// Message now holds only a2.
		const after = await stores.messages.getMessageById(msg.id);
		expect(JSON.parse(after!.attachmentsJson!).map((a: Attachment) => a.id)).toEqual([a2.id]);
	});

	test("adapter.deleteAttachment: idempotent — missing attachment is a no-op (no throw, no file touched)", async () => {
		const { dataRoot, stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const a1 = await makeAttachment(assetService, BYTES_A, 1);
		const msg = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "hi",
			attachmentsJson: JSON.stringify([a1]),
		});

		await expect(chat.deleteAttachment(chatId, msg.id, "ghost")).resolves.toEqual({ ok: true });
		expect(await assetOnDisk(dataRoot, a1.assetId)).toBe(true);
	});

	test("adapter.deleteMessage: cleans up ALL attachment asset files (no orphans)", async () => {
		const { dataRoot, stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const a1 = await makeAttachment(assetService, BYTES_A, 1);
		const a2 = await makeAttachment(assetService, BYTES_B, 2);
		const msg = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "hi",
			attachmentsJson: JSON.stringify([a1, a2]),
		});
		expect(await assetOnDisk(dataRoot, a1.assetId)).toBe(true);
		expect(await assetOnDisk(dataRoot, a2.assetId)).toBe(true);

		await chat.deleteMessage(chatId, msg.id);

		// Both attachment files are cleaned up — deleteMessage no longer orphans them.
		await waitForAssetGone(dataRoot, a1.assetId);
		await waitForAssetGone(dataRoot, a2.assetId);
		expect(await assetOnDisk(dataRoot, a1.assetId)).toBe(false);
		expect(await assetOnDisk(dataRoot, a2.assetId)).toBe(false);
	});

	test("adapter.deleteMessage: a message with no attachments still deletes cleanly", async () => {
		const { stores, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const msg = await stores.messages.addMessage({
			chatId, branchId, role: "user", authorType: "user", content: "hi",
		});

		await expect(chat.deleteMessage(chatId, msg.id)).resolves.toBeDefined();
		expect(await stores.messages.getMessageById(msg.id)).toBeNull();
	});
});

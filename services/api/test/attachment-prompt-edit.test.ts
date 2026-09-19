import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { parseStoredAttachments, type Attachment } from "@vibe-tavern/domain";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import type { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { ChatRuntimeApi } from "../src/api/contract/runtime-api.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const noop = undefined as unknown as LiveChatOrchestrator;
const noopSummary = undefined as unknown as ChatSummaryService;
const noopProviders = undefined as unknown as ProviderProfileService;

/** Distinct PNG-signatured bytes per asset so we can tell them apart on disk. */
const TAG = (b: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, b, b, b, b]);
const BYTES_A = TAG(0x11);
const BYTES_B = TAG(0x22);

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-attach-prompt-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(join(dataRoot, "assets"), stores.content);
	const chatApp = new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls);

	// Minimal sessionRuntime: chatApp is real (so the prompt write hits the
	// real store). ChatAdapter's method only needs stores.messages +
	// sessionRuntime.chatApp (the include-in-prompt sibling shape, MR-9 fork).
	const sessionRuntime = {
		chatApp,
		chatRuntime: {},
	} as unknown as SessionRuntime;

	const chat = new ChatAdapter(stores, sessionRuntime, noop, noopSummary, noopProviders, assetService) as unknown as ChatRuntimeApi;
	return { stores, assetService, chatApp, chat };
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

/** Upload an asset file + build an image-gen SLOT Attachment (IG-14
 *  provenance shape) referencing it. */
async function makeSlotAttachment(
	assetService: AssetService,
	bytes: Uint8Array,
	n: number,
	overrides?: Partial<Attachment>,
): Promise<Attachment> {
	const { assetId } = await assetService.upload(new File([bytes], `slot${n}.png`, { type: "image/png" }));
	return {
		id: `slot_att_${n}`,
		assetId,
		type: "image",
		name: `slot${n}.png`,
		mimeType: "image/png",
		sizeBytes: bytes.length,
		description: null,
		imageGen: { mode: "portrait", profileId: "prof1", params: {}, prompt: `original prompt ${n}` },
		...overrides,
	};
}

/** Plain (non-slot) upload — ordinary attachments have no editable prompt. */
async function makePlainAttachment(assetService: AssetService, bytes: Uint8Array, n: number): Promise<Attachment> {
	const { assetId } = await assetService.upload(new File([bytes], `plain${n}.png`, { type: "image/png" }));
	return {
		id: `plain_att_${n}`,
		assetId,
		type: "image",
		name: `plain${n}.png`,
		mimeType: "image/png",
		sizeBytes: bytes.length,
		description: null,
	};
}

/** Seed one message with the given attachments; return its id. */
async function seedMessage(stores: StoreContainer, chatId: string, branchId: string, attachments: Attachment[]): Promise<string> {
	const message = await stores.messages.addMessage({
		chatId,
		branchId,
		role: "assistant",
		authorType: "assistant",
		content: "",
		attachmentsJson: JSON.stringify(attachments),
	});
	return message.id;
}

/** Re-read the message's stored attachments (the persistence round-trip). */
async function storedAttachments(stores: StoreContainer, messageId: string): Promise<Attachment[]> {
	const message = await stores.messages.getMessageById(messageId);
	return parseStoredAttachments(message?.attachmentsJson) ?? [];
}

/** Seed a regenerate-as-variant row carrying its own attachment set. */
async function seedVariant(stores: StoreContainer, messageId: string, attachments: Attachment[]): Promise<string> {
	const variant = await stores.messages.addVariant(
		messageId,
		"",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		JSON.stringify(attachments),
	);
	return variant.id;
}

/** Re-read a variant row's stored attachments. */
async function storedVariantAttachments(stores: StoreContainer, messageId: string, variantId: string): Promise<Attachment[]> {
	const variants = await stores.messages.getVariants(messageId);
	const variant = variants.find((v) => v.id === variantId);
	return parseStoredAttachments(variant?.attachmentsJson) ?? [];
}

describe("Attachment prompt edit (MR-9): ChatAdapter.updateAttachmentPrompt", () => {
	test("full ladder: non-slot rejected, empty rejected, rewrite persists, siblings untouched", async () => {
		const { stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const slot = await makeSlotAttachment(assetService, BYTES_A, 1);
		const plain = await makePlainAttachment(assetService, BYTES_B, 2);
		const messageId = await seedMessage(stores, chatId, branchId, [slot, plain]);

		// 1) non-slot attachment → validation error, nothing persisted.
		await expect(chat.updateAttachmentPrompt("_", messageId, plain.id, "x")).rejects.toThrow(/Only generated image slots/);

		// 2) empty prompt → validation error.
		await expect(chat.updateAttachmentPrompt("_", messageId, slot.id, "   ")).rejects.toThrow(/cannot be empty/);

		// 3) rewrite → persists on the slot's provenance; the plain sibling
		//    and the slot's own description are untouched.
		await expect(chat.updateAttachmentPrompt("_", messageId, slot.id, "a rewritten knight portrait")).resolves.toEqual({ ok: true });
		const after = await storedAttachments(stores, messageId);
		expect(after.find((a) => a.id === slot.id)?.imageGen?.prompt).toBe("a rewritten knight portrait");
		expect(after.find((a) => a.id === slot.id)?.imageGen?.profileId).toBe("prof1");
		expect(after.find((a) => a.id === slot.id)?.description).toBeNull();
		expect(after.find((a) => a.id === plain.id)?.imageGen).toBeUndefined();
	});

	test("legacy slot without a prompt: the edit CREATES the prompt field (CF6 backfill via editing)", async () => {
		const { stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const legacy = await makeSlotAttachment(assetService, BYTES_A, 3, {
			imageGen: { mode: "portrait", profileId: "prof1", params: {} },
		});
		const messageId = await seedMessage(stores, chatId, branchId, [legacy]);

		await expect(chat.updateAttachmentPrompt("_", messageId, legacy.id, "added later")).resolves.toEqual({ ok: true });
		expect((await storedAttachments(stores, messageId))[0]?.imageGen?.prompt).toBe("added later");
	});

	test("unknown attachment id → not-found error", async () => {
		const { stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const slot = await makeSlotAttachment(assetService, BYTES_A, 1);
		const messageId = await seedMessage(stores, chatId, branchId, [slot]);

		await expect(chat.updateAttachmentPrompt("_", messageId, "nope", "x")).rejects.toThrow(/Attachment not found/);
	});

	describe("MR-4: variant-row slots (regenerate-as-variant)", () => {
		test("rewrite lands on the VARIANT row; the message row's original set is untouched", async () => {
			const { stores, assetService, chat } = await setup();
			const { chatId, branchId } = await makeChat(stores);
			const original = await makeSlotAttachment(assetService, BYTES_A, 1);
			const messageId = await seedMessage(stores, chatId, branchId, [original]);
			const variantSlot = await makeSlotAttachment(assetService, BYTES_B, 5);
			const variantId = await seedVariant(stores, messageId, [variantSlot]);

			await expect(chat.updateAttachmentPrompt("_", messageId, variantSlot.id, "rewritten on the variant")).resolves.toEqual({ ok: true });
			expect((await storedVariantAttachments(stores, messageId, variantId))[0]?.imageGen?.prompt).toBe("rewritten on the variant");
			expect((await storedAttachments(stores, messageId))[0]?.imageGen?.prompt).toBe("original prompt 1");
		});

		test("empty prompt on a variant slot → the same validation gate fires", async () => {
			const { stores, assetService, chat } = await setup();
			const { chatId, branchId } = await makeChat(stores);
			const original = await makeSlotAttachment(assetService, BYTES_A, 1);
			const messageId = await seedMessage(stores, chatId, branchId, [original]);
			const variantSlot = await makeSlotAttachment(assetService, BYTES_B, 6);
			await seedVariant(stores, messageId, [variantSlot]);

			await expect(chat.updateAttachmentPrompt("_", messageId, variantSlot.id, "")).rejects.toThrow(/cannot be empty/);
		});
	});
});

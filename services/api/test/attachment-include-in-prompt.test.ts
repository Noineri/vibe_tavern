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
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-attach-inc-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(join(dataRoot, "assets"), stores.content);
	const chatApp = new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls);

	// Minimal sessionRuntime: chatApp is real (so the include-in-prompt
	// persistence hits the real store). ChatAdapter's method only needs
	// stores.messages + sessionRuntime.chatApp (the description-sibling shape).
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
		imageGen: { mode: "portrait", profileId: "prof1", params: {} },
		...overrides,
	};
}

/** Plain (non-slot) upload — the always-included ordinary attachment. */
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

/** Seed a regenerate-as-variant row (IG-18a) carrying its own attachment
 *  set; return the variant id. Signature-true call — the store's addVariant
 *  takes the attachments as its LAST positional parameter. */
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

describe("Attachment include-in-prompt (IG-18): ChatAdapter.updateAttachmentIncludeInPrompt", () => {
	test("full ladder: undescribed slot rejected, described slot persists, disable persists", async () => {
		const { stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const slot = await makeSlotAttachment(assetService, BYTES_A, 1);
		const messageId = await seedMessage(stores, chatId, branchId, [slot]);

		// 1) enable with no description → validation error, flag stays absent.
		await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, slot.id, true)).rejects.toThrow(/Describe the image/);
		expect((await storedAttachments(stores, messageId))[0]?.includeInPrompt).toBeUndefined();

		// 2) fill the description (the vision-describe flow's persistence),
		//    then enable → persists as true.
		const described = await storedAttachments(stores, messageId);
		await stores.messages.updateMessageAttachments(
			messageId,
			JSON.stringify(described.map((a) => ({ ...a, description: "A painted portrait." }))),
		);
		await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, slot.id, true)).resolves.toEqual({ ok: true });
		expect((await storedAttachments(stores, messageId))[0]?.includeInPrompt).toBe(true);

		// 3) disable → persists as false (explicit off, not flag removal).
		await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, slot.id, false)).resolves.toEqual({ ok: true });
		expect((await storedAttachments(stores, messageId))[0]?.includeInPrompt).toBe(false);
	});

	test("prompt-stamped slot (IG-CF9): the generation prompt satisfies the gate — include succeeds, zero describe", async () => {
		const { stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const slot = await makeSlotAttachment(assetService, BYTES_A, 1, {
			imageGen: { mode: "portrait", profileId: "prof1", params: {}, prompt: "a painted knight portrait, oil on canvas" },
		});
		const messageId = await seedMessage(stores, chatId, branchId, [slot]);

		// No description exists — the CF6-stamped generation prompt is the slot's
		// textual identity (owner 2026-09-16, `description ?? provenance.prompt`).
		await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, slot.id, true)).resolves.toEqual({ ok: true });
		expect((await storedAttachments(stores, messageId))[0]?.includeInPrompt).toBe(true);
	});

	test("non-slot attachment → validation error (ordinary uploads keep always-included semantics)", async () => {
		const { stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const plain = await makePlainAttachment(assetService, BYTES_B, 2);
		plain.description = "already described";
		const messageId = await seedMessage(stores, chatId, branchId, [plain]);

		await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, plain.id, true)).rejects.toThrow(/Only generated image slots/);
		expect((await storedAttachments(stores, messageId))[0]?.includeInPrompt).toBeUndefined();
	});

	test("unknown attachment id → not-found error", async () => {
		const { stores, assetService, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const slot = await makeSlotAttachment(assetService, BYTES_A, 1, { description: "d" });
		const messageId = await seedMessage(stores, chatId, branchId, [slot]);

		await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, "nope", true)).rejects.toThrow(/Attachment not found/);
	});

	test("message without attachments → not-found for any id", async () => {
		const { stores, chat } = await setup();
		const { chatId, branchId } = await makeChat(stores);
		const messageId = await seedMessage(stores, chatId, branchId, []);

		await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, "x", true)).rejects.toThrow(/Attachment not found/);
	});

	describe("MR-4: variant-row attachments (regenerate-as-variant)", () => {
		test("full ladder on a VARIANT attachment: describe gate, include persists to the variant row, message row untouched", async () => {
			const { stores, assetService, chat } = await setup();
			const { chatId, branchId } = await makeChat(stores);
			// The original slot on the MESSAGE row (legacy shape)…
			const original = await makeSlotAttachment(assetService, BYTES_A, 1, { description: "original" });
			const messageId = await seedMessage(stores, chatId, branchId, [original]);
			// …and the swiped-to regeneration on a VARIANT row (IG-18a).
			const variantSlot = await makeSlotAttachment(assetService, BYTES_B, 2);
			const variantId = await seedVariant(stores, messageId, [variantSlot]);

			// 1) undescribed variant slot → the same validation gate fires.
			await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, variantSlot.id, true)).rejects.toThrow(/Describe the image/);

			// 2) describe via the domain write path, then include → persists on
			//    the VARIANT row; the message row's original set is untouched.
			await stores.messages.updateVariantAttachments(
				variantId,
				JSON.stringify([{ ...variantSlot, description: "A regenerated portrait." }]),
			);
			await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, variantSlot.id, true)).resolves.toEqual({ ok: true });
			expect((await storedVariantAttachments(stores, messageId, variantId))[0]?.includeInPrompt).toBe(true);
			expect((await storedAttachments(stores, messageId))[0]?.id).toBe(original.id);
			expect((await storedAttachments(stores, messageId))[0]?.includeInPrompt).toBeUndefined();

			// 3) disable → explicit false on the variant row.
			await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, variantSlot.id, false)).resolves.toEqual({ ok: true });
			expect((await storedVariantAttachments(stores, messageId, variantId))[0]?.includeInPrompt).toBe(false);
		});

		test("prompt-stamped variant slot (IG-CF9 on variants): the generation prompt satisfies the gate", async () => {
			const { stores, assetService, chat } = await setup();
			const { chatId, branchId } = await makeChat(stores);
			const original = await makeSlotAttachment(assetService, BYTES_A, 1, { description: "original" });
			const messageId = await seedMessage(stores, chatId, branchId, [original]);
			const variantSlot = await makeSlotAttachment(assetService, BYTES_B, 3, {
				imageGen: { mode: "portrait", profileId: "prof1", params: {}, prompt: "a knight in the rain" },
			});
			const variantId = await seedVariant(stores, messageId, [variantSlot]);

			await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, variantSlot.id, true)).resolves.toEqual({ ok: true });
			expect((await storedVariantAttachments(stores, messageId, variantId))[0]?.includeInPrompt).toBe(true);
		});

		test("description update lands on the owning variant row", async () => {
			const { stores, assetService, chatApp } = await setup();
			const { chatId, branchId } = await makeChat(stores);
			const original = await makeSlotAttachment(assetService, BYTES_A, 1, { description: "original" });
			const messageId = await seedMessage(stores, chatId, branchId, [original]);
			const variantSlot = await makeSlotAttachment(assetService, BYTES_B, 4);
			const variantId = await seedVariant(stores, messageId, [variantSlot]);

			await chatApp.updateSingleAttachmentDescription(messageId, variantSlot.id, "Described on the variant.");
			expect((await storedVariantAttachments(stores, messageId, variantId))[0]?.description).toBe("Described on the variant.");
			expect((await storedAttachments(stores, messageId))[0]?.description).toBe("original");
		});

		test("removeAttachment on a variant row: removed + the row empties; message row untouched", async () => {
			const { stores, assetService, chatApp } = await setup();
			const { chatId, branchId } = await makeChat(stores);
			const original = await makeSlotAttachment(assetService, BYTES_A, 1, { description: "original" });
			const messageId = await seedMessage(stores, chatId, branchId, [original]);
			const variantSlot = await makeSlotAttachment(assetService, BYTES_B, 5);
			const variantId = await seedVariant(stores, messageId, [variantSlot]);

			const removed = await chatApp.removeAttachment(messageId, variantSlot.id);
			expect(removed?.id).toBe(variantSlot.id);
			expect(await storedVariantAttachments(stores, messageId, variantId)).toEqual([]);
			expect((await storedAttachments(stores, messageId))[0]?.id).toBe(original.id);

			// Idempotent second removal → null.
			expect(await chatApp.removeAttachment(messageId, variantSlot.id)).toBeNull();
		});

		test("unknown id on a variant-carrying message → not-found (the merged lookup is not a false positive)", async () => {
			const { stores, assetService, chat } = await setup();
			const { chatId, branchId } = await makeChat(stores);
			const original = await makeSlotAttachment(assetService, BYTES_A, 1, { description: "original" });
			const messageId = await seedMessage(stores, chatId, branchId, [original]);
			const variantSlot = await makeSlotAttachment(assetService, BYTES_B, 6, { description: "v" });
			await seedVariant(stores, messageId, [variantSlot]);

			await expect(chat.updateAttachmentIncludeInPrompt("_", messageId, "nope", true)).rejects.toThrow(/Attachment not found/);
		});
	});
});

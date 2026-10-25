import { describe, expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer } from "@vibe-tavern/db";
import { parseStoredAttachments, type Attachment } from "@vibe-tavern/domain";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import type { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { countTokensDefault } from "../src/infrastructure/ai/tokenizer-service.js";
import { mapMessageDto } from "../src/runtime/session/session-runtime-dto.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createApp } from "../src/server/app-factory.js";

// T2: only the external model executor is injected. Hono, error mapping,
// profile resolution, asset loading, merged storage and DTO projection are real.
// Template-compatible createStoreContainer; the workspace preload closes/sweeps.
async function setup(mode: "rp" | "coauthor" = "rp") {
  const root = await mkdtemp(join(tmpdir(), "vt-attachment-actions-"));
  const stores = await createStoreContainer(join(root, "test.db"), root);
  await stores.uiSettings.ensureDefaults();
  const providers = createProviderProfileService(stores.providers, stores.proxies);
  const rp = await providers.saveProviderProfile({ name: "RP", providerPreset: "openai_compat", defaultModel: "rp-model", temperature: 0.4 });
  await providers.activateProviderProfile(rp.id);
  const coauthor = await providers.saveProviderProfile({ name: "Co-Author", providerPreset: "openai_compat", defaultModel: "wrong-base-model" });
  await stores.coauthorSettings.upsert(coauthor.id, { modelName: "coauthor-model", settings: { temperature: 0.7 } });
  await stores.uiSettings.update({ coauthorProviderId: coauthor.id });
  const character = await stores.characters.create({ name: "Test" });
  const chat = await stores.chats.createChat({ characterId: character.id, title: "t", promptPresetId: null, mode });
  const assets = new AssetService(join(root, "assets"), stores.content);
  const chatApp = new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls, stores.experiences, stores);
  const execute = mock(async (_input: ProviderExecutionInput) => ({ text: "  The gate opens at 7.\n" }));
  const adapter = new ChatAdapter(
    stores, { chatApp } as unknown as SessionRuntime,
    null as unknown as LiveChatOrchestrator, null as unknown as ChatSummaryService,
    providers, assets, async () => null, execute,
  );
  const app = await createApp({ runtime: { chat: adapter } as RuntimeApi });
  async function file(text = "Original notes.\nThe gate opens at 7."): Promise<Attachment> {
    const result = await assets.upload(new File([text], "notes.md", { type: "text/markdown" }));
    return { id: crypto.randomUUID(), assetId: result.assetId, name: "notes.md", type: "file", mimeType: "text/markdown", sizeBytes: Buffer.byteLength(text), tokenCount: result.tokenCount };
  }
  async function seed(attachments: Attachment[]) {
    return stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: "user", authorType: "user", content: "Read this", attachmentsJson: JSON.stringify(attachments) });
  }
  async function dto(messageId: string) {
    const message = await stores.messages.getMessageById(messageId);
    if (!message) throw new Error("Expected seeded message");
    return mapMessageDto(message, await stores.messages.getVariants(messageId));
  }
  function request(messageId: string, attachmentId: string, action: string, chatId = "_", init: RequestInit = {}) {
    return app.request(`http://localhost/api/chats/${chatId}/messages/${messageId}/attachments/${attachmentId}/${action}`, { method: "POST", ...init });
  }
  return { stores, chat, rp, coauthor, execute, file, seed, dto, request, chatApp };
}

describe("chat attachment action routes (CA-2b)", () => {
  test("RP summarize sends the bundled prompt and full asset with the effective RP profile; survives a fresh DTO read", async () => {
    const h = await setup();
    const text = "BEGIN\n" + "abc ".repeat(600_000) + "\nEND";
    const attachment = await h.file(text);
    const sibling = await h.file("Leave this alone.");
    const message = await h.seed([attachment, sibling]);
    const response = await h.request(message.id, attachment.id, "summarize");
    expect(response.status).toBe(200);
    const updated = { ...attachment, description: "The gate opens at 7.", summaryTokenCount: countTokensDefault("The gate opens at 7.") };
    expect(await response.json()).toEqual(updated);
    expect((await h.dto(message.id)).attachments).toEqual([updated, sibling]);
    expect(h.execute).toHaveBeenCalledTimes(1);
    const input = h.execute.mock.calls[0]![0];
    expect(input.profile).toMatchObject({ id: h.rp.id, defaultModel: "rp-model", temperature: 0.4 });
    expect(input.model).toBe("rp-model");
    const assetPrompt = (await Bun.file(join(import.meta.dir, "../assets/attachment-summarize.md")).text()).replace(/\r\n?/g, "\n");
    expect(input.prompt.finalPayload).toEqual({ messages: [{ role: "system", content: assetPrompt }, { role: "user", content: text }] });
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  test("Co-Author summarize uses its bound connection and connection-settings model", async () => {
    const h = await setup("coauthor");
    const attachment = await h.file();
    const message = await h.seed([attachment]);
    expect((await h.request(message.id, attachment.id, "summarize", h.chat.id)).status).toBe(200);
    expect(h.execute.mock.calls[0]![0]).toMatchObject({ model: "coauthor-model", profile: { id: h.coauthor.id, defaultModel: "coauthor-model", temperature: 0.7 } });
  });

  test("a mismatching real chat id and a missing message return 404 without generation or writes", async () => {
    const h = await setup();
    const attachment = await h.file();
    const message = await h.seed([attachment]);
    for (const action of ["summarize", "clear-summary"]) {
      expect((await h.request(message.id, attachment.id, action, "other-chat")).status).toBe(404);
      expect((await h.request("missing", attachment.id, action)).status).toBe(404);
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect((await h.dto(message.id)).attachments).toEqual([attachment]);
  });

  test("clear-summary clears description and removes summaryTokenCount, preserving exclusion", async () => {
    const h = await setup();
    const attachment = { ...await h.file(), description: "Summary", summaryTokenCount: 4, includeInPrompt: false };
    const message = await h.seed([attachment]);
    const response = await h.request(message.id, attachment.id, "clear-summary");
    expect(response.status).toBe(200);
    const { summaryTokenCount: _removed, ...rest } = attachment;
    const expected = { ...rest, description: null };
    expect(await response.json()).toEqual(expected);
    expect((await h.dto(message.id)).attachments).toEqual([expected]);
    expect(Object.hasOwn((await h.chatApp.findAttachment(message.id, attachment.id))!, "summaryTokenCount")).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
  });

  test("text file exclude and restore persist with the existing ok response; ordinary image stays refused", async () => {
    const h = await setup();
    const attachment = await h.file();
    const image: Attachment = { ...attachment, id: "image", type: "image", mimeType: "image/png" };
    const message = await h.seed([attachment, image]);
    for (const includeInPrompt of [false, true]) {
      const response = await h.request(message.id, attachment.id, "include-in-prompt", "_", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ includeInPrompt }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await h.dto(message.id)).attachments).toEqual([{ ...attachment, includeInPrompt }, image]);
    }
    expect((await h.request(message.id, image.id, "include-in-prompt", "_", { method: "PATCH", body: JSON.stringify({ includeInPrompt: false }) })).status).toBe(400);
  });

  test("a selected variant file summarizes, toggles and clears on the owning variant, leaving the message set untouched", async () => {
    const h = await setup();
    const original = await h.file("Original row.");
    const attachment = await h.file("Variant file.");
    const message = await h.seed([original]);
    const variant = await h.stores.messages.addVariant(message.id, "Variant", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, JSON.stringify([attachment]));
    expect((await h.request(message.id, attachment.id, "summarize")).status).toBe(200);
    expect((await h.dto(message.id)).attachments?.[0]).toMatchObject({ id: attachment.id, description: "The gate opens at 7." });
    expect((await h.request(message.id, attachment.id, "include-in-prompt", "_", { method: "PATCH", body: JSON.stringify({ includeInPrompt: false }) })).status).toBe(200);
    expect((await h.request(message.id, attachment.id, "clear-summary")).status).toBe(200);
    const stored = (await h.stores.messages.getVariants(message.id)).find((row) => row.id === variant.id);
    expect(parseStoredAttachments(stored?.attachmentsJson)).toEqual([{ ...attachment, description: null, includeInPrompt: false }]);
    expect(parseStoredAttachments((await h.stores.messages.getMessageById(message.id))?.attachmentsJson)).toEqual([original]);
    expect((await h.dto(message.id)).messageLevelAttachments).toEqual([original]);
  });

  test("image summarize and clear return 400 attachment_not_text", async () => {
    const h = await setup();
    const attachment: Attachment = { ...await h.file(), type: "image", mimeType: "image/png" };
    const message = await h.seed([attachment]);
    for (const action of ["summarize", "clear-summary"]) {
      const response = await h.request(message.id, attachment.id, action);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { details: { code: "attachment_not_text" } } });
    }
    expect(h.execute).not.toHaveBeenCalled();
  });

  test("missing asset returns 404 attachment_asset_missing and keeps the attachment", async () => {
    const h = await setup();
    const attachment = { ...await h.file(), assetId: "missing-asset" };
    const message = await h.seed([attachment]);
    const response = await h.request(message.id, attachment.id, "summarize");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { details: { code: "attachment_asset_missing" } } });
    expect(h.execute).not.toHaveBeenCalled();
    expect((await h.dto(message.id)).attachments).toEqual([attachment]);
  });

  test("empty model output returns 400 attachment_summary_empty without clearing the previous summary", async () => {
    const h = await setup();
    const attachment = { ...await h.file(), description: "Keep", summaryTokenCount: 1 };
    const message = await h.seed([attachment]);
    h.execute.mockResolvedValue({ text: " \n " });
    const response = await h.request(message.id, attachment.id, "summarize");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { code: "attachment_summary_empty" } } });
    expect((await h.dto(message.id)).attachments).toEqual([attachment]);
  });

  test("request abort reaches the executor and a late summary cannot persist", async () => {
    const h = await setup();
    const attachment = await h.file();
    const message = await h.seed([attachment]);
    const controller = new AbortController();
    h.execute.mockImplementation(async ({ signal }) => {
      expect(signal?.aborted).toBe(false);
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { text: "Too late" };
    });
    await h.request(message.id, attachment.id, "summarize", "_", { signal: controller.signal });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect((await h.dto(message.id)).attachments).toEqual([attachment]);
  });

  test("generic patch re-reads after generation so a sibling's simultaneous edit survives", async () => {
    const h = await setup();
    const attachment = await h.file();
    const sibling = await h.file("Sibling.");
    const message = await h.seed([attachment, sibling]);
    h.execute.mockImplementation(async () => {
      await h.chatApp.updateSingleAttachment(message.id, sibling.id, { includeInPrompt: false });
      return { text: "Summary" };
    });
    expect((await h.request(message.id, attachment.id, "summarize")).status).toBe(200);
    expect((await h.dto(message.id)).attachments?.[1]).toEqual({ ...sibling, includeInPrompt: false });
  });
});

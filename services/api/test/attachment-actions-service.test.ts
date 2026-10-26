import { describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import type { Attachment } from "@vibe-tavern/domain";
import {
  clearSummary,
  setIncluded,
  summarize,
  type AttachmentMessagePort,
  type AttachmentPatch,
  type AttachmentSummaryGenerateInput,
} from "../src/domain/attachment/attachment-actions-service.js";
import { countTokensDefault } from "../src/infrastructure/ai/tokenizer-service.js";

// T1: per-test in-memory storage port and injected generation/asset boundaries.
// Real prompt loading and tokenization. No DB, process-global mutations,
// module mocks, timers, sleeps, network or platform-specific path literals.
const target = { messageId: "message_1", attachmentId: "attachment_1" };

function textFile(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: target.attachmentId, assetId: "asset_1", type: "file", name: "notes.md",
    mimeType: "text/markdown", sizeBytes: 100, tokenCount: 25, ...overrides,
  };
}

function harness(initial: Attachment | null = textFile()) {
  let current = initial === null ? null : structuredClone(initial);
  const find = mock(async (messageId: string, attachmentId: string) =>
    messageId === target.messageId && attachmentId === current?.id ? current : null);
  const update = mock(async (messageId: string, attachmentId: string, patch: AttachmentPatch) => {
    if (messageId !== target.messageId || attachmentId !== current?.id || current === null) {
      throw new Error("Test port update target does not resolve");
    }
    if (patch.description !== undefined) current.description = patch.description;
    if (patch.includeInPrompt !== undefined) current.includeInPrompt = patch.includeInPrompt;
    if (patch.summaryTokenCount === null) delete current.summaryTokenCount;
    else if (patch.summaryTokenCount !== undefined) current.summaryTokenCount = patch.summaryTokenCount;
    return structuredClone(current);
  });
  const port: AttachmentMessagePort = { find, update };
  const generate = mock(async (_input: AttachmentSummaryGenerateInput) => "  The harbor gate opens at 7.\n");
  const assetLoader = mock(async (_assetId: string): Promise<Buffer | null> => Buffer.from("Original file text."));
  return { port, find, update, generate, assetLoader, current: () => current };
}

describe("attachment actions service (CA-2a)", () => {
  it("summarize sends the bundled prompt and a full 2 MiB file once, then writes the trimmed summary and its count", async () => {
    const h = harness(textFile({ description: "Previous summary", summaryTokenCount: 3, includeInPrompt: false }));
    const text = "BEGIN\n" + "a".repeat(2 * 1024 * 1024) + "\nEND";
    h.assetLoader.mockResolvedValue(Buffer.from(text));
    const controller = new AbortController();
    const result = await summarize(h.port, { ...target, ...h, signal: controller.signal });
    const prompt = (await Bun.file(join(import.meta.dir, "../assets/attachment-summarize.md")).text()).replace(/\r\n?/g, "\n");
    expect(h.find.mock.calls).toEqual([[target.messageId, target.attachmentId]]);
    expect(h.assetLoader.mock.calls).toEqual([["asset_1"]]);
    expect(h.generate.mock.calls).toEqual([[{ systemPrompt: prompt, text, signal: controller.signal }]]);
    const summary = "The harbor gate opens at 7.";
    expect(h.update.mock.calls).toEqual([[target.messageId, target.attachmentId, {
      description: summary, summaryTokenCount: countTokensDefault(summary),
    }]]);
    expect(result).toEqual(textFile({ description: summary, summaryTokenCount: countTokensDefault(summary), includeInPrompt: false }));
  });

  it("decodes UTF-8 and strips a BOM before generation", async () => {
    const h = harness();
    h.assetLoader.mockResolvedValue(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Caf\u00e9 <map> & trail.")]));
    await summarize(h.port, { ...target, ...h });
    expect(h.generate.mock.calls[0]![0].text).toBe("Caf\u00e9 <map> & trail.");
  });

  it("clearSummary clears the description and removes the count, preserving all other fields", async () => {
    const h = harness(textFile({ description: "Summary", summaryTokenCount: 2, includeInPrompt: false }));
    const result = await clearSummary(h.port, target);
    expect(h.find.mock.calls).toEqual([[target.messageId, target.attachmentId]]);
    expect(h.update.mock.calls).toEqual([[target.messageId, target.attachmentId, { description: null, summaryTokenCount: null }]]);
    expect(result).toEqual(textFile({ description: null, includeInPrompt: false }));
    expect(Object.hasOwn(result, "summaryTokenCount")).toBe(false);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.assetLoader).not.toHaveBeenCalled();
  });

  it("clearSummary is idempotent for an unsummarized file", async () => {
    const h = harness();
    const first = await clearSummary(h.port, target);
    const second = await clearSummary(h.port, target);
    expect(first).toEqual(textFile({ description: null }));
    expect(second).toEqual(first);
  });

  it("setIncluded excludes then restores, changing only visibility", async () => {
    const initial = textFile({ description: "Summary", summaryTokenCount: 2 });
    const h = harness(initial);
    expect(await setIncluded(h.port, { ...target, included: false })).toEqual({ ...initial, includeInPrompt: false });
    expect(await setIncluded(h.port, { ...target, included: true })).toEqual({ ...initial, includeInPrompt: true });
    expect(h.find.mock.calls).toEqual(Array(2).fill([target.messageId, target.attachmentId]));
    expect(h.update.mock.calls.map((call) => call[2])).toEqual([{ includeInPrompt: false }, { includeInPrompt: true }]);
  });

  const nonTextAttachments = [
    textFile({ type: "image", mimeType: "image/png" }),
    textFile({ type: "audio", mimeType: "audio/webm" }),
    textFile({ type: "video", mimeType: "video/mp4" }),
    textFile({ mimeType: "application/octet-stream" }),
    textFile({ type: "image" }),
  ];
  for (const attachment of nonTextAttachments) {
    it(`refuses ${attachment.type}/${attachment.mimeType} on every operation without side effects`, async () => {
      const h = harness(attachment);
      await expect(summarize(h.port, { ...target, ...h })).rejects.toMatchObject({ kind: "Validation", details: { code: "attachment_not_text" } });
      await expect(clearSummary(h.port, target)).rejects.toMatchObject({ kind: "Validation", details: { code: "attachment_not_text" } });
      await expect(setIncluded(h.port, { ...target, included: false })).rejects.toMatchObject({ kind: "Validation", details: { code: "attachment_not_text" } });
      expect(h.find).toHaveBeenCalledTimes(3);
      expect(h.update).not.toHaveBeenCalled();
      expect(h.generate).not.toHaveBeenCalled();
      expect(h.assetLoader).not.toHaveBeenCalled();
      expect(h.current()).toEqual(attachment);
    });
  }

  it("a missing attachment is NotFound on all operations", async () => {
    const h = harness(null);
    await expect(summarize(h.port, { ...target, ...h })).rejects.toMatchObject({ kind: "NotFound", resource: "Attachment" });
    await expect(clearSummary(h.port, target)).rejects.toMatchObject({ kind: "NotFound", resource: "Attachment" });
    await expect(setIncluded(h.port, { ...target, included: true })).rejects.toMatchObject({ kind: "NotFound", resource: "Attachment" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.assetLoader).not.toHaveBeenCalled();
  });

  it("a missing asset carries attachment_asset_missing and never calls the model or writes", async () => {
    const h = harness();
    h.assetLoader.mockResolvedValue(null);
    await expect(summarize(h.port, { ...target, ...h })).rejects.toMatchObject({
      kind: "NotFound", resource: "AttachmentAsset", details: { code: "attachment_asset_missing" },
    });
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("an empty summary is rejected without overwriting the previous summary", async () => {
    const initial = textFile({ description: "Keep me", summaryTokenCount: 2 });
    const h = harness(initial);
    h.generate.mockResolvedValue(" \n\t ");
    await expect(summarize(h.port, { ...target, ...h })).rejects.toMatchObject({
      kind: "Validation", details: { code: "attachment_summary_empty" },
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.current()).toEqual(initial);
  });

  it("a pre-aborted signal propagates its exact reason without reads or writes", async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = new DOMException("Cancelled", "AbortError");
    controller.abort(reason);
    await expect(summarize(h.port, { ...target, ...h, signal: controller.signal })).rejects.toBe(reason);
    expect(h.find).not.toHaveBeenCalled();
    expect(h.assetLoader).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("aborting during asset loading prevents generation and persistence", async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = new DOMException("Cancelled during loading", "AbortError");
    h.assetLoader.mockImplementation(async () => {
      controller.abort(reason);
      return Buffer.from("File text");
    });
    await expect(summarize(h.port, { ...target, ...h, signal: controller.signal })).rejects.toBe(reason);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("an abort during generation prevents a write even if the model resolves a summary", async () => {
    const initial = textFile({ description: "Keep me", summaryTokenCount: 2 });
    const h = harness(initial);
    const controller = new AbortController();
    const reason = new DOMException("Cancelled during generation", "AbortError");
    h.generate.mockImplementation(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      return "Late summary";
    });
    await expect(summarize(h.port, { ...target, ...h, signal: controller.signal })).rejects.toBe(reason);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.current()).toEqual(initial);
  });

  it("provider failures, including context overflow, propagate unchanged and never write", async () => {
    const h = harness();
    const error = new Error("Provider context length exceeded");
    h.generate.mockRejectedValue(error);
    await expect(summarize(h.port, { ...target, ...h })).rejects.toBe(error);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });
});

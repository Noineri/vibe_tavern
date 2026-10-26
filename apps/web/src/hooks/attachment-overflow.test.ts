import { describe, expect, test } from "bun:test";
import type { Attachment } from "@vibe-tavern/domain";
import { estimateAttachmentOverflow } from "./attachment-overflow.js";

// T0 pure arithmetic. No paths, globals, mocks, waits or platform assumptions.
function file(overrides: Partial<Attachment> = {}): Attachment {
  return { id: "file_1", assetId: "asset_1", type: "file", name: "notes.md", mimeType: "text/markdown", sizeBytes: 10, tokenCount: 100, ...overrides };
}

describe("attachment overflow (CA-1e)", () => {
  test("exactly filling the meter budget is not overflow", () => {
    expect(estimateAttachmentOverflow({ totalUsed: 900, availableBudget: 1000, attachments: [file()] }))
      .toEqual({ attachedTokens: 100, freeTokens: 100, overflow: false });
  });
  test("one token over the meter budget warns", () => {
    expect(estimateAttachmentOverflow({ totalUsed: 901, availableBudget: 1000, attachments: [file()] }))
      .toEqual({ attachedTokens: 100, freeTokens: 99, overflow: true });
  });
  test("zero budget means unknown and never warns", () => {
    expect(estimateAttachmentOverflow({ totalUsed: 900, availableBudget: 0, attachments: [file()] }))
      .toEqual({ attachedTokens: 100, freeTokens: 0, overflow: false });
  });
  test("empty and media-only drafts never warn even when text already overflows", () => {
    for (const attachments of [[], [file({ type: "image", mimeType: "image/png" })], [file({ type: "audio", mimeType: "audio/webm" })]]) {
      expect(estimateAttachmentOverflow({ totalUsed: 1100, availableBudget: 1000, attachments }))
        .toEqual({ attachedTokens: 0, freeTokens: 0, overflow: false });
    }
  });
  test("free tokens never go negative", () => {
    expect(estimateAttachmentOverflow({ totalUsed: 1100, availableBudget: 1000, attachments: [file()] }))
      .toEqual({ attachedTokens: 100, freeTokens: 0, overflow: true });
  });
  test("sums files through the domain weight rule, including summary counts", () => {
    expect(estimateAttachmentOverflow({ totalUsed: 20, availableBudget: 200, attachments: [file(), file({ description: "Summary", summaryTokenCount: 80 })] }))
      .toEqual({ attachedTokens: 180, freeTokens: 180, overflow: false });
  });
  test("legacy files without a count and zero-count files weigh zero", () => {
    expect(estimateAttachmentOverflow({ totalUsed: 1100, availableBudget: 1000, attachments: [file({ tokenCount: undefined }), file({ tokenCount: 0 })] }))
      .toEqual({ attachedTokens: 0, freeTokens: 0, overflow: false });
  });
});

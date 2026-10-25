import { describe, expect, test } from "bun:test";
import type { Attachment } from "@vibe-tavern/domain";
import { attachmentSchema } from "@vibe-tavern/api-contracts";
import { toSendAttachment } from "./send-attachments.js";

// T0: pure projection + real contract, no globals, mocks, paths, waits or DB.
const file: Attachment = { id: "file", assetId: "asset", name: "notes.md", type: "file", mimeType: "text/markdown", sizeBytes: 100, tokenCount: 12400 };

describe("toSendAttachment (CA-1d fix)", () => {
  test("a text file keeps its full token count and accepted fields", () => {
    expect(toSendAttachment(file)).toEqual(file);
    expect(attachmentSchema.parse(toSendAttachment(file))).toEqual(file);
    expect(toSendAttachment({ ...file, tokenCount: 0 }).tokenCount).toBe(0);
  });

  test("an image without a count stays byte-identical and has no tokenCount key", () => {
    const image: Attachment = { id: "image", name: "a.png", type: "image", assetId: "image-asset", mimeType: "image/png", sizeBytes: 12 };
    expect(JSON.stringify(toSendAttachment(image))).toBe(JSON.stringify(image));
    expect(Object.hasOwn(toSendAttachment(image), "tokenCount")).toBe(false);
  });

  test("voice notes keep purpose/duration and the absent-purpose voice default", () => {
    const audio: Attachment = { id: "audio", name: "a.webm", type: "audio", assetId: "audio-asset", mimeType: "audio/webm", sizeBytes: 12, durationMs: 910 };
    expect(toSendAttachment(audio)).toEqual({ ...audio, purpose: "voice" });
    for (const purpose of ["voice", "music", "ambient"] as const) {
      expect(toSendAttachment({ ...audio, purpose })).toEqual({ ...audio, purpose });
    }
    const { durationMs: _removed, ...withoutDuration } = audio;
    expect(Object.hasOwn(toSendAttachment(withoutDuration), "durationMs")).toBe(true);
    expect(toSendAttachment(withoutDuration).durationMs).toBeUndefined();
  });

  test("server-owned fields are never sent and non-audio fields do not leak audio metadata", () => {
    const result = toSendAttachment({ ...file, description: "Summary", summaryTokenCount: 20, includeInPrompt: false, purpose: "music", durationMs: 900 });
    expect(result).toEqual(file);
    for (const key of ["description", "summaryTokenCount", "includeInPrompt", "purpose", "durationMs"]) expect(Object.hasOwn(result, key)).toBe(false);
  });

  test("every contract field is covered so schema additions cannot silently disappear", () => {
    const allFields = toSendAttachment({ ...file, type: "audio", purpose: "voice", durationMs: 100 });
    expect(Object.keys(allFields).sort()).toEqual(Object.keys(attachmentSchema.shape).sort());
  });
});

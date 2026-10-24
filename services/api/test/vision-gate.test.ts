import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  renderAttachmentsAsText,
  resolveMultimodalContent,
  unseenImagePolicy,
  VisionNotSupportedError,
  type VisionGateConfig,
} from "../src/infrastructure/ai/vision-gate.js";
import type { Attachment } from "@vibe-tavern/domain";
import { filterPromptVisibleAttachments, TEXT_MIME_TO_EXT, withImageGenPromptFallback } from "@vibe-tavern/domain";
import { CONTINUATION_USER_INSTRUCTION, prepareSdkMessages, type SdkMessage } from "../src/infrastructure/ai/provider-executor-utils.js";

let warningSpy: ReturnType<typeof spyOn> | undefined;
function restoreWarning() { warningSpy?.mockRestore(); warningSpy = undefined; }
afterEach(restoreWarning);
afterAll(restoreWarning);

// Vision gate is a pure transform over message attachments: the primary model's
// vision capability decides pixels-vs-text, and `description` matters only on
// the non-vision path. These tests pin the asymmetry that makes vision/non-
// vision model switching safe across rerolls (see vision-gate.ts header).

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // tiny PNG-ish stub

function rawImage(id = "img_1"): Attachment {
  return {
    id,
    assetId: `asset_${id}`,
    type: "image",
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 4,
    description: null,
  };
}

function describedImage(id = "img_1", description = "a red square"): Attachment {
  return { ...rawImage(id), description };
}

function slotImage(id = "slot_1", overrides: Partial<Attachment> = {}): Attachment {
  return {
    id,
    assetId: `asset_${id}`,
    type: "image",
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 4,
    description: null,
    includeInPrompt: true,
    imageGen: { mode: "portrait", profileId: "prof1", prompt: "a lighthouse at dusk", params: {} },
    ...overrides,
  };
}

/** The assembly-line composition (prompt-assembly-service.ts): filter, then
 *  the IG-CF9 prompt fallback, before the gate. */
function assemblyVisible(attachments: Attachment[]): Attachment[] {
  return withImageGenPromptFallback(filterPromptVisibleAttachments(attachments));
}

function assetLoader(assetId: string): Promise<Buffer | null> {
  return Promise.resolve(assetId.startsWith("asset_") ? IMAGE_BYTES : null);
}

const VISION_GATE: VisionGateConfig = { hasVision: true, visionModel: "vm" };
const NO_VISION_GATE: VisionGateConfig = { hasVision: false, visionModel: "vm" };

describe("unseen history image policy (CA-1g)", () => {
  test("note emits one part per raw image/video and one warning per message, without loading assets", async () => {
    warningSpy = spyOn(console, "warn").mockImplementation(() => {});
    const load = mock(async () => { throw new Error("Notes must not load media"); });
    const parts = await resolveMultimodalContent({ role: "user", content: "Earlier", attachments: [
      rawImage(), { ...rawImage('clip'), type: "video", name: "clip.mp4", mimeType: "video/mp4" },
    ] }, NO_VISION_GATE, load, { unseenImagePolicy: "note" });
    expect(parts).toEqual([
      { type: "text", text: "Earlier" },
      { type: "text", text: "[Image attachment: img_1.png]\nThe current model cannot see this attachment and no description is available." },
      { type: "text", text: "[Image attachment: clip.mp4]\nThe current model cannot see this attachment and no description is available." },
    ]);
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith("[vision-gate] Undescribed history media replaced with notes: %s", "img_1.png, clip.mp4");
    expect(load).not.toHaveBeenCalled();
  });

  test("the default and explicit error policies still throw for raw images", async () => {
    for (const options of [undefined, { unseenImagePolicy: "error" as const }]) {
      await expect(resolveMultimodalContent({ role: "user", content: "Now", attachments: [rawImage()] }, NO_VISION_GATE, assetLoader, options)).rejects.toBeInstanceOf(VisionNotSupportedError);
    }
  });

  test("note does not change pixels or an available description", async () => {
    expect(await resolveMultimodalContent({ role: "user", content: "", attachments: [describedImage()] }, NO_VISION_GATE, assetLoader, { unseenImagePolicy: "note" })).toEqual([
      { type: "text", text: "[Image attachment: img_1.png]\nImage description: a red square" },
    ]);
    expect(await resolveMultimodalContent({ role: "user", content: "", attachments: [rawImage()] }, VISION_GATE, assetLoader, { unseenImagePolicy: "note" })).toEqual([
      { type: "image", image: IMAGE_BYTES, mediaType: "image/png" },
    ]);
  });

  test("the decision singles out the last user in the original input, including a single-message list", () => {
    const messages = [{ role: "system" }, { role: "user" }, { role: "assistant" }, { role: "user" }, { role: "system" }, { role: "assistant" }];
    expect(messages.map((_, index) => unseenImagePolicy(messages, index))).toEqual(["note", "note", "note", "error", "note", "note"]);
    expect(unseenImagePolicy([{ role: "user" }], 0)).toBe("error");
    expect(unseenImagePolicy([{ role: "system" }], 0)).toBe("note");
    expect(unseenImagePolicy([], 0)).toBe("note");
  });

  for (const providerType of ["openai_compat", "google"] as const) {
    test(`${providerType}: earlier image becomes a note after system reorder and current image still errors, including continuation/prefill`, async () => {
      const messages: SdkMessage[] = [
        { role: "system", content: "First system" },
        { role: "user", content: "Earlier", attachments: [rawImage()] },
        { role: "system", content: "Later system" },
        { role: "assistant", content: "Earlier reply" },
        { role: "user", content: "Now" },
      ];
      const before = structuredClone(messages);
      for (const extra of [{}, { continuationFallback: true }, { prefill: "Start" }]) {
        const options = { providerType, visionGate: NO_VISION_GATE, assetLoader, ...extra };
        const result = await prepareSdkMessages(messages, options);
        expect(result.conversationMessages.find((message) => Array.isArray(message.content))).toEqual({
          role: "user", content: [
            { type: "text", text: "Earlier" },
            { type: "text", text: "[Image attachment: img_1.png]\nThe current model cannot see this attachment and no description is available." },
          ],
        });
        if (extra.continuationFallback) expect(result.conversationMessages.at(-1)).toEqual({ role: "user", content: CONTINUATION_USER_INSTRUCTION });
        if (providerType === "google") expect(result.conversationMessages[0]).toEqual({ role: "system", content: "First system\n\nLater system" });
        const current: SdkMessage[] = messages.map((message) => message.role === "user"
          ? { ...message, attachments: message.content === "Now" ? [rawImage()] : undefined } : message);
        await expect(prepareSdkMessages(current, options)).rejects.toBeInstanceOf(VisionNotSupportedError);
      }
      expect(messages).toEqual(before);
    });
  }

  test("original indexes, not object identity, decide even when two entries reuse a message object", async () => {
    const repeated: SdkMessage = { role: "user", content: "Same", attachments: [rawImage()] };
    expect(unseenImagePolicy([repeated, repeated], 0)).toBe("note");
    expect(unseenImagePolicy([repeated, repeated], 1)).toBe("error");
    await expect(prepareSdkMessages([repeated, repeated], { providerType: "google", visionGate: NO_VISION_GATE, assetLoader })).rejects.toBeInstanceOf(VisionNotSupportedError);
  });
});

describe("vision-gate: exact image prompt characterization (CA-1b)", () => {
  test("non-vision described image flipped to file keeps its exact text parts", async () => {
    const parts = await resolveMultimodalContent(
      { role: "user", content: "look", attachments: [{ ...describedImage(), type: "file" }] },
      NO_VISION_GATE,
      async () => { throw new Error("A described image must not load its asset"); },
    );
    expect(parts).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: "[Attached file: img_1.png]\na red square" },
    ]);
  });

  test("vision image keeps its exact text and image parts", async () => {
    const parts = await resolveMultimodalContent(
      { role: "user", content: "look", attachments: [describedImage()] },
      VISION_GATE,
      assetLoader,
    );
    expect(parts).toEqual([
      { type: "text", text: "look" },
      { type: "image", image: IMAGE_BYTES, mediaType: "image/png" },
    ]);
  });
});

describe("vision-gate: text files from stored assets (CA-1b)", () => {
  function textFile(overrides: Partial<Attachment> = {}): Attachment {
    return {
      id: "file_1", assetId: "asset_file_1", type: "file", name: "notes.md",
      mimeType: "text/markdown", sizeBytes: 10, ...overrides,
    };
  }

  for (const gate of [NO_VISION_GATE, VISION_GATE]) {
    test(`all text MIMEs send full UTF-8 text and never pixels (hasVision=${gate.hasVision})`, async () => {
      const text = "  First line\nUnicode: \u00e9 \u65e5\nLast line  \n";
      for (const [mimeType, ext] of Object.entries(TEXT_MIME_TO_EXT)) {
        const attachment = textFile({ name: `notes.${ext}`, mimeType, sizeBytes: Buffer.byteLength(text) });
        const load = mock(async (_assetId: string) => Buffer.from(text));
        const parts = await resolveMultimodalContent(
          { role: "user", content: "read this", attachments: [attachment] }, gate, load,
        );
        expect(parts).toEqual([
          { type: "text", text: "read this" },
          { type: "text", text: `[Attached file: notes.${ext}]\n${text}` },
        ]);
        expect(load.mock.calls).toEqual([[attachment.assetId]]);
      }
    });
  }

  test("a generated 5 MiB file reaches the text part whole, without truncation", async () => {
    const text = "0123456789abcdef".repeat(5 * 1024 * 1024 / 16);
    const prefix = "[Attached file: notes.md]\n";
    const parts = await resolveMultimodalContent(
      { role: "user", content: "", attachments: [textFile({ sizeBytes: Buffer.byteLength(text) })] },
      NO_VISION_GATE, async () => Buffer.from(text),
    );
    expect(parts).toHaveLength(1);
    const part = parts[0];
    if (part?.type !== "text") throw new Error("Expected the full file as a TextPart");
    expect(part.text.length).toBe(prefix.length + 5 * 1024 * 1024);
    expect(part.text).toBe(prefix + text);
  });

  test("UTF-8 decoding strips a leading BOM", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("full text\n")]);
    const parts = await resolveMultimodalContent(
      { role: "user", content: "", attachments: [textFile()] },
      NO_VISION_GATE, async () => bytes,
    );
    expect(parts).toEqual([{ type: "text", text: "[Attached file: notes.md]\nfull text\n" }]);
  });

  test("a non-empty summary wins verbatim and never loads the asset on either gate", async () => {
    const load = mock(async () => { throw new Error("A summary must bypass asset loading"); });
    for (const gate of [NO_VISION_GATE, VISION_GATE]) {
      const parts = await resolveMultimodalContent(
        { role: "user", content: "", attachments: [textFile({ description: "  Summary\n  " })] },
        gate, load,
      );
      expect(parts).toEqual([{ type: "text", text: "[Attached file: notes.md]\n  Summary\n  " }]);
    }
    expect(load).not.toHaveBeenCalled();
  });

  test("null, absent and whitespace-only descriptions load the full file", async () => {
    for (const description of [undefined, null, " \t\n"]) {
      const parts = await resolveMultimodalContent(
        { role: "user", content: "", attachments: [textFile({ description })] },
        NO_VISION_GATE, async () => Buffer.from("stored text"),
      );
      expect(parts).toEqual([{ type: "text", text: "[Attached file: notes.md]\nstored text" }]);
    }
  });

  test("a missing file emits its placeholder without throwing on either gate", async () => {
    for (const gate of [NO_VISION_GATE, VISION_GATE]) {
      const parts = await resolveMultimodalContent(
        { role: "user", content: "read this", attachments: [textFile()] }, gate, async () => null,
      );
      expect(parts).toEqual([
        { type: "text", text: "read this" },
        { type: "text", text: "[Attached file: notes.md — file is no longer available]" },
      ]);
    }
  });

  test("an empty stored text file still emits its file header", async () => {
    const parts = await resolveMultimodalContent(
      { role: "user", content: "", attachments: [textFile({ sizeBytes: 0 })] },
      NO_VISION_GATE, async () => Buffer.alloc(0),
    );
    expect(parts).toEqual([{ type: "text", text: "[Attached file: notes.md]\n" }]);
  });

  test("assembly exclusion removes a file before the gate and never loads it", async () => {
    const load = mock(async () => { throw new Error("An excluded file must never load"); });
    for (const description of [undefined, "Excluded summary"]) {
      const parts = await resolveMultimodalContent(
        { role: "user", content: "read this", attachments: assemblyVisible([textFile({ includeInPrompt: false, description })]) },
        NO_VISION_GATE, load,
      );
      expect(parts).toEqual([{ type: "text", text: "read this" }]);
    }
    expect(load).not.toHaveBeenCalled();
  });

  test("non-text files keep described-only output and never load their assets", async () => {
    const load = mock(async () => { throw new Error("Non-text files must not load"); });
    const binary = textFile({ name: "document.pdf", mimeType: "application/pdf" });
    for (const gate of [NO_VISION_GATE, VISION_GATE]) {
      const parts = await resolveMultimodalContent(
        { role: "user", content: "", attachments: [binary, { ...binary, description: "A document" }] }, gate, load,
      );
      expect(parts).toEqual([{ type: "text", text: "[Attached file: document.pdf]\nA document" }]);
    }
    expect(load).not.toHaveBeenCalled();
  });

  test("user text comes first, then text files in attachment order", async () => {
    const parts = await resolveMultimodalContent(
      { role: "user", content: "read in order", attachments: [
        textFile({ assetId: "first", name: "first.md" }),
        textFile({ description: "second summary", name: "second.md" }),
        textFile({ assetId: "third", name: "third.md" }),
      ] },
      NO_VISION_GATE, async (assetId) => Buffer.from(`${assetId} text`),
    );
    expect(parts).toEqual([
      { type: "text", text: "read in order" },
      { type: "text", text: "[Attached file: first.md]\nfirst text" },
      { type: "text", text: "[Attached file: second.md]\nsecond summary" },
      { type: "text", text: "[Attached file: third.md]\nthird text" },
    ]);
  });
});

describe("vision-gate: resolveMultimodalContent routing", () => {
  test("vision primary + raw image → ImagePart", async () => {
    const parts = await resolveMultimodalContent(
      { role: "user", content: "look", attachments: [rawImage()] },
      VISION_GATE,
      assetLoader,
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", text: "look" });
    expect(parts[1]).toMatchObject({ type: "image" });
  });

  test("vision primary + DESCRIBED image → still ImagePart (description ignored)", async () => {
    // Regression guard: a vision model always wants the pixels, even when a
    // description has been persisted (for future non-vision rerolls). The old
    // bug routed described images to text unconditionally.
    const parts = await resolveMultimodalContent(
      { role: "user", content: "look", attachments: [describedImage()] },
      VISION_GATE,
      assetLoader,
    );
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ type: "image" });
    expect(parts.some((p) => p.type === "text" && /red square/.test(p.text))).toBe(false);
  });

  test("non-vision primary + DESCRIBED image → text only (no pixels)", async () => {
    // The headline fix: a persisted description must let a non-vision model
    // ingest a previously-sent image on every subsequent send, without the
    // gate throwing VisionNotSupportedError on the historical attachment.
    const parts = await resolveMultimodalContent(
      { role: "user", content: "look", attachments: [describedImage()] },
      NO_VISION_GATE,
      assetLoader,
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", text: "look" });
    expect(parts[1]).toMatchObject({ type: "text" });
    expect((parts[1] as { text: string }).text).toContain("a red square");
    expect(parts.some((p) => p.type === "image")).toBe(false);
  });

  test("non-vision primary + RAW image (no fallback ran) → VisionNotSupportedError", async () => {
    await expect(
      resolveMultimodalContent(
        { role: "user", content: "look", attachments: [rawImage()] },
        NO_VISION_GATE,
        assetLoader,
      ),
    ).rejects.toBeInstanceOf(VisionNotSupportedError);
  });

  test("non-vision primary + mixed described/raw → described as text, raw throws", async () => {
    // A described image must NOT be swallowed by the raw-image error path —
    // the error should still surface the undescribed one by name.
    await expect(
      resolveMultimodalContent(
        {
          role: "user",
          content: "look",
          attachments: [describedImage("img_done", "ok"), rawImage("img_raw")],
        },
        NO_VISION_GATE,
        assetLoader,
      ),
    ).rejects.toMatchObject({
      name: "VisionNotSupportedError",
      attachmentNames: ["img_raw.png"],
    });
  });

  test("described image survives multiple sends (DB-persisted description, type stays image)", async () => {
    // Simulates the exact bug conditions: long chat, user sent an image turns
    // ago, switched to a non-vision model. The DB has type:"image" + a
    // description. The gate must route it as text, not throw.
    const dbPersisted: Attachment = {
      ...rawImage("historical"),
      description: "a historical image of a cat",
    };
    const parts = await resolveMultimodalContent(
      { role: "user", content: "earlier turn", attachments: [dbPersisted] },
      NO_VISION_GATE,
      assetLoader,
    );
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    expect(text).toContain("a historical image of a cat");
    expect(parts.some((p) => p.type === "image")).toBe(false);
  });

  test("(f) non-vision primary + included slot with provenance.prompt → generation-prompt text, NO VisionNotSupportedError (IG-CF9)", async () => {
    // The slot bypasses the describe path (no description), so without the
    // assembly fallback the gate would throw on the rawImages branch. The
    // fallback backfills description from the slot's OWN generation prompt.
    const parts = await resolveMultimodalContent(
      { role: "user", content: "earlier turn", attachments: assemblyVisible([slotImage()]) },
      NO_VISION_GATE,
      assetLoader,
    );
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ type: "text" });
    expect((parts[1] as { text: string }).text).toContain("a lighthouse at dusk");
    expect(parts.some((p) => p.type === "image")).toBe(false);
  });

  test("(g) vision primary + included slot → image part as usual, fallback changes nothing (IG-CF9)", async () => {
    const parts = await resolveMultimodalContent(
      { role: "user", content: "earlier turn", attachments: assemblyVisible([slotImage()]) },
      VISION_GATE,
      assetLoader,
    );
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ type: "image" });
    expect(parts.some((p) => p.type === "text" && /lighthouse at dusk/.test(p.text))).toBe(false);
  });

  test("(h) excluded slot (includeInPrompt off) → nothing about it in parts (IG-CF9)", async () => {
    // The assembly filter drops the slot before the gate ever sees it — the
    // fallback must not resurrect it (it only backfills, never re-includes).
    const excluded = slotImage("slot_off", { includeInPrompt: false });
    expect(assemblyVisible([excluded])).toEqual([]);
    const parts = await resolveMultimodalContent(
      { role: "user", content: "earlier turn", attachments: assemblyVisible([excluded]) },
      NO_VISION_GATE,
      assetLoader,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text", text: "earlier turn" });
  });
});

describe("vision-gate: text-only attachment rendering (CA-1c2)", () => {
  const file: Attachment = {
    id: "file_1", assetId: "asset_file_1", type: "file", name: "notes.md",
    mimeType: "text/markdown", sizeBytes: 10,
  };
  const voice: Attachment = { ...file, type: "audio", name: "note.webm", mimeType: "audio/webm" };

  test("all accepted text MIMEs render full UTF-8 text, strip BOM and retain whitespace", async () => {
    const text = "  Full text\nUnicode: \u00e9 \u65e5\n  ";
    for (const mimeType of Object.keys(TEXT_MIME_TO_EXT)) {
      const load = mock(async (_id: string) => Buffer.from(`\uFEFF${text}`));
      expect(await renderAttachmentsAsText([{ ...file, mimeType }], load)).toEqual([`[Attached file: notes.md]\n${text}`]);
      expect(load.mock.calls).toEqual([[file.assetId]]);
    }
  });

  test("a 5 MiB file renders whole without truncation", async () => {
    const text = "x".repeat(5 * 1024 * 1024);
    expect(await renderAttachmentsAsText([file], async () => Buffer.from(text))).toEqual([`[Attached file: notes.md]\n${text}`]);
  });

  test("a summary is verbatim and never loads the asset", async () => {
    const load = mock(async () => { throw new Error("Summaries must not load bytes"); });
    expect(await renderAttachmentsAsText([{ ...file, description: "  Summary\n" }], load)).toEqual(["[Attached file: notes.md]\n  Summary\n"]);
    expect(load).not.toHaveBeenCalled();
  });

  test("missing assets and an omitted loader render the CA-1b placeholder", async () => {
    const expected = ["[Attached file: notes.md — file is no longer available]"];
    expect(await renderAttachmentsAsText([file], async () => null)).toEqual(expected);
    expect(await renderAttachmentsAsText([file])).toEqual(expected);
  });

  test("absent, null and blank summaries load full text; an empty file retains its header", async () => {
    for (const description of [undefined, null, " \t\n"]) {
      expect(await renderAttachmentsAsText([{ ...file, description }], async () => Buffer.alloc(0))).toEqual(["[Attached file: notes.md]\n"]);
    }
  });

  test("images and videos render names plus existing descriptions without loading bytes", async () => {
    const load = mock(async () => { throw new Error("Summary media must never load bytes"); });
    expect(await renderAttachmentsAsText([
      describedImage(), rawImage("raw"), { ...rawImage("blank"), description: " \t\n" },
      { ...rawImage(), type: "video", name: "clip.mp4", mimeType: "video/mp4", description: "  A clip\n" },
      { ...rawImage(), type: "video", name: "raw.mp4", mimeType: "video/mp4" },
    ], load)).toEqual([
      "[Attached image: img_1.png]\na red square", "[Attached image: raw.png]", "[Attached image: blank.png]",
      "[Attached video: clip.mp4]\n  A clip\n", "[Attached video: raw.mp4]",
    ]);
    expect(load).not.toHaveBeenCalled();
  });

  test("voice notes with explicit or legacy purpose render their transcript verbatim", async () => {
    for (const purpose of [undefined, "voice"] as const) {
      expect(await renderAttachmentsAsText([{ ...voice, purpose, description: "  Spoken words\n" }])).toEqual(["[Voice message: note.webm]\nTranscript:   Spoken words\n"]);
    }
  });

  test("old untranscribed voice notes emit nothing and never throw or load bytes", async () => {
    const load = mock(async () => { throw new Error("Summaries must not transcribe"); });
    for (const description of [undefined, null, "", " \t\n"]) {
      expect(await renderAttachmentsAsText([{ ...voice, description }], load)).toEqual([]);
    }
    expect(load).not.toHaveBeenCalled();
  });

  test("music and ambient audio remain playback-only even when described", async () => {
    const load = mock(async () => { throw new Error("Playback-only media must not load"); });
    for (const purpose of ["music", "ambient"] as const) {
      expect(await renderAttachmentsAsText([{ ...voice, purpose, description: "Do not send" }], load)).toEqual([]);
    }
    expect(load).not.toHaveBeenCalled();
  });

  test("non-text files remain described-only, in attachment order", async () => {
    const binary = { ...file, mimeType: "application/pdf", name: "document.pdf" };
    const load = mock(async () => { throw new Error("Non-text files must not load"); });
    expect(await renderAttachmentsAsText([binary, { ...binary, description: "A document" }, describedImage()], load)).toEqual([
      "[Attached file: document.pdf]\nA document", "[Attached image: img_1.png]\na red square",
    ]);
    expect(load).not.toHaveBeenCalled();
  });

  test("visibility stays in the existing upstream filter", async () => {
    const load = mock(async () => { throw new Error("Excluded files must not load"); });
    expect(await renderAttachmentsAsText(filterPromptVisibleAttachments([{ ...file, includeInPrompt: false }]), load)).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});

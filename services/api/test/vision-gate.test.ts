import { describe, expect, test } from "bun:test";
import {
  resolveMultimodalContent,
  VisionNotSupportedError,
  type VisionGateConfig,
} from "../src/infrastructure/ai/vision-gate.js";
import type { Attachment } from "@vibe-tavern/domain";
import { filterPromptVisibleAttachments, withImageGenPromptFallback } from "@vibe-tavern/domain";

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

import { describe, expect, test } from "bun:test";
import { transcribeAttachments, VoiceTranscribeUnavailableError } from "../src/infrastructure/ai/stt-gate.js";
import { resolveMultimodalContent, type VisionGateConfig } from "../src/infrastructure/ai/vision-gate.js";
import type { Attachment } from "@vibe-tavern/domain";

// STT_PLAN ST-6 — the stt-gate pin set. Two boundaries:
//  • transcribeAttachments: voice-only selection, transcript trimming, abort
//    between clips, missing asset → error.
//  • resolveMultimodalContent audio branch (imported from vision-gate, the
//    single assembly point): described voice note → the exact text part;
//    undescribed voice note → VoiceTranscribeUnavailableError; music/ambient
//    playback-only (never prompt-visible); no double-emit via the
//    otherAttachments path.

const AUDIO_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03]);

function voiceNote(id = "aud_1", description: string | null = null): Attachment {
  return {
    id,
    assetId: `asset_${id}`,
    type: "audio",
    purpose: "voice",
    durationMs: 4200,
    name: `${id}.webm`,
    mimeType: "audio/webm",
    sizeBytes: 4,
    description,
  };
}

function musicClip(id = "mus_1"): Attachment {
  return {
    ...voiceNote(id),
    purpose: "music",
    description: null,
  };
}

function assetLoader(assetId: string): Promise<Buffer | null> {
  return Promise.resolve(assetId.startsWith("asset_") ? AUDIO_BYTES : null);
}

const GATE: VisionGateConfig = { hasVision: true, visionModel: null };

describe("stt-gate: transcribeAttachments", () => {
  test("transcribes only voice notes; music/ambient skipped entirely", async () => {
    const seen: string[] = [];
    const transcripts = await transcribeAttachments(
      [voiceNote("v1"), musicClip("m1"), { ...voiceNote("a1"), purpose: "ambient" }],
      async (audio) => {
        seen.push(audio.fileName);
        return `heard ${audio.fileName}`;
      },
      assetLoader,
    );
    expect(seen).toEqual(["v1.webm"]);
    expect(transcripts.get("v1")).toBe("heard v1.webm");
    expect(transcripts.has("m1")).toBe(false);
    expect(transcripts.has("a1")).toBe(false);
  });

  test("absent purpose defaults to voice (the domain contract)", async () => {
    const note: Attachment = { ...voiceNote("nopurpose") };
    delete (note as { purpose?: Attachment["purpose"] }).purpose;
    const transcripts = await transcribeAttachments(
      [note],
      async () => "text",
      assetLoader,
    );
    expect(transcripts.get("nopurpose")).toBe("text");
  });

  test("transcript is trimmed; empty transcripts are kept as empty strings", async () => {
    const transcripts = await transcribeAttachments(
      [voiceNote("v1"), voiceNote("v2")],
      async (audio) => (audio.fileName === "v1.webm" ? "  hello  " : "   "),
      assetLoader,
    );
    expect(transcripts.get("v1")).toBe("hello");
    expect(transcripts.get("v2")).toBe("");
  });

  test("abort signal stops the loop between clips", async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    await expect(
      transcribeAttachments(
        [voiceNote("v1"), voiceNote("v2")],
        async (audio) => {
          seen.push(audio.fileName);
          return "text";
        },
        assetLoader,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([]);
  });

  test("missing asset throws with the attachment name", async () => {
    await expect(
      transcribeAttachments(
        [{ ...voiceNote("gone"), assetId: "missing" }],
        async () => "text",
        assetLoader,
      ),
    ).rejects.toThrow("gone.webm");
  });
});

describe("stt-gate: resolveMultimodalContent audio branch", () => {
  test("described voice note → [Voice message] text part (capability-independent)", async () => {
    const parts = await resolveMultimodalContent(
      {
        role: "user",
        content: "listen to this",
        attachments: [voiceNote("v1", "hello there")],
      },
      GATE,
      assetLoader,
    );
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    expect(text).toContain("listen to this");
    expect(text).toContain("[Voice message: v1.webm]\nTranscript: hello there");
    // never a native audio part — the transcript is the only prompt form
    expect(parts.some((p) => p.type === "audio")).toBe(false);
  });

  test("undescribed voice note → VoiceTranscribeUnavailableError naming the clip", async () => {
    expect.assertions(2);
    try {
      await resolveMultimodalContent(
        { role: "user", content: "hi", attachments: [voiceNote("raw")] },
        GATE,
        assetLoader,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceTranscribeUnavailableError);
      expect((err as VoiceTranscribeUnavailableError).attachmentNames).toEqual(["raw.webm"]);
    }
  });

  test("music clip is playback-only: no transcript part, no error, not double-emitted", async () => {
    const parts = await resolveMultimodalContent(
      {
        role: "user",
        content: "vibe",
        attachments: [musicClip("m1"), { ...musicClip("m2"), description: "stray text" }],
      },
      GATE,
      assetLoader,
    );
    // Both music clips are invisible to the prompt — even one carrying a stray
    // description must not emit through the otherAttachments path (audio is
    // excluded there; playback-only means prompt-silent).
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    expect(text).toBe("vibe");
    expect(parts).toHaveLength(1);
  });

  test("described voice note emits exactly once (no otherAttachments double-emit)", async () => {
    const parts = await resolveMultimodalContent(
      { role: "user", content: "x", attachments: [voiceNote("v1", "say it once")] },
      GATE,
      assetLoader,
    );
    const occurrences = parts.filter(
      (p) => p.type === "text" && p.text.includes("Transcript: say it once"),
    ).length;
    expect(occurrences).toBe(1);
  });
});

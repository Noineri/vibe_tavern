import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROXY_MODE, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { resetProviderFetchFactory, setProviderFetchFactory, type ProviderFetch } from "../src/domain/providers/provider-fetch-factory.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { wrapProviderExecutionError } from "../src/infrastructure/ai/provider-error-wrapper.js";
import { VoiceTranscribeUnavailableError } from "../src/infrastructure/ai/stt-gate.js";
import { VisionNotSupportedError } from "../src/infrastructure/ai/vision-gate.js";
import type { Attachment } from "@vibe-tavern/domain";

// STT_PLAN ST-6 — executor-boundary pin set. Drives the REAL
// nonstreamingProviderExecute with a stub provider fetch and a stub voice
// transcriber, mirroring the plan's self-check: transcript persisted through
// onAttachmentDescriptions, the [Voice message] text part present in the
// request the provider actually receives, music clips never transcribed, and
// the honest configuration error passing through the error wrapper unwrapped
// (so the route's instanceof 422 catch can fire).

const AUDIO_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03]);

function voiceNote(id: string): Attachment {
  return {
    id,
    assetId: `asset_${id}`,
    type: "audio",
    purpose: "voice",
    durationMs: 1500,
    name: `${id}.webm`,
    mimeType: "audio/webm",
    sizeBytes: 4,
    description: null,
  };
}

function musicClip(id: string): Attachment {
  return { ...voiceNote(id), purpose: "music" };
}

/** Captured outbound chat-completions request bodies. */
let capturedBodies: string[] = [];

function stubProviderFetch(): ProviderFetch {
  const fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 0,
        model: "stub-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as ProviderFetch;
  return fetch;
}

function capturingFetch(): ProviderFetch {
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    capturedBodies.push(String(init?.body ?? ""));
    return stubProviderFetch()();
  }) as unknown as ProviderFetch;
  return fetch;
}

const PROFILE = {
  id: "prof_st6",
  name: "st6",
  providerPreset: "openai",
  endpoint: "https://x.test/v1",
  apiKey: null,
  defaultModel: "stub-model",
  visionModel: null,
  proxyMode: PROXY_MODE.inherit,
  proxyId: null,
  maxTokens: 512,
  temperature: 1,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  stopSequences: [],
} as unknown as StoredProviderProfileRecord;

function makeInput(overrides: Partial<ProviderExecutionInput>): ProviderExecutionInput {
  return {
    profile: PROFILE,
    model: "stub-model",
    prompt: {
      finalPayload: {
        messages: [
          { role: "user", content: "listen", attachments: overrides.prompt ? [] : undefined },
        ],
      },
    },
    ...overrides,
  } as unknown as ProviderExecutionInput;
}

beforeEach(() => {
  capturedBodies = [];
  setProviderFetchFactory({ resolveFetch: async () => capturingFetch() });
});

afterEach(() => {
  resetProviderFetchFactory();
});

describe("ST-6 executor: voice-note transcription wiring", () => {
  test("transcript persisted via onAttachmentDescriptions and sent as a [Voice message] text part", async () => {
    const transcribed: string[] = [];
    const persisted: Array<{ attachmentId: string; description: string }> = [];

    const result = await nonstreamingProviderExecute(
      makeInput({
        prompt: {
          finalPayload: {
            messages: [
              { role: "user", content: "listen", attachments: [voiceNote("v1")] },
            ],
          },
        } as unknown as ProviderExecutionInput["prompt"],
        voiceTranscriber: async (audio) => {
          transcribed.push(audio.fileName);
          return { transcript: "hello from the clip" };
        },
        assetLoader: (assetId) => Promise.resolve(assetId.startsWith("asset_") ? AUDIO_BYTES : null),
        onAttachmentDescriptions: async (descriptions) => {
          persisted.push(...descriptions);
        },
      }),
    );

    expect(result.text).toBe("ok");
    // 1. The transcriber saw only the voice note.
    expect(transcribed).toEqual(["v1.webm"]);
    // 2. The transcript persisted through the shared seam.
    expect(persisted).toEqual([{ attachmentId: "v1", description: "hello from the clip" }]);
    // 3. The provider request carries the transcript as a text part.
    const body = capturedBodies.join("");
    expect(body).toContain("[Voice message: v1.webm]");
    expect(body).toContain("Transcript: hello from the clip");
  });

  test("ST-7: tone annotation rides the persisted description and the prompt text part", async () => {
    const persisted: Array<{ attachmentId: string; description: string }> = [];

    await nonstreamingProviderExecute(
      makeInput({
        prompt: {
          finalPayload: {
            messages: [
              { role: "user", content: "listen", attachments: [voiceNote("v1")] },
            ],
          },
        } as unknown as ProviderExecutionInput["prompt"],
        voiceTranscriber: async () => ({ transcript: "я не могу больше", annotation: "дрожит, сбивчиво" }),
        assetLoader: (assetId) => Promise.resolve(assetId.startsWith("asset_") ? AUDIO_BYTES : null),
        onAttachmentDescriptions: async (descriptions) => {
          persisted.push(...descriptions);
        },
      }),
    );

    // The composed description (transcript + bracketed tone line) persists…
    expect(persisted).toEqual([
      { attachmentId: "v1", description: "я не могу больше\n[Voice tone: дрожит, сбивчиво]" },
    ]);
    // …and the prompt text part carries it verbatim — the character reacts to
    // HOW it was said, not only WHAT was said.
    const body = capturedBodies.join("");
    expect(body).toContain("Transcript: я не могу больше");
    expect(body).toContain("[Voice tone: дрожит, сбивчиво]");
  });

  test("music clip rides the same message but is never transcribed nor prompt-visible", async () => {
    const transcribed: string[] = [];
    const persisted: Array<{ attachmentId: string; description: string }> = [];

    await nonstreamingProviderExecute(
      makeInput({
        prompt: {
          finalPayload: {
            messages: [
              { role: "user", content: "vibe", attachments: [voiceNote("v1"), musicClip("m1")] },
            ],
          },
        } as unknown as ProviderExecutionInput["prompt"],
        voiceTranscriber: async (audio) => {
          transcribed.push(audio.fileName);
          return { transcript: "words" };
        },
        assetLoader: (assetId) => Promise.resolve(assetId.startsWith("asset_") ? AUDIO_BYTES : null),
        onAttachmentDescriptions: async (descriptions) => {
          persisted.push(...descriptions);
        },
      }),
    );

    expect(transcribed).toEqual(["v1.webm"]);
    expect(persisted.map((d) => d.attachmentId)).toEqual(["v1"]);
    const body = capturedBodies.join("");
    expect(body).toContain("Transcript: words");
    expect(body).not.toContain("m1.webm");
  });

  test("voice note without a transcriber → VoiceTranscribeUnavailableError (unwrapped)", async () => {
    expect.assertions(1);
    try {
      await nonstreamingProviderExecute(
        makeInput({
          prompt: {
            finalPayload: {
              messages: [
                { role: "user", content: "listen", attachments: [voiceNote("v1")] },
              ],
            },
          } as unknown as ProviderExecutionInput["prompt"],
          assetLoader: (assetId) => Promise.resolve(assetId.startsWith("asset_") ? AUDIO_BYTES : null),
        }),
      );
    } catch (err) {
      // Unwrapped — the route's instanceof catch must see the real class.
      expect(err).toBeInstanceOf(VoiceTranscribeUnavailableError);
    }
  });

  test("empty transcript is treated as a failed transcription (honest error)", async () => {
    expect.assertions(1);
    try {
      await nonstreamingProviderExecute(
        makeInput({
          prompt: {
            finalPayload: {
              messages: [
                { role: "user", content: "listen", attachments: [voiceNote("v1")] },
              ],
            },
          } as unknown as ProviderExecutionInput["prompt"],
          voiceTranscriber: async () => ({ transcript: "   " }),
          assetLoader: (assetId) => Promise.resolve(assetId.startsWith("asset_") ? AUDIO_BYTES : null),
        }),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceTranscribeUnavailableError);
    }
  });
});

describe("ST-6: wrapProviderExecutionError passthrough", () => {
  test("typed gate errors pass through unwrapped (route instanceof contract)", () => {
    const voice = new VoiceTranscribeUnavailableError(["a.webm"]);
    expect(wrapProviderExecutionError(voice, "openai")).toBe(voice);

    const vision = new VisionNotSupportedError(["a.png"]);
    expect(wrapProviderExecutionError(vision, "openai")).toBe(vision);
  });

  test("ordinary errors still wrap into ProviderExecutionError", () => {
    const wrapped = wrapProviderExecutionError(new Error("boom"), "openai");
    expect(wrapped.name).toBe("ProviderExecutionError");
    expect((wrapped as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });
});

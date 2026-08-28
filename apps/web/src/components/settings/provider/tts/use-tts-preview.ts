/**
 * TTS voice preview hook (TTS_PLAN TS-7d; F1: draft contract).
 *
 * "Say a test sentence with this voice" — verifies any backend in isolation
 * from the profile editor, BEFORE saving/binding. Semantics (locked):
 *  - kokoro → fully client-side synthesis from CURRENT FORM VALUES (works for
 *    a brand-new unsaved profile — the model download is shared with the
 *    narration lane via getSharedKokoroClient);
 *  - server backends (openai-compat / gemini / elevenlabs) → POST
 *    /api/tts/draft/preview with the CURRENT FORM CONFIG (transient key,
 *    never persisted) — works for unsaved profiles AND previews the exact
 *    values on screen, including unsaved edits (no save-to-test detour).
 *
 * Preview audio is a short-lived independent <audio> element — deliberately
 * NOT the playback store's player singleton — and starting a preview first
 * stops the narration lane so the two never overlap.
 */

import { useCallback, useRef, useState } from "react";

import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { previewTtsDraft } from "../../../../api/tts-api.js";
import { ensureSharedKokoroModel, getSharedKokoroClient } from "../../../../lib/tts/kokoro/kokoro-client-instance.js";
import { useTtsPlaybackStore } from "../../../../stores/tts-playback-store.js";

/** Fixed test sentences — intentionally NOT localized. */
const TTS_PREVIEW_SENTENCE = "Hello! This is a preview of the selected voice.";
const TTS_PREVIEW_SENTENCE_DUAL = 'Hello! This is the narrator. "And this is the character."';

export type TtsPreviewState = "idle" | "generating" | "playing";

export interface TtsPreviewInput {
  backend: TtsBackendSlug;
  voiceId: string;
  /** Optional narrator voice — when set, the preview sample includes a quoted span
   *  so the character voice reads the quoted part and the narrator reads the rest. */
  narratorVoiceId?: string | null;
  speed: number;
  /** Required for server backends: the CURRENT form config (transient —
   *  sent to the draft endpoint once, never persisted). Kokoro synthesizes
   *  from form values client-side and ignores it. */
  config: Record<string, unknown> | null;
  /** Saved-profile id for stored-key resolution (F2b): when the transient
   *  config carries no apiKey (strip-on-read form) and this id matches the
   *  saved row (same backend/endpoint), the server injects the stored key
   *  for this one preview. Optional — new profiles send none. */
  profileId?: string | null;
}

export interface TtsPreviewDeps {
  synthesize(input: TtsPreviewInput): Promise<{ blob: Blob; mime: string }>;
  play(blob: Blob, mime: string): Promise<void>;
  /** Optional: kokoro model-download progress (percent 0-100, null when the
   *  payload carries no percent — e.g. transformers "initiate"/"done"
   *  events). The hook shows "Downloading model… N%" while generating. */
  subscribeLoadProgress?(cb: (pct: number | null) => void): () => void;
}

/** Extracts the percent from an opaque transformers.js progress payload
 *  ({status:"progress", file, progress: 0-100, …}) — null when absent. */
function readProgressPercent(data: unknown): number | null {
  if (typeof data !== "object" || data === null || !("progress" in data)) return null;
  const value = data.progress;
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function defaultSubscribeLoadProgress(cb: (pct: number | null) => void): () => void {
  return getSharedKokoroClient().onLoadProgress((progress) => cb(readProgressPercent(progress.data)));
}

let depsOverride: TtsPreviewDeps | null = null;

/** Test seam: replace synthesize/play. Pass null to restore defaults. */
export function __setTtsPreviewDepsForTests(deps: TtsPreviewDeps | null): void {
  depsOverride = deps;
}

async function defaultSynthesize(input: TtsPreviewInput): Promise<{ blob: Blob; mime: string }> {
  if (input.backend === TTS_BACKEND.Kokoro) {
    const client = await ensureSharedKokoroModel();
    const hasNarrator = typeof input.narratorVoiceId === "string" && input.narratorVoiceId.trim() !== "";
    if (hasNarrator) {
      const out = await client.generateChunked(
        [
          { text: "Hello! This is the narrator. ", voiceId: input.narratorVoiceId as string },
          { text: '"And this is the character."', voiceId: input.voiceId },
        ],
        input.speed,
      );
      return { blob: out.blob, mime: "audio/wav" };
    }
    const out = await client.generate(TTS_PREVIEW_SENTENCE, input.voiceId, input.speed);
    return { blob: out.blob, mime: "audio/wav" };
  }
  // Defense-in-depth: the editor always passes the form config, but the
  // draft endpoint needs it — refuse instead of casting a null.
  if (input.config === null) {
    throw new Error("Preview requires the form config for server backends.");
  }
  const hasNarrator = typeof input.narratorVoiceId === "string" && input.narratorVoiceId.trim() !== "";
  return previewTtsDraft({
    backend: input.backend,
    config: input.config,
    profileId: input.profileId ?? undefined,
    voiceId: input.voiceId,
    text: hasNarrator ? TTS_PREVIEW_SENTENCE_DUAL : TTS_PREVIEW_SENTENCE,
    speed: input.speed,
  });
}

/** One-shot element playback; resolves on `ended`, rejects on media error or
 *  a rejected play() (autoplay policy). The object URL is ALWAYS revoked. */
async function defaultPlay(blob: Blob, _mime: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown): void => {
        if (settled) return;
        settled = true;
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        if (error === undefined) resolve();
        else reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onEnded = (): void => finish(undefined);
      const onError = (): void => finish(new Error("Audio playback failed."));
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      audio.play().catch((cause: unknown) => {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function useTtsPreview(): {
  state: TtsPreviewState;
  error: string | null;
  /** Kokoro model-download percent while generating; null = not downloading. */
  downloadPct: number | null;
  preview(input: TtsPreviewInput): void;
} {
  const [state, setState] = useState<TtsPreviewState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const busyRef = useRef(false);

  const preview = useCallback((input: TtsPreviewInput): void => {
    // Last call wins is not needed beyond this guard: the button is disabled
    // while generating/playing, and a stray call mid-flight is ignored.
    if (busyRef.current) return;
    // Server backends need the form config for the transient draft request —
    // unreachable via the editor, but never send a null config to the API.
    if (input.backend !== TTS_BACKEND.Kokoro && input.config === null) {
      setError("Missing form config for server backends.");
      return;
    }
    busyRef.current = true;
    setError(null);
    setState("generating");
    setDownloadPct(null);
    // A preview must never overlap chat narration — stop the lane first.
    useTtsPlaybackStore.getState().stopNarration();
    const deps = depsOverride ?? { synthesize: defaultSynthesize, play: defaultPlay };
    const unsubscribe = deps.subscribeLoadProgress?.(setDownloadPct) ?? null;
    void (async () => {
      try {
        const { blob, mime } = await deps.synthesize(input);
        setState("playing");
        await deps.play(blob, mime);
        setState("idle");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setState("idle");
      } finally {
        unsubscribe?.();
        setDownloadPct(null);
        busyRef.current = false;
      }
    })();
  }, []);

  return { state, error, downloadPct, preview };
}

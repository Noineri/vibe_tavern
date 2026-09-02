/**
 * Dictation orchestration hook (STT_PLAN ST-4b): push-to-talk in the chat
 * input. Owns the recorder + transcriber state machine
 * (idle → recording → transcribing → idle | error) and hands the finished
 * transcript to the caller; WHAT the transcript does to the draft is the
 * caller's mode decision (`applyDictationTranscript`).
 *
 * The transcriber and recorder are injectable seams — tests run without a
 * microphone, MediaRecorder, or the whisper worker. The default transcriber
 * branches on the active profile's backend: whisper-browser goes through the
 * shared in-browser engine (one worker, one model, app lifetime), openai-compat
 * posts the clip to `/api/stt/transcribe` (server-side key resolution).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { SttProfileRecord } from "../../api/stt-api.js";
import { transcribeSttAudio } from "../../api/stt-api.js";
import { ensureSharedWhisperModel } from "../../lib/stt/whisper-client-instance.js";
import {
  createVoiceRecorder,
  VoiceRecorderError,
  type VoiceRecorder,
} from "../../lib/stt/voice-recorder.js";
import type { DictationMode } from "../../lib/stt/dictation-settings.js";

export type DictationStatus = "idle" | "recording" | "transcribing" | "error";

/** The i18n keys the error state can carry (t() keys are strict — a typed
 *  union, not a free string). */
export type DictationErrorKey =
  | "dictation_error_permission"
  | "dictation_error_unsupported"
  | "dictation_error_recorder"
  | "dictation_error_transcribe";

export type DictationTranscriber = (profile: SttProfileRecord, blob: Blob) => Promise<string>;

/** The default transcriber: backend branch per the active profile. */
async function defaultTranscriber(profile: SttProfileRecord, blob: Blob): Promise<string> {
  if (profile.backend === "whisper-browser") {
    const modelId = typeof profile.config.model === "string" ? profile.config.model : "";
    if (modelId === "") throw new Error("The profile has no whisper model selected.");
    const client = await ensureSharedWhisperModel(modelId);
    const language =
      typeof profile.config.language === "string" && profile.config.language !== ""
        ? profile.config.language
        : undefined;
    const result = await client.transcribeBlob(blob, { language });
    return result;
  }
  const language =
    typeof profile.config.language === "string" && profile.config.language !== ""
      ? profile.config.language
      : undefined;
  const result = await transcribeSttAudio(profile.id, blob, language);
  return result.text;
}

export interface UseDictationOptions {
  /** The resolved active dictation profile; null disables the hook. */
  profile: SttProfileRecord | null;
  /** Receives each finished transcript (the caller applies the mode). */
  onTranscript: (text: string) => void;
  transcriber?: DictationTranscriber;
  recorderFactory?: () => VoiceRecorder;
}

/** Map recorder/transcriber failures to typed i18n keys. */
export function dictationErrorTextKey(error: unknown): DictationErrorKey {
  if (error instanceof VoiceRecorderError) {
    if (error.code === "permission") return "dictation_error_permission";
    if (error.code === "unsupported") return "dictation_error_unsupported";
    return "dictation_error_recorder";
  }
  return "dictation_error_transcribe";
}

export function useDictation(options: UseDictationOptions): {
  status: DictationStatus;
  /** Non-null while status === "error" — an i18n KEY (typed), not literal text. */
  errorKey: DictationErrorKey | null;
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
} {
  const { profile, onTranscript } = options;
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [errorKey, setErrorKey] = useState<DictationErrorKey | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const transcriber = options.transcriber ?? defaultTranscriber;
  const transcriberRef = useRef(transcriber);
  transcriberRef.current = transcriber;
  const recorderFactory = options.recorderFactory ?? createVoiceRecorder;
  const recorderFactoryRef = useRef(recorderFactory);
  recorderFactoryRef.current = recorderFactory;

  const start = useCallback(async () => {
    if (recorderRef.current?.isActive()) return;
    setErrorKey(null);
    const recorder = recorderFactoryRef.current();
    try {
      await recorder.start();
      recorderRef.current = recorder;
      setStatus("recording");
    } catch (cause) {
      setStatus("error");
      setErrorKey(dictationErrorTextKey(cause));
    }
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder?.isActive()) return;
    setStatus("transcribing");
    void recorder
      .stop()
      .then(async (blob) => {
        if (profile === null) throw new Error("No active dictation profile.");
        const text = (await transcriberRef.current(profile, blob)).trim();
        if (text !== "") onTranscriptRef.current(text);
        setStatus("idle");
      })
      .catch((cause: unknown) => {
        setStatus("error");
        setErrorKey(dictationErrorTextKey(cause));
      });
  }, [profile]);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setStatus("idle");
    setErrorKey(null);
  }, []);

  // Unmount safety: release the mic if a recording is somehow still open.
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
    };
  }, []);

  return { status, errorKey, start, stop, cancel };
}

/** Pure mode application: what a transcript does to the current draft.
 *  - replace / auto-send: the transcript REPLACES the draft (auto-send then
 *    fires the send in the caller);
 *  - append: joined onto the draft with a single space (a trailing
 *    separator already present is respected).
 *  A trimmed-empty transcript never reaches here (the hook drops it). */
export function applyDictationTranscript(text: string, mode: DictationMode, currentDraft: string): string {
  if (mode !== "append") return text;
  if (currentDraft === "") return text;
  if (/\s$/.test(currentDraft)) return currentDraft + text;
  return `${currentDraft} ${text}`;
}

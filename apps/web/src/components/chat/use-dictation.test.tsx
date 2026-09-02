/**
 * Dictation hook tests (STT_PLAN ST-4b): the recorder→transcriber→transcript
 * state machine with BOTH seams faked (no mic, no worker, no network) and
 * the pure `applyDictationTranscript` mode rules.
 */

import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import type { SttProfileRecord } from "../../api/stt-api.js";
import type { VoiceRecorder } from "../../lib/stt/voice-recorder.js";
import { VoiceRecorderError } from "../../lib/stt/voice-recorder.js";
import { applyDictationTranscript, useDictation, type DictationTranscriber } from "./use-dictation.js";

function makeProfile(overrides: Partial<SttProfileRecord> = {}): SttProfileRecord {
  return {
    id: "stt-1",
    name: "Whisper",
    backend: "whisper-browser",
    config: { model: "onnx-community/whisper-base" },
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    emotionAnnotation: false,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Fake recorder: manual stop() control so each test drives the timing. */
function makeFakeRecorder(options?: { blob?: Blob; startError?: Error }) {
  let active = false;
  let fakeDeliver: (() => void) | null = null;
  const instance: VoiceRecorder & { deliverStop(): void } = {
    async start() {
      if (options?.startError) throw options.startError;
      active = true;
    },
    stop() {
      active = false;
      return new Promise<Blob>((resolve) => {
        fakeDeliver = () => resolve(options?.blob ?? new Blob(["x"], { type: "audio/webm" }));
      });
    },
    cancel() {
      active = false;
    },
    isActive() {
      return active;
    },
    deliverStop() {
      fakeDeliver?.();
    },
  };
  return instance;
}

function setup(
  options?: Partial<{ transcriber: DictationTranscriber; recorder: ReturnType<typeof makeFakeRecorder> }>,
) {
  const recorder = options?.recorder ?? makeFakeRecorder();
  const transcripts: string[] = [];
  const transcriber =
    options?.transcriber ??
    (mock(async (_profile: SttProfileRecord, _blob: Blob) => "расшифровано") as unknown as DictationTranscriber);
  const hook = renderHook(() =>
    useDictation({
      profile: makeProfile(),
      onTranscript: (text) => {
        transcripts.push(text);
      },
      transcriber,
      recorderFactory: () => recorder,
    }),
  );
  return { hook, recorder, transcripts, transcriber };
}

describe("applyDictationTranscript (pure mode rules)", () => {
  test("append onto an empty draft", () => {
    expect(applyDictationTranscript("привет", "append", "")).toBe("привет");
  });

  test("append joins with a single space", () => {
    expect(applyDictationTranscript("мир", "append", "привет")).toBe("привет мир");
  });

  test("append respects an existing trailing separator (no double space)", () => {
    expect(applyDictationTranscript("мир", "append", "привет ")).toBe("привет мир");
    expect(applyDictationTranscript("мир", "append", "привет\n")).toBe("привет\nмир");
  });

  test("replace / auto-send replace the draft", () => {
    expect(applyDictationTranscript("новый текст", "replace", "старый")).toBe("новый текст");
    expect(applyDictationTranscript("новый текст", "auto-send", "старый")).toBe("новый текст");
  });
});

describe("useDictation state machine", () => {
  test("start → recording; stop → transcribing → idle with the transcript", async () => {
    const { hook, recorder, transcripts } = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("recording");
    expect(recorder.isActive()).toBe(true);

    await act(async () => {
      hook.result.current.stop();
    });
    expect(hook.result.current.status).toBe("transcribing");
    await act(async () => {
      recorder.deliverStop();
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe("idle");
    });
    expect(transcripts).toEqual(["расшифровано"]);
  });

  test("cancel discards: no transcription, back to idle", async () => {
    const { hook } = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    act(() => {
      hook.result.current.cancel();
    });
    expect(hook.result.current.status).toBe("idle");
  });

  test("start failure (permission) → error state with the permission i18n key", async () => {
    const recorder = makeFakeRecorder({
      startError: new VoiceRecorderError("permission", "denied"),
    });
    const { hook } = setup({ recorder });
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.errorKey).toBe("dictation_error_permission");
  });

  test("transcriber failure → error state with the transcribe i18n key", async () => {
    const recorder = makeFakeRecorder();
    const transcriber = (async () => {
      throw new Error("upstream 502");
    }) as unknown as DictationTranscriber;
    const { hook } = setup({ recorder, transcriber });
    await act(async () => {
      await hook.result.current.start();
    });
    await act(async () => {
      hook.result.current.stop();
      recorder.deliverStop();
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe("error");
    });
    expect(hook.result.current.errorKey).toBe("dictation_error_transcribe");
  });

  test("an all-whitespace transcript is dropped (no callback, clean idle)", async () => {
    const recorder = makeFakeRecorder();
    const transcriber = (async () => "   ") as unknown as DictationTranscriber;
    const { hook, transcripts } = setup({ recorder, transcriber });
    await act(async () => {
      await hook.result.current.start();
    });
    await act(async () => {
      hook.result.current.stop();
      recorder.deliverStop();
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe("idle");
    });
    expect(transcripts).toEqual([]);
  });
});

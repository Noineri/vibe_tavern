/**
 * Voice recorder tests (STT_PLAN ST-4b): mime negotiation + the platform
 * wrapper against fakes (happy-dom has no MediaRecorder/getUserMedia).
 */

import { describe, expect, test } from "bun:test";

import { createVoiceRecorder, pickRecorderMime, VoiceRecorderError, type RecorderLike } from "./voice-recorder.js";

describe("pickRecorderMime", () => {
  test("webm/opus wins when supported", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm;codecs=opus");
  });

  test("falls back to ogg/opus, then plain webm, then undefined", () => {
    expect(pickRecorderMime((t) => t === "audio/ogg;codecs=opus")).toBe("audio/ogg;codecs=opus");
    expect(pickRecorderMime((t) => t === "audio/webm")).toBe("audio/webm");
    expect(pickRecorderMime(() => false)).toBeUndefined();
  });
});

function fakeRecorderThat(): RecorderLike & { fireData(data: Blob): void; fireStop(): void } {
  let onData: ((event: { data: Blob }) => void) | null = null;
  let onStop: (() => void) | null = null;
  return {
    mimeType: "audio/webm;codecs=opus",
    start() {},
    stop() {},
    get ondataavailable() {
      return onData;
    },
    set ondataavailable(handler) {
      onData = handler;
    },
    get onstop() {
      return onStop;
    },
    set onstop(handler) {
      onStop = handler;
    },
    onerror: null,
    fireData(data: Blob) {
      onData?.({ data });
    },
    fireStop() {
      onStop?.();
    },
  };
}

describe("createVoiceRecorder", () => {
  test("happy path: start captures, stop resolves the assembled blob", async () => {
    let created: (RecorderLike & { fireData(b: Blob): void; fireStop(): void }) | null = null;
    const stream = { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    const recorder = createVoiceRecorder({
      getUserMedia: async () => stream,
      createRecorder: () => {
        created = fakeRecorderThat();
        return created;
      },
    });
    await recorder.start();
    expect(recorder.isActive()).toBe(true);

    const blobPromise = recorder.stop();
    created!.fireData(new Blob(["ab"], { type: "audio/webm" }));
    created!.fireData(new Blob(["cd"], { type: "audio/webm" }));
    created!.fireStop();
    const blob = await blobPromise;
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(blob.size).toBe(4);
    expect(recorder.isActive()).toBe(false);
  });

  test("permission denial maps to the permission error code", async () => {
    const recorder = createVoiceRecorder({
      getUserMedia: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
      createRecorder: () => fakeRecorderThat(),
    });
    const error = await recorder.start().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
    expect((error as VoiceRecorderError).code).toBe("permission");
  });

  test("cancel discards the take and releases the mic; a later stop() rejects", async () => {
    let created: (RecorderLike & { fireData(b: Blob): void; fireStop(): void }) | null = null;
    const stream = { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    const recorder = createVoiceRecorder({
      getUserMedia: async () => stream,
      createRecorder: () => {
        created = fakeRecorderThat();
        return created;
      },
    });
    await recorder.start();
    recorder.cancel();
    expect(recorder.isActive()).toBe(false);
    const error = await recorder.stop().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
  });
});

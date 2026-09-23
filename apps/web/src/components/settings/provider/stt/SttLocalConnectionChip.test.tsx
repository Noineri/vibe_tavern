import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// House i18n test pattern (SttSection.test.tsx): raw keys render as-is.
const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { render, act, cleanup } = await import("@testing-library/react");

// IG-CF12d/12e: the chip's honest ping — moved verbatim from
// SttLocalServerPanel.test.tsx when the chip left the provider card (same
// boundary, new home; the chip is a standalone component now). Deterministic
// per test (default: an empty successful catalog); leak-safe ...real.
let listModelsNext: unknown[] | Error = [];
const listModelsMock = mock(async () => {
  if (listModelsNext instanceof Error) throw listModelsNext;
  return listModelsNext;
});
const realSttApi = await import("../../../../api/stt-api.js");
mock.module("../../../../api/stt-api.js", () => ({
  ...realSttApi,
  listSttDraftModels: listModelsMock,
}));

const { SttLocalConnectionChip } = await import("./SttLocalConnectionChip.js");
const { STT_BACKENDS } = await import("@vibe-tavern/domain");
import type { SttProfileForm } from "./use-stt-profiles.js";

function openaiForm(): SttProfileForm {
  return {
    id: null,
    name: "",
    backend: STT_BACKENDS.OpenAiCompat,
    config: { endpoint: "", model: "" },
    apiKey: "",
    autoKeyProviderName: null,
    hasStoredApiKey: false,
    emotionAnnotation: false,
  };
}

function whisperCppForm(): SttProfileForm {
  return {
    id: null,
    name: "",
    backend: STT_BACKENDS.WhisperCpp,
    config: { endpoint: "" },
    apiKey: "",
    autoKeyProviderName: null,
    hasStoredApiKey: false,
    emotionAnnotation: false,
  };
}

function renderChip(form: SttProfileForm) {
  return render(<SttLocalConnectionChip form={form} />);
}

describe("SttLocalConnectionChip — outside-the-card status chip (IG-CF12e; honest endpoint ping since CF12d)", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    listModelsNext = [];
    listModelsMock.mockClear();
  });

  test("empty endpoint → UNKNOWN and no ping fires", () => {
    const view = renderChip(openaiForm());
    const chip = view.getByTestId("stt-local-status");
    expect(chip.className).toContain("border-border2");
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  test("endpoint answers → ONLINE; dead endpoint → OFFLINE (docker-green antipattern dead on STT too)", async () => {
    const form = { ...openaiForm(), config: { endpoint: "http://127.0.0.1:8000/v1", model: "" } };
    const view = renderChip(form);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("stt-local-status").className).toContain("border-success/30");
    view.unmount();

    listModelsNext = new Error("STT draft model list failed: 502");
    const view2 = renderChip(form);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view2.getByTestId("stt-local-status").className).toContain("border-danger/30");
  });

  test("the re-check button re-pings the endpoint (NOT the port scan)", async () => {
    const form = { ...openaiForm(), config: { endpoint: "http://127.0.0.1:8000/v1", model: "" } };
    const view = renderChip(form);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const recheck = view.getByTestId("stt-local-status").querySelector("button");
    expect(recheck).toBeTruthy();
    await act(async () => {
      recheck!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(2);
  });

  test("whisper.cpp row pings too (route falls back to the backend probe, SPE-7)", async () => {
    const form = { ...whisperCppForm(), config: { endpoint: "http://127.0.0.1:9000" } };
    const view = renderChip(form);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("stt-local-status").className).toContain("border-success/30");
  });
});

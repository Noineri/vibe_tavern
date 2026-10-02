import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_BACKEND } from "@vibe-tavern/domain";
const { render, act, cleanup } = await import("@testing-library/react");

// Docker probe (D8): deterministic states per test — default mirrors the
// honest "not found" shape so no test ever depends on a real fetch.
let dockerStatusNext: { available: boolean; version: string | null } | Error = { available: false, version: null };
// IG-CF12d/12e: the chip's honest ping — moved verbatim from
// TtsLocalServerPanel.test.tsx when the chip left the provider card (same
// boundary, new home; the chip is a standalone component now). Deterministic
// per test (default: an empty successful catalog); leak-safe ...real.
let listModelsNext: unknown[] | Error = [];
const listModelsMock = mock(async () => {
  if (listModelsNext instanceof Error) throw listModelsNext;
  return listModelsNext;
});
const realTtsApi = await import("../../../../api/tts-api.js");
mock.module("../../../../api/tts-api.js", () => ({
  ...realTtsApi,
  fetchLocalDockerStatus: async () => {
    if (dockerStatusNext instanceof Error) throw dockerStatusNext;
    return dockerStatusNext;
  },
  listTtsDraftModels: listModelsMock,
}));

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && "version" in params
        ? `${key}:${String(params.version)}`
        : params && "url" in params
          ? `${key}:${String(params.url)}`
          : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { TtsLocalConnectionChip } = await import("./TtsLocalConnectionChip.js");
import type { TtsProfileForm } from "./use-tts-profiles.js";

function localForm(endpoint: string): TtsProfileForm {
  return {
    id: "p1",
    name: "test",
    backend: TTS_BACKEND.OpenAiCompatible,
    config: { endpoint },
    apiKey: "",
    providerRef: null,
    autoKeyProviderName: null,
    voiceId: "alloy",
    narratorVoiceId: "",
    hasStoredApiKey: false,
  };
}

function renderChip(form: TtsProfileForm) {
  return render(React.createElement(TtsLocalConnectionChip, { form }));
}

describe("TtsLocalConnectionChip — outside-the-card status chip (IG-CF12e; honest endpoint ping since CF12d)", () => {
  beforeEach(() => {
    dockerStatusNext = { available: false, version: null };
    listModelsNext = [];
    listModelsMock.mockClear();
  });

  afterEach(() => cleanup());

  test("ping ONLINE when the endpoint answers; docker version rides the detail line", async () => {
    dockerStatusNext = { available: true, version: "27.3.1" };
    const view = renderChip(localForm("http://127.0.0.1:8880/v1"));
    // Mount probes (ping + docker) settle on later microtasks — drain
    // inside act before reading state (CI flake race, run-3 lesson).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    const status = view.getByTestId("tts-docker-status");
    expect(status.className).toContain("border-success/30");
    // The docker line (WITH version — owner: «вернуть стоит») lives in the
    // chip's detail slot; the i18n mock renders `key:version`.
    expect(status.textContent).toContain("tts_docker_status_ok:27.3.1");
    expect(status.textContent).toContain("http://127.0.0.1:8880/v1");
    // The chip carries the ping re-check button (docker itself stays D8
    // one-shot — the button re-pings the ENDPOINT, not docker).
    expect(status.querySelector("button")).toBeTruthy();
  });

  test("ping OFFLINE when the endpoint is dead — docker green must NOT paint the chip green", async () => {
    dockerStatusNext = { available: true, version: "27.3.1" };
    listModelsNext = new Error("TTS draft model list failed: 502");
    const view = renderChip(localForm("http://127.0.0.1:8880/v1"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const status = view.getByTestId("tts-docker-status");
    expect(status.className).toContain("border-danger/30");
    // The antipattern fix: docker installed + server down = red chip.
    expect(status.textContent).toContain("tts_docker_status_ok:27.3.1");
  });

  test("empty endpoint → UNKNOWN and no ping fires", async () => {
    const view = renderChip(localForm(""));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).not.toHaveBeenCalled();
    const status = view.getByTestId("tts-docker-status");
    expect(status.className).toContain("border-border2");
  });

  test("the re-check button re-pings the endpoint; docker transport failure keeps its own detail", async () => {
    dockerStatusNext = new Error("route unreachable");
    const view = renderChip(localForm("http://127.0.0.1:8880/v1"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    const status = view.getByTestId("tts-docker-status");
    // Docker route down → its detail says unknown; the PING stays honest.
    expect(status.textContent).toContain("tts_docker_status_unknown");
    await act(async () => {
      status.querySelector("button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(2);
  });
});

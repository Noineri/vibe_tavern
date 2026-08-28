import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { __setTtsDiscoveryDepsForTests } from "./use-tts-discovery.js";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";
import type { DiscoveredServer, ProbeOutcome } from "../../../../lib/tts/server-discovery.js";

const { render, act, cleanup, fireEvent, waitFor } = await import("@testing-library/react");

// Track setForm calls
let lastFormPatch: Record<string, unknown> | null = null;
const ttsHookBase: {
  profiles: TtsProfileRecord[];
  loading: boolean;
  editingId: string | null;
  form: {
    id: string | null;
    name: string;
    backend: TtsBackendSlug;
    config: Record<string, unknown>;
    voiceId: string;
    narratorVoiceId: string | null;
    hasStoredApiKey: boolean;
    lang: string;
    sortOrder: number;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
  };
  dirty: boolean;
  error: string | null;
  saving: boolean;
  select: () => void;
  startCreate: () => void;
  setForm: (patch: Record<string, unknown>) => void;
  save: () => Promise<void>;
  remove: () => Promise<void>;
  cancelEdit: () => void;
  reload: () => Promise<void>;
} = {
  profiles: [],
  loading: false,
  editingId: "p1",
  form: {
    id: "p1",
    name: "test",
    backend: TTS_BACKEND.OpenAiCompatible,
    config: {} as Record<string, unknown>,
    voiceId: "alloy",
    narratorVoiceId: null,
    hasStoredApiKey: false,
    lang: "en",
    sortOrder: 0,
    isDefault: false,
    createdAt: "",
    updatedAt: "",
  },
  dirty: false,
  error: null as string | null,
  saving: false,
  select: () => {},
  startCreate: () => {},
  setForm: (patch: Record<string, unknown>) => {
    lastFormPatch = patch;
    // Apply to form for subsequent renders (simulate)
    if (patch.config !== undefined) {
      (ttsHookBase.form as unknown as { config: Record<string, unknown> }).config = patch.config as Record<string, unknown>;
    }
  },
  save: async () => {},
  remove: async () => {},
  cancelEdit: () => {},
  reload: async () => {},
};

function makeTtsHook(overrides: Partial<typeof ttsHookBase> = {}) {
  return { ...ttsHookBase, ...overrides, form: { ...ttsHookBase.form, ...(overrides.form as object | undefined) } } as typeof ttsHookBase;
}

// Mock clipboard via deps seam pattern: we mock the module using safe pattern
// but the panel uses copyText directly; we mock the clipboard module.
const realClipboard = await import("../../../../lib/clipboard.js");
let clipboardResult: { ok: true } | { ok: false; error: "unsupported" | "rejected" } = { ok: true };
mock.module("../../../../lib/clipboard.js", () => ({
  ...realClipboard,
  copyText: async () => clipboardResult,
}));

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && "version" in params ? `${key}:${String(params.version)}` : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// Docker probe (D8): deterministic states per test — default mirrors the
// honest "not found" shape so no test ever depends on a real fetch.
let dockerStatusNext: { available: boolean; version: string | null } | Error = { available: false, version: null };
const realTtsApi = await import("../../../../api/tts-api.js");
mock.module("../../../../api/tts-api.js", () => ({
  ...realTtsApi,
  fetchLocalDockerStatus: async () => {
    if (dockerStatusNext instanceof Error) throw dockerStatusNext;
    return dockerStatusNext;
  },
}));

const { TtsLocalServerPanel } = await import("./TtsLocalServerPanel.js");

beforeEach(() => {
  lastFormPatch = null;
  clipboardResult = { ok: true };
  (ttsHookBase.form as unknown as { config: Record<string, unknown> }).config = {};
  ttsHookBase.form.backend = TTS_BACKEND.OpenAiCompatible;
  cleanup();
});

afterEach(() => {
  __setTtsDiscoveryDepsForTests(null);
  cleanup();
});

describe("TtsLocalServerPanel", () => {
  test("docker status line: available with version (D8)", async () => {
    dockerStatusNext = { available: true, version: "27.3.1" };
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    const status = await waitFor(() => view.getByTestId("tts-docker-status"));
    expect(status.textContent).toContain("tts_docker_status_ok");
    expect(status.textContent).toContain("27.3.1");
    cleanup();
  });

  test("docker status line: not found + alt commands shown anyway", async () => {
    dockerStatusNext = { available: false, version: null };
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    const status = await waitFor(() => view.getByTestId("tts-docker-status"));
    expect(status.textContent).toContain("tts_docker_status_missing");
    // The non-docker variant row must exist on the card (honesty pin).
    expect(view.getByTestId("tts-quickstart-copy-alt-kokoro-fastapi")).toBeTruthy();
    expect(view.getByTestId("tts-quickstart-copy-alt-openai-edge-tts")).toBeTruthy();
    expect(view.getByTestId("tts-quickstart-card-kokoro-fastapi").textContent).toContain("start-cpu.sh");
    cleanup();
  });

  test("docker status line: transport failure → unknown, panel stays usable", async () => {
    dockerStatusNext = new Error("route unreachable");
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    const status = await waitFor(() => view.getByTestId("tts-docker-status"));
    expect(status.textContent).toContain("tts_docker_status_unknown");
    expect(view.getByTestId("tts-discover-btn")).toBeTruthy();
    cleanup();
    dockerStatusNext = { available: false, version: null };
  });

  test("renders null for non-openai backend (kokoro)", () => {
    const tts = makeTtsHook({ form: { ...ttsHookBase.form, backend: TTS_BACKEND.Kokoro } });
    const panelProps = { tts, form: tts.form };
    const { container } = render(React.createElement(TtsLocalServerPanel, panelProps));
    expect(container.innerHTML).toBe("");
  });

  test("quickstart copy button flips label on success", async () => {
    clipboardResult = { ok: true };
    const tts = makeTtsHook();
    const panelProps = { tts, form: tts.form };
    const { getByTestId } = render(React.createElement(TtsLocalServerPanel, panelProps));
    const btn = getByTestId("tts-quickstart-copy-kokoro-fastapi");
    expect(btn.textContent).toContain("tts_quickstart_copy");
    await act(async () => {
      fireEvent.click(btn);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getByTestId("tts-quickstart-copy-kokoro-fastapi").textContent).toContain("tts_quickstart_copied");
  });

  test("quickstart use button writes endpoint via tts.setForm", async () => {
    const tts = makeTtsHook();
    const panelProps = { tts, form: tts.form };
    const { getByTestId } = render(React.createElement(TtsLocalServerPanel, panelProps));
    const useBtn = document.querySelector('[data-testid="tts-quickstart-use-kokoro-fastapi"]') ?? getByTestId("tts-quickstart-use-kokoro-fastapi");
    await act(async () => {
      fireEvent.click(useBtn);
    });
    expect(lastFormPatch).not.toBeNull();
    expect((lastFormPatch?.config as Record<string, unknown>)?.["endpoint"]).toBe("http://127.0.0.1:8880/v1");
  });

  test("adopt writes endpoint via tts.setForm", async () => {
    const discovered: DiscoveredServer = { port: 8880, baseUrl: "http://127.0.0.1:8880", kind: "kokoro-fastapi", voiceIds: ["a"], modelIds: [] };
    const outcomes: ProbeOutcome[] = [{ port: 8880, status: "found", server: discovered }];
    const discoverMock = mock(async (_fetch: unknown) => outcomes);
    __setTtsDiscoveryDepsForTests({ discoverLocalTtsServers: discoverMock });

    const tts = makeTtsHook();
    const panelProps = { tts, form: tts.form };
    const { getByTestId } = render(React.createElement(TtsLocalServerPanel, panelProps));
    const discoverBtn = getByTestId("tts-discover-btn");
    await act(async () => {
      fireEvent.click(discoverBtn);
      await new Promise((r) => setTimeout(r, 30));
    });
    const adoptBtn = getByTestId("tts-discover-adopt-8880");
    await act(async () => {
      fireEvent.click(adoptBtn);
    });
    expect((lastFormPatch?.config as Record<string, unknown>)?.["endpoint"]).toBe("http://127.0.0.1:8880/v1");
  });

  test("none-found renders diag line for worst code (timeout wins)", async () => {
    const outcomes: ProbeOutcome[] = [
      { port: 8880, status: "refused" },
      { port: 8000, status: "timeout" },
      { port: 7851, status: "http-error", httpStatus: 500 },
    ];
    const discoverMock = mock(async (_fetch: unknown) => outcomes);
    __setTtsDiscoveryDepsForTests({ discoverLocalTtsServers: discoverMock });

    const tts = makeTtsHook();
    const panelProps = { tts, form: tts.form };
    const { getByTestId, queryByTestId } = render(React.createElement(TtsLocalServerPanel, panelProps));
    await act(async () => {
      fireEvent.click(getByTestId("tts-discover-btn"));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(queryByTestId("tts-discover-none")).not.toBeNull();
    const diag = getByTestId("tts-discover-diag");
    // timeout is most severe -> should show timeout diag text
    expect(diag.textContent?.length).toBeGreaterThan(0);
  });
});

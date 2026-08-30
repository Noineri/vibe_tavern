import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { __setTtsDiscoveryDepsForTests } from "./use-tts-discovery.js";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";
import type { DiscoveredServer, ProbeOutcome } from "@vibe-tavern/domain";

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
    apiKey: string;
    providerRef: string | null;
    autoKeyProviderName: string | null;
    voiceId: string;
    narratorVoiceId: string;
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
    apiKey: "",
    providerRef: null,
    autoKeyProviderName: null,
    voiceId: "alloy",
    narratorVoiceId: "",
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

async function openHelp(view: { getByTestId: (id: string) => ReturnType<ReturnType<typeof render>["getByTestId"]> }) {
  await act(async () => {
    fireEvent.click(view.getByTestId("tts-setup-help-toggle"));
    await new Promise((r) => setTimeout(r, 350));
  });
}

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

  test("setup help accordion: closed by default, reference steps hidden", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    expect(view.getByTestId("tts-setup-help-accordion")).toBeTruthy();
    expect(view.getByTestId("tts-setup-help-toggle")).toBeTruthy();
    // Steps are inside the collapsed accordion — not in DOM when closed.
    expect(view.queryByTestId("tts-help-step-choose")).toBeNull();
    expect(view.queryByTestId("tts-help-step-endpoint")).toBeNull();
    cleanup();
  });

  test("reference renders: choose step + docker commands for default guide (kokoro)", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    expect(view.getByTestId("tts-help-step-choose")).toBeTruthy();
    expect(view.getByTestId("tts-help-choice-kokoro-fastapi")).toBeTruthy();
    expect(view.getByTestId("tts-help-choice-openai-edge-tts")).toBeTruthy();
    expect(view.getByTestId("tts-help-choice-chatterbox-tts-api")).toBeTruthy();
    expect(view.getByTestId("tts-help-choice-orpheus-fastapi")).toBeTruthy();
    // Default guide = kokoro → its docker command visible.
    expect(view.getByTestId("tts-help-step-download-docker").textContent).toContain("ghcr.io/remsky/kokoro-fastapi-cpu:latest");
    expect(view.getByTestId("tts-help-step-download-clone").textContent).toContain("git clone https://github.com/remsky/Kokoro-FastAPI.git");
    cleanup();
  });

  test("switching the server choice swaps every step (edge-tts)", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-help-choice-openai-edge-tts"));
    });
    expect(view.getByTestId("tts-help-step-download-docker").textContent).toContain("travisvn/openai-edge-tts:latest");
    expect(view.getByTestId("tts-help-step-download-clone").textContent).toContain("git clone https://github.com/travisvn/openai-edge-tts.git");
    expect(view.getByTestId("tts-help-step-install").textContent).toContain("python -m venv venv");
    expect(view.getByTestId("tts-help-step-endpoint").textContent).toContain("http://127.0.0.1:5050/v1");
    // Terminal hint renders once for every card (raw key: no i18n provider here).
    expect(view.getByTestId("tts-help-terminal-hint")).toBeDefined();
    cleanup();
  });

  test("OS toggle switches install/run commands (kokoro: ps1 vs sh)", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    const runStep = view.getByTestId("tts-help-step-run");
    // Whatever the auto-detected default, the OTHER segment must swap it.
    const startsOnWindows = runStep.textContent?.includes("start-cpu.ps1") ?? false;
    await act(async () => {
      fireEvent.click(view.getByText(startsOnWindows ? "tts_help_os_unix" : "tts_help_os_windows"));
    });
    if (startsOnWindows) {
      expect(view.getByTestId("tts-help-step-run").textContent).toContain("./start-cpu.sh");
    } else {
      expect(view.getByTestId("tts-help-step-run").textContent).toContain(".\\start-cpu.ps1");
    }
    // Edge install activation swaps with the toggle too.
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-help-choice-openai-edge-tts"));
    });
    const onWindowsNow = view.getByTestId("tts-help-step-install").textContent?.includes("venv\\Scripts\\activate") ?? false;
    await act(async () => {
      fireEvent.click(view.getByText(onWindowsNow ? "tts_help_os_unix" : "tts_help_os_windows"));
    });
    if (onWindowsNow) {
      expect(view.getByTestId("tts-help-step-install").textContent).toContain("source venv/bin/activate");
    } else {
      expect(view.getByTestId("tts-help-step-install").textContent).toContain("venv\\Scripts\\activate");
    }
    cleanup();
  });

  test("OS toggle does NOT change the docker step (OS-identical)", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    const before = view.getByTestId("tts-help-step-download-docker").textContent;
    const onWindows = before?.includes("ghcr.io") && (view.getByTestId("tts-help-step-run").textContent?.includes("ps1") ?? false);
    await act(async () => {
      fireEvent.click(view.getByText(onWindows ? "tts_help_os_unix" : "tts_help_os_windows"));
    });
    expect(view.getByTestId("tts-help-step-download-docker").textContent).toBe(before);
    cleanup();
  });

  test("kokoro install step is note-only: no copy buttons, note visible (honesty)", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    const install = view.getByTestId("tts-help-step-install");
    expect(install.textContent).toContain("tts_help_install_note_kokoro");
    expect(view.queryByTestId("tts-help-copy-kokoro-fastapi-install-0")).toBeNull();
    // Edge install DOES have per-command copy buttons (one per command).
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-help-choice-openai-edge-tts"));
    });
    const edgeInstall = view.getByTestId("tts-help-step-install");
    for (let i = 0; i < 3; i++) {
      expect(view.getByTestId(`tts-help-copy-openai-edge-tts-install-${i}`)).toBeTruthy();
    }
    expect(edgeInstall.textContent).toContain("pip install -r requirements.txt");
    cleanup();
  });

  test("one copy button per command: docker step has exactly one, run step exactly one", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    const dockerStep = view.getByTestId("tts-help-step-download-docker");
    expect(dockerStep.querySelectorAll('[data-testid^="tts-help-copy-"]').length).toBe(1);
    const runStep = view.getByTestId("tts-help-step-run");
    expect(runStep.querySelectorAll('[data-testid^="tts-help-copy-"]').length).toBe(1);
    cleanup();
  });

  test("copy button flips label on success", async () => {
    clipboardResult = { ok: true };
    const tts = makeTtsHook();
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    const btn = view.getByTestId("tts-help-copy-kokoro-fastapi-download-docker-0");
    expect(btn.textContent).toContain("tts_quickstart_copy");
    await act(async () => {
      fireEvent.click(btn);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(view.getByTestId("tts-help-copy-kokoro-fastapi-download-docker-0").textContent).toContain("tts_quickstart_copied");
    cleanup();
  });

  test("use button writes the guide endpoint via tts.setForm (adopt flow preserved)", async () => {
    const tts = makeTtsHook();
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-help-use-kokoro-fastapi"));
    });
    expect(lastFormPatch).not.toBeNull();
    expect((lastFormPatch?.config as Record<string, unknown>)?.["endpoint"]).toBe("http://127.0.0.1:8880/v1");
    // Switching the guide swaps the endpoint written.
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-help-choice-openai-edge-tts"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-help-use-openai-edge-tts"));
    });
    expect((lastFormPatch?.config as Record<string, unknown>)?.["endpoint"]).toBe("http://127.0.0.1:5050/v1");
    cleanup();
  });

  test("setup help accordion: toggles closed on second click", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    await openHelp(view);
    expect(view.getByTestId("tts-help-step-choose")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-setup-help-toggle"));
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(view.queryByTestId("tts-help-step-choose")).toBeNull();
    cleanup();
  });

  test("discovery row visible without opening the accordion", async () => {
    const tts = makeTtsHook({});
    const view = render(React.createElement(TtsLocalServerPanel, { tts, form: tts.form }));
    expect(view.queryByTestId("tts-help-step-choose")).toBeNull();
    expect(view.getByTestId("tts-discover-btn")).toBeTruthy();
    expect(view.getByTestId("tts-docker-status")).toBeTruthy();
    cleanup();
  });

  test("adopt writes endpoint via tts.setForm", async () => {
    const discovered: DiscoveredServer = { port: 8880, baseUrl: "http://127.0.0.1:8880", kind: "kokoro-fastapi", voiceIds: ["a"], modelIds: [] };
    const outcomes: ProbeOutcome[] = [{ port: 8880, status: "found", server: discovered }];
    const discoverMock = mock(async () => outcomes);
    __setTtsDiscoveryDepsForTests({ discover: () => discoverMock() });

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
    const discoverMock = mock(async () => outcomes);
    __setTtsDiscoveryDepsForTests({ discover: () => discoverMock() });

    const tts = makeTtsHook();
    const panelProps = { tts, form: tts.form };
    const { getByTestId, queryByTestId } = render(React.createElement(TtsLocalServerPanel, panelProps));
    await act(async () => {
      fireEvent.click(getByTestId("tts-discover-btn"));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(queryByTestId("tts-discover-none")).not.toBeNull();
    const diag = getByTestId("tts-discover-diag");
    expect(diag.textContent?.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realSttApi = await import("../../../../api/stt-api.js");
const realI18n = await import("../../../../i18n/context.js");

mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params === "object" && "name" in params) {
        return `${key}:${String(params.name)}`;
      }
      return key;
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

type SttRecord = import("../../../../api/stt-api.js").SttProfileRecord;

function makeRecord(overrides: Partial<SttRecord> = {}): SttRecord {
  return {
    id: "p1",
    name: "Dictation",
    backend: "openai-compat",
    config: { endpoint: "https://api.openai.com/v1", model: "whisper-1" },
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    emotionAnnotation: false,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Mutable store the mocked API closes over — changing it per test affects
// the already-imported hook.
let store: SttRecord[] = [];
let failUpdate = false;
let failMessage = "save boom";

const listAllMock = mock(async () => [...store]);
const createMock = mock(
  async (body: {
    name: string;
    backend: string;
    config?: Record<string, unknown>;
    apiKey?: string;
  }) => {
    const rec = makeRecord({
      id: `p${store.length + 1}`,
      name: body.name,
      backend: body.backend,
      config: body.config ?? {},
    });
    store.push(rec);
    return rec;
  },
);
const updateMock = mock(
  async (
    id: string,
    body: Partial<{
      name: string;
      backend: string;
      config: Record<string, unknown>;
      apiKey: string;
    }>,
  ) => {
    if (failUpdate) throw new Error(failMessage);
    const idx = store.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("not found");
    const updated = { ...store[idx], ...body } as SttRecord;
    store[idx] = updated;
    return updated;
  },
);
const deleteMock = mock(async (id: string) => {
  store = store.filter((p) => p.id !== id);
});
const setDefaultMock = mock(async (id: string) => {
  store = store.map((p) => ({ ...p, isDefault: p.id === id }));
  const updated = store.find((p) => p.id === id);
  if (!updated) throw new Error("not found");
  return updated;
});

mock.module("../../../../api/stt-api.js", () => ({
  ...realSttApi,
  listAllSttProfiles: listAllMock,
  createSttProfile: createMock,
  updateSttProfile: updateMock,
  deleteSttProfile: deleteMock,
  setSttDefault: setDefaultMock,
}));

const { act, cleanup, waitFor, render } = await import("@testing-library/react");
const { useSttProfiles, toSttBackend } = await import("./use-stt-profiles.js");

afterEach(async () => {
  await act(async () => {});
  cleanup();
  store = [];
  failUpdate = false;
  listAllMock.mockClear();
  createMock.mockClear();
  updateMock.mockClear();
  deleteMock.mockClear();
  setDefaultMock.mockClear();
});

describe("useSttProfiles — CRUD", () => {
  it("loads profiles on mount and supports select + startCreate", async () => {
    store = [
      makeRecord({ id: "p1", name: "Alpha", backend: "openai-compat" }),
      makeRecord({ id: "p2", name: "Beta", backend: "whisper-browser" }),
    ];

    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    expect(hook?.loading).toBe(false);
    expect(hook?.error).toBeNull();

    hook!.select("p1");
    await waitFor(() => expect(hook!.editingId).toBe("p1"));
    expect(hook!.form?.name).toBe("Alpha");
    expect(hook!.form?.backend).toBe("openai-compat");
    expect(hook!.dirty).toBe(false);

    hook!.setForm({ name: "Alpha-2" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    expect(hook!.form?.name).toBe("Alpha-2");

    hook!.startCreate();
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    // Tier-0 default: in-browser whisper with the roster default model.
    expect(hook!.form?.backend).toBe("whisper-browser");
    expect(hook!.form?.config.model).toBe("onnx-community/whisper-base");
    expect(hook!.form?.name).toBe("stt_profile_default_name");
    expect(hook!.editingId).toBeNull();
  });

  it("save creates when form.id is null and updates when id exists; blank key is omitted", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" })];

    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));

    hook!.startCreate();
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    hook!.setForm({ name: "NewOne", config: { endpoint: "https://x/v1", model: "whisper-1" } as never });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    expect(createMock).toHaveBeenCalled();
    const createArg = (createMock.mock.calls[0] as unknown[])[0] as {
      name: string;
      backend: string;
      apiKey?: string;
    };
    expect(createArg.name).toBe("NewOne");
    // Blank form key = no key sent (undefined, not an empty string).
    expect(createArg.apiKey).toBeUndefined();

    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    hook!.setForm({ name: "Alpha-renamed" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() =>
      expect(hook?.profiles.find((p: SttRecord) => p.id === "p1")?.name).toBe("Alpha-renamed"),
    );
    expect(updateMock).toHaveBeenCalled();
  });

  it("save failure sets error", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" })];
    failUpdate = true;

    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    hook!.setForm({ name: "BadName" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(hook?.error).toContain("save boom"));
    failUpdate = false;
  });

  it("remove deletes the selected profile and clears selection", async () => {
    store = [
      makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" }),
      makeRecord({ id: "p2", name: "Beta", backend: "openai-compat" }),
    ];

    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    await hook!.remove();
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    expect(hook?.form).toBeNull();
    expect(hook?.editingId).toBeNull();
  });

  it("setDefault calls the API and refreshes profiles", async () => {
    store = [
      makeRecord({ id: "p1", isDefault: true }),
      makeRecord({ id: "p2", isDefault: false }),
    ];
    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    await hook!.setDefault("p2");
    await waitFor(() => expect(setDefaultMock).toHaveBeenCalled());
    expect(setDefaultMock.mock.calls[0][0]).toBe("p2");
    await waitFor(() =>
      expect(hook?.profiles.find((p: SttRecord) => p.id === "p2")?.isDefault).toBe(true),
    );
  });
});

describe("useSttProfiles — backend switch + key lifecycle", () => {
  it("switching backends resets config, apiKey and hasStoredApiKey", async () => {
    store = [
      makeRecord({
        id: "p1",
        backend: "openai-compat",
        config: { endpoint: "https://api.example.com/v1", model: "whisper-1" },
        hasStoredApiKey: true,
      }),
    ];
    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.backend).toBe("openai-compat"));
    expect(hook!.form?.hasStoredApiKey).toBe(true);
    expect(hook!.form?.config.endpoint).toBe("https://api.example.com/v1");

    // Backend switch → whisper-browser: config resets to the roster default,
    // a stored key never survives into the new backend.
    hook!.setForm({ backend: "whisper-browser" as never });
    await waitFor(() => expect(hook?.form?.backend).toBe("whisper-browser"));
    expect(hook!.form?.config).toEqual({ model: "onnx-community/whisper-base" });
    expect(hook!.form?.hasStoredApiKey).toBe(false);
    expect(hook!.form?.apiKey).toBe("");

    // Back to openai-compat: config wipes.
    hook!.setForm({ backend: "openai-compat" as never });
    await waitFor(() => expect(hook?.form?.backend).toBe("openai-compat"));
    expect(hook!.form?.config).toEqual({});
  });

  it("select() mirrors autoKeyProviderName from the saved record", async () => {
    store = [
      makeRecord({
        id: "p1",
        backend: "openai-compat",
        autoKeyProviderName: "OpenAI",
      }),
    ];
    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.autoKeyProviderName).toBe("OpenAI"));
  });
});

describe("useSttProfiles — headerMode machine", () => {
  it("select -> view; startEdit -> edit; save returns to view; cancelEdit restores", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" })];
    let hook: any = null;
    function Probe() {
      hook = useSttProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    expect(hook?.headerMode).toBe("view");

    hook!.startEdit();
    await waitFor(() => expect(hook?.headerMode).toBe("edit"));
    hook!.setForm({ name: "Discard me" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    hook!.cancelEdit();
    await waitFor(() => expect(hook?.headerMode).toBe("view"));
    expect(hook?.form?.name).toBe("Alpha");
    expect(hook?.dirty).toBe(false);

    hook!.save();
    await waitFor(() => expect(hook?.headerMode).toBe("view"));
  });
});

describe("toSttBackend", () => {
  it("known slugs pass through; unknown degrade to whisper-browser", () => {
    expect(toSttBackend("openai-compat")).toBe("openai-compat");
    expect(toSttBackend("whisper-browser")).toBe("whisper-browser");
    expect(toSttBackend("future-backend")).toBe("whisper-browser");
  });
});
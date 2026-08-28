import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realTtsApi = await import("../../../../api/tts-api.js");
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

type TtsRecord = import("../../../../api/tts-api.js").TtsProfileRecord;

function makeRecord(overrides: Partial<TtsRecord> = {}): TtsRecord {
  return {
    id: "p1",
    name: "Voice One",
    backend: "kokoro",
    config: {},
    voiceId: "af_heart",
    narratorVoiceId: null,
    hasStoredApiKey: false,
    lang: "en",
    sortOrder: 0,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Mutable store that the mocked API closes over — changing it per test affects the already-imported hook
let store: TtsRecord[] = [];
let failUpdate = false;
let failMessage = "save boom";

const listAllMock = mock(async () => [...store]);
const createMock = mock(async (body: { name: string; backend: string; config?: Record<string, unknown>; voiceId?: string; narratorVoiceId?: string | null }) => {
  const rec = makeRecord({
    id: `p${store.length + 1}`,
    name: body.name,
    backend: body.backend,
    config: body.config ?? {},
    voiceId: body.voiceId ?? "",
    narratorVoiceId: body.narratorVoiceId ?? null,
  });
  store.push(rec);
  return rec;
});
const updateMock = mock(async (id: string, body: Partial<{ name: string; backend: string; config: Record<string, unknown>; voiceId: string; narratorVoiceId: string | null }>) => {
  if (failUpdate) throw new Error(failMessage);
  const idx = store.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error("not found");
  const updated = { ...store[idx], ...body } as TtsRecord;
  store[idx] = updated;
  return updated;
});
const deleteMock = mock(async (id: string) => {
  store = store.filter((p) => p.id !== id);
});

mock.module("../../../../api/tts-api.js", () => ({
  ...realTtsApi,
  listAllTtsProfiles: listAllMock,
  createTtsProfile: createMock,
  updateTtsProfile: updateMock,
  deleteTtsProfile: deleteMock,
}));

const { act, cleanup, waitFor, render } = await import("@testing-library/react");
const { useTtsProfiles } = await import("./use-tts-profiles.js");

afterEach(async () => {
  await act(async () => {});
  cleanup();
  // reset mutable state
  store = [];
  failUpdate = false;
  // clear mock call history
  listAllMock.mockClear();
  createMock.mockClear();
  updateMock.mockClear();
  deleteMock.mockClear();
});

describe("useTtsProfiles", () => {
  it("loads profiles on mount and supports select + startCreate", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" }), makeRecord({ id: "p2", name: "Beta", backend: "gemini" })];

    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    expect(hook?.loading).toBe(false);
    expect(hook?.error).toBeNull();

    hook!.select("p1");
    await waitFor(() => expect(hook!.editingId).toBe("p1"));
    expect(hook!.form?.name).toBe("Alpha");
    expect(hook!.form?.backend).toBe("kokoro");
    expect(hook!.dirty).toBe(false);

    hook!.setForm({ name: "Alpha-2" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    expect(hook!.form?.name).toBe("Alpha-2");

    hook!.startCreate();
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    expect(hook!.form?.backend).toBe("kokoro");
    expect(hook!.form?.name).toBe("");
    expect(hook!.editingId).toBeNull();
  });

  it("save creates a new profile when form.id is null and updates when id exists", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" })];

    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));

    hook!.startCreate();
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    hook!.setForm({ name: "NewOne", backend: "gemini" as never });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    expect(createMock).toHaveBeenCalled();
    const createArg = (createMock.mock.calls[0] as unknown[])[0] as { name: string; backend: string };
    expect(createArg.name).toBe("NewOne");
    expect(createArg.backend).toBe("gemini");

    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    hook!.setForm({ name: "Alpha-renamed" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(hook?.profiles.find((p: TtsRecord) => p.id === "p1")?.name).toBe("Alpha-renamed"));
    expect(updateMock).toHaveBeenCalled();
  });

  it("save failure sets error", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" })];
    failUpdate = true;

    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
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
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" }), makeRecord({ id: "p2", name: "Beta", backend: "gemini" })];

    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
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

  it("backend switch resets config and voiceId (kokoro defaults af_heart)", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro", config: { speed: 1.5 }, voiceId: "af_heart" })];
    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.backend).toBe("kokoro"));
    expect(hook!.form?.config).toEqual({ speed: 1.5 });
    expect(hook!.form?.voiceId).toBe("af_heart");
    hook!.setForm({ backend: "gemini" as never });
    await waitFor(() => expect(hook?.form?.backend).toBe("gemini"));
    expect(hook!.form?.config).toEqual({});
    expect(hook!.form?.voiceId).toBe("");
    hook!.setForm({ backend: "kokoro" as never });
    await waitFor(() => expect(hook?.form?.backend).toBe("kokoro"));
    expect(hook!.form?.config).toEqual({});
    expect(hook!.form?.voiceId).toBe("af_heart");
  });

  it("narratorVoiceId round-trips through select/startCreate/backend-switch/save", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro", narratorVoiceId: "af_bella" })];
    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.narratorVoiceId).toBe("af_bella"));
    // Backend switch resets narratorVoiceId
    hook!.setForm({ backend: "gemini" as never });
    await waitFor(() => expect(hook?.form?.narratorVoiceId).toBe(""));
    // Set narrator and save — payload maps "" -> null and value -> string
    hook!.setForm({ narratorVoiceId: "Kore" });
    await waitFor(() => expect(hook?.form?.narratorVoiceId).toBe("Kore"));
    hook!.setForm({ name: "Alpha2" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const updateArg = (updateMock.mock.calls[updateMock.mock.calls.length - 1] as unknown[])[1] as { narratorVoiceId: string | null };
    expect(updateArg.narratorVoiceId).toBe("Kore");
    // Empty narrator maps to null
    hook!.setForm({ narratorVoiceId: "" });
    await waitFor(() => expect(hook?.form?.narratorVoiceId).toBe(""));
    hook!.setForm({ name: "Alpha3" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(updateMock.mock.calls.length).toBe(2));
    const secondArg = (updateMock.mock.calls[1] as unknown[])[1] as { narratorVoiceId: string | null };
    expect(secondArg.narratorVoiceId).toBeNull();
    // startCreate defaults narratorVoiceId to ""
    hook!.startCreate();
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    expect(hook!.form?.narratorVoiceId).toBe("");
    cleanup();
  });

  it("save passes config and voiceId through create and update", async () => {
    store = [];
    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.loading).toBe(false));
    hook!.startCreate();
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    // Set config + voiceId on the new form
    hook!.setForm({ config: { endpoint: "https://x", speed: 1.2 } as never, voiceId: "test-voice" });
    await waitFor(() => expect(hook?.form?.voiceId).toBe("test-voice"));
    hook!.setForm({ name: "NewOne" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    const created = store[0];
    expect(created.config).toEqual({ endpoint: "https://x", speed: 1.2 });
    expect(created.voiceId).toBe("test-voice");
    // Update path
    hook!.select(created.id);
    await waitFor(() => expect(hook?.form?.id).toBe(created.id));
    hook!.setForm({ config: { apiKey: "k123" } as never, voiceId: "new-voice" });
    await waitFor(() => expect(hook?.form?.voiceId).toBe("new-voice"));
    hook!.setForm({ name: "Renamed" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(store.find((p) => p.id === created.id)?.voiceId).toBe("new-voice"));
    expect(store.find((p) => p.id === created.id)?.config).toEqual({ apiKey: "k123" });
  });

  it("startCreate defaults to kokoro + af_heart", async () => {
    store = [];
    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.loading).toBe(false));
    hook!.startCreate();
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    expect(hook!.form?.backend).toBe("kokoro");
    expect(hook!.form?.voiceId).toBe("af_heart");
    expect(hook!.form?.config).toEqual({});
  });
});

// ─── F5/F2b: the form mirrors the record's hasStoredApiKey and drops it on
// a backend switch — the UI must never believe a stored key survives a
// backend change (server-side merge has the same guard, pinned in
// services/api/test/tts-routes.test.ts). ─────────────────────────────────

describe("useTtsProfiles — hasStoredApiKey lifecycle (F2b)", () => {
  it("select() mirrors the record's hasStoredApiKey into the form", async () => {
    store = [
      makeRecord({
        id: "p1",
        backend: "openai-compatible",
        config: { endpoint: "https://api.example.com/v1" },
        hasStoredApiKey: true,
      }),
      makeRecord({ id: "p2", backend: "gemini", config: {}, hasStoredApiKey: false }),
    ];
    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(2));

    hook!.select("p1");
    await waitFor(() => expect(hook!.editingId).toBe("p1"));
    expect(hook!.form?.hasStoredApiKey).toBe(true);

    hook!.select("p2");
    await waitFor(() => expect(hook!.form?.backend).toBe("gemini"));
    expect(hook!.form?.hasStoredApiKey).toBe(false);
    cleanup();
  });

  it("switching the backend resets hasStoredApiKey to false", async () => {
    store = [
      makeRecord({
        id: "p1",
        backend: "openai-compatible",
        config: { endpoint: "https://api.example.com/v1", apiKey: "" },
        hasStoredApiKey: true,
      }),
    ];
    let hook: any = null;
    function Probe() {
      hook = useTtsProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook!.form?.hasStoredApiKey).toBe(true));

    hook!.setForm({ backend: "gemini", config: {}, voiceId: "" });
    await waitFor(() => expect(hook!.form?.backend).toBe("gemini"));
    expect(hook!.form?.hasStoredApiKey).toBe(false);
    cleanup();
  });
});

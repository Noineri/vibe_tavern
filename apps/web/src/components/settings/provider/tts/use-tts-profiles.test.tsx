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
const createMock = mock(async (body: { name: string; backend: string }) => {
  const rec = makeRecord({ id: `p${store.length + 1}`, name: body.name, backend: body.backend });
  store.push(rec);
  return rec;
});
const updateMock = mock(async (id: string, body: Partial<{ name: string; backend: string }>) => {
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
});

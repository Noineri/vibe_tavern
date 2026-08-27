import { describe, expect, it, mock, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
const realMasterDetail = await import("../../../shared/MasterDetailModal.js");

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

mock.module("../../../shared/MasterDetailModal.js", () => ({
  ...realMasterDetail,
  useMasterDetail: () => ({ isMobile: false, isDetailOpen: false, openDetail: () => {}, closeDetail: () => {} }),
  MasterDetailMobileDrillDown: () => null,
}));

const { act, cleanup, render, within } = await import("@testing-library/react");
const { TtsSection } = await import("./TtsSection.js");

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

function makeTts(overrides: Record<string, unknown> = {}) {
  return {
    profiles: [] as unknown[],
    loading: false,
    editingId: null as string | null,
    form: null,
    dirty: false,
    error: null as string | null,
    saving: false,
    select: mock(() => {}),
    startCreate: mock(() => {}),
    setForm: mock(() => {}),
    save: mock(async () => {}),
    remove: mock(async () => {}),
    cancelEdit: mock(() => {}),
    reload: mock(async () => {}),
    ...overrides,
  } as unknown as ReturnType<typeof import("./use-tts-profiles.js").useTtsProfiles>;
}

describe("TtsSection", () => {
  it("renders both profiles and highlights the editing row", async () => {
    const select = mock(() => {});
    const startCreate = mock(() => {});
    const tts = makeTts({
      profiles: [
        { id: "p1", name: "Alpha", backend: "kokoro", config: {}, voiceId: "", lang: "en", sortOrder: 0, isDefault: false, createdAt: "", updatedAt: "" },
        { id: "p2", name: "Beta", backend: "gemini", config: {}, voiceId: "", lang: "en", sortOrder: 1, isDefault: false, createdAt: "", updatedAt: "" },
      ] as unknown[],
      editingId: "p1",
      select,
      startCreate,
    });
    const view = render(React.createElement(TtsSection as never, { tts } as never));
    expect(within(view.baseElement).getByText("Alpha")).toBeTruthy();
    expect(within(view.baseElement).getByText("Beta")).toBeTruthy();
    const rows = view.baseElement.querySelectorAll('[data-testid="tts-profile-row"]');
    expect(rows.length).toBe(2);
    const editingRow = view.baseElement.querySelector('[data-profile-id="p1"]') as HTMLElement;
    expect(editingRow.className).toContain("border-l-accent");
  });

  it("clicking a row calls select and + New calls startCreate", async () => {
    const select = mock(() => {});
    const startCreate = mock(() => {});
    const tts = makeTts({
      profiles: [
        { id: "p1", name: "Alpha", backend: "kokoro", config: {}, voiceId: "", lang: "en", sortOrder: 0, isDefault: false, createdAt: "", updatedAt: "" },
        { id: "p2", name: "Beta", backend: "gemini", config: {}, voiceId: "", lang: "en", sortOrder: 1, isDefault: false, createdAt: "", updatedAt: "" },
      ] as unknown[],
      select,
      startCreate,
    });
    const view = render(React.createElement(TtsSection as never, { tts } as never));
    const row = view.baseElement.querySelector('[data-profile-id="p2"]') as HTMLElement;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.pointerDown(row);
    expect(select).toHaveBeenCalledWith("p2");

    const newBtn = view.getByTestId("tts-new-profile-btn");
    fireEvent.click(newBtn);
    expect(startCreate).toHaveBeenCalled();
  });

  it("shows load error when tts.error is set", async () => {
    const tts = makeTts({ error: "boom", profiles: [] as unknown[] });
    const view = render(React.createElement(TtsSection as never, { tts } as never));
    expect(view.getByTestId("tts-load-error").textContent).toContain("boom");
  });
});

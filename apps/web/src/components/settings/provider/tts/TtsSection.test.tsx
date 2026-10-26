import { describe, expect, it, mock, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../../test/i18n-context-seam.js";

useDomEnv();

const realMasterDetail = await import("../../../shared/MasterDetailModal.js");
// Co-load contract (master-list.test.tsx registers the SAME mocks;
// mock.module is process-global, last-write-wins — the factories must stay
// shape-identical so either registration order is safe). The rows render the
// REAL MasterDetailMobileDrillDown with `isDetailOpen: false` (the ML-8
// rework lesson: a null-drill-down stub poisons the primitive's co-load).

installI18nContextSeam();

mock.module("../../../shared/MasterDetailModal.js", () => ({
  ...realMasterDetail,
  useMasterDetail: () => ({ isMobile: false, isDetailOpen: false, openDetail: () => {}, closeDetail: () => {} }),
}));

const { act, cleanup, render, within } = await import("@testing-library/react");
const { TtsSection } = await import("./TtsSection.js");

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

function makeTts(overrides: Record<string, unknown> = {}) {
  const base = {
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
    profileSearch: "",
    filteredProfiles: [] as unknown[],
    setProfileSearch: mock(() => {}),
    reorder: mock(async () => {}),
    defaultProfileId: null as string | null,
  };
  return {
    ...base,
    ...overrides,
    filteredProfiles: "filteredProfiles" in overrides ? overrides.filteredProfiles : base.profiles,
  } as unknown as ReturnType<typeof import("../../../../hooks/use-tts-profiles.js").useTtsProfiles>;
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
    // Behavior change (was: the editing row carried an accent hand-rolled
    // dot; now: the primitive owns the dot and selection owns the accent —
    // owner follow-up 2026-10-24. No default set → no dot anywhere).
    expect(editingRow.querySelector(".bg-accent")).toBeNull();
    expect(editingRow.querySelector(".bg-success")).toBeNull();
  });

  it("marks the default profile with the unified green dot", async () => {
    // Owner follow-up 2026-10-24: TTS rows pass
    // `active={p.id === hook.defaultProfileId}` — the dot follows the
    // persisted default; inactive rows show nothing.
    const tts = makeTts({
      profiles: [
        { id: "p1", name: "Alpha", backend: "kokoro", hasStoredApiKey: true, config: {}, voiceId: "", lang: "en", sortOrder: 0, isDefault: true, createdAt: "", updatedAt: "" },
        { id: "p2", name: "Beta", backend: "gemini", hasStoredApiKey: true, config: {}, voiceId: "", lang: "en", sortOrder: 1, isDefault: false, createdAt: "", updatedAt: "" },
      ] as unknown[],
      defaultProfileId: "p1",
    });
    const view = render(<TtsSection tts={tts} />);
    const defaultRow = view.baseElement.querySelector('[data-profile-id="p1"]') as HTMLElement;
    expect(defaultRow.querySelector(".bg-success")).toBeTruthy();
    const otherRow = view.baseElement.querySelector('[data-profile-id="p2"]') as HTMLElement;
    expect(otherRow.querySelector(".bg-success")).toBeNull();
    expect(otherRow.querySelector(".bg-danger")).toBeNull();
  });

  it("renders the danger tone for a default profile without a usable key", async () => {
    // The provider auth state survives the unification: active without a
    // stored key renders the red dot (the old defaultStatusClassName rule).
    const tts = makeTts({
      profiles: [
        { id: "p1", name: "Alpha", backend: "kokoro", hasStoredApiKey: false, autoKeyProviderName: null, config: {}, voiceId: "", lang: "en", sortOrder: 0, isDefault: true, createdAt: "", updatedAt: "" },
      ] as unknown[],
      defaultProfileId: "p1",
    });
    const view = render(<TtsSection tts={tts} />);
    const defaultRow = view.baseElement.querySelector('[data-profile-id="p1"]') as HTMLElement;
    expect(defaultRow.querySelector(".bg-danger")).toBeTruthy();
    expect(defaultRow.querySelector(".bg-success")).toBeNull();
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

  it("keeps the loading shell title, label, and compact layout", () => {
    const tts = makeTts({ loading: true, profiles: [] as unknown[] });
    const view = render(<TtsSection tts={tts} />);
    const section = view.getByTestId("tts-section");
    expect(section.className).toBe("flex flex-col p-3");
    expect(view.getByText("tts_section_title")).toBeTruthy();
    expect(view.getByText("loading")).toBeTruthy();
  });
});

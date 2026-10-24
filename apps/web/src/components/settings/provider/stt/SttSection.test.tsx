import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params === "object" && "name" in params
        ? `${key}:${String(params.name)}`
        : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { act, cleanup, waitFor, render } = await import("@testing-library/react");
const { SttSection } = await import("./SttSection.js");
const { useSttProfiles } = await import("../../../../hooks/use-stt-profiles.js");
const { useMasterDetail, MasterDetailModal } = await import("../../../shared/MasterDetailModal.js");

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
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStt(overrides: Record<string, unknown> = {}) {
  const base = {
    profiles: [makeRecord()] as SttRecord[],
    loading: false,
    editingId: "p1",
    form: null,
    dirty: false,
    error: null,
    saving: false,
    headerMode: "view",
    startEdit: mock(() => {}),
    setDefault: mock(async () => {}),
    select: mock(() => {}),
    startCreate: mock(() => {}),
    setForm: mock(() => {}),
    save: mock(async () => {}),
    remove: mock(async () => {}),
    cancelEdit: mock(() => {}),
    reload: mock(async () => {}),
    profileSearch: "",
    filteredProfiles: [makeRecord()] as SttRecord[],
    setProfileSearch: mock(() => {}),
    reorder: mock(async () => {}),
    defaultProfileId: null as string | null,
  };
  return {
    ...base,
    ...overrides,
    filteredProfiles: "filteredProfiles" in overrides ? overrides.filteredProfiles : base.profiles,
  };
}

/** Section renders inside the MasterDetailModal context (it calls
 *  useMasterDetail). A minimal wrapper stands in for the modal. */
function SectionHost({ stt }: { stt: ReturnType<typeof useSttProfiles> }) {
  void useMasterDetail();
  return <SttSection stt={stt} />;
}

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

describe("SttSection", () => {
  it("renders the section title and profile rows", async () => {
    // SttSection needs the MasterDetail provider — render through the real
    // MasterDetailModal with a masterContent that mounts the section.
    const stt = makeStt();
    const view = render(
      React.createElement(
        MasterDetailModal as never,
        {
          isOpen: true,
          title: "x",
          masterContent: () => React.createElement(SectionHost, { stt: stt as never }) as never,
          detailContent: null,
          onClose: () => {},
        } as never,
        null as never,
      ),
    );
    await waitFor(() => expect(view.getByTestId("stt-section")).toBeTruthy());
    expect(view.getByText("Dictation")).toBeTruthy();
    // Behavior change (was: the editing row carried an accent hand-rolled
    // dot; now: the primitive owns the dot and selection owns the accent —
    // owner follow-up 2026-10-24. No default set → no dot anywhere).
    expect(view.getByTestId("stt-profile-row").querySelector(".bg-accent")).toBeNull();
    expect(view.getByTestId("stt-profile-row").querySelector(".bg-success")).toBeNull();
  });

  it("marks the default profile with the unified green dot", async () => {
    // Owner follow-up 2026-10-24: STT rows pass
    // `active={p.id === hook.defaultProfileId}` — the dot follows the
    // persisted default; inactive rows show nothing.
    const stt = makeStt({
      profiles: [makeRecord({ id: "p1", isDefault: true, hasStoredApiKey: true }), makeRecord({ id: "p2", name: "Second", hasStoredApiKey: true })],
      filteredProfiles: [makeRecord({ id: "p1", isDefault: true, hasStoredApiKey: true }), makeRecord({ id: "p2", name: "Second", hasStoredApiKey: true })],
      editingId: null,
      defaultProfileId: "p1",
    }) as unknown as ReturnType<typeof useSttProfiles>;
    const view = render(
      <MasterDetailModal
        isOpen={true}
        title="x"
        masterContent={() => <SectionHost stt={stt} />}
        detailContent={null}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(view.getAllByTestId("stt-profile-row")).toHaveLength(2));
    const rows = view.getAllByTestId("stt-profile-row");
    const defaultRow = rows.find((row) => row.getAttribute("data-profile-id") === "p1")!;
    expect(defaultRow.querySelector(".bg-success")).toBeTruthy();
    const otherRow = rows.find((row) => row.getAttribute("data-profile-id") === "p2")!;
    expect(otherRow.querySelector(".bg-success")).toBeNull();
    expect(otherRow.querySelector(".bg-danger")).toBeNull();
  });

  it("loading state shows the loading label", async () => {
    const stt = makeStt({ loading: true, profiles: [] });
    const view = render(
      React.createElement(
        MasterDetailModal as never,
        {
          isOpen: true,
          title: "x",
          masterContent: () => React.createElement(SectionHost, { stt: stt as never }) as never,
          detailContent: null,
          onClose: () => {},
        } as never,
        null as never,
      ),
    );
    await waitFor(() => expect(view.getByTestId("stt-section")).toBeTruthy());
    expect(view.getByTestId("stt-section").className).toBe("flex flex-col p-3");
    expect(view.getByText("stt_section_title")).toBeTruthy();
    expect(view.getByText("loading")).toBeTruthy();
  });

  it("error state renders the load-error banner", async () => {
    const stt = makeStt({ error: "boom" });
    const view = render(
      React.createElement(
        MasterDetailModal as never,
        {
          isOpen: true,
          title: "x",
          masterContent: () => React.createElement(SectionHost, { stt: stt as never }) as never,
          detailContent: null,
          onClose: () => {},
        } as never,
        null as never,
      ),
    );
    await waitFor(() => expect(view.getByTestId("stt-load-error")).toBeTruthy());
  });

  it("whisper-browser rows carry the browser badge", async () => {
    const stt = makeStt({
      profiles: [makeRecord({ id: "p1", backend: "whisper-browser" })],
    });
    const view = render(
      React.createElement(
        MasterDetailModal as never,
        {
          isOpen: true,
          title: "x",
          masterContent: () => React.createElement(SectionHost, { stt: stt as never }) as never,
          detailContent: null,
          onClose: () => {},
        } as never,
        null as never,
      ),
    );
    await waitFor(() => expect(view.getByTestId("stt-profile-row")).toBeTruthy());
    // Owner 2026-09-05: the "runs in browser" badge is an anti-pattern the
    // TTS list never had — the row shows the bare backend like the twin.
    expect(view.queryByText("stt_backend_browser_badge")).toBeNull();
  });

});

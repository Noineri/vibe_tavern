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
const { useSttProfiles } = await import("./use-stt-profiles.js");
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStt(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
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
    expect(view.getByText("stt_backend_browser_badge")).toBeTruthy();
  });
});
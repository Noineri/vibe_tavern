import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import type { TtsLinkRecord, TtsProfileRecord } from "../../../../api/tts-api.js";
import type { TtsProfileForm } from "./use-tts-profiles.js";
import type { TtsLinkPutRow } from "./use-tts-links.js";

/** Rows the seam's getLinks returns for profile "p1": one voice binding
 *  (character c1) + one mute row (character c2) — both render as pills. */
let mockLinks: TtsLinkRecord[] = [];

// ── module mocks (safe pattern: real import FIRST, spread, override only) ──

const realI18n = await import("../../../../i18n/context.js");
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

// The hook itself runs REAL — driven through its deps seam. A mock.module of
// "./use-tts-links.js" here would poison the later use-tts-links.test.ts in
// the same bun process (registry mocks replace the module for every later
// importer); the seam lets both files share the one cached module safely.
const putCalls: Array<{ id: string; rows: TtsLinkPutRow[] }> = [];
const seamDeps = {
  getLinks: async (id: string): Promise<TtsLinkRecord[]> => (id === "p1" ? mockLinks : []),
  putLinks: async (id: string, rows: TtsLinkPutRow[]): Promise<void> => {
    putCalls.push({ id, rows });
  },
  refreshVoiceMap: async (): Promise<void> => {},
};

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { TtsBindingFields } = await import("./TtsBindingFields.js");
const { __setTtsLinksDepsForTests } = await import("./use-tts-links.js");
const { TooltipProvider } = await import("../../../shared/Tooltip.js");
const { useSnapshotStore } = await import("../../../../stores/snapshot-store.js");
const { useBootstrapStore } = await import("../../../../stores/api-actions/bootstrap-actions.js");
const { TTS_BACKEND } = await import("@vibe-tavern/domain");

// CustomTooltip (Radix Tooltip) inside LinkBindingPopover needs a
// TooltipProvider ancestor — in the app the provider sits above the modal
// tree (same wrapper pattern as LinkBindingPopover.test.tsx).
function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  return render(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(TooltipProvider, null, children),
  });
}

function profile(id: string, isDefault: boolean): TtsProfileRecord {
  return {
    id,
    name: `Profile ${id}`,
    backend: TTS_BACKEND.Kokoro,
    config: {},
    voiceId: "af_heart",
    lang: "en",
    sortOrder: 0,
    isDefault,
    hasStoredApiKey: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeForm(id: string | null): TtsProfileForm {
  return { id, name: "Alpha", backend: TTS_BACKEND.Kokoro, config: {}, voiceId: "", hasStoredApiKey: false };
}

type TtsHook = ReturnType<typeof import("./use-tts-profiles.js").useTtsProfiles>;

function makeTts(profiles: TtsProfileRecord[]): TtsHook {
  return {
    profiles,
    loading: false,
    editingId: "p1",
    form: makeForm("p1"),
    dirty: false,
    error: null,
    saving: false,
    select: () => {},
    startCreate: () => {},
    setForm: () => {},
    save: async () => {},
    remove: async () => {},
    cancelEdit: () => {},
    reload: async () => {},
  };
}

function seedCharacters(): void {
  useSnapshotStore.setState({
    allCharacters: [
      {
        id: "c1",
        name: "Alice",
        subtitle: "",
        tags: [],
        avatarAssetId: null,
        avatarFullAssetId: null,
        avatarCropJson: null,
        avatarExt: null,
        avatarFullExt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "c2",
        name: "Bob",
        subtitle: "",
        tags: [],
        avatarAssetId: null,
        avatarFullAssetId: null,
        avatarCropJson: null,
        avatarExt: null,
        avatarFullExt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  useBootstrapStore.setState({ personas: [] });
}

beforeEach(() => {
  mockLinks = [
    { ttsProfileId: "p1", targetType: "character", targetId: "c1", mode: "voice" },
    { ttsProfileId: "p1", targetType: "character", targetId: "c2", mode: "disabled" },
  ];
  putCalls.length = 0;
  __setTtsLinksDepsForTests(seamDeps);
  seedCharacters();
});

afterEach(async () => {
  __setTtsLinksDepsForTests(null);
  await act(async () => {});
  cleanup();
  document.body.innerHTML = "";
});

describe("TtsBindingFields", () => {
  it("renders BOTH sections when the edited profile is the default profile", () => {
    const tts = makeTts([profile("p1", true)]);
    const view = renderWithProviders(React.createElement(TtsBindingFields, { tts, form: makeForm("p1") }));
    expect(view.getByTestId("tts-bind-section")).toBeTruthy();
    expect(view.getByTestId("tts-mute-section")).toBeTruthy();
    expect(view.getByText("tts_bind_section")).toBeTruthy();
    expect(view.getByText("tts_mute_section")).toBeTruthy();
    expect(view.queryByTestId("tts-links-error")).toBeNull();
  });

  it("renders NO mute section for a non-default profile", () => {
    const tts = makeTts([profile("p1", false), profile("p2", true)]);
    const view = renderWithProviders(React.createElement(TtsBindingFields, { tts, form: makeForm("p1") }));
    expect(view.getByTestId("tts-bind-section")).toBeTruthy();
    expect(view.queryByTestId("tts-mute-section")).toBeNull();
  });

  it("renders NOTHING when profileId is null (defensive guard)", () => {
    const tts = makeTts([profile("p1", true)]);
    const view = renderWithProviders(React.createElement(TtsBindingFields, { tts, form: makeForm(null) }));
    expect(view.container.children.length).toBe(0);
  });

  it("clicking a bound pill PUTs the merged voice set (mute row preserved)", async () => {
    const tts = makeTts([profile("p1", true)]);
    const view = renderWithProviders(React.createElement(TtsBindingFields, { tts, form: makeForm("p1") }));
    // mockLinks binds c1 (voice) — the bind section renders an "Alice" pill.
    await waitFor(() => expect(view.getByText("Alice")).toBeTruthy());
    fireEvent.click(view.getByText("Alice"));
    // Unlinking c1 leaves an empty voice selection; the c2 mute row survives
    // (merge rule 1a) — the real hook computed this payload from the seam.
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0].id).toBe("p1");
    expect(putCalls[0].rows).toEqual([
      { targetType: "character", targetId: "c2", mode: "disabled" },
    ]);
  });

  it("clicking a muted pill PUTs the merged set with the voice row kept", async () => {
    const tts = makeTts([profile("p1", true)]);
    const view = renderWithProviders(React.createElement(TtsBindingFields, { tts, form: makeForm("p1") }));
    // mockLinks mutes c2 — the mute section renders a "Bob" pill.
    await waitFor(() => expect(view.getByText("Bob")).toBeTruthy());
    fireEvent.click(view.getByText("Bob"));
    // Unmuting c2 leaves the c1 voice row (merge rule 1b) and no mute rows.
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0].id).toBe("p1");
    expect(putCalls[0].rows).toEqual([
      { targetType: "character", targetId: "c1", mode: "voice" },
    ]);
  });
});

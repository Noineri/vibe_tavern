import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ComponentProps } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { act, fireEvent, render, within } = await import("@testing-library/react");
const realI18n = await import("../../../i18n/context.js");
const realMasterDetailModal = await import("../../shared/MasterDetailModal.js");
// Co-load contract (master-list.test.tsx registers the SAME mock for
// @dnd-kit/core; Bun's mock.module is process-global, last-write-wins — the
// two factories must stay shape-identical so either registration order is
// safe). @dnd-kit/sortable is NOT mocked anymore: ML-1 moved the sortable
// wiring into the primitive, so this suite renders the real useSortable
// (handle attributes, activator listeners) through SortableMasterListPhoneRow.
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
type RealDragOverlayProps = ComponentProps<typeof realDndKit.DragOverlay>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;

mock.module("../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../shared/MasterDetailModal.js", () => ({
  ...realMasterDetailModal,
  useMasterDetail: () => ({ isMobile: false, isDetailOpen: false, openDetail: () => {}, closeDetail: () => {} }),
}));
mock.module("@dnd-kit/core", () => ({
  ...realDndKit,
  // Preserve dnd-kit's provider while exposing the exact drag-end boundary
  // without fragile pointer simulation in happy-dom.
  DndContext: (props: RealDndContextProps) => {
    dndHandlers = props;
    return <RealDndContext {...props} />;
  },
  // DragOverlay mounts children only while dnd-kit's INTERNAL active state
  // is set; the captured-handler pattern drives the hook state, never the
  // internal one — so the preview renders inline here. Shape-identical with
  // master-list.test.tsx (co-load contract: last-write-wins).
  DragOverlay: (props: RealDragOverlayProps) => <>{props.children}</>,
}));

let ProviderProfileList: typeof import("./ProviderProfileList.js").ProviderProfileList;
beforeAll(async () => {
  ({ ProviderProfileList } = await import("./ProviderProfileList.js"));
});

const profiles = [
  { id: "p1", name: "Alpha", providerPreset: "openai", hasStoredApiKey: true },
  { id: "p2", name: "Beta", providerPreset: "anthropic", hasStoredApiKey: false },
];

function baseProps(overrides: Partial<Parameters<typeof ProviderProfileList>[0]> = {}) {
  return {
    profiles,
    filteredProfiles: profiles,
    editingId: "p1",
    activeProfileId: "p1",
    profileSearch: "",
    onProfileSearchChange: mock(),
    onSelectProfile: mock(),
    onAddProfile: mock(),
    onReorder: mock(),
    ...overrides,
  };
}

describe("ProviderProfileList", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    dndHandlers = null;
  });

  it("keeps the LLM list's search, status, active row, drag handles, and new-profile action", () => {
    const onProfileSearchChange = mock();
    const onAddProfile = mock();
    const view = render(<ProviderProfileList {...baseProps({ onProfileSearchChange, onAddProfile })} />);

    expect(view.getByText("profiles_label")).toBeTruthy();
    // Behavior change (was: `★ Alpha` as one title text node, then: the ★ in
    // the status slot; now: the unified green dot — owner follow-up
    // 2026-10-24, ★ retired. Alpha is active with a stored key → green).
    expect(view.getByText("Alpha")).toBeTruthy();
    const alphaRow = view.getByText("Alpha").closest("div.group");
    expect(alphaRow?.querySelector(".bg-success")).toBeTruthy();
    // The inactive row renders no dot at all (the gray bg-t4 dot is retired).
    const betaRow = view.getByText("Beta").closest("div.group");
    expect(betaRow?.querySelector(".bg-success")).toBeNull();
    expect(betaRow?.querySelector(".bg-danger")).toBeNull();
    expect(view.getAllByLabelText("drag")).toHaveLength(2);
    fireEvent.change(view.getByPlaceholderText("search_profiles"), { target: { value: "Alpha" } });
    expect(onProfileSearchChange).toHaveBeenCalledWith("Alpha");
    fireEvent.click(view.getByText("new_profile_btn"));
    expect(onAddProfile).toHaveBeenCalledTimes(1);
  });

  it("wraps the title inside the master column instead of truncating it", () => {
    // Behavior change (was: `truncate` on the title; now: `break-words` wrap
    // per MASTER_LIST_PRIMITIVE_PLAN row rules — authored names are UI copy).
    const view = render(<ProviderProfileList {...baseProps()} />);
    const title = view.getByText("Alpha");
    expect(title.classList.contains("truncate")).toBe(false);
    expect(title.classList.contains("break-words")).toBe(true);
    const textColumn = title.parentElement;
    const contentRow = textColumn?.parentElement;
    if (!contentRow) throw new Error("Profile-row content wrapper missing");

    expect(contentRow.classList.contains("min-w-0")).toBe(true);
    expect(contentRow.classList.contains("flex-1")).toBe(true);
    expect(contentRow.classList.contains("w-full")).toBe(false);
  });

  it("disables drag while searching and in selection-only mode", () => {
    const searching = render(<ProviderProfileList {...baseProps({ profileSearch: "Alpha", filteredProfiles: [profiles[0]!] })} />);
    expect(searching.queryByLabelText("drag")).toBeNull();

    const selectionOnly = render(<ProviderProfileList {...baseProps({ selectionOnly: true, onReorder: undefined })} />);
    expect(within(selectionOnly.container).queryByLabelText("drag")).toBeNull();
    expect(within(selectionOnly.container).queryByText("new_profile_btn")).toBeNull();
  });

  it("allows a selection-only family to supply its own independent reorder target", () => {
    const onReorder = mock();
    const view = render(<ProviderProfileList {...baseProps({ selectionOnly: true, onReorder })} />);

    expect(view.getAllByLabelText("drag")).toHaveLength(2);
    const endEvent = { active: { id: "p1" }, over: { id: "p2" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => { dndHandlers!.onDragEnd!(endEvent); });
    expect(onReorder).toHaveBeenCalledWith([{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }]);
  });

  it("commits the complete sorted payload through the family reorder action on drop", () => {
    const onReorder = mock();
    render(<ProviderProfileList {...baseProps({ onReorder })} />);

    expect(dndHandlers).toBeTruthy();
    const endEvent = {
      active: { id: "p1" },
      over: { id: "p2" },
    } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => {
      dndHandlers!.onDragEnd!(endEvent);
    });

    expect(onReorder).toHaveBeenCalledWith([
      { id: "p2", sortOrder: 0 },
      { id: "p1", sortOrder: 1 },
    ]);
  });

  it("uses family slots for the title, row sub-label, active marker, tone, and test-id stem", () => {
    const profiles = [
      { id: "media-1", name: "Voice One", backend: "local", connected: true },
      { id: "media-2", name: "Voice Two", backend: "cloud", connected: false },
    ];
    const onSelectProfile = mock();
    // Behavior change (was: a hand-rolled per-row status dot fed by
    // `statusClassName` — gray on inactive rows, accent on the editing row;
    // now: the primitive owns the dot. Rows pass `active` + `activeTone`
    // only — owner follow-up 2026-10-24. Inactive rows show no dot.)
    const view = render(
      <ProviderProfileList
        profiles={profiles}
        filteredProfiles={profiles}
        editingId="media-1"
        activeProfileId={null}
        rowActive={(profile) => profile.id === "media-2"}
        rowSubLabel={(profile) => `backend:${profile.backend}`}
        rowActiveTone={(profile) => profile.connected ? "success" : "danger"}
        titleKey="tts_section_title"
        newProfileKey="tts_profile_new"
        testidStem="tts"
        profileSearch=""
        onProfileSearchChange={() => {}}
        onSelectProfile={onSelectProfile}
        onAddProfile={() => {}}
      />,
    );

    expect(view.getByText("tts_section_title")).toBeTruthy();
    expect(view.getByText("backend:local")).toBeTruthy();
    // Behavior change (was: `★ Voice Two` as one title text node, then: the ★
    // in the status slot; now: the unified green/red dot — owner follow-up
    // 2026-10-24. Rows pass `active` + `activeTone` only).
    expect(view.getByText("Voice Two")).toBeTruthy();
    const voiceOneRow = view.getAllByTestId("tts-profile-row").find((row) => row.getAttribute("data-profile-id") === "media-1");
    if (!voiceOneRow) throw new Error("Voice One row missing");
    expect(voiceOneRow.getAttribute("data-profile-id")).toBe("media-1");
    // Inactive: no dot (the old connected-green dot is retired).
    expect(voiceOneRow.querySelector(".bg-success")).toBeNull();
    expect(voiceOneRow.querySelector(".bg-danger")).toBeNull();
    const voiceTwoRow = view.getAllByTestId("tts-profile-row").find((row) => row.getAttribute("data-profile-id") === "media-2");
    if (!voiceTwoRow) throw new Error("Voice Two row missing");
    // Active with a danger tone: the red dot.
    expect(voiceTwoRow.querySelector(".bg-danger")).toBeTruthy();
    expect(within(voiceOneRow).getByText("backend:local")).toBeTruthy();
    fireEvent.pointerDown(voiceOneRow);
    expect(onSelectProfile).toHaveBeenCalledWith("media-1");
    // Behavior change (was: a stubbed `drill` button asserted via getByText;
    // now: the REAL MasterDetailMobileDrillDown caret, basis: ML-1 rework —
    // the stub diverged from master-list.test.tsx's MasterDetailModal mock
    // and poisoned its co-load run; same click→select boundary either way).
    fireEvent.click(within(voiceOneRow).getByLabelText("master_detail_open"));
    expect(onSelectProfile).toHaveBeenCalledTimes(2);
  });

  it("rerenders generic family slots when same-id profile data and slot callbacks change", () => {
    const initialProfiles = [{ id: "media-1", name: "Voice One", backend: "local", connected: true }];
    const view = render(
      <ProviderProfileList
        profiles={initialProfiles}
        filteredProfiles={initialProfiles}
        editingId={null}
        activeProfileId="media-1"
        rowSubLabel={(profile) => `first:${profile.backend}`}
        rowActiveTone={(profile) => profile.connected ? "success" : "danger"}
        profileSearch=""
        onProfileSearchChange={() => {}}
        onSelectProfile={() => {}}
      />,
    );

    expect(view.getByText("first:local")).toBeTruthy();
    expect(view.container.querySelector(".bg-success")).toBeTruthy();

    const updatedProfiles = [{ id: "media-1", name: "Voice One", backend: "cloud", connected: false }];
    view.rerender(
      <ProviderProfileList
        profiles={updatedProfiles}
        filteredProfiles={updatedProfiles}
        editingId={null}
        activeProfileId="media-1"
        rowSubLabel={(profile) => `second:${profile.backend}`}
        rowActiveTone={(profile) => profile.connected ? "success" : "danger"}
        profileSearch=""
        onProfileSearchChange={() => {}}
        onSelectProfile={() => {}}
      />,
    );

    expect(view.getByText("second:cloud")).toBeTruthy();
    expect(view.container.querySelector(".bg-danger")).toBeTruthy();
  });

  it("renders the danger tone for the active profile without a usable key", () => {
    // Owner follow-up 2026-10-24: the LLM default tone — active without a
    // stored API key (and no no-key preset) renders the red dot.
    const view = render(<ProviderProfileList {...baseProps({ editingId: null, activeProfileId: "p2" })} />);
    const betaRow = view.getByText("Beta").closest("div.group");
    expect(betaRow?.querySelector(".bg-danger")).toBeTruthy();
    expect(betaRow?.querySelector(".bg-success")).toBeNull();
    const alphaRow = view.getByText("Alpha").closest("div.group");
    expect(alphaRow?.querySelector(".bg-danger")).toBeNull();
    expect(alphaRow?.querySelector(".bg-success")).toBeNull();
  });
});

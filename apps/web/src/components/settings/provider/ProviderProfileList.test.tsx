import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { fireEvent, render, within } = await import("@testing-library/react");
const realI18n = await import("../../../i18n/context.js");
const realMasterDetailModal = await import("../../shared/MasterDetailModal.js");
const realSortable = await import("@dnd-kit/sortable");

const useSortable = mock(() => ({
  attributes: {},
  listeners: {},
  setNodeRef: mock(),
  setActivatorNodeRef: mock(),
  transform: null,
  transition: undefined,
  isDragging: false,
}));

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
  MasterDetailMobileDrillDown: ({ onSelect, className }: { onSelect?: () => void; className?: string }) => (
    <button type="button" className={className} onClick={onSelect}>drill</button>
  ),
}));
mock.module("@dnd-kit/sortable", () => ({ ...realSortable, useSortable }));

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
  });

  it("keeps the LLM list's search, status, active row, drag handles, and new-profile action", () => {
    const onProfileSearchChange = mock();
    const onAddProfile = mock();
    const view = render(<ProviderProfileList {...baseProps({ onProfileSearchChange, onAddProfile })} />);

    expect(view.getByText("profiles_label")).toBeTruthy();
    expect(view.getByText("★ Alpha")).toBeTruthy();
    expect(view.getAllByLabelText("drag")).toHaveLength(2);
    fireEvent.change(view.getByPlaceholderText("search_profiles"), { target: { value: "Alpha" } });
    expect(onProfileSearchChange).toHaveBeenCalledWith("Alpha");
    fireEvent.click(view.getByText("new_profile_btn"));
    expect(onAddProfile).toHaveBeenCalledTimes(1);
  });

  it("disables drag while searching and in selection-only mode", () => {
    const searching = render(<ProviderProfileList {...baseProps({ profileSearch: "Alpha", filteredProfiles: [profiles[0]!] })} />);
    expect(searching.queryByLabelText("drag")).toBeNull();

    const selectionOnly = render(<ProviderProfileList {...baseProps({ selectionOnly: true })} />);
    expect(within(selectionOnly.container).queryByLabelText("drag")).toBeNull();
    expect(within(selectionOnly.container).queryByText("new_profile_btn")).toBeNull();
  });

  it("uses family slots for the title, row sub-label, active marker, status, and test-id stem", () => {
    const profiles = [
      { id: "media-1", name: "Voice One", backend: "local", connected: true },
      { id: "media-2", name: "Voice Two", backend: "cloud", connected: false },
    ];
    const onSelectProfile = mock();
    const view = render(
      <ProviderProfileList
        profiles={profiles}
        filteredProfiles={profiles}
        editingId="media-1"
        activeProfileId={null}
        rowActive={(profile) => profile.id === "media-2"}
        rowSubLabel={(profile) => `backend:${profile.backend}`}
        statusClassName={(profile) => profile.connected ? "bg-success" : "bg-danger"}
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
    expect(view.getByText("★ Voice Two")).toBeTruthy();
    const voiceOneRow = view.getAllByTestId("tts-profile-row").find((row) => row.getAttribute("data-profile-id") === "media-1");
    if (!voiceOneRow) throw new Error("Voice One row missing");
    expect(voiceOneRow.getAttribute("data-profile-id")).toBe("media-1");
    expect(within(voiceOneRow).getByText("backend:local")).toBeTruthy();
    fireEvent.pointerDown(voiceOneRow);
    expect(onSelectProfile).toHaveBeenCalledWith("media-1");
  });
});

const { useDomEnv } = await import("../../../../test/dom-env.js");

useDomEnv();

const { describe, expect, mock, test } = await import("bun:test");
const React = await import("react");
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { LocaleProvider } = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");

// CustomTooltip wraps Radix's Tooltip (needs TooltipProvider) — bare wrapper,
// the leak-safe ...real spread per the tier policy (RegexPresetList.test
// precedent). The pane's own api prop seam covers the client; no other mocks.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { ImagePromptTemplatesPane } = await import("./ImagePromptTemplatesPane.js");
import type {
  ImagePromptTemplatesPaneApi,
  ImagePromptTemplatesPaneRowId,
  ImagePromptTemplatesPaneSlots,
} from "./ImagePromptTemplatesPane.js";
import type {
  ImagePromptFamilyInfoValue,
  ImagePromptProfileDetailResponse,
  ImagePromptProfileListResponse,
  ImagePromptProfileValue,
  ImagePromptTemplateCellValue,
  ImagePromptTemplateRowKeyValue,
} from "@vibe-tavern/api-contracts";

// IF-1d — the Images pane rebuilt on image prompt PROFILES (a fork of the
// ServicePromptsPane flow) with the IPT detail side kept (mode rows × family
// dropdown, canon/custom status, quality layer, assist read-only view) and
// whole-profile saves. Pins the fork-parity flow AND the kept detail-side
// behaviors under the profile seam.

const ROW_KEYS: ImagePromptTemplateRowKeyValue[] = [
  "scene-background",
  "portrait",
  "character",
  "user-persona",
  "scene-illustration",
  "free",
  "selfie",
  "avatar",
  "negative",
];

const FAMILIES: ImagePromptFamilyInfoValue[] = [
  { id: "prose", grammar: "prose", ownTemplates: true, ownNegative: true, ownQuality: false, hasAssistAddendum: false },
  { id: "pony", grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true, hasAssistAddendum: true },
];

function makeCell(
  rowKey: ImagePromptTemplateRowKeyValue,
  family: string,
  customText: string | null = null,
  qualityText: string | null = null,
): ImagePromptTemplateCellValue {
  return {
    rowKey,
    family: family as ImagePromptTemplateCellValue["family"],
    canonText: `canon ${rowKey} ${family}`,
    canonSource: family === "prose" ? "family-canon" : "prose-canon",
    customText,
    qualityText,
    isCustomized: customText !== null || qualityText !== null,
  };
}

function makeCatalog() {
  return {
    cells: ROW_KEYS.flatMap((rowKey) => FAMILIES.map((family) => makeCell(rowKey, family.id))),
    qualityCanon: { pony: "canon quality pony" },
    assist: {
      core: "extract the visible scene",
      addenda: { pony: "return ordered tags" },
    },
  };
}

function makeProfile(overrides: Partial<ImagePromptProfileValue> = {}): ImagePromptProfileValue {
  return {
    id: "p1",
    name: "My Profile",
    isDefault: false,
    sortOrder: 0,
    overrides: {},
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function makeDefaultProfile(): ImagePromptProfileValue {
  return makeProfile({ id: "default", name: "Default", isDefault: true });
}

function makeDetail(profile: ImagePromptProfileValue): ImagePromptProfileDetailResponse {
  return { profile, catalog: makeCatalog() };
}

function makeApi(options: { profiles?: ImagePromptProfileValue[]; activeProfileId?: string | null } = {}) {
  const profiles = options.profiles ?? [makeDefaultProfile(), makeProfile()];
  const activeProfileId = options.activeProfileId ?? null;
  const store = new Map(profiles.map((p) => [p.id, { ...p, overrides: { ...p.overrides } }]));
  return {
    api: {
      listProfiles: mock(async (): Promise<ImagePromptProfileListResponse> => ({
        profiles: [...store.values()],
        activeProfileId,
      })),
      getProfile: mock(async (id: string): Promise<ImagePromptProfileDetailResponse | null> => {
        const profile = store.get(id);
        return profile ? makeDetail(profile) : null;
      }),
      create: mock(async (body: { name: string; overrides?: object }) => {
        const created = makeProfile({ id: "created_1", name: body.name, overrides: (body.overrides ?? {}) as ImagePromptProfileValue["overrides"] });
        store.set(created.id, created);
        return created;
      }),
      update: mock(async (id: string, body: { name?: string; overrides?: object }) => {
        const current = store.get(id);
        if (!current) throw new Error("not found");
        const next: ImagePromptProfileValue = {
          ...current,
          name: body.name ?? current.name,
          overrides: (body.overrides ?? current.overrides) as ImagePromptProfileValue["overrides"],
        };
        store.set(id, next);
        return next;
      }),
      remove: mock(async (id: string) => {
        store.delete(id);
      }),
      setActive: mock(async (_profileId: string | null) => {}),
      reorder: mock(async (updates: Array<{ id: string; sortOrder: number }>): Promise<ImagePromptProfileListResponse> => ({
        profiles: [...store.values()],
        activeProfileId,
      })),
      listFamilies: mock(async () => ({ families: FAMILIES })),
    } satisfies ImagePromptTemplatesPaneApi,
    store,
  };
}

function Harness({
  api,
  active = true,
  onDirtyChange,
  renderRowDrillDown,
}: {
  api: ImagePromptTemplatesPaneApi;
  active?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  renderRowDrillDown?: (rowId: string, selectRow: () => void) => React.ReactNode;
}) {
  return (
    <LocaleProvider>
      <ImagePromptTemplatesPane
        active={active}
        api={api}
        onDirtyChange={onDirtyChange}
        renderRowDrillDown={renderRowDrillDown}
      >
        {(slots: ImagePromptTemplatesPaneSlots) => (
          <div>
            <div data-testid="master">{slots.master}</div>
            <div data-testid="detail">{slots.detail}</div>
            <div data-testid="footer">{slots.footer}</div>
          </div>
        )}
      </ImagePromptTemplatesPane>
    </LocaleProvider>
  );
}

async function openRow(getByTestId: (id: string) => HTMLElement, rowId: ImagePromptTemplatesPaneRowId) {
  await act(async () => {
    fireEvent.click(getByTestId(`image-prompt-template-row-${rowId}`).querySelector("button") as HTMLButtonElement);
  });
}

/** Open a row's family dropdown and pick the option whose label contains
 *  `label` (the cmdk list appends after the trigger, so the last match is
 *  the list item). */
async function selectFamily(getByTestId: (id: string) => HTMLElement, rowId: ImagePromptTemplatesPaneRowId, label: string) {
  // triggerTestId sits on the trigger BUTTON itself (DropdownSelect convention).
  await act(async () => {
    fireEvent.click(getByTestId(`image-prompt-template-family-${rowId}`));
  });
  const item = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("[cmdk-item]"))
      .find((node) => node.textContent?.includes(label));
    if (!el) throw new Error(`family option "${label}" not open yet`);
    return el as HTMLElement;
  });
  await act(async () => {
    fireEvent.click(item);
  });
}

describe("ImagePromptTemplatesPane (IF-1d profile fork)", () => {
  test("master renders Default pinned first with lock + live badge, then profiles; drill-down seam fires", async () => {
    const renderDrillDown = mock((_rowId: string, _selectRow: () => void) => <span data-testid="drill" />);
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile(), makeProfile({ id: "p2", name: "Second", sortOrder: 1 })], activeProfileId: "p2" });
    const { getByTestId } = render(<Harness api={api} renderRowDrillDown={renderDrillDown} />);
    await waitFor(() => expect(getByTestId("image-prompt-profile-row-default")).toBeTruthy());
    expect(getByTestId("image-prompt-profile-row-p1")).toBeTruthy();
    expect(getByTestId("image-prompt-profile-row-p2")).toBeTruthy();
    // Default row renders the live badge and the drill-down seam.
    expect(getByTestId("image-prompt-profile-row-default").textContent).toContain("live");
    expect(renderDrillDown).toHaveBeenCalled();
  });

  test("detail renders the exact row inventory (8 modes + negative + assist) with per-row family dropdowns", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile()], activeProfileId: null });
    const { getByTestId } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    for (const rowKey of ROW_KEYS) {
      expect(getByTestId(`image-prompt-template-row-${rowKey}`)).toBeTruthy();
      expect(getByTestId(`image-prompt-template-family-${rowKey}`)).toBeTruthy();
      expect(getByTestId(`image-prompt-template-status-${rowKey}`)).toBeTruthy();
    }
    expect(getByTestId("image-prompt-template-row-assist")).toBeTruthy();
    expect(getByTestId("image-prompt-template-family-assist")).toBeTruthy();
  });

  test("Default profile: canon read-only blocks, duplicate-only footer, no save button", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile()], activeProfileId: null });
    const { getByTestId, queryByRole } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    await openRow(getByTestId, "portrait");
    const detail = getByTestId("detail");
    // Canon text visible read-only (code quote), no editor textarea on Default.
    expect(detail.textContent).toContain("canon portrait prose");
    expect(queryByRole("textbox", { name: "Image prompt template" }) === null || (queryByRole("textbox", { name: "Image prompt template" }) as HTMLTextAreaElement).disabled).toBeTruthy();
    // Footer: duplicate present, no save button, no delete.
    expect(getByTestId("footer").textContent).toContain("Duplicate");
    expect(getByTestId("footer").textContent).not.toContain("Delete");
  });

  test("clicking a profile row selects AND makes it live (null for Default)", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile({ id: "p2", name: "Second" })], activeProfileId: "p2" });
    const { getByTestId } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-profile-row-default")).toBeTruthy());
    // Initial selection follows the live pointer.
    await waitFor(() => expect(api.getProfile).toHaveBeenCalledWith("p2"));
    await act(async () => {
      fireEvent.click(getByTestId("image-prompt-profile-row-default"));
    });
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith(null));
  });

  test("cell edit → dirty → whole-profile save sends normalized overrides; reset drops the key", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile()], activeProfileId: "p1" });
    const onDirtyChange = mock((_dirty: boolean) => {});
    const { getByTestId, getByRole } = render(<Harness api={api} onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    await openRow(getByTestId, "portrait");
    const editor = getByRole("textbox", { name: "Image prompt template" }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(editor, { target: { value: "my own portrait template" } });
    });
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("p1", {
      name: "My Profile",
      overrides: { "portrait|prose": { body: "my own portrait template", qualityText: null } },
    }));
    // Reset-to-canon drops the key from the draft; saving sends the empty map.
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Reset" }));
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(api.update).toHaveBeenLastCalledWith("p1", { name: "My Profile", overrides: {} }));
  });

  test("emptying the editor body returns the cell to canon on save (no blank overrides)", async () => {
    const profile = makeProfile({ overrides: { "portrait|prose": { body: "existing custom", qualityText: null } } });
    const { api } = makeApi({ profiles: [makeDefaultProfile(), profile], activeProfileId: "p1" });
    const { getByTestId, getByRole } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    await openRow(getByTestId, "portrait");
    const editor = getByRole("textbox", { name: "Image prompt template" }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(editor, { target: { value: "" } });
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(api.update).toHaveBeenLastCalledWith("p1", { name: "My Profile", overrides: {} }));
  });

  test("free row's enabled family dropdown selects and persists a non-default family cell", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile()], activeProfileId: "p1" });
    const { getByTestId, getByRole } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-free")).toBeTruthy());
    const trigger = getByTestId("image-prompt-template-family-free") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    await selectFamily(getByTestId, "free", "Pony");
    expect(getByTestId("image-prompt-template-family-free").textContent).toContain("Pony");
    await openRow(getByTestId, "free");
    const editor = getByRole("textbox", { name: "Image prompt template" }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(editor, { target: { value: "my pony free template" } });
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(api.update).toHaveBeenLastCalledWith("p1", {
      name: "My Profile",
      overrides: { "free|pony": { body: "my pony free template", qualityText: null } },
    }));
  });

  test("quality layer: toggle rides the draft, blank quality clears to canon on save", async () => {
    const profile = makeProfile({ overrides: { "portrait|pony": { body: "pony body", qualityText: null } } });
    const { api } = makeApi({ profiles: [makeDefaultProfile(), profile], activeProfileId: "p1" });
    const { getByTestId, getByRole } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    // Switch the row's family to pony (the quality-authoring family).
    await selectFamily(getByTestId, "portrait", "Pony");
    await openRow(getByTestId, "portrait");
    const toggle = getByRole("switch", { name: "Customize quality text" });
    await act(async () => {
      fireEvent.click(toggle);
    });
    const qualityEditor = getByRole("textbox", { name: "Custom quality text" }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(qualityEditor, { target: { value: "   " } });
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(api.update).toHaveBeenLastCalledWith("p1", {
      name: "My Profile",
      overrides: { "portrait|pony": { body: "pony body", qualityText: null } },
    }));
    // The canon quality block is visible for the pony family.
    expect(getByTestId("image-prompt-template-quality-canon").textContent).toContain("canon quality pony");
  });

  test("negative row never exposes quality controls", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile()], activeProfileId: "p1" });
    const { getByTestId, queryByRole } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-negative")).toBeTruthy());
    await openRow(getByTestId, "negative");
    expect(queryByRole("switch", { name: "Customize quality text" })).toBeNull();
  });

  test("switching profiles with unsaved changes requires discard confirmation", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile(), makeProfile({ id: "p2", name: "Second" })], activeProfileId: "p1" });
    const { getByTestId, getByRole, queryByText } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    await openRow(getByTestId, "portrait");
    const editor = getByRole("textbox", { name: "Image prompt template" }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(editor, { target: { value: "unsaved edit" } });
    });
    await act(async () => {
      fireEvent.click(getByTestId("image-prompt-profile-row-p2"));
    });
    await waitFor(() => expect(queryByText("Discard changes?")).toBeTruthy());
    // Cancel keeps the dirty draft; confirm applies the switch.
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Confirm" }));
    });
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith("p2"));
  });

  test("assist row renders the canon core and the selected-family addendum read-only", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile()], activeProfileId: "p1" });
    const { getByTestId } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-assist")).toBeTruthy());
    await openRow(getByTestId, "assist");
    expect(getByTestId("image-prompt-template-assist-core").textContent).toContain("extract the visible scene");
    // prose (the default family) has no addendum; switch the row to pony.
    expect(getByTestId("image-prompt-template-assist-addendum").textContent).toContain("No family addendum");
    await selectFamily(getByTestId, "assist", "Pony");
    await waitFor(() => expect(getByTestId("image-prompt-template-assist-addendum").textContent).toContain("return ordered tags"));
  });

  test("duplicate footer action creates a (copy) profile, activates, and selects it", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile({ overrides: { "portrait|prose": { body: "x", qualityText: null } } })], activeProfileId: "p1" });
    const { getByTestId, getByText } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByText("Duplicate"));
    });
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({
      name: "My Profile (copy)",
      overrides: { "portrait|prose": { body: "x", qualityText: null } },
    }));
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith("created_1"));
  });

  test("create flow: new profile input commits, activates, and starts inline rename", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile()], activeProfileId: null });
    const { getByTestId, getByRole } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-profile-row-default")).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "New Profile" }));
    });
    const input = getByTestId("master").querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Fresh" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ name: "Fresh", overrides: {} }));
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith("created_1"));
  });

  test("delete flow: non-default profile removed, selection falls back to live", async () => {
    const { api } = makeApi({ profiles: [makeDefaultProfile(), makeProfile()], activeProfileId: "p1" });
    const { getByTestId, getAllByText } = render(<Harness api={api} />);
    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    // Desktop footer actions are icon+label SPANS with onClick (canon
    // MasterDetailFooter) — click the footer Delete by text.
    await act(async () => {
      fireEvent.click(getAllByText("Delete")[0]!);
    });
    // The destructive confirm opens in a portal; its confirm is the only
    // BUTTON carrying the Delete label.
    const confirmButton = await waitFor(() => {
      const button = getAllByText("Delete").map((node) => node.closest("button")).find(Boolean);
      if (!button) throw new Error("confirm not open yet");
      return button as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("p1"));
  });

  test("shows a retryable loading error", async () => {
    const failingApi: ImagePromptTemplatesPaneApi = {
      listProfiles: mock(async () => { throw new Error("boom"); }),
      getProfile: mock(async () => null),
      create: mock(async () => { throw new Error("boom"); }),
      update: mock(async () => { throw new Error("boom"); }),
      remove: mock(async () => {}),
      setActive: mock(async () => {}),
      reorder: mock(async () => ({ profiles: [], activeProfileId: null })),
      listFamilies: mock(async () => ({ families: FAMILIES })),
    };
    const { getByText, queryByText } = render(<Harness api={failingApi} />);
    await waitFor(() => expect(queryByText("Failed to load image templates")).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByText("Retry"));
    });
    // Still failing → error stays visible.
    await waitFor(() => expect(queryByText("Failed to load image templates")).toBeTruthy());
  });
});

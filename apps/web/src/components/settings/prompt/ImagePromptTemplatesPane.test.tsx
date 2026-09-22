const { useDomEnv } = await import("../../../../test/dom-env.js");

useDomEnv();

const { describe, expect, mock, test } = await import("bun:test");
const React = await import("react");
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { LocaleProvider } = await import("../../../i18n/context.js");
const { ImagePromptTemplatesPane } = await import("./ImagePromptTemplatesPane.js");
import type {
  ImagePromptTemplatesPaneApi,
  ImagePromptTemplatesPaneRowId,
  ImagePromptTemplatesPaneSlots,
} from "./ImagePromptTemplatesPane.js";
import type {
  ImagePromptFamilyInfoValue,
  ImagePromptFamilyValue,
  ImagePromptTemplateCellValue,
  ImagePromptTemplateRowKeyValue,
  ImagePromptTemplatesValue,
} from "@vibe-tavern/api-contracts";

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
  family: ImagePromptFamilyValue,
  customText: string | null = null,
  qualityText: string | null = null,
): ImagePromptTemplateCellValue {
  return {
    rowKey,
    family,
    canonText: `canon ${rowKey} ${family}`,
    canonSource: family === "prose" ? "family-canon" : "prose-canon",
    customText,
    qualityText,
    isCustomized: customText !== null || qualityText !== null,
  };
}

function makeTemplates(customPortrait = false): ImagePromptTemplatesValue {
  return {
    cells: ROW_KEYS.flatMap((rowKey) => FAMILIES.map((family) => makeCell(
      rowKey,
      family.id,
      customPortrait && rowKey === "portrait" && family.id === "prose" ? "custom portrait" : null,
    ))),
    qualityCanon: { pony: "canon quality pony" },
    assist: {
      core: "extract the visible scene",
      addenda: { pony: "return ordered tags" },
    },
  };
}

function makeApi(templates = makeTemplates()): ImagePromptTemplatesPaneApi {
  return {
    listTemplates: mock(async () => templates),
    listFamilies: mock(async () => ({ families: FAMILIES })),
    upsert: mock(async (rowKey, family, body) => {
      const current = templates.cells.find((cell) => cell.rowKey === rowKey && cell.family === family);
      const qualityText = body.qualityText === undefined ? current?.qualityText ?? null : body.qualityText;
      return makeCell(rowKey, family, body.body, qualityText);
    }),
    reset: mock(async (rowKey, family) => makeCell(rowKey, family)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((nextResolve) => { resolve = nextResolve; }),
    resolve,
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
  renderRowDrillDown?: (rowId: ImagePromptTemplatesPaneRowId, selectRow: () => void) => React.ReactNode;
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

function rowButton(getByTestId: (id: string) => HTMLElement, rowId: ImagePromptTemplatesPaneRowId): HTMLButtonElement {
  return getByTestId(`image-prompt-template-row-${rowId}`).querySelector("button") as HTMLButtonElement;
}

describe("ImagePromptTemplatesPane", () => {
  test("renders the exact server row inventory in order with inline family controls and drill-down seam", async () => {
    const api = makeApi();
    const drillCalls: ImagePromptTemplatesPaneRowId[] = [];
    const { getByTestId } = render(
      <Harness
        api={api}
        renderRowDrillDown={(rowId, selectRow) => {
          drillCalls.push(rowId);
          return <button type="button" data-testid={`drill-${rowId}`} onClick={selectRow}>drill</button>;
        }}
      />,
    );

    await waitFor(() => expect(getByTestId("image-prompt-template-row-assist")).toBeTruthy());
    const rows = Array.from(getByTestId("master").querySelectorAll("[data-testid^='image-prompt-template-row-']"));
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      ...ROW_KEYS.map((rowKey) => `image-prompt-template-row-${rowKey}`),
      "image-prompt-template-row-assist",
    ]);
    expect(drillCalls).toEqual([...ROW_KEYS, "assist"]);

    const portrait = getByTestId("image-prompt-template-row-portrait");
    expect(portrait.className).toContain("items-center");
    expect(portrait.className).not.toContain("flex-col");
    expect(portrait.querySelector("[data-testid='image-prompt-template-family-portrait']")).toBeTruthy();
    expect(getByTestId("image-prompt-template-status-scene-background").getAttribute("aria-label")).toBe("Canon");

    fireEvent.click(getByTestId("drill-character"));
    await waitFor(() => expect(getByTestId("detail").textContent).toContain("Character"));
  });

  test("never reports clean load or clean row/family switches as dirty", async () => {
    const api = makeApi();
    const dirtyStates: boolean[] = [];
    const { getAllByText, getByTestId } = render(<Harness api={api} onDirtyChange={(dirty) => dirtyStates.push(dirty)} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-assist")).toBeTruthy());
    fireEvent.click(getByTestId("image-prompt-template-family-scene-background"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    await waitFor(() => expect(getByTestId("detail").textContent).toContain("canon scene-background pony"));
    fireEvent.click(rowButton(getByTestId, "portrait"));
    await waitFor(() => expect(getByTestId("detail").textContent).toContain("Portrait"));

    expect(dirtyStates.includes(true)).toBe(false);
  });

  test("reports inactive as clean without losing a dirty draft or its save path", async () => {
    const api = makeApi(makeTemplates(true));
    const dirtyStates: boolean[] = [];
    const onDirtyChange = (dirty: boolean) => dirtyStates.push(dirty);
    const { getByRole, getByTestId, rerender } = render(<Harness api={api} onDirtyChange={onDirtyChange} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    const textarea = await waitFor(() => getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement);
    fireEvent.change(textarea, { target: { value: "inactive dirty portrait" } });
    await waitFor(() => expect(dirtyStates.at(-1)).toBe(true));

    rerender(<Harness api={api} active={false} onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(dirtyStates.at(-1)).toBe(false));
    expect(getByTestId("detail").textContent).toBe("");

    rerender(<Harness api={api} onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("inactive dirty portrait"));
    await waitFor(() => expect(dirtyStates.at(-1)).toBe(true));
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("dirty row and selected-family changes require discard confirmation, preserve on cancel, and apply on confirm", async () => {
    const api = makeApi(makeTemplates(true));
    const { getAllByText, getByRole, getByTestId, getByText, queryByText } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    const textarea = await waitFor(() => {
      const element = getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement | null;
      expect(element?.value).toBe("custom portrait");
      return element!;
    });
    fireEvent.change(textarea, { target: { value: "dirty portrait" } });

    fireEvent.click(rowButton(getByTestId, "character"));
    await waitFor(() => expect(getByText("Discard changes?")).toBeTruthy());
    expect(getByTestId("detail").textContent).toContain("Portrait");
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(queryByText("Discard changes?")).toBeNull());
    expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("dirty portrait");

    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    await waitFor(() => expect(getByText("Discard changes?")).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(queryByText("Discard changes?")).toBeNull());
    expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("dirty portrait");

    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    await waitFor(() => expect(getByText("Discard changes?")).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("canon portrait pony"));
  });

  test("confirming discard applies the pending row selection", async () => {
    const api = makeApi(makeTemplates(true));
    const { getByRole, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    const textarea = await waitFor(() => getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement);
    fireEvent.change(textarea, { target: { value: "dirty portrait" } });
    fireEvent.click(rowButton(getByTestId, "character"));
    await waitFor(() => expect(getByRole("button", { name: "Confirm" })).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(getByTestId("detail").textContent).toContain("Character"));
    expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("canon character prose");
  });

  test("free mode is fixed to prose and saves and resets only its prose cell", async () => {
    const api = makeApi();
    const { getByRole, getByTestId, queryByText } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-free")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "free"));
    const freeFamily = getByTestId("image-prompt-template-family-free") as HTMLButtonElement;
    expect(freeFamily.disabled).toBe(true);
    fireEvent.click(freeFamily);
    expect(queryByText("Pony")).toBeNull();

    const textarea = await waitFor(() => getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement);
    expect(textarea.value).toBe("canon free prose");
    fireEvent.change(textarea, { target: { value: "custom free prompt" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.upsert).toHaveBeenCalledWith("free", "prose", { body: "custom free prompt" }));

    await waitFor(() => expect(getByTestId("image-prompt-template-status-free").getAttribute("aria-label")).toBe("Customized"));
    fireEvent.click(getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith("free", "prose"));
    expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("canon free prose");
  });

  test("shows an own-family canon quality block with the custom-quality toggle initially off", async () => {
    const api = makeApi();
    const { getAllByText, getByRole, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);

    await waitFor(() => expect(getByTestId("image-prompt-template-quality-canon").textContent).toBe("canon quality pony"));
    const toggle = getByRole("switch", { name: "Customize quality text" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getByTestId("detail").querySelector("textarea[aria-label='Custom quality text']")).toBeNull();
  });

  test("never exposes quality controls for the negative row", async () => {
    const api = makeApi();
    const { getAllByText, getByTestId, queryByRole } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-negative")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "negative"));
    fireEvent.click(getByTestId("image-prompt-template-family-negative"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);

    await waitFor(() => expect(getByTestId("detail").textContent).toContain("Shared negative prompt"));
    expect(getByTestId("detail").querySelector("[data-testid='image-prompt-template-quality-canon']")).toBeNull();
    expect(queryByRole("switch", { name: "Customize quality text" })).toBeNull();
    expect(getByTestId("detail").querySelector("textarea[aria-label='Custom quality text']")).toBeNull();
  });

  test("blank custom quality with a canonical body resets to the returned canon cell", async () => {
    const api = makeApi();
    const { getAllByText, getByRole, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    fireEvent.click(await waitFor(() => getByRole("switch", { name: "Customize quality text" })));
    const qualityEditor = getByTestId("detail").querySelector("textarea[aria-label='Custom quality text']") as HTMLTextAreaElement;
    fireEvent.change(qualityEditor, { target: { value: "   " } });
    fireEvent.click(getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.reset).toHaveBeenCalledWith("portrait", "pony"));
    await waitFor(() => expect(getByTestId("image-prompt-template-status-portrait").getAttribute("aria-label")).toBe("Canon"));
    expect(getByTestId("detail").querySelector("textarea[aria-label='Custom quality text']")).toBeNull();
  });

  test("body-only edits preserve an existing custom quality override when the server cell returns it", async () => {
    const templates = makeTemplates();
    templates.cells = templates.cells.map((cell) => cell.rowKey === "portrait" && cell.family === "pony"
      ? makeCell("portrait", "pony", "stored body", "stored quality")
      : cell);
    const api = makeApi(templates);
    const { getAllByText, getByRole, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    const toggle = await waitFor(() => getByRole("switch", { name: "Customize quality text" }));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const bodyEditor = getByTestId("detail").querySelector("textarea[aria-label='Image prompt template']") as HTMLTextAreaElement;
    fireEvent.change(bodyEditor, { target: { value: "updated body" } });
    fireEvent.click(getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.upsert).toHaveBeenCalledWith("portrait", "pony", { body: "updated body" }));
    await waitFor(() => expect((getByTestId("detail").querySelector("textarea[aria-label='Custom quality text']") as HTMLTextAreaElement).value).toBe("stored quality"));
    expect(getByRole("switch", { name: "Customize quality text" }).getAttribute("aria-checked")).toBe("true");
  });

  test("saving a custom quality override uses the returned cell as truth", async () => {
    const api = makeApi();
    api.upsert = mock(async (rowKey, family) => makeCell(rowKey, family, "server portrait", "server quality"));
    const { getAllByText, getByRole, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    const toggle = await waitFor(() => getByRole("switch", { name: "Customize quality text" }));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    const qualityEditor = getByTestId("detail").querySelector("textarea[aria-label='Custom quality text']") as HTMLTextAreaElement;
    expect(qualityEditor.value).toBe("canon quality pony");
    fireEvent.change(qualityEditor, { target: { value: "my quality" } });
    fireEvent.click(getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.upsert).toHaveBeenCalledWith("portrait", "pony", { body: "canon portrait pony", qualityText: "my quality" }));
    await waitFor(() => expect((getByTestId("detail").querySelector("textarea[aria-label='Custom quality text']") as HTMLTextAreaElement).value).toBe("server quality"));
    expect((getByTestId("detail").querySelector("textarea[aria-label='Image prompt template']") as HTMLTextAreaElement).value).toBe("server portrait");
  });

  test("clearing quality preserves an independently customized body and resets a quality-only override", async () => {
    const templates = makeTemplates();
    templates.cells = templates.cells.map((cell) => cell.rowKey === "portrait" && cell.family === "pony"
      ? makeCell("portrait", "pony", "custom portrait", "custom quality")
      : cell);
    const api = makeApi(templates);
    const { getAllByText, getByRole, getByTestId, unmount } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    const toggle = await waitFor(() => getByRole("switch", { name: "Customize quality text" }));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.upsert).toHaveBeenCalledWith("portrait", "pony", { body: "custom portrait", qualityText: null }));

    const qualityOnly = makeTemplates();
    qualityOnly.cells = qualityOnly.cells.map((cell) => cell.rowKey === "portrait" && cell.family === "pony"
      ? makeCell("portrait", "pony", null, "custom quality")
      : cell);
    const qualityOnlyApi = makeApi(qualityOnly);
    unmount();
    const qualityOnlyView = render(<Harness api={qualityOnlyApi} />);
    await waitFor(() => expect(qualityOnlyView.getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(qualityOnlyView.getByTestId, "portrait"));
    fireEvent.click(qualityOnlyView.getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(qualityOnlyView.getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(qualityOnlyView.getAllByText("Pony").at(-1)!);
    fireEvent.click(await waitFor(() => qualityOnlyView.getByRole("switch", { name: "Customize quality text" })));
    fireEvent.click(qualityOnlyView.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(qualityOnlyApi.reset).toHaveBeenCalledWith("portrait", "pony"));
  });

  test("quality edits require discard confirmation, survive inactive state, and never appear for no-quality rows", async () => {
    const api = makeApi();
    const dirtyStates: boolean[] = [];
    const { getAllByText, getByRole, getByTestId, getByText, queryByText, rerender } = render(<Harness api={api} onDirtyChange={(dirty) => dirtyStates.push(dirty)} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    expect(getByTestId("detail").querySelector("[data-testid='image-prompt-template-quality-canon']")).toBeNull();
    fireEvent.click(rowButton(getByTestId, "free"));
    await waitFor(() => expect(getByTestId("detail").querySelector("[data-testid='image-prompt-template-quality-canon']")).toBeNull());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    fireEvent.click(await waitFor(() => getByRole("switch", { name: "Customize quality text" })));
    await waitFor(() => expect(dirtyStates.at(-1)).toBe(true));

    fireEvent.click(rowButton(getByTestId, "character"));
    await waitFor(() => expect(getByText("Discard changes?")).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(queryByText("Discard changes?")).toBeNull());
    expect(getByRole("switch", { name: "Customize quality text" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(getAllByText("Prose").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Prose").at(-1)!);
    await waitFor(() => expect(getByText("Discard changes?")).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(queryByText("Discard changes?")).toBeNull());

    rerender(<Harness api={api} active={false} onDirtyChange={(dirty) => dirtyStates.push(dirty)} />);
    await waitFor(() => expect(dirtyStates.at(-1)).toBe(false));
    rerender(<Harness api={api} onDirtyChange={(dirty) => dirtyStates.push(dirty)} />);
    await waitFor(() => expect(getByRole("switch", { name: "Customize quality text" }).getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(dirtyStates.at(-1)).toBe(true));

    fireEvent.click(rowButton(getByTestId, "free"));
    await waitFor(() => expect(getByText("Discard changes?")).toBeTruthy());
  });

  test("PUT save and DELETE reset use returned server cells and freeze editing/navigation while pending", async () => {
    const api = makeApi(makeTemplates(true));
    const put = deferred<ImagePromptTemplateCellValue>();
    const reset = deferred<ImagePromptTemplateCellValue>();
    api.upsert = mock(async () => put.promise);
    api.reset = mock(async () => reset.promise);
    const { getByRole, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "portrait"));
    const textarea = await waitFor(() => getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement);
    fireEvent.change(textarea, { target: { value: "saved portrait" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.upsert).toHaveBeenCalledWith("portrait", "prose", { body: "saved portrait" }));
    expect(textarea.disabled).toBe(true);
    expect(rowButton(getByTestId, "character").disabled).toBe(true);
    expect((getByTestId("image-prompt-template-family-portrait") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "must not replace saved value" } });
    fireEvent.click(rowButton(getByTestId, "character"));

    await act(async () => { put.resolve(makeCell("portrait", "prose", "server portrait")); });
    await waitFor(() => expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("server portrait"));
    expect(getByTestId("detail").textContent).toContain("Portrait");
    expect(getByTestId("image-prompt-template-status-portrait").getAttribute("aria-label")).toBe("Customized");

    fireEvent.click(getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith("portrait", "prose"));
    expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect(rowButton(getByTestId, "character").disabled).toBe(true);
    fireEvent.click(rowButton(getByTestId, "character"));
    await act(async () => { reset.resolve(makeCell("portrait", "prose")); });
    await waitFor(() => expect((getByTestId("detail").querySelector("textarea") as HTMLTextAreaElement).value).toBe("canon portrait prose"));
    expect(getByTestId("detail").textContent).toContain("Portrait");
    expect(getByTestId("image-prompt-template-status-portrait").getAttribute("aria-label")).toBe("Canon");
  });

  test("renders assist core and selected-family addendum as read-only content", async () => {
    const api = makeApi();
    const { getAllByText, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByTestId("image-prompt-template-row-assist")).toBeTruthy());
    fireEvent.click(rowButton(getByTestId, "assist"));
    await waitFor(() => expect(getByTestId("image-prompt-template-assist-core").textContent).toContain("extract the visible scene"));
    expect(getByTestId("detail").querySelector("textarea")).toBeNull();

    fireEvent.click(getByTestId("image-prompt-template-family-assist"));
    await waitFor(() => expect(getAllByText("Pony").length).toBeGreaterThan(0));
    fireEvent.click(getAllByText("Pony").at(-1)!);
    await waitFor(() => expect(getByTestId("image-prompt-template-assist-addendum").textContent).toContain("return ordered tags"));
    expect(getByTestId("footer").querySelector("button[aria-label='Save']")).toBeNull();
  });

  test("shows a retryable loading error", async () => {
    const api = makeApi();
    let shouldFail = true;
    api.listTemplates = mock(async () => {
      if (shouldFail) throw new Error("offline");
      return makeTemplates();
    });
    const { getByRole, getByText, getByTestId } = render(<Harness api={api} />);

    await waitFor(() => expect(getByText("Failed to load image templates")).toBeTruthy());
    shouldFail = false;
    fireEvent.click(getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getByTestId("image-prompt-template-row-assist")).toBeTruthy());
  });
});

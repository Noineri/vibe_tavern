/**
 * ScriptEditor — explicit-save integration tests.
 *
 * Pins the complete editor boundary with the REAL CodeMirror and ScriptTester:
 * local draft → explicit Save → app-client PATCH, and unsaved draft → test
 * endpoint override. Network, stores unrelated to script drafts, i18n and
 * heavyweight children are mocked; the editor/controller path is real.
 *
 * Invariants:
 *   - typing never writes to the server; Save submits one complete snapshot;
 *   - Save never refetches the full script list;
 *   - Run executes the current unsaved code without first saving it;
 *   - templates mutate only the draft;
 *   - dirty drafts survive World & Lore panel unmount/remount;
 *   - edits made while Save is in flight remain dirty after that save resolves.
 *
 * Runner: vitest (apps/web) + happy-dom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import {
  listScripts,
  listAllScripts,
  createScript,
  updateScript,
  deleteScript,
  importScript,
  getScriptLinks,
  setScriptLinks,
  testScript,
  type ScriptRecord,
} from "../../../app-client.js";
import { useScriptPanel } from "./ScriptEditor.js";
import { SCRIPT_TEMPLATES } from "./script-templates/index.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";

vi.mock("../../../app-client.js", () => ({
  listScripts: vi.fn(),
  listAllScripts: vi.fn(),
  createScript: vi.fn(),
  updateScript: vi.fn(),
  deleteScript: vi.fn(),
  importScript: vi.fn(),
  getScriptLinks: vi.fn(),
  setScriptLinks: vi.fn(),
  testScript: vi.fn(),
}));

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

vi.mock("../../../stores/snapshot-store.js", () => ({
  useAllCharacters: () => [],
}));

vi.mock("../../../stores/api-actions/bootstrap-actions.js", () => ({
  useBootstrapStore: (selector: (s: { personas: unknown[] }) => unknown) => selector({ personas: [] }),
}));

vi.mock("../../../hooks/use-mobile.js", () => ({
  useIsMobile: () => false,
}));

vi.mock("../../shared/AiAssistantModal.js", () => ({
  AiAssistantModal: () => null,
}));
vi.mock("../../shared/LinkBindingPopover.js", () => ({
  LinkBindingPopover: () => null,
}));
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const baseScript: ScriptRecord = {
  id: "s1",
  name: "Test Script",
  description: "",
  code: "",
  scriptKind: "prompt",
  scopeType: "character",
  characterId: "c1",
  personaId: null,
  chatId: null,
  enabled: true,
  sortOrder: 0,
};

let serverScript: ScriptRecord;
let updateGate: { promise: Promise<ScriptRecord>; resolve: (value: ScriptRecord) => void } | null;

function holdNextUpdate() {
  let resolveFn: (value: ScriptRecord) => void = () => {};
  const promise = new Promise<ScriptRecord>((resolve) => { resolveFn = resolve; });
  const gate = { promise, resolve: resolveFn };
  updateGate = gate;
  return gate;
}

beforeEach(() => {
  vi.clearAllMocks();
  useScriptDraftStore.getState().resetAll();
  serverScript = { ...baseScript };
  updateGate = null;
  vi.mocked(listScripts).mockImplementation(async () => [{ ...serverScript }]);
  vi.mocked(listAllScripts).mockResolvedValue([]);
  vi.mocked(getScriptLinks).mockResolvedValue([]);
  vi.mocked(createScript).mockResolvedValue({ ...baseScript });
  vi.mocked(deleteScript).mockResolvedValue(undefined);
  vi.mocked(importScript).mockResolvedValue({ ...baseScript });
  vi.mocked(setScriptLinks).mockResolvedValue([]);
  vi.mocked(updateScript).mockImplementation(async (_id, patch) => {
    serverScript = { ...serverScript, ...patch };
    const gate = updateGate;
    updateGate = null;
    if (gate) return gate.promise;
    return { ...serverScript };
  });
  vi.mocked(testScript).mockResolvedValue({
    kind: "prompt",
    personality: "",
    scenario: "",
    state: {},
    injectedMessages: [],
    console: [],
    shared: {},
    errors: [],
  });
});

function Harness() {
  const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "character" });
  return <>{panel.modals}{panel.activeScriptId ? panel.scriptEditorPanel : panel.scriptListContent}</>;
}

async function openEditor(container: HTMLElement): Promise<EditorView> {
  fireEvent.click(await screen.findByText("Test Script"));
  let view: EditorView | null = null;
  await waitFor(() => {
    const dom = container.querySelector(".cm-editor");
    if (!(dom instanceof HTMLElement)) throw new Error("cm-editor not mounted");
    view = EditorView.findFromDOM(dom);
    if (!view) throw new Error("EditorView not found");
  });
  if (!view) throw new Error("unreachable");
  return view;
}

function replaceCode(view: EditorView, code: string) {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  });
}

describe("useScriptPanel explicit save", () => {
  it("keeps every field local until Save, then PATCHes one complete snapshot without refetching", async () => {
    const { container } = render(<Harness />);
    const view = await openEditor(container);

    fireEvent.change(screen.getByPlaceholderText("script_name"), { target: { value: "Renamed" } });
    fireEvent.change(screen.getByPlaceholderText("script_desc_placeholder"), { target: { value: "Description" } });
    fireEvent.click(screen.getByRole("switch"));
    replaceCode(view, "context.state.set('x', 1);");

    expect(vi.mocked(updateScript)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(vi.mocked(updateScript)).toHaveBeenCalledWith("s1", {
        name: "Renamed",
        description: "Description",
        code: "context.state.set('x', 1);",
        enabled: false,
        scriptKind: "prompt",
      });
    });
    expect(vi.mocked(updateScript)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listScripts)).toHaveBeenCalledTimes(1);
  });

  it("saves the current draft with Ctrl/Cmd+S", async () => {
    const { container } = render(<Harness />);
    const view = await openEditor(container);
    replaceCode(view, "keyboard save");

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => {
      expect(vi.mocked(updateScript)).toHaveBeenCalledWith("s1", expect.objectContaining({ code: "keyboard save" }));
    });
  });

  it("runs the current unsaved code directly, without saving first", async () => {
    const { container } = render(<Harness />);
    const view = await openEditor(container);
    replaceCode(view, "context.character.personality = 'DRAFT';");

    fireEvent.change(screen.getByPlaceholderText("script_test_input_placeholder"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("script_test_run"));

    await waitFor(() => {
      expect(vi.mocked(testScript)).toHaveBeenCalledWith("s1", {
        messages: [{ role: "user", content: "hello" }],
        code: "context.character.personality = 'DRAFT';",
      });
    });
    expect(vi.mocked(updateScript)).not.toHaveBeenCalled();
  });

  it("appends a template to the draft without saving it", async () => {
    const { container } = render(<Harness />);
    const view = await openEditor(container);
    replaceCode(view, "AAA");

    const templateKey = Object.keys(SCRIPT_TEMPLATES)[0];
    if (!templateKey) throw new Error("no script templates");
    const template = SCRIPT_TEMPLATES[templateKey];
    if (!template) throw new Error("unreachable");
    fireEvent.click(screen.getByText("script_template_" + templateKey));

    expect(view.state.doc.toString()).toBe("AAA\n\n" + template.code.replaceAll("\r\n", "\n"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    expect(vi.mocked(updateScript)).not.toHaveBeenCalled();
  });

  it("preserves an unsaved draft across panel unmount/remount", async () => {
    const first = render(<Harness />);
    const firstView = await openEditor(first.container);
    replaceCode(firstView, "UNSAVED DRAFT");
    first.unmount();

    expect(vi.mocked(updateScript)).not.toHaveBeenCalled();

    const second = render(<Harness />);
    const secondView = await openEditor(second.container);
    expect(secondView.state.doc.toString()).toBe("UNSAVED DRAFT");
  });

  it("keeps edits made during an in-flight Save dirty for the next Save", async () => {
    const gate = holdNextUpdate();
    const { container } = render(<Harness />);
    const view = await openEditor(container);
    replaceCode(view, "A");
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(vi.mocked(updateScript)).toHaveBeenCalledTimes(1));

    replaceCode(view, "AB");
    await act(async () => { gate.resolve({ ...serverScript, code: "A" }); });

    const saveButton = await screen.findByRole("button", { name: "save" });
    if (!(saveButton instanceof HTMLButtonElement)) throw new Error("save control is not a button");
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(vi.mocked(updateScript)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateScript).mock.calls[1]?.[1]).toMatchObject({ code: "AB" });
  });
});

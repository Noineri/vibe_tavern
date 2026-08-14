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
 * Runner: bun:test with scoped happy-dom.
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import type { ReactNode } from "react";
import {
  type ScriptRecord,
} from "../../../app-client.js";
import { SCRIPT_TEMPLATES } from "./script-templates/index.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const listScripts = mock((_characterId?: string) => Promise.resolve<ScriptRecord[]>([]));
const listAllScripts = mock(() => Promise.resolve<ScriptRecord[]>([]));
const createScript = mock(() => Promise.resolve<ScriptRecord>(undefined as never));
const updateScript = mock((_id: string, _patch: Partial<ScriptRecord>) => Promise.resolve<ScriptRecord>(undefined as never));
const deleteScript = mock(() => Promise.resolve());
const importScript = mock(() => Promise.resolve<ScriptRecord>(undefined as never));
const getScriptLinks = mock(() => Promise.resolve([]));
const setScriptLinks = mock(() => Promise.resolve([]));
const testScript = mock(() => Promise.resolve({
	kind: "prompt" as const,
	personality: "",
	scenario: "",
	state: {},
	injectedMessages: [],
	console: [],
	shared: {},
	errors: [],
}));
const realAppClient = await import("../../../app-client.js");
const realI18nContext = await import("../../../i18n/context.js");
const realSnapshotStore = await import("../../../stores/snapshot-store.js");
const realBootstrapActions = await import("../../../stores/api-actions/bootstrap-actions.js");
const realMobileHook = await import("../../../hooks/use-mobile.js");
const realAiAssistantModal = await import("../../shared/AiAssistantModal.js");
const realLinkBindingPopover = await import("../../shared/LinkBindingPopover.js");
const realTooltip = await import("../../shared/Tooltip.js");

mock.module("../../../app-client.js", () => ({
	...realAppClient,
  listScripts,
  listAllScripts,
  createScript,
  updateScript,
  deleteScript,
  importScript,
  getScriptLinks,
  setScriptLinks,
  testScript,
}));

mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("../../../stores/snapshot-store.js", () => ({
	...realSnapshotStore,
  useAllCharacters: () => [],
}));

mock.module("../../../stores/api-actions/bootstrap-actions.js", () => ({
	...realBootstrapActions,
  useBootstrapStore: <T,>(selector: (state: { personas: never[] }) => T): T => selector({ personas: [] }),
}));

mock.module("../../../hooks/use-mobile.js", () => ({
	...realMobileHook,
  useIsMobile: () => false,
}));

mock.module("../../shared/AiAssistantModal.js", () => ({
	...realAiAssistantModal,
  AiAssistantModal: () => null,
}));
mock.module("../../shared/LinkBindingPopover.js", () => ({
	...realLinkBindingPopover,
  LinkBindingPopover: () => null,
}));
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let useScriptPanel: typeof import("./ScriptEditor.js").useScriptPanel;
type EditorViewInstance = import("@codemirror/view").EditorView;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let userEvent: typeof import("@testing-library/user-event").default;
let EditorView: typeof import("@codemirror/view").EditorView;
beforeAll(async () => {
	({ act, fireEvent, render, waitFor } = await import("@testing-library/react"));
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ EditorView } = await import("@codemirror/view"));
	({ useScriptPanel } = await import("./ScriptEditor.js"));
});

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
  defaultVisualId: null,
  copilotProfileId: null,
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
  listScripts.mockClear();
  listAllScripts.mockClear();
  createScript.mockClear();
  updateScript.mockClear();
  deleteScript.mockClear();
  importScript.mockClear();
  getScriptLinks.mockClear();
  setScriptLinks.mockClear();
  testScript.mockClear();
  useScriptDraftStore.getState().resetAll();
  serverScript = { ...baseScript };
  updateGate = null;
  listScripts.mockImplementation(async () => [{ ...serverScript }]);
  listAllScripts.mockResolvedValue([]);
  getScriptLinks.mockResolvedValue([]);
  createScript.mockResolvedValue({ ...baseScript });
  deleteScript.mockResolvedValue(undefined);
  importScript.mockResolvedValue({ ...baseScript });
  setScriptLinks.mockResolvedValue([]);
  updateScript.mockImplementation(async (_id, patch) => {
    serverScript = { ...serverScript, ...patch };
    const gate = updateGate;
    updateGate = null;
    if (gate) return gate.promise;
    return { ...serverScript };
  });
  testScript.mockResolvedValue({
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

function HarnessAll() {
  const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "all" });
  return <>{panel.modals}{panel.activeScriptId ? panel.scriptEditorPanel : panel.scriptListContent}</>;
}

async function openEditor(container: HTMLElement, findByText: (text: string) => Promise<HTMLElement>): Promise<EditorViewInstance> {
  fireEvent.click(await findByText("Test Script"));
  let view: EditorViewInstance | null = null;
  await waitFor(() => {
    const dom = container.querySelector(".cm-editor");
    if (!(dom instanceof HTMLElement)) throw new Error("cm-editor not mounted");
    view = EditorView.findFromDOM(dom);
    if (!view) throw new Error("EditorView not found");
  });
  if (!view) throw new Error("unreachable");
  return view;
}

function replaceCode(view: EditorViewInstance, code: string) {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  });
}

describe("useScriptPanel explicit save", () => {
  it("keeps every field local until Save, then PATCHes one complete snapshot without refetching", async () => {
    const { container, findByText, getByPlaceholderText, getByRole } = render(<Harness />);
    const view = await openEditor(container, findByText);
    const user = userEvent.setup();

    await user.clear(getByPlaceholderText("script_name"));
    await user.type(getByPlaceholderText("script_name"), "Renamed");
    await user.type(getByPlaceholderText("script_desc_placeholder"), "Description");
    fireEvent.click(getByRole("switch"));
    replaceCode(view, "context.state.set('x', 1);");

    expect(updateScript).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("s1", {
        name: "Renamed",
        description: "Description",
        code: "context.state.set('x', 1);",
        enabled: false,
        scriptKind: "prompt",
      });
    });
    expect(updateScript).toHaveBeenCalledTimes(1);
    expect(listScripts).toHaveBeenCalledTimes(1);
  });

  it("saves the current draft with Ctrl/Cmd+S", async () => {
    const { container, findByText } = render(<Harness />);
    const view = await openEditor(container, findByText);
    replaceCode(view, "keyboard save");

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("s1", expect.objectContaining({ code: "keyboard save" }));
    });
  });

  it("runs the current unsaved code directly, without saving first", async () => {
    const { container, findByText, getByPlaceholderText, getByText } = render(<Harness />);
    const view = await openEditor(container, findByText);
    const user = userEvent.setup();
    replaceCode(view, "context.character.personality = 'DRAFT';");

    await user.type(getByPlaceholderText("script_test_input_placeholder"), "hello");
    fireEvent.click(getByText("script_test_run"));

    await waitFor(() => {
      expect(testScript).toHaveBeenCalledWith("s1", {
        messages: [{ role: "user", content: "hello" }],
        code: "context.character.personality = 'DRAFT';",
      });
    });
    expect(updateScript).not.toHaveBeenCalled();
  });

  it("keeps the Dice badge beside the test-panel title and bottom-aligns the run button", async () => {
    serverScript = { ...baseScript, scriptKind: "dice" };
    const { container, findByText, getByText, getByRole } = render(<Harness />);
    await openEditor(container, findByText);

    const title = getByText("script_test_panel");
    const badge = getByText("DICE");
    expect(title.parentElement).toBe(badge.parentElement);
    expect(title.parentElement?.getAttribute("class")).toContain("gap-2");

    const runButton = getByRole("button", { name: "script_test_run" });
    expect(runButton.parentElement?.getAttribute("class")).toContain("items-end");
  });

  it("appends a template to the draft without saving it", async () => {
    const { container, findByText, getByText } = render(<Harness />);
    const view = await openEditor(container, findByText);
    replaceCode(view, "AAA");

    const templateKey = Object.keys(SCRIPT_TEMPLATES)[0];
    if (!templateKey) throw new Error("no script templates");
    const template = SCRIPT_TEMPLATES[templateKey];
    if (!template) throw new Error("unreachable");
    fireEvent.click(getByText("script_template_" + templateKey));

    expect(view.state.doc.toString()).toBe("AAA\n\n" + template.code.replaceAll("\r\n", "\n"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    expect(updateScript).not.toHaveBeenCalled();
  });

  it("preserves an unsaved draft across panel unmount/remount", async () => {
    const first = render(<Harness />);
    const firstView = await openEditor(first.container, first.findByText);
    replaceCode(firstView, "UNSAVED DRAFT");
    first.unmount();

    expect(updateScript).not.toHaveBeenCalled();

    const second = render(<Harness />);
    const secondView = await openEditor(second.container, second.findByText);
    expect(secondView.state.doc.toString()).toBe("UNSAVED DRAFT");
  });

  it("keeps edits made during an in-flight Save dirty for the next Save", async () => {
    const gate = holdNextUpdate();
    const { container, findByText, getByRole, findByRole } = render(<Harness />);
    const view = await openEditor(container, findByText);
    replaceCode(view, "A");
    fireEvent.click(getByRole("button", { name: "save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));

    replaceCode(view, "AB");
    await act(async () => { gate.resolve({ ...serverScript, code: "A" }); });

    const saveButton = await findByRole("button", { name: "save" });
    if (!(saveButton instanceof HTMLButtonElement)) throw new Error("save control is not a button");
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(2));
    expect(updateScript.mock.calls[1]?.[1]).toMatchObject({ code: "AB" });
  });
});

// ── IR-90A: interactive scripts are owned exclusively by the Experience editor ─
describe("useScriptPanel interactive-script filtering", () => {
  it("never lists an interactive script returned by listScripts (character scope)", async () => {
    listScripts.mockResolvedValue([
      { ...baseScript, id: "p1", name: "Prompt One", scriptKind: "prompt" },
      { ...baseScript, id: "d1", name: "Dice One", scriptKind: "dice" },
      { ...baseScript, id: "i1", name: "Interactive One", scriptKind: "interactive" },
    ]);
    const { findByText, queryByText } = render(<Harness />);

    expect(await findByText("Prompt One")).toBeTruthy();
    expect(await findByText("Dice One")).toBeTruthy();
    // The interactive script is filtered out at the list-fetch choke point and
    // therefore is never listed, never badged, and never openable/tested as a
    // PROMPT script by this generic Prompt/Dice editor.
    expect(queryByText("Interactive One")).toBeNull();
  });

  it("filters interactive scripts from the 'all' overview scope (listAllScripts) too", async () => {
    listAllScripts.mockResolvedValue([
      { ...baseScript, id: "p1", name: "Prompt All", scriptKind: "prompt" },
      { ...baseScript, id: "i1", name: "Interactive All", scriptKind: "interactive" },
    ]);
    const { findByText, queryByText } = render(<HarnessAll />);

    expect(await findByText("Prompt All")).toBeTruthy();
    expect(queryByText("Interactive All")).toBeNull();
  });
});

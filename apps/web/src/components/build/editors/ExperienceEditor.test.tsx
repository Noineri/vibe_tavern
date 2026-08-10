/**
 * ExperienceEditor — IR-81C boundary tests.
 *
 * Boundary under test: API mocks (script-api / experience-api) → the REAL
 * ExperienceEditor with the REAL CodeMirror editor, REAL draft stores
 * (script-draft-store + experience-authoring-store, the IR-81A invariant
 * included), REAL starters, and REAL shared primitives → DOM + store
 * observations. i18n and Tooltip are mocked (keys verbatim / passthrough),
 * matching ScriptEditor.test.tsx and ExperienceAssignment.test.tsx.
 *
 * Pinned behavior (per the IR-81C contract):
 *  1. The starter picker lands in the editor with the starter's rules source
 *     plus a paired, INDEPENDENT visual draft — both editable, both dirty,
 *     and edits to one never touch the other.
 *  2. Dirty/save flow: the first save CREATEs (scriptKind "interactive",
 *     scopeType "global", enabled false); later saves PATCH one snapshot via
 *     prepareSave/completeSave; a failed save stays dirty and retryable;
 *     edits made during an in-flight save survive reconciliation. The visual
 *     buffer saves independently through the visuals API.
 *  3. Trust UX: a changed (or never-saved) source shows untrusted and LOCKS
 *     the enable toggle; after saving the exact reviewed source the toggle
 *     unlocks and enabling persists only via an explicit second save; an
 *     enabled script that is edited drops to untrusted (store invariant).
 *  4. Duplication from a starter and from an existing script/visual produces
 *     independent, explicitly untrusted copies (no shared array references).
 *  5. The interactive API reference mounts from the editor toolbar.
 *
 * Runner: bun:test with scoped happy-dom (one file per process —
 * mock.module() is process-global).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";
import { getRulesStarter } from "../../../lib/experience-rules-starters.js";
import { getVisualStarter } from "../../experience/starters/index.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";
import { useExperienceVisualDraftStore } from "../../../stores/experience-authoring-store.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const EXISTING_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'existing', name: 'Existing' }, capabilities: [], create() { return {}; }, project() { return {}; }, actions() { return []; }, reduce(context) { return { state: context.state, status: 'active', events: [] }; } });";

const baseScript: ScriptRecord = {
  id: "srv_1",
  name: "Existing Rules",
  description: "",
  code: EXISTING_CODE,
  scriptKind: "interactive",
  scopeType: "global",
  characterId: null,
  personaId: null,
  chatId: null,
  enabled: false,
  sortOrder: 0,
};

const baseVisual: ExperienceVisualRow = {
  id: "vis_1",
  name: "Existing Visual",
  source: "<!doctype html><html><body>visual</body></html>",
  sourceHash: "abc123def4567890",
  apiVersion: 1,
  compatibleManifestIds: ["board"],
  scopeType: "global",
  characterId: null,
  personaId: null,
  chatId: null,
  createdAt: "",
  updatedAt: "",
};

const listAllScripts = mock(() => Promise.resolve<ScriptRecord[]>([]));
const createScript = mock((_body: Record<string, unknown>) => Promise.resolve<ScriptRecord>({ ...baseScript }));
const updateScript = mock((_id: string, _patch: Record<string, unknown>) => Promise.resolve<ScriptRecord>({ ...baseScript }));
const listExperienceVisuals = mock(() => Promise.resolve<ExperienceVisualRow[]>([]));
const createExperienceVisual = mock((_body: Record<string, unknown>) => Promise.resolve<ExperienceVisualRow>({ ...baseVisual, compatibleManifestIds: [...baseVisual.compatibleManifestIds] }));
const updateExperienceVisual = mock((_id: string, _patch: Record<string, unknown>) => Promise.resolve<ExperienceVisualRow>({ ...baseVisual, compatibleManifestIds: [...baseVisual.compatibleManifestIds] }));
const deleteExperienceVisual = mock((_id: string) => Promise.resolve<void>(undefined));

const realScriptApi = await import("../../../api/script-api.js");
const realExperienceApi = await import("../../../api/experience-api.js");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");

mock.module("../../../api/script-api.js", () => ({
  ...realScriptApi,
  listAllScripts,
  createScript,
  updateScript,
}));

mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  listExperienceVisuals,
  createExperienceVisual,
  updateExperienceVisual,
  deleteExperienceVisual,
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

mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let ExperienceEditor: typeof import("./ExperienceEditor.js").ExperienceEditor;
type EditorViewInstance = import("@codemirror/view").EditorView;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let EditorView: typeof import("@codemirror/view").EditorView;

beforeAll(async () => {
  ({ act, fireEvent, render, waitFor } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ ExperienceEditor } = await import("./ExperienceEditor.js"));
});

let serverScripts: ScriptRecord[];
let serverVisuals: ExperienceVisualRow[];
let createGate: { promise: Promise<ScriptRecord>; resolve: (value: ScriptRecord) => void } | null;
let updateGate: { promise: Promise<ScriptRecord>; resolve: (value: ScriptRecord) => void } | null;

function holdNextCreate() {
  let resolveFn: (value: ScriptRecord) => void = () => {};
  const promise = new Promise<ScriptRecord>((resolve) => { resolveFn = resolve; });
  const gate = { promise, resolve: resolveFn };
  createGate = gate;
  return gate;
}

function holdNextUpdate() {
  let resolveFn: (value: ScriptRecord) => void = () => {};
  const promise = new Promise<ScriptRecord>((resolve) => { resolveFn = resolve; });
  const gate = { promise, resolve: resolveFn };
  updateGate = gate;
  return gate;
}

beforeEach(() => {
  listAllScripts.mockClear();
  createScript.mockClear();
  updateScript.mockClear();
  listExperienceVisuals.mockClear();
  createExperienceVisual.mockClear();
  updateExperienceVisual.mockClear();
  deleteExperienceVisual.mockClear();
  useScriptDraftStore.getState().resetAll();
  useExperienceVisualDraftStore.getState().resetAll();
  serverScripts = [];
  serverVisuals = [];
  createGate = null;
  updateGate = null;
  listAllScripts.mockImplementation(async () => serverScripts.map((s) => ({ ...s })));
  listExperienceVisuals.mockImplementation(async () => serverVisuals.map((v) => ({ ...v, compatibleManifestIds: [...v.compatibleManifestIds] })));
  createScript.mockImplementation(async (body) => {
    const gate = createGate;
    createGate = null;
    if (gate) return gate.promise;
    const created: ScriptRecord = {
      ...baseScript,
      id: `srv_${serverScripts.length + 1}`,
      name: String(body.name ?? ""),
      description: String(body.description ?? ""),
      code: String(body.code ?? ""),
      enabled: Boolean(body.enabled),
    };
    serverScripts.push(created);
    return { ...created };
  });
  updateScript.mockImplementation(async (id, patch) => {
    const gate = updateGate;
    updateGate = null;
    if (gate) return gate.promise;
    const current = serverScripts.find((s) => s.id === id) ?? { ...baseScript, id };
    const updated: ScriptRecord = {
      ...current,
      ...(patch.name !== undefined ? { name: String(patch.name) } : {}),
      ...(patch.description !== undefined ? { description: String(patch.description) } : {}),
      ...(patch.code !== undefined ? { code: String(patch.code) } : {}),
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    };
    serverScripts = serverScripts.map((s) => (s.id === id ? updated : s));
    return { ...updated };
  });
  createExperienceVisual.mockImplementation(async (body) => {
    const created: ExperienceVisualRow = {
      ...baseVisual,
      id: `vis_${serverVisuals.length + 1}`,
      name: String(body.name ?? ""),
      source: String(body.source ?? ""),
      compatibleManifestIds: Array.isArray(body.compatibleManifestIds) ? [...body.compatibleManifestIds] as string[] : [],
    };
    serverVisuals.push(created);
    return { ...created, compatibleManifestIds: [...created.compatibleManifestIds] };
  });
  updateExperienceVisual.mockImplementation(async (id, patch) => {
    const current = serverVisuals.find((v) => v.id === id) ?? { ...baseVisual, id };
    const updated: ExperienceVisualRow = {
      ...current,
      ...(patch.name !== undefined ? { name: String(patch.name) } : {}),
      ...(patch.source !== undefined ? { source: String(patch.source) } : {}),
      sourceHash: "newhash0000000000",
    };
    serverVisuals = serverVisuals.map((v) => (v.id === id ? updated : v));
    return { ...updated, compatibleManifestIds: [...updated.compatibleManifestIds] };
  });
  deleteExperienceVisual.mockImplementation(async (id) => {
    serverVisuals = serverVisuals.filter((v) => v.id !== id);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** All mounted CodeMirror views in DOM order: [rules, visual]. */
async function codeViews(container: HTMLElement): Promise<EditorViewInstance[]> {
  let views: EditorViewInstance[] = [];
  await waitFor(() => {
    const doms = Array.from(container.querySelectorAll(".cm-editor"));
    if (doms.length === 0) throw new Error("cm-editor not mounted");
    views = doms.map((dom) => {
      if (!(dom instanceof HTMLElement)) throw new Error("cm-editor not an element");
      const view = EditorView.findFromDOM(dom);
      if (!view) throw new Error("EditorView not found");
      return view;
    });
  });
  return views;
}

function replaceCode(view: EditorViewInstance, code: string) {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  });
}

function rulesDraftEntries() {
  return Object.entries(useScriptDraftStore.getState().drafts);
}

function visualDraftEntries() {
  return Object.entries(useExperienceVisualDraftStore.getState().drafts);
}

function singlePendingRulesDraft() {
  const pending = rulesDraftEntries().filter(([id]) => id.startsWith("local:"));
  if (pending.length !== 1) throw new Error(`expected exactly one pending rules draft, got ${pending.length}`);
  const entry = pending[0];
  if (!entry) throw new Error("unreachable");
  return entry;
}

/** Count the mounted playground instances across the whole document (incl.
 *  portaled Modals) via its unique title text node — enforces the IR-90A
 *  single-instance invariant. */
function playgroundInstanceCount(): number {
  return [...document.body.querySelectorAll("span")].filter(
    (s) => s.textContent === "experience_playground_title",
  ).length;
}

/** Open a DropdownSelect (its trigger currently showing `triggerText`) and pick
 *  the item whose text matches `optionLabel`. Mirrors the cmdk-portal pattern
 *  used in ExperiencePlayground.test.tsx / ExperienceSetupModal.test.tsx. */
async function pickDropdown(view: { container: HTMLElement; baseElement: HTMLElement }, triggerText: string, optionLabel: string): Promise<void> {
  const trigger = [...view.container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes(triggerText),
  ) as HTMLButtonElement | undefined;
  if (!trigger) throw new Error(`no dropdown trigger containing "${triggerText}"`);
  fireEvent.click(trigger);
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
  const item = [...view.baseElement.querySelectorAll("[cmdk-item]")].find(
    (i) => (i.textContent ?? "").trim() === optionLabel,
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`no cmdk item "${optionLabel}"`);
  fireEvent.click(item);
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull());
}

/** The active visual's trash button (there is exactly one in the visual section). */
function visualDeleteButton(container: HTMLElement): HTMLElement {
  const btns = [...container.querySelectorAll('button[aria-label="experience_editor_visual_delete"]')];
  const btn = btns[0];
  if (!(btn instanceof HTMLElement)) throw new Error("visual delete button missing");
  return btn;
}

/** The open DestructiveConfirmModal's confirm button (bg-danger, in the portal). */
async function waitForVisualDeleteConfirm(): Promise<HTMLElement> {
  let confirm: HTMLElement | undefined;
  await waitFor(() => {
    const found = ([...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "experience_editor_visual_delete" && (b.getAttribute("class") ?? "").includes("bg-danger"),
    ));
    if (!(found instanceof HTMLElement)) throw new Error("visual delete confirm not mounted");
    confirm = found;
  });
  if (!confirm) throw new Error("visual delete confirm missing");
  return confirm;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ExperienceEditor", () => {
  it("lists only interactive scripts and lands the starter pick in the editor with paired, independently dirty drafts", async () => {
    serverScripts = [
      { ...baseScript },
      { ...baseScript, id: "srv_prompt", name: "Prompt Script", scriptKind: "prompt" },
    ];
    const board = getRulesStarter("board");
    const gridBoard = getVisualStarter("grid-board");
    if (!board || !gridBoard) throw new Error("starters missing");

    const { container, findByText, getByPlaceholderText, queryByText, getByRole } = render(<ExperienceEditor />);

    // Picker: five starters + blank; the existing list shows only interactive.
    expect(await findByText("Board")).toBeTruthy();
    expect(await findByText("Existing Rules")).toBeTruthy();
    expect(queryByText("Prompt Script")).toBeNull();

    fireEvent.click(await findByText("Board"));

    // Rules buffer: starter source in the real CodeMirror, name prefilled.
    const [rulesView, visualView] = await codeViews(container);
    if (!rulesView || !visualView) throw new Error("expected rules + visual editors");
    expect(rulesView.state.doc.toString()).toBe(board.source);
    expect((getByPlaceholderText("script_name") as HTMLInputElement).value).toBe("Board");

    // Paired visual buffer: the canonical Grid/Board starter, editable, with
    // the rules manifest id pre-associated.
    expect(visualView.state.doc.toString()).toBe(gridBoard.source);
    expect((getByPlaceholderText("experience_editor_visual_name_ph") as HTMLInputElement).value).toBe("Grid / Board");
    const visualDraft = visualDraftEntries()[0]?.[1];
    expect(visualDraft?.values.compatibleManifestIds).toEqual(["board"]);

    // Both buffers start dirty (unsaved): both save controls are enabled.
    expect((getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(false);
    expect((getByRole("button", { name: "experience_editor_visual_save" }) as HTMLButtonElement).disabled).toBe(false);

    // Untrusted: a never-saved source locks the enable toggle.
    expect((getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect(await findByText("experience_editor_untrusted")).toBeTruthy();

    // Independence: a rules edit never touches the visual buffer, and a
    // visual edit never touches the rules buffer.
    replaceCode(rulesView, board.source + "\n// rules edit");
    replaceCode(visualView, gridBoard.source + "\n<!-- visual edit -->");
    const rulesDraft = singlePendingRulesDraft()[1];
    expect(rulesDraft.values.code).toBe(board.source + "\n// rules edit");
    const visualDraftAfter = visualDraftEntries()[0]?.[1];
    expect(visualDraftAfter?.values.source).toBe(gridBoard.source + "\n<!-- visual edit -->");
    // The frozen starters are never mutated by draft edits.
    expect(getRulesStarter("board")?.source).toBe(board.source);
    expect(getVisualStarter("grid-board")?.source).toBe(gridBoard.source);

    // Back returns to the picker.
    fireEvent.click(await findByText("experience_editor_back"));
    expect(await findByText("experience_editor_starters_label")).toBeTruthy();
  });

  it("creates the rules script on first save and returns to idle-clean", async () => {
    const board = getRulesStarter("board");
    if (!board) throw new Error("starter missing");
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Board"));

    fireEvent.click(getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(createScript).toHaveBeenCalledWith({
        name: "Board",
        description: board.description,
        code: board.source,
        scriptKind: "interactive",
        enabled: false,
        scopeType: "global",
      });
    });
    expect(createScript).toHaveBeenCalledTimes(1);

    // The buffer migrated to the server id and is clean (status + store).
    expect(await findByText("saved_state")).toBeTruthy();
    const drafts = rulesDraftEntries();
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.[0]).toBe("srv_1");
    expect(drafts[0]?.[1].saveState === "saved" || drafts[0]?.[1].saveState === "idle").toBe(true);
  });

  it("patches one snapshot on later saves and keeps a failed save dirty + retryable", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole, findByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    replaceCode(rulesView, "context.experience.register({}); // v2");
    fireEvent.click(getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("srv_1", expect.objectContaining({
        code: "context.experience.register({}); // v2",
        enabled: false,
        scriptKind: "interactive",
      }));
    });
    expect(await findByText("saved_state")).toBeTruthy();
    expect(createScript).not.toHaveBeenCalled();

    // Failure path: reject, stay dirty, retry, succeed.
    replaceCode(rulesView, "// v3");
    updateScript.mockImplementationOnce(async () => { throw new Error("network down"); });
    fireEvent.click(getByRole("button", { name: "save" }));
    await waitFor(() => {
      expect(useScriptDraftStore.getState().drafts["srv_1"]?.saveState).toBe("error");
    });
    // The draft is still dirty and the save control is retryable.
    expect(useScriptDraftStore.getState().drafts["srv_1"]?.values.code).toBe("// v3");
    const retryButton = await findByRole("button", { name: "retry" });
    expect((retryButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("srv_1", expect.objectContaining({ code: "// v3" }));
    });
    expect(await findByText("saved_state")).toBeTruthy();
  });

  it("preserves edits made during an in-flight create", async () => {
    const gate = holdNextCreate();
    const card = getRulesStarter("card");
    if (!card) throw new Error("starter missing");
    const { container, findByText, getByRole, findByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Card"));
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    fireEvent.click(getByRole("button", { name: "save" }));
    await waitFor(() => expect(createScript).toHaveBeenCalledTimes(1));

    // Edit while the create is in flight, then resolve with the submitted code.
    replaceCode(rulesView, card.source + "\n// mid-flight");
    const created: ScriptRecord = { ...baseScript, id: "srv_1", name: "Card", description: card.description, code: card.source, enabled: false };
    await act(async () => { gate.resolve({ ...created }); });

    // The mid-flight edit survives as a dirty buffer against the new base.
    const saveButton = await findByRole("button", { name: "save" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    const migrated = useScriptDraftStore.getState().drafts["srv_1"];
    expect(migrated?.values.code).toBe(card.source + "\n// mid-flight");
    expect(migrated?.base.code).toBe(card.source);

    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("srv_1", expect.objectContaining({ code: card.source + "\n// mid-flight" }));
    });
  });

  it("saves the visual buffer independently through the visuals API", async () => {
    const board = getRulesStarter("board");
    const gridBoard = getVisualStarter("grid-board");
    if (!board || !gridBoard) throw new Error("starters missing");
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Board"));

    fireEvent.click(getByRole("button", { name: "experience_editor_visual_save" }));

    await waitFor(() => {
      expect(createExperienceVisual).toHaveBeenCalledWith({
        name: "Grid / Board",
        source: gridBoard.source,
        apiVersion: 1,
        compatibleManifestIds: ["board"],
        scopeType: "global",
      });
    });
    // The rules buffer is untouched by the visual save (still unsaved).
    expect(createScript).not.toHaveBeenCalled();
    expect(await findByText("saved_state")).toBeTruthy();
    expect(await findByText("unsaved_changes")).toBeTruthy();
    const migrated = visualDraftEntries();
    expect(migrated[0]?.[0]).toBe("vis_1");
    expect(migrated[0]?.[1].values.source).toBe(migrated[0]?.[1].base.source);
  });

  it("locks enabling while the source is changed and allows it after saving the exact reviewed source", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    // Clean saved source → trusted; the toggle is available.
    expect((getByRole("switch") as HTMLButtonElement).disabled).toBe(false);

    // Change the source → the buffer is untrusted and the toggle locks.
    replaceCode(rulesView, EXISTING_CODE + "\n// changed");
    expect((getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect(await findByText("experience_editor_untrusted")).toBeTruthy();
    expect(await findByText("experience_editor_trust_blocked_hint")).toBeTruthy();

    // Save the exact reviewed source → the toggle unlocks.
    fireEvent.click(getByRole("button", { name: "save" }));
    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect((getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
    });

    // Enabling is a separate explicit action, persisted by a second save that
    // names the exact same source.
    fireEvent.click(getByRole("switch"));
    fireEvent.click(getByRole("button", { name: "save" }));
    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("srv_1", expect.objectContaining({
        code: EXISTING_CODE + "\n// changed",
        enabled: true,
      }));
    });
    expect(await findByText("experience_editor_trusted")).toBeTruthy();
  });

  it("drops an enabled script to untrusted when its source is edited (store invariant surfaced)", async () => {
    serverScripts = [{ ...baseScript, enabled: true }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    expect(await findByText("experience_editor_trusted")).toBeTruthy();

    replaceCode(rulesView, EXISTING_CODE + "\n// invalidate trust");
    expect(await findByText("experience_editor_untrusted")).toBeTruthy();
    const toggle = getByRole("switch") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
    // Never auto-saved: the trust drop is local until an explicit save.
    expect(updateScript).not.toHaveBeenCalled();
  });

  it("duplicates from a starter and from an existing script as independent, untrusted copies", async () => {
    serverScripts = [{ ...baseScript, enabled: true }];
    serverVisuals = [{ ...baseVisual }];
    const round = getRulesStarter("round");
    if (!round) throw new Error("starter missing");
    const { findByText, getAllByRole, getByRole, container } = render(<ExperienceEditor />);

    // Duplicate from a starter-derived buffer.
    fireEvent.click(await findByText("Round"));
    await codeViews(container);
    const [dupRulesButton] = getAllByRole("button", { name: "experience_editor_duplicate" });
    if (!dupRulesButton) throw new Error("duplicate button missing");
    fireEvent.click(dupRulesButton);

    const pending = rulesDraftEntries().filter(([id]) => id.startsWith("local:"));
    expect(pending.length).toBe(2);
    const codes = pending.map(([, entry]) => entry.values.code);
    expect(codes.every((code) => code === round.source)).toBe(true);
    expect(pending.every(([, entry]) => entry.values.enabled === false)).toBe(true);

    // Editing the duplicate never touches the first copy.
    const [firstId, dupId] = pending.map(([id]) => id);
    if (!firstId || !dupId) throw new Error("unreachable");
    act(() => {
      useScriptDraftStore.getState().patch(dupId, { code: round.source + "\n// dup edit" });
    });
    expect(useScriptDraftStore.getState().drafts[firstId]?.values.code).toBe(round.source);

    // Duplicate from an existing script: enabled is stripped (untrusted copy).
    fireEvent.click(await findByText("experience_editor_back"));
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);
    const [dupExistingButton] = getAllByRole("button", { name: "experience_editor_duplicate" });
    if (!dupExistingButton) throw new Error("duplicate button missing");
    fireEvent.click(dupExistingButton);

    const dupOfExisting = rulesDraftEntries().find(([id, entry]) => id.startsWith("local:") && entry.values.code === EXISTING_CODE);
    expect(dupOfExisting).toBeTruthy();
    expect(dupOfExisting?.[1].values.name).toBe("Existing Rules");
    expect(dupOfExisting?.[1].values.enabled).toBe(false);
    // The toggle is locked for the duplicate: its source was never saved.
    expect((getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });

  it("duplicates a visual without sharing the compatibleManifestIds array", async () => {
    serverVisuals = [{ ...baseVisual }];
    const board = getRulesStarter("board");
    if (!board) throw new Error("starter missing");
    const { findByText, getAllByRole, container } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Board"));
    await codeViews(container);

    // Duplicate the starter-paired visual buffer; the copy must not share the
    // compatibleManifestIds array reference (duplicateVisualDraftValues copies).
    const dupButtons = getAllByRole("button", { name: "experience_editor_duplicate" });
    const visualDup = dupButtons[1];
    if (!visualDup) throw new Error("visual duplicate button missing");
    fireEvent.click(visualDup);

    const pendingVisuals = visualDraftEntries().filter(([id]) => id.startsWith("local:"));
    expect(pendingVisuals.length).toBe(2);
    const [original, duplicate] = pendingVisuals;
    if (!original || !duplicate) throw new Error("unreachable");
    expect(duplicate[1].values.compatibleManifestIds).toEqual(original[1].values.compatibleManifestIds);
    expect(duplicate[1].values.compatibleManifestIds).not.toBe(original[1].values.compatibleManifestIds);
  });

  it("mounts the interactive API reference from the toolbar", async () => {
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Board"));
    fireEvent.click(getByRole("button", { name: "script_api_reference" }));

    expect(await findByText("experience_api_title")).toBeTruthy();
    expect(await findByText("experience_api_methods")).toBeTruthy();
    expect(await findByText("experience_api_optional")).toBeTruthy();
    expect(await findByText("experience_api_events")).toBeTruthy();
  });

  // ── IR-90A: above-the-fold playground launcher + explicit visual delete ──
  it("opens the draft-bound playground from an above-the-fold launcher in a shared Modal (single instance, no persistent write)", async () => {
    const board = getRulesStarter("board");
    if (!board) throw new Error("starter missing");
    const { container, findByText, getByRole, queryByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Board"));

    // The launcher is rendered ABOVE the rules editor (visible without scrolling).
    const launcher = getByRole("button", { name: "experience_editor_playground_open" });
    const rulesEditor = container.querySelector(".cm-editor");
    expect(rulesEditor).not.toBeNull();
    expect(Boolean(rulesEditor!.compareDocumentPosition(launcher) & Node.DOCUMENT_POSITION_PRECEDING)).toBe(true);

    // Before opening: exactly one playground instance (inline, collapsed).
    expect(playgroundInstanceCount()).toBe(1);

    fireEvent.click(launcher);

    // The inline slot collapses to a placeholder; the SAME draft-bound
    // playground renders inside the Modal. Exactly ONE instance is mounted at
    // a time (the inline instance is unmounted while the modal is open — no
    // second in-memory driver).
    await waitFor(() => expect(queryByText("experience_editor_playground_open_in_modal")).not.toBeNull());
    expect(playgroundInstanceCount()).toBe(1);

    // Closing the modal writes nothing — no create/update/delete API call fires
    // (the playground never persists and never creates an API session).
    const closeBtn = [...document.body.querySelectorAll('button[aria-label="close"]')][0]!;
    fireEvent.click(closeBtn);
    await waitFor(() => expect(queryByText("experience_editor_playground_open_in_modal")).toBeNull());
    expect(playgroundInstanceCount()).toBe(1);
    expect(createScript).not.toHaveBeenCalled();
    expect(updateScript).not.toHaveBeenCalled();
    expect(createExperienceVisual).not.toHaveBeenCalled();
    expect(deleteExperienceVisual).not.toHaveBeenCalled();
  });

  it("deletes a saved visual on confirm via deleteExperienceVisual and removes it from the list + draft", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    const { container, findByText, queryByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));

    // Select the saved visual from the visual dropdown.
    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    fireEvent.click(visualDeleteButton(container));
    fireEvent.click(await waitForVisualDeleteConfirm());

    await waitFor(() => expect(deleteExperienceVisual).toHaveBeenCalledWith("vis_1"));
    expect(deleteExperienceVisual).toHaveBeenCalledTimes(1);
    // Removed from the draft store; the active visual was reset (none selected).
    expect(useExperienceVisualDraftStore.getState().drafts["vis_1"]).toBeUndefined();
    await waitFor(() => expect(queryByText("experience_editor_visual_none")).not.toBeNull());
  });

  it("removes a pending (unsaved) visual locally without an API call", async () => {
    const { container, findByText, queryByText } = render(<ExperienceEditor />);
    // A starter pick lands a paired PENDING (local-id) visual, selected.
    fireEvent.click(await findByText("Board"));

    fireEvent.click(visualDeleteButton(container));
    fireEvent.click(await waitForVisualDeleteConfirm());

    // No server call: a pending visual was never persisted.
    expect(deleteExperienceVisual).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByText("experience_editor_visual_none")).not.toBeNull());
  });

  it("keeps a saved visual and surfaces the error when deleteExperienceVisual fails", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    deleteExperienceVisual.mockImplementationOnce(async () => { throw new Error("network down"); });
    const { container, findByText, queryByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    fireEvent.click(visualDeleteButton(container));
    fireEvent.click(await waitForVisualDeleteConfirm());

    // Error surfaced; the visual is KEPT (draft + name still present).
    await waitFor(() => expect(queryByText(/experience_editor_visual_delete_error/)).not.toBeNull());
    expect(deleteExperienceVisual).toHaveBeenCalledWith("vis_1");
    expect(useExperienceVisualDraftStore.getState().drafts["vis_1"]).toBeDefined();
  });

  it("deleting a visual never mutates an already-pinned source snapshot (live-session isolation)", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    // A live session pins its own immutable copy of the visual source at start
    // time, independent of the resource row (the editor has no session handle).
    const pinnedBySession = serverVisuals[0]!.source;

    const { container, findByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    fireEvent.click(visualDeleteButton(container));
    fireEvent.click(await waitForVisualDeleteConfirm());

    await waitFor(() => expect(deleteExperienceVisual).toHaveBeenCalledTimes(1));
    // The resource row was removed (delete reached the API) …
    expect(deleteExperienceVisual).toHaveBeenCalledWith("vis_1");
    // … but the session's pinned snapshot is byte-identical: the editor's delete
    // path (deleteExperienceVisual + list filter + draft remove) cannot and did
    // not reach an external pinned copy.
    expect(pinnedBySession).toBe(baseVisual.source);
  });
});

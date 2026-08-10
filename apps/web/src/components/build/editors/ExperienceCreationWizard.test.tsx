/**
 * ExperienceCreationWizard — IR-90C boundary tests.
 *
 * Boundary under test: API mocks (script-api / experience-api) → the REAL
 * ExperienceCreationWizard with the REAL draft stores (script-draft-store +
 * experience-authoring-store, the IR-81A trust invariant included), REAL
 * starters, REAL CodeMirror editor, and REAL shared primitives → DOM + store
 * observations. i18n and Tooltip are mocked (keys verbatim / passthrough),
 * and the universal AiAssistantModal is mocked with a thin capturing double —
 * matching ExperienceEditor.test.tsx and ExperienceEditorAiHelper.test.tsx.
 *
 * Pinned behavior (per the IR-90C contract):
 *  1. Exactly three step indicators; opens on Step 1.
 *  2. Step 1 → 2 gated on a non-empty name.
 *  3. Step 2 → 3 gated on validated rules (invalid blocks with a visible
 *     reason; valid starter rules allow it).
 *  4. Back/Next preserve drafts (dirty preservation across navigation).
 *  5. No persistence before Finish (createScript / createExperienceVisual fire
 *     ONLY on the Finish action).
 *  6. Finish creates BOTH resources; partial-failure keeps drafts + surfaces
 *     the error (rollback the orphaned create) so a retry creates both.
 *  7. AI-helper is a tool inside Steps 2/3 (never the entry); onReplace
 *     write-backs flow through the normal draft actions.
 *  8. Cancel confirms discard via DestructiveConfirmModal.
 *
 * Runner: bun:test with scoped happy-dom (one file per process —
 * mock.module() is process-global). URL.createObjectURL is stubbed so the
 * embedded ExperienceFrame does not make happy-dom navigate (mirrors
 * ExperiencePreview.test.tsx).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import type { ExperienceTestRunData, ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";
import { getRulesStarter } from "../../../lib/experience-rules-starters.js";
import { getVisualStarter } from "../../experience/starters/index.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";
import { useExperienceVisualDraftStore } from "../../../stores/experience-authoring-store.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

// URL spy so the embedded ExperienceFrame (Step 3 preview) does not navigate.
const realCreate = URL.createObjectURL;
URL.createObjectURL = (() => "about:blank#blob") as typeof URL.createObjectURL;

// ── Test data ──────────────────────────────────────────────────────────────

const baseScript: ScriptRecord = {
  id: "srv_1",
  name: "Created Rules",
  description: "",
  code: "code",
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
  name: "Created Visual",
  source: "<!doctype html><html><body>v</body></html>",
  sourceHash: "abc123def4567890",
  apiVersion: 1,
  compatibleManifestIds: [],
  scopeType: "global",
  characterId: null,
  personaId: null,
  chatId: null,
  createdAt: "",
  updatedAt: "",
};

function makeRunData(): ExperienceTestRunData {
  return {
    definition: {
      apiVersion: 1,
      manifest: { id: "round", name: "Round" },
      declaredCapabilities: [],
      hasChoose: false,
      hasFlavor: false,
    },
    sourceHash: "hash_1",
    initialState: {},
    finalState: {},
    revision: 0,
    status: "active",
    projection: { state: {}, actions: [] },
    events: [],
    effects: [],
    console: [],
    steps: [],
  };
}

// ── Mocks ──────────────────────────────────────────────────────────────────

const createScript = mock((_body: Record<string, unknown>) => Promise.resolve<ScriptRecord>({ ...baseScript }));
const deleteScript = mock((_id: string) => Promise.resolve<void>(undefined));
const updateScript = mock((_id: string, _patch: Record<string, unknown>) => Promise.resolve<ScriptRecord>({ ...baseScript }));
const listAllScripts = mock(() => Promise.resolve<ScriptRecord[]>([]));
const createExperienceVisual = mock((_body: Record<string, unknown>) => Promise.resolve<ExperienceVisualRow>({ ...baseVisual }));
const runExperienceTest = mock((_body: Record<string, unknown>) => Promise.resolve<ExperienceTestRunData>(makeRunData()));
const simulateExperienceTest = mock((_body: Record<string, unknown>) => Promise.resolve(makeRunData() as never));
const listExperienceVisuals = mock(() => Promise.resolve<ExperienceVisualRow[]>([]));

const realScriptApi = await import("../../../api/script-api.js");
const realExperienceApi = await import("../../../api/experience-api.js");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realAiAssistantModal = await import("../../shared/AiAssistantModal.js");

mock.module("../../../api/script-api.js", () => ({
  ...realScriptApi,
  listAllScripts,
  createScript,
  updateScript,
  deleteScript,
}));

mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  listExperienceVisuals,
  createExperienceVisual,
  updateExperienceVisual: realExperienceApi.updateExperienceVisual,
  deleteExperienceVisual: realExperienceApi.deleteExperienceVisual,
  runExperienceTest,
  simulateExperienceTest,
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

interface CapturedAiProps {
  apiMode?: string;
  isOpen?: boolean;
  existingContent?: string;
  interactiveRulesSource?: string;
  onInsert?: (text: string) => void;
  onReplace?: (text: string) => void;
}
let lastAiProps: CapturedAiProps | null = null;
let lastVisualAiProps: CapturedAiProps | null = null;

mock.module("../../shared/AiAssistantModal.js", () => ({
  ...realAiAssistantModal,
  AiAssistantModal: (props: CapturedAiProps) => {
    if (props.apiMode === "interactive_visual") lastVisualAiProps = props;
    else lastAiProps = props;
    return null;
  },
}));

// ── Setup ──────────────────────────────────────────────────────────────────

let ExperienceCreationWizard: typeof import("./ExperienceCreationWizard.js").ExperienceCreationWizard;
type EditorViewInstance = import("@codemirror/view").EditorView;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let EditorView: typeof import("@codemirror/view").EditorView;

beforeAll(async () => {
  ({ act, fireEvent, render, waitFor } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ ExperienceCreationWizard } = await import("./ExperienceCreationWizard.js"));
});

let serverScripts: ScriptRecord[];
let serverVisuals: ExperienceVisualRow[];
let finishScript: ScriptRecord | null;
let finishVisual: ExperienceVisualRow | null;

const noopOnClose = () => {};
const noopOnFinish = (_s: ScriptRecord, _v: ExperienceVisualRow) => {};

beforeEach(() => {
  createScript.mockClear();
  deleteScript.mockClear();
  updateScript.mockClear();
  listAllScripts.mockClear();
  createExperienceVisual.mockClear();
  runExperienceTest.mockClear();
  simulateExperienceTest.mockClear();
  listExperienceVisuals.mockClear();
  useScriptDraftStore.getState().resetAll();
  useExperienceVisualDraftStore.getState().resetAll();
  lastAiProps = null;
  lastVisualAiProps = null;
  serverScripts = [];
  serverVisuals = [];
  finishScript = null;
  finishVisual = null;
  listAllScripts.mockImplementation(async () => serverScripts.map((s) => ({ ...s })));
  listExperienceVisuals.mockImplementation(async () => serverVisuals.map((v) => ({ ...v })));
  runExperienceTest.mockImplementation(async () => makeRunData());
  simulateExperienceTest.mockImplementation(async () => makeRunData() as never);
  createScript.mockImplementation(async (body) => {
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
  deleteScript.mockImplementation(async (id) => {
    serverScripts = serverScripts.filter((s) => s.id !== id);
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
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Render the wizard with capturing onClose/onFinish. */
function renderWizard(starterId: string | null = "board") {
  const starter = starterId ? getRulesStarter(starterId) ?? null : null;
  const utils = render(
    <ExperienceCreationWizard
      starter={starter}
      onClose={noopOnClose}
      onFinish={(s, v) => { finishScript = s; finishVisual = v; }}
    />,
  );
  return utils;
}

/** All step indicators (portaled into document.body). */
function indicators(): HTMLElement[] {
  return [...document.body.querySelectorAll('[data-testid="wizard-step-indicator"]')] as HTMLElement[];
}

/** Find a button in the portal by exact text content. */
function bodyButton(text: string): HTMLElement {
  const btn = [...document.body.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!btn) throw new Error(`button "${text}" not found in portal`);
  return btn;
}

/** Find an input by its aria-label. */
function bodyInput(label: string): HTMLInputElement {
  const input = document.body.querySelector(`input[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`input[${label}] not found`);
  return input;
}

/** The single mounted CodeMirror view in the portal. */
async function codeView(): Promise<EditorViewInstance> {
  let view: EditorViewInstance | undefined;
  await waitFor(() => {
    const dom = document.body.querySelector(".cm-editor");
    if (!(dom instanceof HTMLElement)) throw new Error("cm-editor not mounted");
    const found = EditorView.findFromDOM(dom);
    if (!found) throw new Error("EditorView not found");
    view = found;
  });
  if (!view) throw new Error("EditorView not found");
  return view;
}

function replaceCode(view: EditorViewInstance, code: string) {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  });
}

/** Navigate to Step 2: type a name and click Next. */
async function gotoStep2(starterId: string | null = "board") {
  renderWizard(starterId);
  await waitFor(() => expect(indicators().length).toBe(3));
  fireEvent.change(bodyInput("experience_wizard_name_label"), { target: { value: "My Game" } });
  fireEvent.click(bodyButton("next"));
  await waitFor(() => expect(indicators()[1]?.getAttribute("aria-current")).toBe("step"));
}

/** Navigate to Step 3: from Step 2, validate rules and click Next. */
async function gotoStep3(starterId: string | null = "board") {
  await gotoStep2(starterId);
  fireEvent.click(bodyButton("experience_wizard_validate"));
  await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
  fireEvent.click(bodyButton("next"));
  await waitFor(() => expect(indicators()[2]?.getAttribute("aria-current")).toBe("step"));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ExperienceCreationWizard", () => {
  it("renders exactly three step indicators and opens on Step 1", async () => {
    renderWizard();
    await waitFor(() => expect(indicators().length).toBe(3));
    expect(indicators()[0]?.getAttribute("aria-current")).toBe("step");
    expect(indicators()[1]?.getAttribute("aria-current")).toBeNull();
    expect(indicators()[2]?.getAttribute("aria-current")).toBeNull();
  });

  it("gates Step 1 → 2 on a non-empty name (Next disabled with empty name)", async () => {
    renderWizard();
    await waitFor(() => expect(indicators().length).toBe(3));
    // The starter pre-fills the name (e.g. "Board"), so clear it first.
    const nameInput = bodyInput("experience_wizard_name_label");
    fireEvent.change(nameInput, { target: { value: "" } });
    const nextBtn = bodyButton("next") as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
    // Typing a name enables Next.
    fireEvent.change(nameInput, { target: { value: "My Game" } });
    expect(nextBtn.disabled).toBe(false);
    fireEvent.click(nextBtn);
    await waitFor(() => expect(indicators()[1]?.getAttribute("aria-current")).toBe("step"));
  });

  it("gates Step 2 → 3 on rules validity (invalid blocks with a visible reason; valid allows it)", async () => {
    await gotoStep2();
    // Before validation: Next is disabled, and the not-validated hint is shown.
    expect((bodyButton("next") as HTMLButtonElement).disabled).toBe(true);

    // Invalid rules: make the tester reject, check rules → visible error.
    runExperienceTest.mockImplementationOnce(async () => { throw new Error("syntax error at line 1"); });
    fireEvent.click(bodyButton("experience_wizard_validate"));
    await waitFor(() => {
      expect([...document.body.querySelectorAll("*")].some((e) => (e.textContent ?? "").includes("experience_wizard_rules_invalid"))).toBe(true);
    });
    expect((bodyButton("next") as HTMLButtonElement).disabled).toBe(true);

    // Valid rules: the starter code passes discovery → Next enabled.
    fireEvent.click(bodyButton("experience_wizard_validate"));
    await waitFor(() => expect((bodyButton("next") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(bodyButton("next"));
    await waitFor(() => expect(indicators()[2]?.getAttribute("aria-current")).toBe("step"));
  });

  it("preserves drafts across Back/Next navigation", async () => {
    renderWizard();
    await waitFor(() => expect(indicators().length).toBe(3));
    // Step 1: type a name.
    fireEvent.change(bodyInput("experience_wizard_name_label"), { target: { value: "Persisted Name" } });
    fireEvent.click(bodyButton("next"));
    await waitFor(() => expect(indicators()[1]?.getAttribute("aria-current")).toBe("step"));

    // Step 2: edit the rules code.
    const view = await codeView();
    replaceCode(view, "context.experience.register({}); // edited");

    // Back to Step 1: the name is still there.
    fireEvent.click(bodyButton("back"));
    await waitFor(() => expect(indicators()[0]?.getAttribute("aria-current")).toBe("step"));
    expect(bodyInput("experience_wizard_name_label").value).toBe("Persisted Name");

    // Next to Step 2: the rules edit is still there.
    fireEvent.click(bodyButton("next"));
    await waitFor(() => expect(indicators()[1]?.getAttribute("aria-current")).toBe("step"));
    const viewAfter = await codeView();
    expect(viewAfter.state.doc.toString()).toBe("context.experience.register({}); // edited");
  });

  it("does NOT persist before Finish (no createScript / createExperienceVisual during navigation)", async () => {
    await gotoStep3();
    // Navigated through all three steps — no persistence should have fired.
    expect(createScript).not.toHaveBeenCalled();
    expect(createExperienceVisual).not.toHaveBeenCalled();
  });

  it("creates BOTH resources on Finish with the right bodies and hands them back", async () => {
    const board = getRulesStarter("board");
    const gridBoard = getVisualStarter("grid-board");
    if (!board || !gridBoard) throw new Error("starters missing");

    await gotoStep3();
    fireEvent.click(bodyButton("experience_wizard_finish"));

    await waitFor(() => expect(finishScript).not.toBeNull());
    expect(createScript).toHaveBeenCalledTimes(1);
    expect(createScript).toHaveBeenCalledWith({
      name: "My Game",
      description: board.description,
      code: board.source,
      scriptKind: "interactive",
      enabled: false,
      scopeType: "global",
    });
    expect(createExperienceVisual).toHaveBeenCalledTimes(1);
    expect(createExperienceVisual).toHaveBeenCalledWith({
      name: gridBoard.label,
      source: gridBoard.source,
      apiVersion: 1,
      compatibleManifestIds: ["board"],
      scopeType: "global",
    });
    // The created records were handed to onFinish.
    expect(finishScript?.id).toBe("srv_1");
    expect(finishVisual?.id).toBe("vis_1");
    // The local drafts were cleaned up (migrated to server ids).
    const rulesDrafts = Object.keys(useScriptDraftStore.getState().drafts);
    expect(rulesDrafts.every((id) => !id.startsWith("local:"))).toBe(true);
    const visualDrafts = Object.keys(useExperienceVisualDraftStore.getState().drafts);
    expect(visualDrafts.every((id) => !id.startsWith("local:"))).toBe(true);
  });

  it("recovers from partial-failure: rolls back the orphaned script, keeps drafts, retries Finish", async () => {
    const board = getRulesStarter("board");
    if (!board) throw new Error("starter missing");
    await gotoStep3();

    // First Finish: visual create rejects → rollback the script, stay open.
    createExperienceVisual.mockImplementationOnce(async () => { throw new Error("visual API down"); });
    fireEvent.click(bodyButton("experience_wizard_finish"));

    await waitFor(() => expect(createScript).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createExperienceVisual).toHaveBeenCalledTimes(1));
    // The orphaned script was rolled back.
    await waitFor(() => expect(deleteScript).toHaveBeenCalledTimes(1));
    // The wizard stayed open (still on Step 3) and the error is surfaced.
    expect(indicators()[2]?.getAttribute("aria-current")).toBe("step");
    await waitFor(() => {
      expect([...document.body.querySelectorAll("*")].some((e) => (e.textContent ?? "").includes("experience_wizard_finish_error"))).toBe(true);
    });
    // Drafts are intact (the local rules + visual drafts still exist).
    expect(Object.keys(useScriptDraftStore.getState().drafts).some((id) => id.startsWith("local:"))).toBe(true);

    // Second Finish: both succeed → wizard closes, onFinish fires.
    fireEvent.click(bodyButton("experience_wizard_finish"));
    await waitFor(() => expect(finishScript).not.toBeNull());
    expect(createScript).toHaveBeenCalledTimes(2);
    expect(createExperienceVisual).toHaveBeenCalledTimes(2);
    expect(deleteScript).toHaveBeenCalledTimes(1);
    expect(finishScript?.id).toBe("srv_1");
    expect(finishVisual?.id).toBe("vis_1");
  });

  it("launches the interactive_rules AI modal from Step 2 and writes back via onReplace", async () => {
    await gotoStep2();
    fireEvent.click(bodyButton("experience_editor_ai_helper"));
    expect(lastAiProps).not.toBeNull();
    expect(lastAiProps!.apiMode).toBe("interactive_rules");
    expect(lastAiProps!.isOpen).toBe(true);

    // The existingContent is the current rules code (the starter source).
    const board = getRulesStarter("board");
    if (!board) throw new Error("starter missing");
    expect(lastAiProps!.existingContent).toBe(board.source);

    // Accept AI output → flows through the draft action (no silent overwrite).
    const aiCode = "context.experience.register({ apiVersion: 1, manifest: { id: 'ai', name: 'AI' }, capabilities: [], create() { return {}; }, project() { return {}; }, actions() { return []; }, reduce(c) { return { state: c.state, status: 'active', events: [] }; } });";
    act(() => { lastAiProps!.onReplace!(aiCode); });
    const view = await codeView();
    expect(view.state.doc.toString()).toBe(aiCode);
    // No persistence from the AI write-back.
    expect(createScript).not.toHaveBeenCalled();
  });

  it("launches the interactive_visual AI modal from Step 3 with the rules source", async () => {
    await gotoStep3();
    fireEvent.click(bodyButton("experience_editor_visual_ai_helper"));
    expect(lastVisualAiProps).not.toBeNull();
    expect(lastVisualAiProps!.apiMode).toBe("interactive_visual");
    expect(lastVisualAiProps!.interactiveRulesSource).toBeTruthy();

    // Accept AI visual output → flows through the visual draft action.
    const aiVisual = "<!doctype html><html><body>ai visual</body></html>";
    act(() => { lastVisualAiProps!.onReplace!(aiVisual); });
    const view = await codeView();
    expect(view.state.doc.toString()).toBe(aiVisual);
    expect(createExperienceVisual).not.toHaveBeenCalled();
  });

  it("cancel confirms discard via DestructiveConfirmModal", async () => {
    renderWizard();
    await waitFor(() => expect(indicators().length).toBe(3));
    // Click Cancel → the confirm modal opens (drafts are always dirty).
    fireEvent.click(bodyButton("cancel"));
    // The DestructiveConfirmModal renders its confirm button with the
    // experience_wizard_cancel_confirm label.
    await waitFor(() => {
      expect([...document.body.querySelectorAll("button")].some(
        (b) => (b.textContent ?? "").trim() === "experience_wizard_cancel_confirm",
      )).toBe(true);
    });
    // Confirm → drafts cleaned up, onClose fires (the wizard unmounts).
    const confirmBtn = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "experience_wizard_cancel_confirm",
    )!;
    fireEvent.click(confirmBtn);
    // Drafts were removed (confirmCancel cleans up before onClose).
    await waitFor(() => {
      expect(Object.keys(useScriptDraftStore.getState().drafts).filter((id) => id.startsWith("local:")).length).toBe(0);
    });
    expect(Object.keys(useExperienceVisualDraftStore.getState().drafts).filter((id) => id.startsWith("local:")).length).toBe(0);
  });

  it("mounts the isolated ExperiencePreview in Step 3 (preview isolation inherited)", async () => {
    await gotoStep3();
    // The ExperiencePreview is mounted (data-testid).
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="experience-preview"]')).toBeTruthy();
    });
    // No persistence from navigating to the preview step.
    expect(createScript).not.toHaveBeenCalled();
    expect(createExperienceVisual).not.toHaveBeenCalled();
  });

  it("keeps AI-generated rules UNTRUSTED (enabled=false, never auto-enabled)", async () => {
    await gotoStep2();
    fireEvent.click(bodyButton("experience_editor_ai_helper"));
    const aiCode = "context.experience.register({ apiVersion: 1, manifest: { id: 'ai' }, capabilities: [], create() { return {}; }, project() { return {}; }, actions() { return []; }, reduce(c) { return { state: c.state, status: 'active', events: [] }; } });";
    act(() => { lastAiProps!.onReplace!(aiCode); });

    // The draft has enabled=false (never auto-trusted).
    const drafts = Object.entries(useScriptDraftStore.getState().drafts);
    const rulesDraft = drafts.find(([id]) => id.startsWith("local:"));
    expect(rulesDraft?.[1].values.enabled).toBe(false);

    // Finish creates with enabled=false.
    fireEvent.click(bodyButton("experience_wizard_validate"));
    await waitFor(() => expect((bodyButton("next") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(bodyButton("next"));
    await waitFor(() => expect(indicators()[2]?.getAttribute("aria-current")).toBe("step"));
    fireEvent.click(bodyButton("experience_wizard_finish"));
    await waitFor(() => expect(finishScript).not.toBeNull());
    expect(finishScript?.enabled).toBe(false);
  });

  it("works from a blank start (no starter): user writes rules manually", async () => {
    renderWizard(null);
    await waitFor(() => expect(indicators().length).toBe(3));
    // Blank start: name is the untitled placeholder, code is empty.
    const nameInput = bodyInput("experience_wizard_name_label");
    fireEvent.change(nameInput, { target: { value: "Custom Game" } });
    fireEvent.click(bodyButton("next"));
    await waitFor(() => expect(indicators()[1]?.getAttribute("aria-current")).toBe("step"));
    // Code is empty → validate fails (empty).
    fireEvent.click(bodyButton("experience_wizard_validate"));
    await waitFor(() => {
      expect([...document.body.querySelectorAll("*")].some((e) => (e.textContent ?? "").includes("experience_wizard_rules_empty"))).toBe(true);
    });
    // Write valid code and validate.
    const view = await codeView();
    const blank = getRulesStarter("blank_state_machine");
    if (!blank) throw new Error("starter missing");
    replaceCode(view, blank.source);
    // Wait for the code change to propagate (validate button becomes enabled).
    await waitFor(() => expect((bodyButton("experience_wizard_validate") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(bodyButton("experience_wizard_validate"));
    await waitFor(() => expect((bodyButton("next") as HTMLButtonElement).disabled).toBe(false));
  });
});

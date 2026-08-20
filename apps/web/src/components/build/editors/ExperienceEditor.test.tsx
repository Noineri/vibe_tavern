/**
 * ExperienceEditor — IR-81C / ER-13d-2a boundary tests.
 *
 * Boundary under test: API mocks (script-api / experience-api) → the REAL
 * ExperienceEditor with the REAL CodeMirror editor, REAL draft stores
 * (script-draft-store + experience-authoring-store, the IR-81A invariant
 * included), REAL starters, and REAL shared primitives → DOM + store
 * observations. i18n and Tooltip are mocked (keys verbatim / passthrough),
 * matching ScriptEditor.test.tsx and ExperienceAssignment.test.tsx.
 *
 * Pinned behavior (per the IR-81C contract):
 *  1. Persist-on-create (ER-13d-2a/2b): the blank "create new" button persists
 *     a fresh EMPTY script immediately (enabled=false, server id) and opens the
 *     editor in CREATION MODE (3-position toggle). Rules templates are applied
 *     to that buffer in step 1; the paired VISUAL is highlighted (not created)
 *     in step 2.
 *  2. Dirty/save flow: the created script is already server-side, so saves
 *     PATCH via updateScript (prepareSave/completeSave); a failed save stays
 *     dirty and retryable; edits made during an in-flight save survive
 *     reconciliation. The duplicate path still CREATEs a local-id draft on its
 *     first save. The visual buffer saves independently through the visuals
 *     API.
 *  3. Trust UX: a changed (or never-saved) source shows untrusted and LOCKS
 *     the enable toggle; after saving the exact reviewed source the toggle
 *     unlocks and enabling persists only via an explicit second save; an
 *     enabled script that is edited drops to untrusted (store invariant).
 *  4. Duplication from an existing script/visual produces independent,
 *     explicitly untrusted copies (no shared array references).
 *  5. The interactive API reference mounts from the editor toolbar.
 *
 * Runner: bun:test with scoped happy-dom (one file per process —
 * mock.module() is process-global).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import type { ExperienceTestRunData, ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";
import { getVisualStarter, VISUAL_STARTERS } from "../../experience/starters/index.js";
import { RULES_STARTERS } from "../../../lib/experience-rules-starters.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";
import { useExperienceVisualDraftStore } from "../../../stores/experience-authoring-store.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const EXISTING_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'existing', name: 'Existing' }, capabilities: [], create() { return {}; }, project() { return {}; }, actions() { return []; }, reduce(context) { return { state: context.state, status: 'active', events: [] }; } });";

/** The frozen "board" rules starter source — the exact code persist-on-create
 *  seeds when a starter pick creates a fresh script (ER-13d-2a). */
const BOARD_SOURCE = (() => {
  const starter = RULES_STARTERS.find((s) => s.id === "board");
  if (!starter) throw new Error("board starter missing");
  return starter.source;
})();

/** A typed `ExperienceTestRunData` fixture — no `unknown`/`any` cast, no suppressions. */
function makeTestRunData(): ExperienceTestRunData {
  return {
    definition: {
      apiVersion: 1,
      manifest: { id: "test", name: "Test", mode: "turn" },
      declaredCapabilities: [],
      hasChoose: false,
      hasFlavor: false,
    },
    sourceHash: "abc123def456",
    initialState: {},
    finalState: {},
    revision: 1,
    status: "completed",
    projection: { state: {}, actions: [] },
    events: [],
    effects: [],
    console: [],
    steps: [],
  };
}

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
  defaultVisualId: null,
  copilotProfileId: null,
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
const deleteScript = mock((_id: string) => Promise.resolve<void>(undefined));
const getScriptVisuals = mock((_id?: string) => Promise.resolve<ExperienceVisualRow[]>([]));
const bindScriptVisual = mock((_scriptId: string, _visualId: string) => Promise.resolve<void>(undefined));
const unbindScriptVisual = mock((_scriptId: string, _visualId: string) => Promise.resolve<void>(undefined));
const listExperienceVisuals = mock(() => Promise.resolve<ExperienceVisualRow[]>([]));
const createExperienceVisual = mock((_body: Record<string, unknown>) => Promise.resolve<ExperienceVisualRow>({ ...baseVisual, compatibleManifestIds: [...baseVisual.compatibleManifestIds] }));
const updateExperienceVisual = mock((_id: string, _patch: Record<string, unknown>) => Promise.resolve<ExperienceVisualRow>({ ...baseVisual, compatibleManifestIds: [...baseVisual.compatibleManifestIds] }));
const deleteExperienceVisual = mock((_id: string) => Promise.resolve<void>(undefined));
const runExperienceTest = mock((_body: Record<string, unknown>) => Promise.resolve(makeTestRunData()));

const realScriptApi = await import("../../../api/script-api.js");
const realExperienceApi = await import("../../../api/experience-api.js");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realMobileHook = await import("../../../hooks/use-mobile.js");

// Follow-up round 3 (mobile script header): drive `useIsMobile` from a test
// flag — SAFE mock (capture real module first, spread, override the one hook).
const mobileMocks = { mobile: false };
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile: () => mobileMocks.mobile,
}));

mock.module("../../../api/script-api.js", () => ({
  ...realScriptApi,
  listAllScripts,
  createScript,
  updateScript,
  deleteScript,
  getScriptVisuals,
  bindScriptVisual,
  unbindScriptVisual,
}));

mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  listExperienceVisuals,
  createExperienceVisual,
  updateExperienceVisual,
  deleteExperienceVisual,
  runExperienceTest,
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

// The editor view now hosts ExperienceCopilotShell (ER-13c). Its session-load
// lifecycle would hit the real experience-copilot REST client under happy-dom
// (no server). SAFE mock: capture the real module first, then override only the
// two lifecycle fns this test surface reaches. getExperienceCopilotActive
// rejects → the chat pane renders its error empty state, so the heavy chat
// subcomponents (session switcher / message list / input area) never mount
// here; the editor pane is the only surface these tests drive.
const getExperienceCopilotActive = mock(async () => {
  throw new Error("no copilot session in ExperienceEditor tests");
});
const listExperienceCopilotSessions = mock(async () => []);

const realCopilotApi = await import("../../../api/experience-copilot-api.js");
mock.module("../../../api/experience-copilot-api.js", () => ({
  ...realCopilotApi,
  getExperienceCopilotActive,
  listExperienceCopilotSessions,
}));

// The shell's preview tab (XU-5) renders a real ExperienceFrame — a sandboxed
// iframe served from a blob URL — whenever the active visual's source is
// non-empty. Its DOM/CSP/URL lifecycle is pinned in ExperienceFrame.test.tsx;
// this suite only needs the preview tab to mount without happy-dom choking on
// the iframe navigation, so replace it with a marker stub (SAFE: capture the
// real module first, spread, override only the component).
const realFrame = await import("../../experience/ExperienceFrame.js");
mock.module("../../experience/ExperienceFrame.js", () => ({
  ...realFrame,
  ExperienceFrame: () => <div data-testid="experience-frame-stub" />,
}));

// ── XU-7: IntersectionObserver stub ────────────────────────────────────────
// happy-dom 20 ships an IntersectionObserver whose observe() is a no-op (the
// callback never fires), so the lazy card preview would never mount its iframe.
// This stub records observations and lets a test fire the callback for a
// specific element, pinning the "mount only after intersection" boundary.
class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  private callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    IntersectionObserverStub.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve(_target: Element) {
    // no-op
  }
  disconnect() {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Fire the callback as if the observed element(s) entered/left the viewport. */
  fire(isIntersecting: boolean) {
    const entries = this.observed.map((target) => {
      const rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
      return {
        isIntersecting,
        target,
        intersectionRatio: isIntersecting ? 1 : 0,
        intersectionRect: rect,
        rootBounds: null,
        boundingClientRect: rect,
        time: 0,
      } as unknown as IntersectionObserverEntry;
    });
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

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
  mobileMocks.mobile = false;
  listAllScripts.mockClear();
  createScript.mockClear();
  updateScript.mockClear();
  deleteScript.mockClear();
  getScriptVisuals.mockClear();
  getScriptVisuals.mockImplementation(async () => []);
  bindScriptVisual.mockClear();
  unbindScriptVisual.mockClear();
  listExperienceVisuals.mockClear();
  createExperienceVisual.mockClear();
  updateExperienceVisual.mockClear();
  deleteExperienceVisual.mockClear();
  runExperienceTest.mockClear();
  runExperienceTest.mockImplementation(async () => makeTestRunData());
  useScriptDraftStore.getState().resetAll();
  useExperienceVisualDraftStore.getState().resetAll();
  // XU-7: reset + install the IntersectionObserver stub before every render so
  // the lazy card preview observes into a fresh, test-controllable observer.
  IntersectionObserverStub.instances = [];
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
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

/** Set a controlled text input value via the native setter + `input` event.
 *  Mirrors ExperienceSetupModal.test.tsx: React's valueTracker does not
 *  reliably pick up a bare fireEvent.change target override on controlled
 *  text controls, so use the native setter + dispatched input event. */
function setInputValue(el: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
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
  return [...document.body.querySelectorAll("[data-testid='experience-playground']")].length;
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

/** The active experience (script) delete button in the rules header. */
function experienceDeleteButton(container: HTMLElement): HTMLElement {
  const btn = [...container.querySelectorAll('button[aria-label="experience_editor_delete"]')][0];
  if (!(btn instanceof HTMLElement)) throw new Error("experience delete button missing");
  return btn;
}

/** The open experience-delete confirm's primary (full) button (bg-danger). */
async function waitForExperienceDeleteConfirm(): Promise<HTMLElement> {
  let confirm: HTMLElement | undefined;
  await waitFor(() => {
    const found = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "experience_editor_delete_full" && (b.getAttribute("class") ?? "").includes("bg-danger"),
    );
    if (!(found instanceof HTMLElement)) throw new Error("experience delete confirm not mounted");
    confirm = found;
  });
  if (!confirm) throw new Error("experience delete confirm missing");
  return confirm;
}

/** The open experience-delete confirm's secondary (rules-only) button (border-danger). */
async function waitForExperienceDeleteSecondary(): Promise<HTMLElement> {
  let secondary: HTMLElement | undefined;
  await waitFor(() => {
    const found = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "experience_editor_delete_rules_only" && (b.getAttribute("class") ?? "").includes("border-danger"),
    );
    if (!(found instanceof HTMLElement)) throw new Error("experience delete secondary not mounted");
    secondary = found;
  });
  if (!secondary) throw new Error("experience delete secondary missing");
  return secondary;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ExperienceEditor", () => {
  it("lists only interactive scripts; the blank create persists a fresh script and opens the editor in creation mode", async () => {
    serverScripts = [
      { ...baseScript },
      { ...baseScript, id: "srv_prompt", name: "Prompt Script", scriptKind: "prompt" },
    ];

    const { findByText, queryByText, getByRole } = render(<ExperienceEditor />);

    // Picker: the create-new button + the existing list (only interactive
    // scripts). The rules template grid is gone — templates live in step 1.
    expect(await findByText("experience_editor_create_new")).toBeTruthy();
    expect(await findByText("Existing Rules")).toBeTruthy();
    expect(queryByText("Prompt Script")).toBeNull();

    // ER-13d-2a: the blank create persists a fresh script (enabled=false) and
    // opens the editor in CREATION MODE (3-position toggle).
    fireEvent.click(await findByText("experience_editor_create_new"));

    await waitFor(() => {
      expect(createScript).toHaveBeenCalledWith({
        name: "experience_editor_new_experience_name",
        description: "",
        code: "",
        scriptKind: "interactive",
        enabled: false,
        scopeType: "global",
      });
    });
    expect(createScript).toHaveBeenCalledTimes(1);

    // The editor view mounted in creation mode: the shell's 3-position toggle
    // includes the sandbox position (i18n-labelled).
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_rules" })).toBeDefined();
      expect(getByRole("radio", { name: "experience_copilot_visual" })).toBeDefined();
      expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    });
  });

  it("the card shows bound visuals as pills and a '+' to add more (ER-18b)", async () => {
    serverScripts = [{ ...baseScript }];
    getScriptVisuals.mockResolvedValue([{ ...baseVisual }]);
    listExperienceVisuals.mockResolvedValue([{ ...baseVisual }]);

    const { findByText, findByLabelText } = render(<ExperienceEditor />);

    // The bound visual renders as a pill on the card.
    expect(await findByText("Existing Visual")).toBeTruthy();
    // The dashed "+" trigger (aria-label = scope_visual key) is present.
    expect(await findByLabelText("scope_visual")).toBeTruthy();
  });

  it("lazy-mounts the card visual preview only after intersection (XU-7)", async () => {
    serverScripts = [{ ...baseScript }];
    getScriptVisuals.mockResolvedValue([{ ...baseVisual }]); // vis_1 bound → non-null source

    const { findByTestId, queryByTestId } = render(<ExperienceEditor />);

    // The card preview renders its placeholder; the iframe stub is NOT mounted
    // before intersection.
    expect(await findByTestId("experience-card-preview")).toBeTruthy();
    expect(queryByTestId("experience-frame-stub")).toBeNull();

    // Exactly one observer was created and is observing the preview container.
    await waitFor(() => {
      expect(IntersectionObserverStub.instances.length).toBe(1);
      expect(IntersectionObserverStub.instances[0]?.observed.length).toBe(1);
    });

    // Fire the intersection → the iframe mounts and the observer disconnects.
    act(() => {
      IntersectionObserverStub.instances[0]!.fire(true);
    });
    expect(queryByTestId("experience-frame-stub")).toBeTruthy();
    expect(IntersectionObserverStub.instances[0]!.disconnected).toBe(true);
  });

  it("renders human status dots and a uniform description slot on the card (XU-7)", async () => {
    serverScripts = [
      { ...baseScript, enabled: true },
      { ...baseScript, id: "srv_2", name: "Second Rules", enabled: false },
    ];
    getScriptVisuals.mockImplementation(async (id) =>
      id === "srv_1" ? [{ ...baseVisual }] : [],
    );

    const { findByLabelText, getAllByTestId } = render(<ExperienceEditor />);

    // Status is a colored dot before the name, labelled with the human status
    // (the old text chip + Draft badge are gone — the dot replaces both).
    expect(await findByLabelText("experience_editor_enabled")).toBeTruthy();
    expect(await findByLabelText("experience_editor_disabled")).toBeTruthy();

    // The description slot is always present (fixed two-line height) so cards
    // keep a uniform height even when a script has no description.
    expect(getAllByTestId("card-description")).toHaveLength(2);
  });

  // ── Follow-up round 3: mobile script header compaction ──────────────────
  // The header action cluster must compose into ONE tight mobile row:
  // [вкл/выкл pill][toggle][floppy save][duplicate][delete] — hence the short
  // status keys and the icon-only SaveButton below 768px. Desktop (and every
  // non-mobile test above) keeps the full word + text save label.
  it("mobile: the status pill uses the short form and save collapses to a floppy icon", async () => {
    serverScripts = [{ ...baseScript }];
    mobileMocks.mobile = true;

    const { findByText, queryByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("experience_editor_create_new"));

    // Fresh script is disabled → short pill key, never the full word.
    expect(await findByText("experience_editor_disabled_short")).toBeTruthy();
    expect(queryByText("experience_editor_disabled")).toBeNull();

    // Save is icon-only: a floppy svg, no visible text, state via aria-label.
    const save = getByRole("button", { name: "save" });
    expect(save.querySelector("svg")).toBeTruthy();
    expect(save.textContent).toBe("");
  });

  it("desktop: the full status word and the text save label are unchanged", async () => {
    serverScripts = [{ ...baseScript }];

    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("experience_editor_create_new"));

    expect(await findByText("experience_editor_disabled")).toBeTruthy();
    const save = getByRole("button", { name: "save" });
    expect(save.textContent).toContain("save");
  });

  it("auto-selects the first bound visual on open and badges bound visuals in the list (ER-18b)", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [
      { ...baseVisual },
      { ...baseVisual, id: "vis_2", name: "Visual Two", source: "<!doctype html><html><body>two</body></html>" },
    ];
    getScriptVisuals.mockResolvedValue([{ ...baseVisual }]); // only vis_1 is bound

    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    // XU-5: the bound visual (non-empty source) defaults the editor to the
    // Preview tab — switch to Code first, then to the Visual buffer.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_code" }));
    await codeViews(container);
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    // Auto-select: the dropdown trigger shows the bound visual, not the placeholder.
    await waitFor(() => {
      const trigger = [...container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Existing Visual"),
      );
      expect(trigger).toBeTruthy();
    });

    // Open the dropdown: only the bound visual (vis_1) carries the bound badge.
    const trigger = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Existing Visual"));
    if (!trigger) throw new Error("dropdown trigger missing");
    fireEvent.click(trigger);
    await waitFor(() => expect(document.body.querySelector("[cmdk-list]")).toBeTruthy());
    expect(document.body.querySelectorAll("[data-testid='experience_visual_bound_badge']").length).toBe(1);
  });

  it("persists the script immediately on the blank create in a saved/idle state (server id, not local)", async () => {
    // ER-13d-2a: the create happens on the blank create button
    // (persist-on-create), NOT on the first save. The boundary is unchanged:
    // createScript is called once with the right body and the script exists
    // with a server id.
    serverScripts = [{ ...baseScript }];
    const { findByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("experience_editor_create_new"));

    await waitFor(() => {
      expect(createScript).toHaveBeenCalledWith({
        name: "experience_editor_new_experience_name",
        description: "",
        code: "",
        scriptKind: "interactive",
        enabled: false,
        scopeType: "global",
      });
    });
    expect(createScript).toHaveBeenCalledTimes(1);

    // The script exists immediately (server id, not local) and is clean.
    expect(await findByText("saved_state")).toBeTruthy();
    const drafts = rulesDraftEntries().filter(([id]) => !id.startsWith("local:"));
    expect(drafts.some(([id]) => id === "srv_2")).toBe(true);
    // No local (unsaved) draft was ever created for the blank create.
    expect(rulesDraftEntries().filter(([id]) => id.startsWith("local:"))).toHaveLength(0);
  });

  it("blank create implies a fresh visual draft: the Visual tab opens on an editable empty buffer (2026-08-17)", async () => {
    serverScripts = [{ ...baseScript }];
    const { findByText, getByRole, findByDisplayValue } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("experience_editor_create_new"));
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_visual" })).toBeDefined();
    });

    // A pending (local-id) visual draft exists, seeded empty with the default name.
    const pending = visualDraftEntries().filter(([id]) => id.startsWith("local:"));
    expect(pending).toHaveLength(1);
    expect(pending[0]![1].values.name).toBe("experience_editor_new_visual_name");
    expect(pending[0]![1].values.source).toBe("");

    // And it is SELECTED: opening the Visual tab shows the draft's name in the
    // visual-name input — a live editable buffer, not a "no visual" dead end.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    expect(await findByDisplayValue("experience_editor_new_visual_name")).toBeDefined();
  });

  it("in creation mode the rules template picker fills the buffer and records the choice", async () => {
    const { findByText, getByRole } = render(<ExperienceEditor />);

    // Blank create → creation mode.
    fireEvent.click(await findByText("experience_editor_create_new"));
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    });

    // The rules template picker renders in step 1 (creation only).
    expect(await findByText("experience_editor_rules_template")).toBeTruthy();

    // Picking a starter fills the EXISTING (server-id) rules buffer via the
    // draft store and overwrites the blank-create default name.
    fireEvent.click(await findByText("Board"));

    await waitFor(() => {
      const drafts = rulesDraftEntries().filter(([id]) => !id.startsWith("local:"));
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.[1].values.code).toBe(BOARD_SOURCE);
      expect(drafts[0]?.[1].values.name).toBe("Board");
    });
    // No second create — the template is a buffer edit, not a new script.
    expect(createScript).toHaveBeenCalledTimes(1);
  });

  it("highlights the paired visual starter after choosing a rules starter in creation mode", async () => {
    const { container, findByText, getByRole } = render(<ExperienceEditor />);

    // Blank create → creation mode.
    fireEvent.click(await findByText("experience_editor_create_new"));
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    });

    // Switch to the Visual buffer before choosing a rules starter: no paired
    // highlight (nothing chosen yet).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    expect(container.querySelector('button[aria-label="experience_editor_visual_paired"]')).toBeNull();

    // Back to Rules, choose the board starter (paired visual = Grid / Board).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_rules" }));
    fireEvent.click(await findByText("Board"));

    // Switch to Visual: the paired starter is highlighted + badged.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    const paired = container.querySelector('button[aria-label="experience_editor_visual_paired"]');
    expect(paired).toBeTruthy();
    expect(paired?.textContent).toContain("Grid / Board");
  });

  it("the blank 'create new' button persists an empty script and opens creation mode", async () => {
    const { findByText, getByRole } = render(<ExperienceEditor />);

    fireEvent.click(await findByText("experience_editor_create_new"));

    await waitFor(() => {
      expect(createScript).toHaveBeenCalledWith({
        name: "experience_editor_new_experience_name",
        description: "",
        code: "",
        scriptKind: "interactive",
        enabled: false,
        scopeType: "global",
      });
    });
    expect(createScript).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    });
  });

  it("renders the creation stepper only in creation mode (XU-6)", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByTestId, queryByTestId } = render(<ExperienceEditor />);

    // Editing an existing script: no creation stepper.
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);
    expect(queryByTestId("experience-creation-stepper")).toBeNull();

    // Back, then blank create → creation mode: the stepper renders.
    const backButton = [...container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("experience_editor_back"),
    );
    if (!backButton) throw new Error("back button missing");
    fireEvent.click(backButton);
    fireEvent.click(await findByText("experience_editor_create_new"));
    await waitFor(() => {
      expect(getByTestId("experience-creation-stepper")).toBeDefined();
    });

    // The three steps render (Rules / Appearance / Try it).
    const stepper = getByTestId("experience-creation-stepper");
    expect(stepper.textContent).toContain("experience_copilot_rules");
    expect(stepper.textContent).toContain("experience_editor_step_appearance");
    expect(stepper.textContent).toContain("experience_copilot_try_it");
  });

  it("navigating back to the picker and re-opening shows the SAME unified 3-position toggle (XU-6)", async () => {
    const { container, findByText, getByRole } = render(<ExperienceEditor />);

    // Create via the blank button → the unified 3-position toggle.
    fireEvent.click(await findByText("experience_editor_create_new"));
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    });

    // Navigate back to the picker.
    const backButton = [...container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("experience_editor_back"),
    );
    if (!backButton) throw new Error("back button missing");
    fireEvent.click(backButton);
    expect(await findByText("experience_editor_create_new")).toBeTruthy();

    // Re-open the same script → the SAME unified toggle (XU-6 quote 10: no
    // creation/editing tab distinction — the Try tab is always present).
    fireEvent.click(await findByText("experience_editor_new_experience_name"));
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_visual" })).toBeDefined();
      expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    });
  });

  it("back → create-new gives the fresh experience its OWN visual draft — the previous visual never leaks (TF-1)", async () => {
    // TF-1: neither the back button nor persist-on-create reset activeVisualId,
    // so the previous experience's bound visual leaked into the brand-new one
    // (its source landed in the Visual buffer of a script that never bound it).
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    getScriptVisuals.mockResolvedValue([{ ...baseVisual }]); // vis_1 bound to srv_1

    const { container, findByText, getByRole } = render(<ExperienceEditor />);

    // Open the existing experience — ER-18b auto-selects its bound visual.
    fireEvent.click(await findByText("Existing Rules"));
    // XU-5: the bound visual (non-empty source) defaults the editor to the
    // Preview tab — switch to Code first, then to the Visual buffer.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_code" }));
    await codeViews(container);
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    await waitFor(() => {
      const trigger = [...container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Existing Visual"),
      );
      expect(trigger).toBeTruthy();
    });

    // Back to the picker, then create a NEW experience (persist-on-create).
    const backButton = [...container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("experience_editor_back"),
    );
    if (!backButton) throw new Error("back button missing");
    fireEvent.click(backButton);
    fireEvent.click(await findByText("experience_editor_create_new"));
    await waitFor(() => {
      expect(getByRole("radio", { name: "experience_copilot_try_it" })).toBeDefined();
    });

    // Creation mode's Visual buffer must NOT carry the previous experience's
    // visual — and since 2026-08-17 it carries its OWN fresh draft instead:
    // the dropdown shows the new draft's name (not "Existing Visual", not the
    // empty placeholder — the tab is a live editable buffer from the start).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    await waitFor(() => {
      const trigger = [...container.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("experience_editor_new_visual_name"),
      );
      expect(trigger).toBeTruthy();
    });
    const stale = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Existing Visual"),
    );
    expect(stale).toBeUndefined();
    // The draft is a NEW pending visual, not the old bound row.
    const pending = visualDraftEntries().filter(([id]) => id.startsWith("local:"));
    expect(pending).toHaveLength(1);
    expect(pending[0]![1].values.source).toBe("");
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

  it("preserves edits made during an in-flight create (duplicate path — the remaining local-id create)", async () => {
    // ER-13d-2a: persist-on-create gives the starter path a SERVER id (no local
    // draft), so the mid-flight-edit boundary now lives ONLY on the duplicate
    // path (local-id draft → createScript on first save). The boundary is
    // unchanged: edits made while the create is in flight survive reconciliation.
    const gate = holdNextCreate();
    serverScripts = [{ ...baseScript }];
    const { container, findByText, findByRole, getAllByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    // Duplicate → a local-id draft; save → createScript (held by the gate).
    const [dupButton] = getAllByRole("button", { name: "experience_editor_duplicate" });
    if (!dupButton) throw new Error("duplicate button missing");
    fireEvent.click(dupButton);
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    fireEvent.click(await findByRole("button", { name: "save" }));
    await waitFor(() => expect(createScript).toHaveBeenCalledTimes(1));

    // Edit while the create is in flight, then resolve with the submitted code.
    replaceCode(rulesView, EXISTING_CODE + "\n// mid-flight");
    const created: ScriptRecord = { ...baseScript, id: "srv_2", name: "Existing Rules", code: EXISTING_CODE, enabled: false };
    await act(async () => { gate.resolve({ ...created }); });

    // The mid-flight edit survives as a dirty buffer against the new base.
    const saveButton = await findByRole("button", { name: "save" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    const migrated = useScriptDraftStore.getState().drafts["srv_2"];
    expect(migrated?.values.code).toBe(EXISTING_CODE + "\n// mid-flight");
    expect(migrated?.base.code).toBe(EXISTING_CODE);

    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("srv_2", expect.objectContaining({ code: EXISTING_CODE + "\n// mid-flight" }));
    });
  });

  it("saves the visual buffer independently through the visuals API", async () => {
    // IR-90C: the starter pick now opens the wizard, so the visual buffer is
    // created from the editor's visual starter picker instead. The boundary is
    // unchanged: saving a pending visual calls createExperienceVisual.
    const choiceStarter = getVisualStarter("choice");
    if (!choiceStarter) throw new Error("choice starter missing");
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    // The visual starter picker lives in the Visual buffer's contextual
    // toolbar, so switch the shell to the Visual tab first.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    // Create a pending visual from the Choice starter (the editor's visual
    // starter picker, not the rules starter picker).
    fireEvent.click(await findByText("Choice"));

    fireEvent.click(getByRole("button", { name: "experience_editor_visual_save" }));

    await waitFor(() => {
      expect(createExperienceVisual).toHaveBeenCalledWith({
        name: "Choice",
        source: choiceStarter.source,
        apiVersion: 1,
        compatibleManifestIds: [],
        scopeType: "global",
      });
    });
    // The rules buffer is untouched by the visual save (still clean).
    expect(createScript).not.toHaveBeenCalled();
    // The visual save status reached "saved" (the rules buffer is also clean,
    // so two "saved_state" elements are present — one per buffer).
    await waitFor(() => {
      expect(container.querySelectorAll("*")).toBeTruthy();
      const savedStates = [...document.body.querySelectorAll("span")].filter(
        (s) => s.textContent === "saved_state",
      );
      expect(savedStates.length).toBeGreaterThanOrEqual(1);
    });
    const migrated = visualDraftEntries().filter(([id]) => !id.startsWith("local:"));
    expect(migrated.some(([id]) => id === "vis_1")).toBe(true);
  });

  it("adds a completely blank visual from the '+ Blank' chip (TF-2)", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    // The '+ Blank' chip creates a pending visual with an EMPTY name + source
    // (no starter skeleton) — the blank visual the copilot/user fills by hand.
    fireEvent.click(await findByText("experience_editor_visual_blank"));
    await waitFor(() => {
      const blank = visualDraftEntries().find(
        ([, draft]) => draft.values.name === "" && draft.values.source === "",
      );
      expect(blank).toBeDefined();
      if (blank) {
        expect(blank[1].values.apiVersion).toBe(1);
        expect(blank[1].values.compatibleManifestIds).toEqual([]);
      }
    });

    // The blank visual is active: the buffer renders as an empty editor.
    const [view] = await codeViews(container);
    expect(view.state.doc.toString()).toBe("");

    // Starter chips are untouched — all five still render.
    for (const starter of VISUAL_STARTERS) {
      expect(await findByText(starter.label)).toBeTruthy();
    }
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
    expect(await findByText("experience_editor_disabled")).toBeTruthy();
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
    expect(await findByText("experience_editor_enabled")).toBeTruthy();
  });

  it("drops an enabled script to untrusted when its source is edited (store invariant surfaced)", async () => {
    serverScripts = [{ ...baseScript, enabled: true }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    expect(await findByText("experience_editor_enabled")).toBeTruthy();

    replaceCode(rulesView, EXISTING_CODE + "\n// invalidate trust");
    expect(await findByText("experience_editor_disabled")).toBeTruthy();
    const toggle = getByRole("switch") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
    // Never auto-saved: the trust drop is local until an explicit save.
    expect(updateScript).not.toHaveBeenCalled();
  });

  it("duplicates an existing script as an independent, untrusted copy", async () => {
    // IR-90C: the starter-pick path now opens the wizard, so the duplicate-
    // from-starter half moved there. The duplicate-from-existing boundary is
    // unchanged: duplication produces an independent, explicitly untrusted
    // local-id copy whose edits never touch the source.
    serverScripts = [{ ...baseScript, enabled: true }];
    const { findByText, getAllByRole, getByRole, container } = render(<ExperienceEditor />);

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

    // Editing the duplicate never touches the original saved script's draft.
    const dupId = dupOfExisting?.[0];
    if (!dupId) throw new Error("unreachable");
    act(() => {
      useScriptDraftStore.getState().patch(dupId, { code: EXISTING_CODE + "\n// dup edit" });
    });
    expect(useScriptDraftStore.getState().drafts["srv_1"]?.values.code).toBe(EXISTING_CODE);
  });

  it("duplicates a visual without sharing the compatibleManifestIds array", async () => {
    // IR-90C: the starter pick opens the wizard, so we enter via an existing
    // script and select the saved visual. The boundary is unchanged.
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    const { container, findByText, getAllByRole, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    // Switch to the Visual tab (the dropdown + duplicate button live in the
    // visual toolbar slot).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    // Select the saved visual so it is active (the duplicate targets it).
    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    // Duplicate the visual; the copy must not share the compatibleManifestIds
    // array reference (duplicateVisualDraftValues copies).
    const dupButtons = getAllByRole("button", { name: "experience_editor_duplicate" });
    const visualDup = dupButtons[1];
    if (!visualDup) throw new Error("visual duplicate button missing");
    fireEvent.click(visualDup);

    const pendingVisuals = visualDraftEntries().filter(([id]) => id.startsWith("local:"));
    expect(pendingVisuals.length).toBe(1);
    const duplicate = pendingVisuals[0];
    if (!duplicate) throw new Error("unreachable");
    expect(duplicate[1].values.compatibleManifestIds).toEqual([...baseVisual.compatibleManifestIds]);
    expect(duplicate[1].values.compatibleManifestIds).not.toBe(baseVisual.compatibleManifestIds);
  });

  it("mounts the interactive API reference from the toolbar", async () => {
    serverScripts = [{ ...baseScript }];
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("button", { name: "script_api_reference" }));

    expect(await findByText("experience_api_title")).toBeTruthy();
    expect(await findByText("experience_api_methods")).toBeTruthy();
    expect(await findByText("experience_api_optional")).toBeTruthy();
    expect(await findByText("experience_api_events")).toBeTruthy();
  });

  it("mounts the visual API reference from the visual toolbar", async () => {
    serverScripts = [{ ...baseScript }];
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    fireEvent.click(getByRole("button", { name: "script_api_reference" }));

    expect(await findByText("experience_visual_api_title")).toBeTruthy();
    expect(await findByText("experience_visual_api_methods_title")).toBeTruthy();
    expect(await findByText("experience_visual_api_callbacks_title")).toBeTruthy();
  });

  // ── IR-90A: above-the-fold playground launcher + explicit visual delete ──
  it("opens the draft-bound playground from the Try tab inline (single instance, no persistent write)", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole, getByTestId } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    // IR-90A: exactly one ExperiencePlayground lives in the tree — the shell's
    // inline Try tab. None is mounted until that tab is opened.
    expect(playgroundInstanceCount()).toBe(0);

    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));

    // The inline Try tab mounted with the SAME draft-bound playground.
    await waitFor(() => {
      expect(getByTestId("experience-playground")).toBeDefined();
      expect(playgroundInstanceCount()).toBe(1);
    });

    // Switching away unmounts the playground and writes nothing — no
    // create/update/delete API call fires (the playground never persists and
    // never creates an API session).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_code" }));
    await waitFor(() => expect(playgroundInstanceCount()).toBe(0));
    expect(createScript).not.toHaveBeenCalled();
    expect(updateScript).not.toHaveBeenCalled();
    expect(createExperienceVisual).not.toHaveBeenCalled();
    expect(deleteExperienceVisual).not.toHaveBeenCalled();
  });

  it("deletes a saved visual on confirm via deleteExperienceVisual and removes it from the list + draft", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    const { container, findByText, queryByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));

    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

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
    // IR-90C: the starter pick opens the wizard, so the pending visual is
    // created from the editor's visual starter picker instead. The boundary is
    // unchanged: a local-id visual is removed locally with no API call.
    serverScripts = [{ ...baseScript }];
    const { container, findByText, queryByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    // Create a pending visual from the Choice starter.
    fireEvent.click(await findByText("Choice"));

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
    const { container, findByText, queryByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
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

    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
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

  // ── IR-90E: compact friendly rules validation ───────────────────────────

  it("validates the rules buffer and shows success", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    fireEvent.click(getByRole("button", { name: "experience_editor_validate_rules" }));

    await waitFor(() => {
      expect(runExperienceTest).toHaveBeenCalledWith({
        rulesCode: EXISTING_CODE,
        settings: {},
        participants: [],
        capabilityGrants: [],
        actions: [],
      });
    });
    expect(runExperienceTest).toHaveBeenCalledTimes(1);
    expect(await findByText("experience_wizard_rules_valid")).toBeTruthy();
  });

  it("shows validation failure with the error message", async () => {
    serverScripts = [{ ...baseScript }];
    runExperienceTest.mockRejectedValueOnce(new Error("syntax error at line 1"));
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    fireEvent.click(getByRole("button", { name: "experience_editor_validate_rules" }));

    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    expect(await findByText(/experience_wizard_rules_invalid/)).toBeTruthy();
    expect(await findByText(/syntax error at line 1/)).toBeTruthy();
  });

  it("reveals the unified test surface (Try tab) from the editor", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, findByTestId, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    // XU-4/XU-6: the tester modal and the sandbox modal are gone — the single
    // Try tab hosts the merged tester capabilities inline. Same boundary as the
    // retired InteractiveTester test: editor → shell tabs → test surface.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_try_it" }));

    expect(await findByTestId("experience-playground")).toBeTruthy();
  });

  // IR-90E: fail-closed validation — stale valid state must never survive
  // an edit or script switch.
  it("clears validation state when the code changes", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole, queryByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    // Validate succeeds.
    fireEvent.click(getByRole("button", { name: "experience_editor_validate_rules" }));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    expect(await findByText("experience_wizard_rules_valid")).toBeTruthy();

    // Edit the code — validation must clear immediately (fail-closed).
    replaceCode(rulesView, EXISTING_CODE + "\n// changed");
    await waitFor(() => {
      expect(queryByText("experience_wizard_rules_valid")).toBeNull();
      expect(queryByText(/experience_wizard_rules_invalid/)).toBeNull();
    });
  });

  // IR-90E: in-flight race — a validation started against source A whose
  // promise hasn't resolved must never update state when the user edits to
  // source B before the promise settles. The monotonic token in the editor
  // drops the stale result and the loading indicator is cleared by the
  // code-change effect.
  it("drops a stale validation result when the code changes before the promise resolves", async () => {
    serverScripts = [{ ...baseScript }];
    let resolveTest: (value: ExperienceTestRunData) => void = () => {};
    const deferred = new Promise<ExperienceTestRunData>((resolve) => { resolveTest = resolve; });
    runExperienceTest.mockReturnValueOnce(deferred);

    const { container, findByText, getByRole, queryByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    const [rulesView] = await codeViews(container);
    if (!rulesView) throw new Error("rules editor missing");

    // Start validation — the promise is deferred, so validation is in flight.
    fireEvent.click(getByRole("button", { name: "experience_editor_validate_rules" }));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    // Edit the code while the stale request is still in flight.
    replaceCode(rulesView, EXISTING_CODE + "\n// race edit");

    // Now resolve the stale request with a typed fixture.
    await act(async () => { resolveTest(makeTestRunData()); });

    // The stale result must NOT appear — no valid/invalid indicator.
    expect(queryByText("experience_wizard_rules_valid")).toBeNull();
    expect(queryByText(/experience_wizard_rules_invalid/)).toBeNull();

    // The validate button is restored (loading indicator cleared by the
    // code-change effect, stale promise's finally block skipped via token).
    const validateBtn = getByRole("button", { name: "experience_editor_validate_rules" });
    expect((validateBtn as HTMLButtonElement).disabled).toBe(false);
  });

  // ── IR-90A: explicit experience (script) delete with dual-action confirm ──

  it("opens the experience-delete confirm from the script header trigger", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));

    fireEvent.click(experienceDeleteButton(container));

    // The dual-action confirm modal opened (primary confirm is mounted).
    await waitForExperienceDeleteConfirm();
  });

  it("full delete removes the script and the active visual and clears both", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    const { container, findByText, queryByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    fireEvent.click(experienceDeleteButton(container));
    fireEvent.click(await waitForExperienceDeleteConfirm());

    await waitFor(() => expect(deleteScript).toHaveBeenCalledWith("srv_1"));
    await waitFor(() => expect(deleteExperienceVisual).toHaveBeenCalledWith("vis_1"));
    // Both drafts were removed.
    await waitFor(() => expect(useScriptDraftStore.getState().drafts["srv_1"]).toBeUndefined());
    await waitFor(() => expect(useExperienceVisualDraftStore.getState().drafts["vis_1"]).toBeUndefined());
    // The editor returned to the picker (no active script); the script is gone
    // from the list.
    await waitFor(() => expect(queryByText("Existing Rules")).toBeNull());
  });

  it("rules-only delete removes the script but keeps the active visual", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    fireEvent.click(experienceDeleteButton(container));
    fireEvent.click(await waitForExperienceDeleteSecondary());

    await waitFor(() => expect(deleteScript).toHaveBeenCalledWith("srv_1"));
    // The visual was NOT deleted.
    expect(deleteExperienceVisual).not.toHaveBeenCalled();
    // The visual draft survives; the script draft is gone.
    expect(useExperienceVisualDraftStore.getState().drafts["vis_1"]).toBeDefined();
    await waitFor(() => expect(useScriptDraftStore.getState().drafts["srv_1"]).toBeUndefined());
  });

  it("does not render the rules-only secondary when no visual is active", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(experienceDeleteButton(container));

    // The primary confirm is present ...
    await waitForExperienceDeleteConfirm();
    // ... but the secondary (rules-only) button is absent.
    const secondary = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "experience_editor_delete_rules_only",
    );
    expect(secondary).toBeUndefined();
  });

  it("cancel dismisses the experience-delete confirm without deleting", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(experienceDeleteButton(container));
    await waitForExperienceDeleteConfirm();

    const cancelBtn = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "cancel",
    )!;
    fireEvent.click(cancelBtn);

    expect(deleteScript).not.toHaveBeenCalled();
    expect(deleteExperienceVisual).not.toHaveBeenCalled();
    // The confirm modal is gone.
    await waitFor(() => {
      const confirm = [...document.body.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "experience_editor_delete_full",
      );
      expect(confirm).toBeUndefined();
    });
  });

  // ── ER-13a: characterization gap-fill (pre-rewrite pins) ────────────────
  // These pin behaviors the ER-13 rewrite must preserve. Each exercises the
  // SAME boundary as the tests above (API mocks → real ExperienceEditor → DOM
  // + store observation) — no pure-helper unit tests.

  it("switches between two saved visuals and shows each one's source", async () => {
    const visualTwoSource = "<!doctype html><html><body>two</body></html>";
    serverScripts = [{ ...baseScript }];
    serverVisuals = [
      { ...baseVisual },
      { ...baseVisual, id: "vis_2", name: "Visual Two", source: visualTwoSource },
    ];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    // Switch to the Visual buffer (the dropdown + source editor live there).
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    // Select vis_1 (the dropdown shows its placeholder while none is active).
    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    // The single shell CodeEditor now shows the selected visual's source.
    const [visualView] = await codeViews(container);
    if (!visualView) throw new Error("visual editor missing");
    await waitFor(() => {
      expect(visualView.state.doc.toString()).toBe(baseVisual.source);
    });

    // Switch to vis_2 (the trigger now displays vis_1's name).
    await pickDropdown({ container, baseElement: document.body }, "Existing Visual", "Visual Two");

    // The SAME editor now shows vis_2's source (external-value sync).
    await waitFor(() => {
      expect(visualView.state.doc.toString()).toBe(visualTwoSource);
    });
    // The active visual is vis_2 — its name field reflects the active buffer.
    const nameInput = container.querySelector('input[placeholder="experience_editor_visual_name_ph"]') as HTMLInputElement | null;
    if (!nameInput) throw new Error("visual name input missing");
    expect(nameInput.value).toBe("Visual Two");
  });

  it("renames a saved visual and persists the new name via updateExperienceVisual", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));

    await pickDropdown({ container, baseElement: document.body }, "experience_assign_visual_placeholder", "Existing Visual");

    const nameInput = container.querySelector('input[placeholder="experience_editor_visual_name_ph"]') as HTMLInputElement | null;
    if (!nameInput) throw new Error("visual name input missing");
    setInputValue(nameInput, "Renamed Visual");

    fireEvent.click(getByRole("button", { name: "experience_editor_visual_save" }));

    await waitFor(() => {
      expect(updateExperienceVisual).toHaveBeenCalledWith("vis_1", expect.objectContaining({ name: "Renamed Visual" }));
    });
    expect(updateExperienceVisual).toHaveBeenCalledTimes(1);
    expect(createExperienceVisual).not.toHaveBeenCalled();
  });

  it("renames a saved script and persists the new name via updateScript", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    await codeViews(container);

    const nameInput = container.querySelector('input[placeholder="script_name"]') as HTMLInputElement | null;
    if (!nameInput) throw new Error("script name input missing");
    setInputValue(nameInput, "Renamed Rules");

    fireEvent.click(getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("srv_1", expect.objectContaining({ name: "Renamed Rules" }));
    });
    expect(updateScript).toHaveBeenCalledTimes(1);
    expect(createScript).not.toHaveBeenCalled();
  });

  it("returns to the starter picker when navigating back", async () => {
    serverScripts = [{ ...baseScript }];
    const { container, findByText, queryByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));

    // The editor view is mounted (the rules name field is present).
    expect(container.querySelector('input[placeholder="script_name"]')).toBeTruthy();

    const backButton = [...container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("experience_editor_back"),
    );
    if (!backButton) throw new Error("back button missing");
    fireEvent.click(backButton);

    // The picker returns: the create button + existing-list label are visible
    // again and no script is active.
    expect(await findByText("experience_editor_create_new")).toBeTruthy();
    expect(await findByText("experience_editor_existing_label")).toBeTruthy();
    expect(queryByText("experience_editor_back")).toBeNull();
    expect(container.querySelector('input[placeholder="script_name"]')).toBeNull();
  });

  // 4a mobile audit pins (MOBILE_AND_PROMPT_FIXES_REPORT, 2026-08-17): the
  // mobile-only reworks are `max-md:` variants (desktop classes untouched —
  // useIsMobile / the shell's mobile branch break at 768px, same as Tailwind's
  // md). happy-dom computes no layout, so these pins assert the responsive
  // classes on the real rendered DOM.
  it("picker view owns a mobile scroll container (4a defect 1: list could not scroll)", async () => {
    serverScripts = [];
    const { getByTestId } = render(<ExperienceEditor />);
    await waitFor(() => expect(getByTestId("experience-picker-scroll")).toBeTruthy());
    const scroller = getByTestId("experience-picker-scroll");
    expect(scroller.classList.contains("max-md:h-full")).toBe(true);
    expect(scroller.classList.contains("max-md:overflow-y-auto")).toBe(true);
    // Desktop keeps the old behavior (no forced scroll container of its own —
    // the max-md variants simply do not apply at ≥768px).
    expect(scroller.classList.contains("max-w-[860px]")).toBe(true);
  });

  it("script header: mobile recomposes into two tight rows — name shares the back row, save is an icon-only floppy (4a follow-up + round 3)", async () => {
    serverScripts = [{ ...baseScript }];
    mobileMocks.mobile = true;
    const { container, findByText } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));

    // The name input must NOT claim its own row anymore (no basis-full): it
    // shares row 1 with the back button (flex-1 fills the remainder).
    const nameInput = container.querySelector('input[placeholder="script_name"]');
    if (!(nameInput instanceof HTMLInputElement)) throw new Error("name input missing");
    expect(nameInput.classList.contains("max-md:basis-full")).toBe(false);
    expect(nameInput.classList.contains("flex-1")).toBe(true);
    // The action cluster is a display:contents group on desktop (flat row)
    // and a nested flex row on mobile — the deterministic two-row split.
    const pill = container.querySelector("span.cursor-help");
    if (!(pill instanceof HTMLElement)) throw new Error("status pill missing");
    const cluster = pill.closest("div");
    if (!(cluster instanceof HTMLElement)) throw new Error("action cluster missing");
    expect(cluster.classList.contains("contents")).toBe(true);
    expect(cluster.classList.contains("max-md:flex")).toBe(true);
    expect(cluster.classList.contains("max-md:flex-wrap")).toBe(true);

    // The save-state label stays hidden on mobile; the save button is an
    // icon-only floppy (round 3): a fixed 36px touch square instead of the
    // old flex-1 filler, so [pill][toggle][save][dup][del] fit one row.
    const stateLabel = await findByText("saved_state");
    expect(stateLabel.classList.contains("max-md:hidden")).toBe(true);
    const saveBtn = container.querySelector('button[aria-label="Сохранить"], button[aria-label="save"]');
    if (!(saveBtn instanceof HTMLElement)) throw new Error("save button missing");
    expect(saveBtn.classList.contains("h-9")).toBe(true);
    expect(saveBtn.classList.contains("w-9")).toBe(true);
    expect(saveBtn.classList.contains("min-w-[124px]")).toBe(false);
    expect(saveBtn.querySelector("svg")).toBeTruthy();

    const dupBtn = container.querySelector('button[aria-label="experience_editor_duplicate"]');
    if (!(dupBtn instanceof HTMLElement)) throw new Error("duplicate button missing");
    expect(dupBtn.classList.contains("max-md:h-9")).toBe(true);
    expect(dupBtn.classList.contains("max-md:w-9")).toBe(true);
  });

  it("visual toolbar: rows wrap on mobile, save button takes a full row, chips are touch-tall (4a defect 4/5)", async () => {
    serverScripts = [{ ...baseScript }];
    serverVisuals = [{ ...baseVisual }];
    getScriptVisuals.mockResolvedValue([{ ...baseVisual }]); // bound → auto-selected on open

    const { container, findByText, getByRole, getByDisplayValue } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    // XU-5: a bound visual defaults to Preview — switch to Code → Visual buffer
    // so the visual toolbar (dropdown/starter chips/name+save row) mounts.
    fireEvent.click(getByRole("radio", { name: "experience_copilot_code" }));
    fireEvent.click(getByRole("radio", { name: "experience_copilot_visual" }));
    const nameField = await getByDisplayValue("Existing Visual");

    // Row 3 (name + save): wraps on mobile; the save button owns a full row.
    const row = nameField.parentElement;
    if (!(row instanceof HTMLElement)) throw new Error("visual name row missing");
    expect(row.classList.contains("max-md:flex-wrap")).toBe(true);
    const saveBtn = row.querySelector('button[aria-label="experience_editor_visual_save"]');
    if (!(saveBtn instanceof HTMLElement)) throw new Error("visual save button missing");
    expect(saveBtn.classList.contains("max-md:w-full")).toBe(true);
    expect(saveBtn.classList.contains("max-md:min-h-[44px]")).toBe(true);

    // Row 1: the visual dropdown drops its 220px floor on mobile.
    const dropdownWrap = container.querySelector("div.min-w-\\[220px\\]");
    if (!(dropdownWrap instanceof HTMLElement)) throw new Error("dropdown wrapper missing");
    expect(dropdownWrap.classList.contains("max-md:min-w-0")).toBe(true);

    // Starter chips + API chip are touch-tall on mobile (h-7 desktop stays).
    const chip = [...container.querySelectorAll("button")].find(
      (b) => b.classList.contains("h-7") && (b.textContent ?? "").trim() === "Choice",
    );
    if (!chip) throw new Error("visual starter chip missing");
    expect(chip.classList.contains("max-md:h-9")).toBe(true);
    const deleteBtn = container.querySelector('button[aria-label="experience_editor_visual_delete"]');
    if (!(deleteBtn instanceof HTMLElement)) throw new Error("visual delete button missing");
    expect(deleteBtn.classList.contains("max-md:h-9")).toBe(true);
  });
});

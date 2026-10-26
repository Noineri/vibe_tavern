/**
 * ScriptEditor — explicit-save integration tests.
 *
 * Pins the complete editor boundary with the REAL CodeMirror and ScriptTester:
 * local draft → explicit Save → script-api PATCH, and unsaved draft → test
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
import { afterAll, afterEach, describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { wireScript } from "../../../../test/wire-fixtures.js";
import { useEffect, type ReactNode } from "react";
import type { AppCharacterEntry, ScriptLinkRecord, ScriptRecord } from "../../../api/types.js";
import { SCRIPT_TEMPLATES } from "./script-templates/index.js";
import { WORLD_LORE_UNBOUND_OWNER_ID } from "./use-world-lore-list-filters.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { installBootstrapActionsSeam } from "../../../../test/bootstrap-actions-seam.js";
import { installSnapshotStoreSeam } from "../../../../test/snapshot-store-seam.js";
import { installToggleSeam } from "../../../../test/toggle-seam.js";
import { installPersonaApiSeam } from "../../../../test/persona-api-seam.js";

useDomEnv();

const listScripts = mock((_characterId?: string) => Promise.resolve<ScriptRecord[]>([]));
const listAllScripts = mock(() => Promise.resolve<ScriptRecord[]>([]));
const listParticipatingScripts = mock((_chatId: string) => Promise.resolve<ScriptRecord[]>([]));
const createScript = mock((_body: unknown) => Promise.resolve<ScriptRecord>(undefined as never));
const updateScript = mock((_id: string, _patch: Partial<ScriptRecord>) => Promise.resolve<ScriptRecord>(undefined as never));
const deleteScript = mock(() => Promise.resolve());
const importScript = mock((_body: unknown) => Promise.resolve<ScriptRecord>(undefined as never));
const getScriptLinks = mock((_scriptId: string) => Promise.resolve<ScriptLinkRecord[]>([]));
const setScriptLinks = mock((_scriptId: string, _links: Array<{ targetType: "character" | "persona"; targetId: string }>) => Promise.resolve<ScriptLinkRecord[]>([]));
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
const realScriptApi = await import("../../../api/script-api.js");
const realMobileHook = await import("../../../hooks/use-mobile.js");
const realAiAssistantModal = await import("../../shared/AiAssistantModal.js");
const realLinkBindingPopover = await import("../../shared/LinkBindingPopover.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realSettingsApi = await import("../../../api/settings-api.js");

// SS-7: the script-safety settings singleton (the suppression flag) — the
// warning flow reads it at attempt time; seed the store directly per test.
const getScriptSafetySettings = mock(async () => ({ suppressImportWarnings: false, updatedAt: "" }));
const updateScriptSafetySettings = mock(async (input: { suppressImportWarnings: boolean }) => ({
	suppressImportWarnings: input.suppressImportWarnings,
	updatedAt: "",
}));
mock.module("../../../api/settings-api.js", () => ({
	...realSettingsApi,
	getScriptSafetySettings,
	updateScriptSafetySettings,
}));

let testCharacters: AppCharacterEntry[] = [];

mock.module("../../../api/script-api.js", () => ({
	...realScriptApi,
	listScripts,
	listAllScripts,
	listParticipatingScripts,
	createScript,
	updateScript,
	deleteScript,
	importScript,
	getScriptLinks,
	setScriptLinks,
	testScript,
}));

installI18nContextSeam();

// CO-LOAD CONTRACT (snapshot-store seam): the former inline R4 mock narrowed
// `useAllCharacters` to this file's fixture array — process-global,
// last-write-wins, it stayed live for every later file and broke the real-store
// riders (rail-character-browser's rail rows failed 68/68 in the reproduced
// bundle). Register through the shared seam: this file's narrow semantics for
// its own run, the REAL store for everyone after the next seam registration.
installSnapshotStoreSeam({
	useAllCharacters: () => testCharacters,
});

// CO-LOAD CONTRACT (test/bootstrap-actions-seam.ts): the former inline R4
// mock narrowed `useBootstrapStore` to a plain selector fn — process-global,
// last-write-wins, it stayed live for every later file in a hand-bundled run
// and killed the real-store suites wholesale (`useBootstrapStore.setState is
// not a function`, 46/46 in the AgentProfileModal pair). Register through the
// shared seam: this file's narrow semantics for its own run, the REAL hook
// for everyone after the next seam registration.
installBootstrapActionsSeam({
	useBootstrapStore: <T,>(selector: (state: { personas: never[] }) => T): T => selector({ personas: [] }),
});

// CO-LOAD CONTRACT (toggle-seam family): this suite drives the REAL wrapped
// Radix Toggle (`getByRole("switch")` in the safety-banner bar) — register
// the real arm so a co-loaded stub suite's Toggle registration cannot poison
// it in a hand-bundled run (mock.module is last-write-wins).
installToggleSeam();

// CO-LOAD CONTRACT (persona-api seam): this suite's AgentShell mount consumes
// the real `listPersonas` (its allSettled catalog skips a REJECTED source
// gracefully) — register the real arm so a co-loaded persona-api mock
// (ExperienceSetupModal's) cannot leave a reset-to-undefined `mock()` live for
// it in a hand-bundled run.
installPersonaApiSeam();

// Mobile flag as a mutable cell: the file's tests pin the desktop path by
// default; the D3 block below flips it for the mobile booster path.
const mobileState = { isMobile: false };

mock.module("../../../hooks/use-mobile.js", () => ({
	...realMobileHook,
  useIsMobile: () => mobileState.isMobile,
}));

mock.module("../../shared/AiAssistantModal.js", () => ({
	...realAiAssistantModal,
  AiAssistantModal: () => null,
}));
mock.module("../../shared/LinkBindingPopover.js", () => ({
	...realLinkBindingPopover,
  LinkBindingPopover: (props: {
    links: Array<{ targetType: "character" | "persona"; targetId: string }>;
    onSetLinks: (links: Array<{ targetType: "character" | "persona"; targetId: string }>) => void;
  }) => (
    <div data-testid="script-owner-picker">
      {props.links.map((link) => (
        <button
          key={`${link.targetType}:${link.targetId}`}
          type="button"
          onClick={() => props.onSetLinks(props.links.filter((candidate) => candidate !== link))}
        >
          {link.targetId}
        </button>
      ))}
      <button type="button" onClick={() => props.onSetLinks([...props.links, { targetType: "persona", targetId: "persona-2" }])}>add-persona</button>
    </div>
  ),
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
let within: typeof import("@testing-library/react").within;
let userEvent: typeof import("@testing-library/user-event").default;
let EditorView: typeof import("@codemirror/view").EditorView;
beforeAll(async () => {
	({ act, fireEvent, render, waitFor, within } = await import("@testing-library/react"));
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ EditorView } = await import("@codemirror/view"));
	({ useScriptPanel } = await import("./ScriptEditor.js"));
});

const baseScript: ScriptRecord = {
  ...wireScript(),
  id: "s1",
  name: "Test Script",
  description: "",
  code: "",
  scriptKind: "prompt",
  scopeType: "entity",
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
  listParticipatingScripts.mockClear();
  createScript.mockClear();
  updateScript.mockClear();
  deleteScript.mockClear();
  importScript.mockClear();
  getScriptLinks.mockClear();
  setScriptLinks.mockClear();
  testScript.mockClear();
  testCharacters = [];
  useScriptDraftStore.getState().resetAll();
  serverScript = { ...baseScript };
  updateGate = null;
  listScripts.mockImplementation(async () => [{ ...serverScript }]);
  listAllScripts.mockResolvedValue([]);
  listParticipatingScripts.mockResolvedValue([]);
  getScriptLinks.mockResolvedValue([]);
  createScript.mockResolvedValue({ ...baseScript });
  deleteScript.mockResolvedValue(undefined);
  importScript.mockResolvedValue({ ...baseScript });
  setScriptLinks.mockImplementation(async (_scriptId, links) => links.map((link) => ({ scriptId: "s1", ...link })));
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

// ── AS-8c4a: the whole file runs on the always-on layout ────────────────────
// The shell's session load runs against this minimal fetch router: the
// file-level module mocks cover script-api, not the script-agent transport
// (the real hono client → real fetch). Installed for the WHOLE file
// (testing skill R3: set in beforeEach, restore in afterEach + afterAll).
const agentModeFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const path = new URL(String(input), "http://gateway.test").pathname;
	const method = (init?.method ?? "GET").toUpperCase();
	const json = (payload: unknown, status = 200) =>
		new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
	if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/active$/.test(path)) return json(null);
	if (method === "POST" && /\/api\/experience-copilot\/script\/[^/]+\/session$/.test(path)) {
		return json({ id: "agent-thread-1", scriptId: "s1", draftSessionId: null, title: "Agent", archivedAt: null, createdAt: "", updatedAt: "", metrics: null, contextLinks: [], todo: [] });
	}
	if (method === "GET" && /\/api\/experience-copilot\/script\/[^/]+\/sessions$/.test(path)) return json([]);
	if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/messages$/.test(path)) return json([]);
	if (method === "GET" && /\/api\/experience-copilot\/[^/]+\/context$/.test(path)) return json({ metrics: null, autoCompact: true });
	if (method === "GET" && /\/api\/scripts\/[^/]+\/agent-plan$/.test(path)) return json({ plan: { goal: "", constraints: [], tasks: [] } });
	if (method === "GET" && /\/api\/settings\/script-safety$/.test(path)) return json({ suppressImportWarnings: false, updatedAt: "" });
	if (method === "GET" && (path.endsWith("/api/personas") || path.endsWith("/api/lorebooks/all") || path.endsWith("/api/scripts/all") || path.endsWith("/model-favorites"))) return json([]);
	if (method === "GET" && path.endsWith("/api/coauthor/skills")) return json({ entries: [], errors: [] });
	return json({ error: { message: `Unhandled fetch in script editor test: ${method} ${path}` } }, 404);
});

const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = agentModeFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
});

/** Every harness below renders the always-on layout (AS-8c4a): the agent
 *  shell whenever an open script exists, the no-script placeholder while
 *  the editor view is open with none, the script list otherwise — the path
 *  the user sees. */
function Harness() {
  const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "entity", ownerId: null });
  return <>{panel.modals}{panel.scriptAgentPanel ?? (panel.activeScriptId ? panel.scriptPlaceholderPanel : panel.scriptListContent)}</>;
}

function HarnessAll() {
  const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "all", ownerId: null });
  return <>{panel.modals}{panel.scriptAgentPanel ?? (panel.activeScriptId ? panel.scriptPlaceholderPanel : panel.scriptListContent)}</>;
}

function HarnessGlobal() {
  const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "global", ownerId: null });
  return <>{panel.modals}{panel.scriptAgentPanel ?? (panel.activeScriptId ? panel.scriptPlaceholderPanel : panel.scriptListContent)}</>;
}

function HarnessCurrent() {
  const panel = useScriptPanel({ characterId: "c1", chatId: "chat-current", personaId: null, scope: "current", ownerId: null });
  return <>{panel.modals}{panel.scriptAgentPanel ?? (panel.activeScriptId ? panel.scriptPlaceholderPanel : panel.scriptListContent)}</>;
}

function HarnessFiltered({ ownerId, nameSearch }: { ownerId: string | null; nameSearch: string }) {
  const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "entity", ownerId });
  useEffect(() => panel.setNameSearch(nameSearch), [nameSearch, panel.setNameSearch]);
  return <>
    <div data-testid="script-owner-options">{panel.ownerOptions.map((owner) => owner.id).join(",")}</div>
    {panel.modals}{panel.scriptAgentPanel ?? (panel.activeScriptId ? panel.scriptPlaceholderPanel : panel.scriptListContent)}
  </>;
}

/** Renders the modals plus a control that opens the import modal — the hook
 *  returns `handleImportOpen` for the caller's chrome, so tests reach the
 *  modal through a button of their own. */
function ImportHarness() {
  const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "entity", ownerId: null });
  return (
    <>
      {panel.modals}
      <button type="button" onClick={panel.handleImportOpen}>open-import</button>
    </>
  );
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

/** AS-8c4a bar scope: the management bar holds the script_name input and the
 *  enable toggle, while the shell's context-auto toggle lives outside it —
 *  so scoping the switch query to the input's parent finds the enable toggle
 *  and never the shell's toggle. */
function barScope(nameInput: HTMLElement) {
  const bar = nameInput.parentElement;
  if (!bar) throw new Error("management bar not found");
  return within(bar);
}

describe("useScriptPanel explicit save", () => {
  it("keeps every field local until Save, then PATCHes one complete snapshot without refetching", async () => {
    const { container, findByText, getByPlaceholderText, getByRole } = render(<Harness />);
    const view = await openEditor(container, findByText);
    const user = userEvent.setup();

    await user.clear(getByPlaceholderText("script_name"));
    await user.type(getByPlaceholderText("script_name"), "Renamed");
    await user.type(getByPlaceholderText("script_desc_placeholder"), "Description");
    const bar = barScope(getByPlaceholderText("script_name"));
    fireEvent.click(bar.getByRole("switch"));
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
    const { container, findByText, getByPlaceholderText, getByRole, getByText } = render(<Harness />);
    const view = await openEditor(container, findByText);
    const user = userEvent.setup();
    replaceCode(view, "context.character.personality = 'DRAFT';");
    fireEvent.click(getByRole("radio", { name: "script_tab_check" }));

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
    fireEvent.click(getByRole("radio", { name: "script_tab_check" }));

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

// ── Templates by script kind (SCRIPT_EDITOR_CLEANUP step 3) ─────────────────
// Under the ACTIVE script only its own kind's templates are offered; the
// import modal (no active script) keeps every template but splits them into
// labeled prompt/dice groups.
describe("useScriptPanel list filters", () => {
  it("loads Current scripts from the backend participation query", async () => {
    listParticipatingScripts.mockResolvedValue([{ ...baseScript, id: "current-script", name: "Current script" }]);
    const { findByText } = render(<HarnessCurrent />);

    expect(await findByText("Current script")).toBeTruthy();
    expect(listParticipatingScripts).toHaveBeenCalledWith("chat-current");
    expect(listScripts).not.toHaveBeenCalled();
  });

  it("lists and filters Bound scripts by a linked-only owner, then exactly the unbound scripts", async () => {
    testCharacters = [{
      id: "owner-1",
      name: "Linked-only owner",
      subtitle: "",
      tags: [],
      avatarAssetId: null,
      avatarFullAssetId: null,
      avatarCropJson: null,
      avatarExt: null,
      avatarFullExt: null,
      updatedAt: "",
    }];
    listScripts.mockResolvedValue([
      { ...baseScript, id: "owner-alpha", name: "Owner alpha", characterId: null, personaId: null },
      { ...baseScript, id: "owner-tavern", name: "Owner tavern", characterId: null, personaId: null },
      { ...baseScript, id: "unbound-script", name: "Unbound script", characterId: null, personaId: null },
      { ...baseScript, id: "global-script", name: "Global script", scopeType: "global", characterId: null, personaId: null },
    ]);
    getScriptLinks.mockImplementation(async (id) => id.startsWith("owner-")
      ? [{ scriptId: id, targetType: "character" as const, targetId: "owner-1" }]
      : []);
    const ui = render(<HarnessFiltered ownerId="owner-1" nameSearch="" />);

    await waitFor(() => expect(ui.getByTestId("script-owner-options").textContent).toContain("owner-1"));
    await waitFor(() => expect(ui.queryAllByTestId("script-name")).toHaveLength(2));
    ui.rerender(<HarnessFiltered ownerId="owner-1" nameSearch="tavern" />);

    await waitFor(() => expect(ui.queryAllByTestId("script-name")).toHaveLength(1));
    expect(ui.queryAllByTestId("script-name")[0]?.textContent).toBe("Owner tavern");

    ui.rerender(<HarnessFiltered ownerId={WORLD_LORE_UNBOUND_OWNER_ID} nameSearch="" />);
    await waitFor(() => expect(ui.queryAllByTestId("script-name")).toHaveLength(1));
    expect(ui.queryAllByTestId("script-name")[0]?.textContent).toBe("Unbound script");
  });
});

// ── Templates by script kind (SCRIPT_EDITOR_CLEANUP step 3) ─────────────────
describe("useScriptPanel templates by script kind", () => {
  it("offers only dice templates under a dice script", async () => {
    serverScript = { ...baseScript, scriptKind: "dice" };
    const { container, findByText, getByText, queryByText } = render(<Harness />);
    await openEditor(container, findByText);

    expect(getByText("script_template_fate_die")).toBeTruthy();
    // Prompt-kind templates stay out — including the prompt-kind «Dice Roller»
    // (a /roll listener inside a prompt script, a different scenario).
    expect(queryByText("script_template_dice")).toBeNull();
    expect(queryByText("script_template_relationship")).toBeNull();
    const buttons = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.getAttribute("class")?.includes("rounded-md"));
    expect(buttons.length).toBeGreaterThan(0);
    const templateLabels = buttons.map((b) => b.textContent).filter((x): x is string => x !== null && x.startsWith("script_template_"));
    expect(templateLabels).toEqual(["script_template_fate_die"]);
  });

  it("offers no dice-kind template under a prompt script (Dice Roller stays)", async () => {
    const { container, findByText, getByText, queryByText } = render(<Harness />);
    await openEditor(container, findByText);

    expect(queryByText("script_template_fate_die")).toBeNull();
    expect(getByText("script_template_dice")).toBeTruthy();
    expect(getByText("script_template_relationship")).toBeTruthy();
  });

  it("shows both labeled groups in the import modal", () => {
    const { getByText } = render(<ImportHarness />);
    fireEvent.click(getByText("open-import"));

    expect(getByText("script_template_group_prompt:")).toBeTruthy();
    expect(getByText("script_template_group_dice:")).toBeTruthy();
    // Prompt group keeps its templates, dice group keeps Fate Die — all nine
    // remain importable; only the grouping changed.
    expect(getByText("script_template_relationship")).toBeTruthy();
    expect(getByText("script_template_fate_die")).toBeTruthy();
  });
});

// ── MUI step 7: phone-width creation-button rows ──────────────────────────────
// Three AddButtons in one row («Новый скрипт» + dice + import) do not fit a
// phone: RU labels run 20–30% longer than EN (AD-022). The empty-state row
// stacks on mobile (`max-md:flex-col` + `max-md:items-stretch`), so each
// AddButton becomes a full-width touch row; desktop keeps the centered row.
describe("useScriptPanel empty-state creation buttons (mobile stack, MUI-W2b)", () => {
  it("stacks the empty-state AddButton row on mobile", async () => {
    listScripts.mockResolvedValue([]);
    const { findByText } = render(<Harness />);

    const addButton = await findByText("new_script");
    const row = addButton.parentElement;
    if (!row) throw new Error("AddButton row not found");
    expect(row.className).toContain("max-md:flex-col");
    expect(row.className).toContain("max-md:items-stretch");
    expect(row.querySelectorAll("button")).toHaveLength(3);
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

// ── MUI step 13: link binding is entity-scope only ────────────────────────────
// Global (application-scope) scripts run everywhere, so a character/persona
// link is never consulted for them; chat scripts are already chat-bound.
describe("useScriptPanel link-binding scope filter", () => {
  it("shows an unbound warning after an entity script's empty links load", async () => {
    const { findByText } = render(<Harness />);
    expect(await findByText("script_unbound_warning")).toBeTruthy();
  });

  it("omits the character/persona link binding for global (application-scope) scripts", async () => {
    serverScript = { ...baseScript, scopeType: "global" };
    const { container, findByText, queryByText } = render(<HarnessGlobal />);

    await openEditor(container, findByText);
    expect(queryByText("script_links_label")).toBeNull();
  });

  it("keeps the character/persona link binding for entity-scope scripts", async () => {
    const { container, findByText } = render(<Harness />);

    await openEditor(container, findByText);
    expect(await findByText("script_links_label")).toBeTruthy();
  });

  it("changes and clears an owner chip through the shared link picker", async () => {
    getScriptLinks.mockResolvedValue([{ scriptId: "s1", targetType: "character", targetId: "c1" }]);
    const { container, findByText, getByText } = render(<Harness />);

    await openEditor(container, findByText);
    expect(await findByText("c1")).toBeTruthy();
    fireEvent.click(getByText("add-persona"));
    await waitFor(() => expect(setScriptLinks).toHaveBeenLastCalledWith("s1", [
      { targetType: "character", targetId: "c1" },
      { targetType: "persona", targetId: "persona-2" },
    ]));
    fireEvent.click(getByText("c1"));
    await waitFor(() => expect(setScriptLinks).toHaveBeenLastCalledWith("s1", [
      { targetType: "persona", targetId: "persona-2" },
    ]));
  });
});

// LORE_SCRIPT_OWNERS_AS_LINKS step 2: creating (or importing) a script never
// derives an owner from the persona/character context — the create body
// carries scopeType (+chatId for chat scope) and nothing else; owners are
// explicit links (the creation-row picker is step 3).
describe("useScriptPanel create/import owner boundary (LORE_SCRIPT_OWNERS_AS_LINKS step 2)", () => {
  function HarnessPersonaContext() {
    // Persona context ACTIVE — before step 2 this silently homed every
    // created script to that persona.
    const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: "persona_active", scope: "entity", ownerId: null });
    return (
      <>
        {panel.modals}
        <button type="button" onClick={() => panel.handleAdd()}>trigger-add</button>
        <button type="button" onClick={panel.handleImportOpen}>trigger-import-open</button>
      </>
    );
  }

  it("creating a script from an entity scope explicitly links the current character", async () => {
    const { getByText } = render(<HarnessPersonaContext />);
    fireEvent.click(getByText("trigger-add"));
    await waitFor(() => expect(createScript).toHaveBeenCalledTimes(1));
    const body = createScript.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.scopeType).toBe("entity");
    expect("characterId" in body).toBe(false);
    expect("personaId" in body).toBe(false);
    expect(body.links).toEqual([{ targetType: "character", targetId: "c1" }]);
  });

  it("importing a script from an entity scope with a persona context sends NO owner fields", async () => {
    const { getByText, getByPlaceholderText, getByRole } = render(<HarnessPersonaContext />);
    fireEvent.click(getByText("trigger-import-open"));
    fireEvent.change(getByPlaceholderText("script_import_placeholder"), { target: { value: "code();" } });
    fireEvent.click(getByRole("button", { name: "script_import_import" }));
    await waitFor(() => expect(importScript).toHaveBeenCalledTimes(1));
    const body = importScript.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.scopeType).toBe("entity");
    expect("characterId" in body).toBe(false);
    expect("personaId" in body).toBe(false);
  });
});


// ── SS-7: the first-enable warning flow on the prompt/dice enable toggle ───
// The matrix itself lives in scriptSafetyWarningFlow's own suite; these pin
// the EDITOR-side wiring: the toggle is guarded, the modal releases the
// pending enable, cancel leaves the script disabled, and «Show in code»
// jumps the REAL CodeMirror caret to the finding line.
const { useScriptSafetySettingsStore } = await import("../../../stores/script-safety-settings-store.js");

describe("useScriptPanel SS-7 enable warning flow", () => {
  const CLEAN = "context.state.set('x', 1);";
  const FINDINGS_CODE = CLEAN + "\neval('y');";

  beforeEach(() => {
    // Seed the loaded sentinel so the banner's load() is a no-op.
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  });

  async function openUntrustedImport(overrides: Partial<ScriptRecord> = {}) {
    serverScript = { ...baseScript, enabled: false, origin: "imported", firstEnabledAt: null, code: CLEAN, ...overrides };
    const view = render(<Harness />);
    // openEditor performs the list→editor navigation click itself.
    const editor = await openEditor(view.container, (text) => view.findByText(text));
    return { ...view, editor };
  }

  it("enabling an untrusted import is blocked by the plain warning; confirm enables and Save persists it", async () => {
    const { getByPlaceholderText, getByRole, getAllByRole, getByText, queryAllByText, editor } = await openUntrustedImport();
    expect(editor.state.doc.toString()).toBe(CLEAN);
    const bar = barScope(getByPlaceholderText("script_name"));

    fireEvent.click(bar.getByRole("switch"));
    // The honest warning blocks (visible copy + the Modal's sr-only pair).
    expect(queryAllByText("script_safety_warning_body")).toHaveLength(2);
    // The modal's own suppress toggle is a second switch — the EDITOR's
    // switch stays aria-checked=false until the modal is confirmed. (hidden:
    // the open modal aria-hides the bar, so the scoped query pierces that.)
    expect(bar.getAllByRole("switch", { hidden: true }).every((el) => el.getAttribute("aria-checked") !== "true")).toBe(true);
    expect(updateScript).not.toHaveBeenCalled();

    fireEvent.click(getByText("script_safety_warning_confirm_enable"));
    // The pending enable released: the draft flips on; Save persists it.
    expect(bar.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(getByRole("button", { name: "save" }));
    await waitFor(() => {
      expect(updateScript).toHaveBeenCalledWith("s1", expect.objectContaining({ enabled: true }));
    });
  });

  it("cancel leaves the untrusted import disabled", async () => {
    const { getByPlaceholderText, getByRole, getByText } = await openUntrustedImport();
    const bar = barScope(getByPlaceholderText("script_name"));
    fireEvent.click(bar.getByRole("switch"));
    fireEvent.click(getByText("cancel"));
    expect(bar.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(updateScript).not.toHaveBeenCalled();
  });

  it("no modal for an in-app script (direct enable)", async () => {
    serverScript = { ...baseScript, enabled: false, origin: "in_app" };
    const view = render(<Harness />);
    await openEditor(view.container, (text) => view.findByText(text));
    const bar = barScope(view.getByPlaceholderText("script_name"));
    fireEvent.click(bar.getByRole("switch"));
    expect(view.queryByText("script_safety_warning_body")).toBeNull();
    expect(bar.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("a suppressed untrusted import enables with no modal", async () => {
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: true });
    const { getByPlaceholderText, getByRole, queryAllByText } = await openUntrustedImport();
    const bar = barScope(getByPlaceholderText("script_name"));
    fireEvent.click(bar.getByRole("switch"));
    expect(queryAllByText("script_safety_warning_body")).toHaveLength(0);
    expect(bar.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("findings fire the findings modal ALONE with the honest text; «Show in code» closes it and jumps the real editor caret", async () => {
    const { getByPlaceholderText, getByRole, getByText, queryAllByText, editor } = await openUntrustedImport({ code: FINDINGS_CODE });
    const bar = barScope(getByPlaceholderText("script_name"));
    fireEvent.click(bar.getByRole("switch"));
    expect(queryAllByText("script_safety_findings_title")).toHaveLength(2);
    // Honest text rides inside the findings modal (decision 11) — exactly
    // once (visible paragraph; the sr-only pair describes the findings intro).
    expect(queryAllByText("script_safety_warning_body")).toHaveLength(1);
    expect(getByText("script_safety_rule_unsafe_eval")).toBeTruthy();

    fireEvent.click(getByText("script_safety_findings_show_in_code"));
    // Modal closed; the reveal extension moved the caret to line 2's start.
    expect(queryAllByText("script_safety_findings_title")).toHaveLength(0);
    await waitFor(() => {
      expect(editor.state.selection.main.head).toBe(editor.state.doc.line(2).from);
    });
  });

  it("a TRUSTED import with findings re-enables through the findings modal — without the honest text", async () => {
    const { getByPlaceholderText, getByRole, queryAllByText } = await openUntrustedImport({
      code: FINDINGS_CODE,
      firstEnabledAt: "2026-01-01T00:00:00.000Z",
    });
    const bar = barScope(getByPlaceholderText("script_name"));
    fireEvent.click(bar.getByRole("switch"));
    expect(queryAllByText("script_safety_findings_title")).toHaveLength(2);
    expect(queryAllByText("script_safety_warning_body")).toHaveLength(0);
  });
});

// ── AS-8c3b: always-on assistant (AGENT_SHELL_PLAN, section "AS-8c") ─────────
// The assistant is ALWAYS on for every open script: the AS-8c1 management bar
// sits above the shell, with no toggle and no back-to-plain (the lore
// editor's own editorHeader caret stays the script view's back control). The
// legacy AiAssistantModal is gone from THIS editor (ScriptEditor.tsx no longer
// imports it — the file-level stub above stays null, so any modal open would
// have to surface as a dialog role). The shell's session load runs against the
// fetch router above the harnesses (installed for the whole file since AS-8c4a).
/** Mirrors LorebookEditorView: the agent panel renders whenever an open script
 *  exists (always-on — the hook returns null only with no active script). */
function AgentModeHarness() {
	const panel = useScriptPanel({ characterId: "c1", chatId: null, personaId: null, scope: "entity", ownerId: null });
	return <>{panel.modals}{panel.scriptAgentPanel ?? (panel.activeScriptId ? panel.scriptPlaceholderPanel : panel.scriptListContent)}</>;
}

describe("useScriptPanel always-on assistant (AS-8c3b)", () => {
	it("shows the script agent shell at once — no helper button, no back control, no modal", async () => {
		const { container, findByText, findByTestId, queryByRole, queryByTestId } = render(<AgentModeHarness />);
		await openEditor(container, findByText);

		// Always-on: the shell's chat input is mounted as soon as the editor
		// opens — no helper-button click. The removed helper button would
		// render a script_ai_helper button, the removed back control a
		// script-agent-back testid, the legacy modal a dialog role.
		expect(await findByTestId("copilot-send-btn")).toBeTruthy();
		expect(queryByRole("button", { name: "script_ai_helper" })).toBeNull();
		expect(queryByTestId("script-agent-back")).toBeNull();
		expect(queryByRole("dialog")).toBeNull();
	});

	it("renders the management bar above the shell with no back-to-plain control", async () => {
		const { container, findByText, getByPlaceholderText, getByRole, getByText, queryByTestId } = render(<AgentModeHarness />);
		await openEditor(container, findByText);

		// The AS-8c1 bar above the shell: the name input shows the script
		// name, the kind badge and the save button render alongside it —
		// and there is no back-to-plain control anywhere.
		expect((getByPlaceholderText("script_name") as HTMLInputElement).value).toBe("Test Script");
		expect(getByText("script_kind_prompt")).toBeTruthy();
		expect(getByRole("button", { name: "save" })).toBeTruthy();
		expect(queryByTestId("script-agent-back")).toBeNull();
	});

	it("renders the shell editor with the live draft code", async () => {
		const { container, findByText, findByTestId } = render(<AgentModeHarness />);
		const view = await openEditor(container, findByText);
		replaceCode(view, "AGENT DRAFT");
		await findByTestId("copilot-send-btn");

		// One CodeMirror in the document (the agent pane's): the opaque
		// hostProps share the hook's draft state, not a copy.
		const editors = container.querySelectorAll(".cm-editor");
		expect(editors).toHaveLength(1);
		const agentView = EditorView.findFromDOM(editors[0] as HTMLElement);
		expect(agentView?.state.doc.toString()).toBe("AGENT DRAFT");
	});

	it("keeps the shell mounted across the mobile breakpoint — no second session load", async () => {
		const activeCalls = () =>
			agentModeFetch.mock.calls.filter(([input, init]) =>
				(init?.method ?? "GET").toUpperCase() === "GET" &&
				/\/api\/experience-copilot\/script\/[^/]+\/active$/.test(new URL(String(input), "http://gateway.test").pathname),
			).length;
		try {
			const ui = render(<AgentModeHarness />);
			await openEditor(ui.container, ui.findByText);
			await ui.findByTestId("copilot-send-btn");
			const before = activeCalls();
			expect(before).toBeGreaterThan(0);

			// Cross the breakpoint: the bar moves into the shell's Edit-tab
			// header, the shell itself keeps its tree position. A remount would
			// run the shell's session load again (a second GET …/active).
			mobileState.isMobile = true;
			ui.rerender(<AgentModeHarness />);
			await ui.findByRole("tab", { name: "agent_tab_edit" });
			// Drain the macrotasks a remounted shell's chained session load
			// would need to reach fetch, so a remount cannot slip past the count.
			await act(async () => {
				for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(activeCalls()).toBe(before);
		} finally {
			mobileState.isMobile = false;
		}
	});

	it("returns to the list through the bar's back button on desktop (AS-8c4d)", async () => {
		const { container, findByText, findByTestId, getByRole, queryByTestId } = render(<AgentModeHarness />);
		await openEditor(container, findByText);
		await findByTestId("copilot-send-btn");

		// The back control is the FIRST element of the script bar (the
		// ExperienceEditor back-button shape, label import_back) — there is
		// no header row above the bar. The name is unique on desktop (the
		// shell's mobile chevron renders only with onBack, which desktop
		// never passes), so no bar scoping is needed.
		fireEvent.click(getByRole("button", { name: "import_back" }));

		// Back on the list: the script row shows, the shell is gone.
		expect(await findByText("Test Script")).toBeTruthy();
		await waitFor(() => expect(queryByTestId("copilot-send-btn")).toBeNull());
	});

	it("returns to the list through the shell's tab-row chevron on mobile (AS-8c4d)", async () => {
		try {
			mobileState.isMobile = true;
			const { container, findByText, findByTestId, getByTestId, queryByTestId } = render(<AgentModeHarness />);
			await openEditor(container, findByText);
			await findByTestId("copilot-send-btn");

			// No desktop bar on mobile — back lives in the shell's tab-bar
			// row (the copilot-mobile-back chevron, as in script-agent-host).
			fireEvent.click(getByTestId("copilot-mobile-back"));

			expect(await findByText("Test Script")).toBeTruthy();
			await waitFor(() => expect(queryByTestId("copilot-send-btn")).toBeNull());
		} finally {
			mobileState.isMobile = false;
		}
	});
});

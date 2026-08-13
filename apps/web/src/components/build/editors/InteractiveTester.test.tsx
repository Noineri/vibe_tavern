/**
 * InteractiveTester — IR-81D boundary tests.
 *
 * Boundary under test: the REAL InteractiveTester component (and, for the seam
 * test, the REAL ExperienceEditor + CodeMirror + draft stores) with the
 * network mocked at the tester client-function boundary
 * (runExperienceTest / simulateExperienceTest in api/experience-api.ts) — the
 * kernel is never stubbed; the component under test is real.
 *
 * Pinned behavior (per the IR-81D contract):
 *  1. Discover-only: a valid unsaved rules body shows the validated definition
 *     (manifest id/name, declared capabilities) + projected view + legal
 *     actions; a broken body shows the typed vm_error with the kernel kind.
 *  2. One-action reduce: a legal action shows the next state / events /
 *     effects / console + the bumped revision; an illegal action type shows
 *     illegal_action; a stale expectedRevision shows stale_revision with
 *     currentRevision.
 *  3. Capability: an over-granted capability shows capability_denied with
 *     granted/needs; a declared+granted capability run succeeds and the grant
 *     list reaches the request body.
 *  4. Read-only invariant: running the tester (discover + apply) leaves the
 *     rules draft store and the visual draft store byte-identical.
 *  5. Editor seam: the tester mounts inside ExperienceEditor and drives the
 *     CURRENT UNSAVED buffer (an unsaved CodeMirror edit is what gets sent).
 *
 * Runner: bun:test with scoped happy-dom (one file per process —
 * mock.module() is process-global). Identity i18n (assertion strings are the
 * keys verbatim) and passthrough Tooltip mirror ExperienceEditor.test.tsx;
 * AutoTextarea is stubbed to a plain textarea (the real one sizes via
 * scrollHeight, irrelevant here), mirroring ScriptTester.test.tsx.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChangeEvent, ReactNode } from "react";
import type {
  ExperienceTestRunData,
  ExperienceTestSimulateData,
  ExperienceVisualRow,
  ScriptRecord,
} from "../../../api/types.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";
import { useExperienceVisualDraftStore } from "../../../stores/experience-authoring-store.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

/** A minimal real rules body that passes discovery (register + four mandatory
 *  methods). The network is mocked, so the body is deterministic test data —
 *  its CONTENT never reaches a kernel here; what is pinned is that exactly
 *  this unsaved string is what the tester sends as `rulesCode`. */
const VALID_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'round', name: 'Round' }, capabilities: [{ capability: 'participants' }], create() { return { round: 1, scores: [0] }; }, project(context) { return { round: context.state.round }; }, actions() { return [{ type: 'score' }, { type: 'pass' }]; }, reduce(context) { return { state: context.state, status: 'active', events: [] }; } });";

const SEAM_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'seam', name: 'Seam' }, capabilities: [], create() { return {}; }, project() { return {}; }, actions() { return []; }, reduce(context) { return { state: context.state, status: 'active', events: [] }; } });";

const seamScript: ScriptRecord = {
  id: "srv_seam",
  name: "Seam Rules",
  description: "",
  code: SEAM_CODE,
  scriptKind: "interactive",
  scopeType: "global",
  characterId: null,
  personaId: null,
  chatId: null,
  enabled: false,
  sortOrder: 0,
  defaultVisualId: null,
};

const seamVisual: ExperienceVisualRow = {
  id: "vis_seam",
  name: "Seam Visual",
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

function makeRunData(overrides: Partial<ExperienceTestRunData> = {}): ExperienceTestRunData {
  return {
    definition: {
      apiVersion: 1,
      manifest: { id: "round", name: "Round" },
      declaredCapabilities: [{ capability: "participants", reason: "scores" }],
      hasChoose: false,
      hasFlavor: false,
    },
    sourceHash: "hash_1",
    initialState: { round: 1, scores: [0] },
    finalState: { round: 1, scores: [0] },
    revision: 0,
    status: "active",
    projection: {
      state: { round: 1 },
      actions: [
        { type: "score", label: "Score" },
        { type: "pass", label: "Pass turn" },
      ],
    },
    events: [],
    effects: [],
    console: [],
    steps: [],
    ...overrides,
  };
}

function makeAppliedRunData(): ExperienceTestRunData {
  return makeRunData({
    finalState: { round: 1, scores: [1] },
    revision: 1,
    events: [{ visibility: "public", type: "scored" }],
    effects: [{ kind: "model", request: { prompt: "narrate" } }],
    console: [{ level: "log", args: ["scored one"] }],
    steps: [{
      requestId: "test-req-1",
      actionType: "score",
      replayed: false,
      revision: 1,
      status: "active",
      events: [{ visibility: "public", type: "scored" }],
      effects: [{ kind: "model", request: { prompt: "narrate" } }],
      console: [{ level: "log", args: ["scored one"] }],
    }],
  });
}

function makeSimData(): ExperienceTestSimulateData {
  return {
    ...makeRunData(),
    stopReason: "awaiting_human",
    iterations: 2,
  };
}

// ── Module-boundary mocks (hoisted above the component imports) ─────────────

const runExperienceTest = mock((_body: Record<string, unknown>) => Promise.resolve(makeRunData()));
const simulateExperienceTest = mock((_body: Record<string, unknown>) => Promise.resolve(makeSimData()));
const listExperienceVisuals = mock(() => Promise.resolve<ExperienceVisualRow[]>([]));
const listAllScripts = mock(() => Promise.resolve<ScriptRecord[]>([]));

const realExperienceApi = await import("../../../api/experience-api.js");
const realScriptApi = await import("../../../api/script-api.js");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realAutoTextarea = await import("../../shared/auto-textarea.js");

mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  runExperienceTest,
  simulateExperienceTest,
  listExperienceVisuals,
}));

mock.module("../../../api/script-api.js", () => ({
  ...realScriptApi,
  listAllScripts,
}));

// Identity i18n — assertion strings match the i18n keys verbatim.
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

// AutoTextarea sizes via scrollHeight in a layout effect; irrelevant to the
// logic under test, so stub it to a plain textarea (ScriptTester pattern).
mock.module("../../shared/auto-textarea.js", () => ({
  ...realAutoTextarea,
  AutoTextarea: ({ value, onChange, placeholder }: { value?: string; onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void; placeholder?: string }) => (
    <textarea data-testid="auto-textarea" value={value} onChange={onChange} placeholder={placeholder} />
  ),
}));

const { ExperienceApiError } = realExperienceApi;

let InteractiveTester: typeof import("./InteractiveTester.js").InteractiveTester;
let ExperienceEditor: typeof import("./ExperienceEditor.js").ExperienceEditor;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let EditorView: typeof import("@codemirror/view").EditorView;

beforeAll(async () => {
  ({ act, fireEvent, render, waitFor } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ InteractiveTester } = await import("./InteractiveTester.js"));
  ({ ExperienceEditor } = await import("./ExperienceEditor.js"));
});

beforeEach(() => {
  runExperienceTest.mockClear();
  simulateExperienceTest.mockClear();
  listExperienceVisuals.mockClear();
  listAllScripts.mockClear();
  runExperienceTest.mockImplementation(async () => makeRunData());
  simulateExperienceTest.mockImplementation(async () => makeSimData());
  useScriptDraftStore.getState().resetAll();
  useExperienceVisualDraftStore.getState().resetAll();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderTester(code: string = VALID_CODE) {
  // The tester content is always visible (internal disclosure removed — ER-13 review fix C).
  return render(<InteractiveTester code={code} />);
}

function draftSnapshot(): string {
  return JSON.stringify({
    rules: useScriptDraftStore.getState().drafts,
    visual: useExperienceVisualDraftStore.getState().drafts,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("InteractiveTester", () => {
  it("discover-only: sends the unsaved code with the chosen context and renders the validated definition, projection, and legal actions", async () => {
    const { getByText, findByText } = renderTester();
    fireEvent.click(getByText("experience_tester_run"));

    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    expect(runExperienceTest).toHaveBeenCalledWith({
      rulesCode: VALID_CODE,
      settings: {},
      participants: [{ id: "you", label: "You", controller: "human" }],
      capabilityGrants: [],
      actions: [],
    });

    // Validated definition: manifest name + id + declared capability.
    expect(await findByText("Round")).toBeTruthy();
    expect(await findByText("(round)")).toBeTruthy();
    expect(await findByText("participants")).toBeTruthy();
    // Projected view + legal actions at the created state.
    expect(await findByText("experience_tester_projection")).toBeTruthy();
    expect(await findByText("score")).toBeTruthy();
    expect(await findByText("pass")).toBeTruthy();
    // A discover-only run replays nothing: no steps block.
    expect(runExperienceTest.mock.calls[0]?.[0]).toMatchObject({ actions: [] });
  });

  it("discover-only: a broken rules body renders the typed vm_error with the kernel kind and the captured console", async () => {
    runExperienceTest.mockRejectedValueOnce(new ExperienceApiError(422, "Unexpected token", "vm_error", {
      kind: "syntax",
      console: [{ level: "error", args: ["boom"] }],
    }));
    const { getByText, findByText } = renderTester();
    fireEvent.click(getByText("experience_tester_run"));

    expect(await findByText("vm_error")).toBeTruthy();
    expect(await findByText("syntax")).toBeTruthy();
    expect(await findByText("boom")).toBeTruthy();
  });

  it("one-action reduce: a legal action replays the accumulated list and renders the next state, events, effects, console, and the bumped revision", async () => {
    const { getByText, getByPlaceholderText, findByText } = renderTester();
    fireEvent.click(getByText("experience_tester_run"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockImplementationOnce(async () => makeAppliedRunData());
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "score" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(2));
    expect(runExperienceTest).toHaveBeenLastCalledWith({
      rulesCode: VALID_CODE,
      settings: {},
      participants: [{ id: "you", label: "You", controller: "human" }],
      capabilityGrants: [],
      actions: [{ type: "score", requestId: "test-req-1", expectedRevision: 0 }],
    });

    // Bumped host revision + step trace + transition outputs.
    expect(await findByText("1")).toBeTruthy();
    expect(await findByText("test-req-1")).toBeTruthy();
    expect(await findByText("scored")).toBeTruthy();
    expect(await findByText("model")).toBeTruthy();
    expect(await findByText("scored one")).toBeTruthy();
  });

  it("one-action reduce: an illegal action type renders illegal_action and appends nothing", async () => {
    const { getByText, getByPlaceholderText, findByText } = renderTester();
    fireEvent.click(getByText("experience_tester_run"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockRejectedValueOnce(new ExperienceApiError(422, "Action type is not legal for this viewer", "illegal_action", {}));
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "cheat" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    expect(await findByText("illegal_action")).toBeTruthy();

    // Nothing was appended: the next apply still sends a single-action list.
    runExperienceTest.mockImplementationOnce(async () => makeAppliedRunData());
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "score" } });
    fireEvent.click(getByText("experience_tester_action_apply"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(3));
    expect(runExperienceTest).toHaveBeenLastCalledWith(
      expect.objectContaining({ actions: [{ type: "score", requestId: "test-req-1", expectedRevision: 0 }] }),
    );
  });

  it("one-action reduce: a stale expectedRevision renders stale_revision with the currentRevision", async () => {
    const { getByText, getByPlaceholderText, getByLabelText, findByText } = renderTester();
    fireEvent.click(getByText("experience_tester_run"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockRejectedValueOnce(new ExperienceApiError(409, "Action expected revision 7, run is at 0", "stale_revision", { currentRevision: 3 }));
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "score" } });
    fireEvent.change(getByLabelText("experience_tester_action_expected_revision"), { target: { value: "7" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    expect(await findByText("stale_revision")).toBeTruthy();
    expect(await findByText("3")).toBeTruthy();
  });

  it("capability: a declared+granted capability reaches the request body; an over-granted one renders capability_denied with granted/needs", async () => {
    const { getByText, findByText } = renderTester();
    // Grant the declared capability (Checkbox label = its i18n key under identity t).
    fireEvent.click(getByText("experience_cap_participants"));
    fireEvent.click(getByText("experience_tester_run"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    expect(runExperienceTest).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityGrants: ["participants"] }),
    );
    // The declared+granted run succeeds: the definition renders.
    expect(await findByText("experience_tester_definition")).toBeTruthy();

    // Over-grant: the backend gate rejects with granted/needs.
    runExperienceTest.mockRejectedValueOnce(new ExperienceApiError(422, "Granted capabilities not declared by the rules: model", "capability_denied", {
      granted: ["participants", "model"],
      needs: ["model"],
    }));
    fireEvent.click(getByText("experience_cap_model"));
    fireEvent.click(getByText("experience_tester_run"));
    expect(await findByText("capability_denied")).toBeTruthy();
    expect(await findByText("participants, model")).toBeTruthy();
    expect(await findByText("model")).toBeTruthy();
  });

  it("read-only invariant: discover + apply leave the rules draft store and the visual draft store byte-identical", async () => {
    useScriptDraftStore.getState().ensure(seamScript);
    useScriptDraftStore.getState().patch(seamScript.id, { code: "edited unsaved rules" });
    useExperienceVisualDraftStore.getState().ensure(seamVisual);
    useExperienceVisualDraftStore.getState().patch(seamVisual.id, { source: "edited unsaved visual" });
    const before = draftSnapshot();

    const { getByText, getByPlaceholderText, findByText } = renderTester();
    fireEvent.click(getByText("experience_tester_run"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockImplementationOnce(async () => makeAppliedRunData());
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "score" } });
    fireEvent.click(getByText("experience_tester_action_apply"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(2));
    expect(await findByText("experience_tester_steps")).toBeTruthy();

    // The core safety property: every authoring draft is byte-identical.
    expect(draftSnapshot()).toBe(before);
    expect(useScriptDraftStore.getState().drafts[seamScript.id]?.values.code).toBe("edited unsaved rules");
    expect(useExperienceVisualDraftStore.getState().drafts[seamVisual.id]?.values.source).toBe("edited unsaved visual");
  });

  it("simulate: auto-advance sends the same context and renders the typed stop reason", async () => {
    const { getByText, findByText } = renderTester();
    fireEvent.click(getByText("experience_tester_simulate"));

    await waitFor(() => expect(simulateExperienceTest).toHaveBeenCalledTimes(1));
    expect(simulateExperienceTest).toHaveBeenCalledWith({
      rulesCode: VALID_CODE,
      settings: {},
      participants: [{ id: "you", label: "You", controller: "human" }],
      capabilityGrants: [],
    });
    expect(await findByText("awaiting_human")).toBeTruthy();
    expect(await findByText("2")).toBeTruthy();
    // Simulate never replays author actions and never calls run.
    expect(runExperienceTest).not.toHaveBeenCalled();
  });

  it("editor seam: mounts inside ExperienceEditor and drives the CURRENT UNSAVED buffer", async () => {
    listAllScripts.mockImplementation(async () => [{ ...seamScript }]);
    const { container, findByText, getByTestId, getByText } = render(<ExperienceEditor />);

    // Open the existing interactive script from the list.
    fireEvent.click(await findByText("Seam Rules"));

    // Make an UNSAVED edit in the real rules CodeMirror (index 0 = rules).
    let rulesView: import("@codemirror/view").EditorView | null = null;
    await waitFor(() => {
      const dom = container.querySelector(".cm-editor");
      if (!(dom instanceof HTMLElement)) throw new Error("cm-editor not mounted");
      const found = EditorView.findFromDOM(dom);
      if (!found) throw new Error("EditorView not found");
      rulesView = found;
    });
    if (rulesView === null) throw new Error("unreachable");
    const view: import("@codemirror/view").EditorView = rulesView;
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: `${SEAM_CODE}\n// unsaved edit` } });
    });

    // The tester lives in the shell's tester modal (ER-13b′); open it. Its
    // content is always visible (internal disclosure removed — ER-13 review fix C).
    fireEvent.click(getByTestId("copilot-toolbar-tester"));
    fireEvent.click(getByText("experience_tester_run"));

    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    expect(runExperienceTest.mock.calls[0]?.[0]).toMatchObject({
      rulesCode: `${SEAM_CODE}\n// unsaved edit`,
      actions: [],
    });
    expect(await findByText("experience_tester_definition")).toBeTruthy();
  });
});

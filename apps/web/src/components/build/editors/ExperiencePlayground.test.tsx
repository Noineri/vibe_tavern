/**
 * ExperiencePlayground — IR-84B boundary tests.
 *
 * Boundary under test: the REAL ExperiencePlayground component (and, for the
 * seam test, the REAL ExperienceEditor + CodeMirror + draft stores) with the
 * network mocked at the playground client-function boundary
 * (startExperiencePlayground / advanceExperiencePlayground in
 * api/experience-api.ts) — the IR-84A driver and the kernel are never
 * stubbed; the component under test is real.
 *
 * Pinned behavior (per the IR-84B contract):
 *  1. Start: picking a human seat and starting sends the unsaved rules +
 *     roster + humanSeatId and renders the validated definition, the initial
 *     projection, the legal actions for the human seat, and the boundary
 *     stop-reason; a broken rules body renders the typed vm_error + kind.
 *  2. Drive: a legal action advances the turn (bumped revision, this turn's
 *     events incl. the script-seat moves, reported effects, console); an
 *     illegal action type renders illegal_action; a stale expectedRevision
 *     renders stale_revision + currentRevision; a duplicated requestId
 *     replays without advancing the revision.
 *  3. Model-seat stub: an awaiting_model boundary renders as informational
 *     (never an error) and no advance/provider path is invoked.
 *  4. Read-only invariant: a full start → advance → reset cycle leaves the
 *     rules draft store and the visual draft store byte-identical.
 *  5. Frame isolation: the visual renders inside the isolated ExperienceFrame
 *     (sandbox="allow-scripts" WITHOUT allow-same-origin; the blob document
 *     carries the real visual source) and reset tears the frame down
 *     (iframe removed, blob URL revoked).
 *  6. Editor seam: the playground mounts inside ExperienceEditor and drives
 *     the CURRENT UNSAVED rules buffer.
 *
 * Runner: bun:test with scoped happy-dom (one file per process —
 * mock.module() is process-global). Identity i18n (assertion strings are the
 * keys verbatim) and passthrough Tooltip mirror InteractiveTester.test.tsx;
 * AutoTextarea is stubbed to a plain textarea. The blob-URL spy pattern
 * mirrors ExperienceFrame.test.tsx (happy-dom must not navigate the iframe).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChangeEvent, ReactNode } from "react";
import type { ExperienceSetupFieldDto } from "@vibe-tavern/api-contracts";
import type { RenderResult } from "@testing-library/react";
import type {
  ExperiencePlaygroundData,
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
 *  methods + choose). The network is mocked, so the body is deterministic test
 *  data — its CONTENT never reaches a kernel here; what is pinned is that
 *  exactly this unsaved string is what the playground sends as `rulesCode`. */
const VALID_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'round', name: 'Round' }, capabilities: [{ capability: 'participants' }], create() { return { round: 1, scores: [0] }; }, project(context) { return { round: context.state.round }; }, actions() { return [{ type: 'score' }, { type: 'pass' }]; }, choose(context) { return context.legal[0]; }, reduce(context) { return { state: context.state, status: 'active', events: [] }; } });";

const SEAM_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'seam', name: 'Seam' }, capabilities: [], create() { return {}; }, project() { return {}; }, actions() { return []; }, reduce(context) { return { state: context.state, status: 'active', events: [] }; } });";

const VISUAL_SOURCE = "<div id=\"game\">hello</div>\n<script>document.getElementById('game').textContent='v';</script>";

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
  copilotProfileId: null,
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

/** The start envelope (definition present). Distinctive revision numbers
 *  (0 → 41) keep revision assertions unambiguous in the rendered DOM. */
function makeStartData(overrides: Partial<ExperiencePlaygroundData> = {}): ExperiencePlaygroundData {
  return {
    playgroundSessionId: "pg-session-1",
    definition: {
      apiVersion: 1,
      manifest: { id: "round", name: "Round", mode: "turn" },
      declaredCapabilities: [{ capability: "participants", reason: "scores" }],
      hasChoose: true,
      hasFlavor: false,
    },
    initialState: { round: 1, scores: [0] },
    state: { round: 1, scores: [0] },
    projection: {
      state: { round: 1 },
      actions: [
        { type: "score", label: "Score" },
        { type: "pass", label: "Pass turn" },
      ],
    },
    events: [],
    effects: [],
    pendingTimers: 0,
    console: [],
    revision: 0,
    status: "active",
    stopReason: "awaiting_human",
    ...overrides,
  };
}

/** The advance envelope (definition OMITTED, matching the driver): the human
 *  reduce plus the script-seat moves that followed it this turn. */
function makeAdvanceData(overrides: Partial<ExperiencePlaygroundData> = {}): ExperiencePlaygroundData {
  return {
    playgroundSessionId: "pg-session-1",
    initialState: { round: 1, scores: [0] },
    state: { round: 2, scores: [1, 1] },
    projection: {
      state: { round: 2 },
      actions: [
        { type: "score", label: "Score" },
        { type: "pass", label: "Pass turn" },
      ],
    },
    events: [
      { visibility: "public", type: "scored" },
      { visibility: "public", type: "dealer_drew" },
    ],
    effects: [{ kind: "model", request: { prompt: "narrate" } }],
    pendingTimers: 0,
    console: [{ level: "log", args: ["scored one"] }],
    revision: 41,
    status: "active",
    stopReason: "awaiting_human",
    ...overrides,
  };
}

// ── Module-boundary mocks (hoisted above the component imports) ─────────────

const startExperiencePlayground = mock((_body: Record<string, unknown>) => Promise.resolve(makeStartData()));
const runExperiencePlaygroundTimer = mock((_body: { playgroundSessionId: string }) => Promise.resolve(makeAdvanceData()));
const advanceExperiencePlayground = mock((_body: Record<string, unknown>) => Promise.resolve(makeAdvanceData()));
const simulateExperienceTest = mock((_body: Record<string, unknown>) => Promise.resolve(makeSimData()));
const listExperienceVisuals = mock(() => Promise.resolve<ExperienceVisualRow[]>([]));
const listAllScripts = mock(() => Promise.resolve<ScriptRecord[]>([]));
const listProviderProfiles = mock(() => Promise.resolve([{ id: "pp_test", name: "Test Provider", providerPreset: "openai", defaultModel: "gpt-test" }]));
const fetchProviderProfileModels = mock((_id: string) => Promise.resolve({ models: [{ id: "gpt-test", label: "GPT Test" }] }));

// IR-90E: mock runExperienceTest for the auto-derive discovery. By default it
// rejects (no definition discovered → default single human seat preserved).
// Individual tests override it to return a real definition.
// Explicit return type avoids TS2322: Promise.reject infers Promise<never>,
// which rejects later mockImplementation calls returning Promise<ExperienceTestRunData>.
const runExperienceTest = mock(
  (_body: Record<string, unknown>): Promise<ExperienceTestRunData> =>
    Promise.reject(new Error("mock not configured")),
);

const realExperienceApi = await import("../../../api/experience-api.js");
const realScriptApi = await import("../../../api/script-api.js");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realAutoTextarea = await import("../../shared/auto-textarea.js");

/** Shared discovery mock for auto-derive tests (the model_conversation shape). */
function makeTestRunData(): ExperienceTestRunData {
  return {
          definition: {
            apiVersion: 1,
            manifest: { id: "model_conversation", name: "Model Conversation", mode: "turn" },
            declaredCapabilities: [
              { capability: "participants", reason: "human and model seats" },
              { capability: "model", reason: "AI replies" },
            ],
            hasChoose: false,
            hasFlavor: false,
          },
          sourceHash: "abc",
          initialState: { messages: [], turn: 0 },
          finalState: { messages: [], turn: 0 },
          revision: 0,
          status: "active" as const,
          projection: { state: { messages: [], turn: 0 }, actions: [] },
          events: [],
          effects: [],
          console: [],
          steps: [],
  } as ExperienceTestRunData;
}

/** XU-4: a create-only discover result (the absorbed tester's run shape): a
 *  minimal "Round" definition with score/pass legal actions. */
function makeDiscoverData(overrides: Partial<ExperienceTestRunData> = {}): ExperienceTestRunData {
  return {
    definition: {
      apiVersion: 1,
      manifest: { id: "round", name: "Round", mode: "turn" },
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

/** XU-4: a bounded-simulation result (the absorbed tester's simulate shape). */
function makeSimData(overrides: Partial<ExperienceTestSimulateData> = {}): ExperienceTestSimulateData {
  return {
    ...makeDiscoverData(),
    stopReason: "awaiting_human",
    iterations: 2,
    ...overrides,
  };
}

mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  startExperiencePlayground,
  advanceExperiencePlayground,
  runExperiencePlaygroundTimer,
  runExperienceTest,
  simulateExperienceTest,
  listExperienceVisuals,
}));

const realProviderApi = await import("../../../api/provider-api.js");
mock.module("../../../api/provider-api.js", () => ({
  ...realProviderApi,
  listProviderProfiles,
  fetchProviderProfileModels,
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

let ExperiencePlayground: typeof import("./ExperiencePlayground.js").ExperiencePlayground;
let ExperienceEditor: typeof import("./ExperienceEditor.js").ExperienceEditor;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let EditorView: typeof import("@codemirror/view").EditorView;

beforeAll(async () => {
  ({ act, fireEvent, render, waitFor } = await import("@testing-library/react"));
  ({ EditorView } = await import("@codemirror/view"));
  ({ ExperiencePlayground } = await import("./ExperiencePlayground.js"));
  ({ ExperienceEditor } = await import("./ExperienceEditor.js"));
});

beforeEach(() => {
  startExperiencePlayground.mockClear();
  advanceExperiencePlayground.mockClear();
  runExperiencePlaygroundTimer.mockClear();
  simulateExperienceTest.mockClear();
  listExperienceVisuals.mockClear();
  listAllScripts.mockClear();
  listProviderProfiles.mockClear();
  fetchProviderProfileModels.mockClear();
  runExperienceTest.mockClear();
  runExperienceTest.mockImplementation(async () => Promise.reject(new Error("mock not configured")));
  simulateExperienceTest.mockImplementation(async () => makeSimData());
  startExperiencePlayground.mockImplementation(async () => makeStartData());
  advanceExperiencePlayground.mockImplementation(async () => makeAdvanceData());
  useScriptDraftStore.getState().resetAll();
  useExperienceVisualDraftStore.getState().resetAll();
  createdBlobs.length = 0;
  revokedUrls.length = 0;
  restoreUrl();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderPlayground(
  code: string = VALID_CODE,
  visualSource: string | null = null,
  props: { scriptId?: string } = {},
) {
  const utils = render(<ExperiencePlayground code={code} visualSource={visualSource} {...props} />);
  return utils;
}

function draftSnapshot(): string {
  return JSON.stringify({
    rules: useScriptDraftStore.getState().drafts,
    visual: useExperienceVisualDraftStore.getState().drafts,
  });
}

/** Open a DropdownSelect (by its trigger showing `triggerText`) and pick the
 *  item whose text matches `optionLabel` (cmdk items live in a portal; matched
 *  by textContent). Mirrors the ExperienceSetupModal.test helper. */
async function pickDropdown(view: RenderResult, scope: ParentNode, triggerText: string, optionLabel: string): Promise<void> {
  const trigger = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === triggerText,
  ) as HTMLButtonElement | undefined;
  if (!trigger) throw new Error(`no dropdown trigger "${triggerText}"`);
  fireEvent.click(trigger);
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
  const item = [...view.baseElement.querySelectorAll("[cmdk-item]")].find(
    (i) => i.textContent?.trim() === optionLabel,
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`no cmdk item "${optionLabel}"`);
  fireEvent.click(item);
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull());
}

/** Expand the collapsed Developer diagnostics disclosure so raw state/actions/
 *  events/effects/console are reachable in assertions (IR-90E collapsed default). */
function expandDiagnostics(utils: { getByText: (text: string) => HTMLElement }): void {
  fireEvent.click(utils.getByText("experience_playground_diagnostics"));
}

// ── Blob-URL spies (ExperienceFrame.test pattern: happy-dom must not navigate) ─

const createdBlobs: Blob[] = [];
const revokedUrls: string[] = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

function installUrlSpies() {
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    createdBlobs.push(blob);
    return `about:blank#blob-${n++}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
}

function restoreUrl() {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ExperiencePlayground", () => {
  it("start: picking a human seat and starting sends the unsaved rules + roster + seat and renders the definition, projection, legal actions, and stop-reason", async () => {
    const utils = renderPlayground();
    const { container, getByText, getByRole, getAllByPlaceholderText, findByText } = utils;

    // Add a second human seat and pick it as the driven seat. The seat id is
    // now auto-generated from the name (XU-1): typing "Alice" yields id
    // "alice" without a separate id field.
    fireEvent.click(getByText("experience_setup_add_participant"));
    const labelInputs = getAllByPlaceholderText("experience_setup_participant_name_placeholder");
    fireEvent.change(labelInputs[1]!, { target: { value: "Alice" } });
    // XU-2: "Random start" is ON by default (fresh config); turn it OFF so the
    // manual (empty) seed path is exercised — the deterministic-default
    // boundary this test pins.
    fireEvent.click(getByRole("switch"));
    await pickDropdown(utils, container, "experience_playground_human_seat_auto", "Alice (experience_playground_role_short_human)");

    fireEvent.click(getByText("experience_playground_start"));

    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground).toHaveBeenCalledWith({
      rulesCode: VALID_CODE,
      settings: {},
      participants: [
        { id: "you", label: "You", controller: "human" },
        { id: "alice", label: "Alice", controller: "human" },
      ],
      capabilityGrants: [],
      humanSeatId: "alice",
    });

    // Validated definition + initial projection + legal actions + boundary.
    // Legal actions + turn title are in the novice view; definition/projection/
    // stop-reason are behind the collapsed Developer diagnostics (IR-90E).
    expect(await findByText("experience_playground_turn_title")).toBeTruthy();
    expect(await findByText("Score")).toBeTruthy();
    expect(await findByText("Pass turn")).toBeTruthy();
    expandDiagnostics(utils);
    expect(await findByText("Round")).toBeTruthy();
    expect(await findByText("(round)")).toBeTruthy();
    expect(await findByText("participants")).toBeTruthy();
    expect(await findByText("experience_tester_projection")).toBeTruthy();
    expect(await findByText("awaiting_human")).toBeTruthy();
    // No provider/model path is involved in a start.
    expect(advanceExperiencePlayground).not.toHaveBeenCalled();
  });

  it("start: a broken rules body renders the typed vm_error with the kernel kind and the captured console", async () => {
    startExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(422, "Unexpected token", "vm_error", {
      kind: "syntax",
      console: [{ level: "error", args: ["boom"] }],
    }));
    const { getByText, findByText, queryByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));

    // XU-3: the human first line renders immediately; the technical fields
    // (code/kind/console) sit behind the closed-by-default "Technical details"
    // disclosure.
    expect(await findByText("Unexpected token")).toBeTruthy();
    expect(queryByText("vm_error")).toBeNull();
    expect(queryByText("syntax")).toBeNull();

    fireEvent.click(getByText("experience_playground_error_tech_details"));
    expect(await findByText("vm_error")).toBeTruthy();
    expect(await findByText("syntax")).toBeTruthy();
    expect(await findByText("boom")).toBeTruthy();
  });

  it("drive: a legal action advances the turn and renders the bumped revision, the script-seat moves, reported effects, and console", async () => {
    const utils = renderPlayground();
    const { getByText, findByText } = utils;
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    fireEvent.click(getByText("Score"));

    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(advanceExperiencePlayground).toHaveBeenCalledWith({
      playgroundSessionId: "pg-session-1",
      humanAction: { type: "score", requestId: "pg-req-1", expectedRevision: 0 },
    });

    // Bumped revision + this turn's events (the human reduce AND the
    // script-seat move that followed it) + reported effects + console.
    // These are in the collapsed Developer diagnostics (IR-90E).
    expandDiagnostics(utils);
    expect(await findByText("41")).toBeTruthy();
    expect(await findByText("scored")).toBeTruthy();
    expect(await findByText("dealer_drew")).toBeTruthy();
    expect(await findByText("model")).toBeTruthy();
    expect(await findByText("scored one")).toBeTruthy();
  });

  it("drive: an illegal action type renders illegal_action and the session keeps the prior state", async () => {
    const utils = renderPlayground();
    const { getByText, getByPlaceholderText, findByText } = utils;
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // The custom action form is inside the collapsed Developer diagnostics.
    expandDiagnostics(utils);
    advanceExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(422, "Action type is not legal for this viewer", "illegal_action", {}));
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "cheat" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    // XU-3: the human message renders first; the error code sits behind the
    // closed "Technical details" disclosure.
    expect(await findByText("Action type is not legal for this viewer")).toBeTruthy();
    expect(advanceExperiencePlayground).toHaveBeenCalledWith({
      playgroundSessionId: "pg-session-1",
      humanAction: { type: "cheat", requestId: "pg-req-1", expectedRevision: 0 },
    });
    fireEvent.click(getByText("experience_playground_error_tech_details"));
    expect(await findByText("illegal_action")).toBeTruthy();
    // The pre-action projection is still the rendered one (revision 0).
    expect(await findByText("experience_tester_projection")).toBeTruthy();
  });

  it("drive: a stale expectedRevision renders stale_revision with the currentRevision", async () => {
    const utils = renderPlayground();
    const { getByText, getByPlaceholderText, getByLabelText, findByText } = utils;
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // The custom action form is inside the collapsed Developer diagnostics.
    expandDiagnostics(utils);
    advanceExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(409, "Action expected revision 7, session is at 0", "stale_revision", { currentRevision: 3 }));
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "score" } });
    fireEvent.change(getByLabelText("experience_tester_action_expected_revision"), { target: { value: "7" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    // XU-3: the error code + current revision sit behind the closed "Technical
    // details" disclosure.
    expect(await findByText("Action expected revision 7, session is at 0")).toBeTruthy();
    fireEvent.click(getByText("experience_playground_error_tech_details"));
    expect(await findByText("stale_revision")).toBeTruthy();
    expect(await findByText("3")).toBeTruthy();
  });

  it("drive: a duplicated requestId replays without advancing the rendered revision", async () => {
    const utils = renderPlayground();
    const { getByText, getByLabelText, findByText, queryByText } = utils;
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // Turn 1: the legal action advances 0 → 41.
    fireEvent.click(getByText("Score"));
    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(1));
    // The revision lives in the collapsed Developer diagnostics.
    expandDiagnostics(utils);
    expect(await findByText("41")).toBeTruthy();

    // A retried duplicate carries the ORIGINAL requestId + expectedRevision
    // (idempotency precedes CAS server-side); the driver replays the prior
    // step, so the envelope comes back at the SAME revision.
    fireEvent.change(getByLabelText("experience_tester_action_request_id"), { target: { value: "pg-req-1" } });
    fireEvent.change(getByLabelText("experience_tester_action_expected_revision"), { target: { value: "0" } });
    fireEvent.click(getByText("Score"));

    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(2));
    expect(advanceExperiencePlayground.mock.calls[0]?.[0]).toMatchObject({ humanAction: { requestId: "pg-req-1", expectedRevision: 0 } });
    expect(advanceExperiencePlayground.mock.calls[1]?.[0]).toMatchObject({ humanAction: { requestId: "pg-req-1", expectedRevision: 0 } });
    // Replayed: the rendered revision is still 41, never 42.
    expect(await findByText("41")).toBeTruthy();
    expect(queryByText("42")).toBeNull();
  });

  it("model-seat boundary: an awaiting_model boundary renders the ordinary-language status, never an error, and no advance/provider call is invoked directly by the client", async () => {
    startExperiencePlayground.mockImplementationOnce(async () => makeStartData({ stopReason: "awaiting_model" }));
    const { getByText, findByText, queryByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));

    // The ordinary-language status shows “Model is responding…” (the adapter
    // transparently drives the model turn; the client never invokes advance
    // for a model seat itself).
    expect(await findByText("experience_playground_status_model")).toBeTruthy();
    // Informational only: no error block, and no advance/provider call.
    expect(queryByText("experience_playground_error_title")).toBeNull();
    expect(advanceExperiencePlayground).not.toHaveBeenCalled();
  });

  it("read-only invariant: a full start → advance → reset cycle leaves the rules and visual draft stores byte-identical", async () => {
    useScriptDraftStore.getState().ensure(seamScript);
    useScriptDraftStore.getState().patch(seamScript.id, { code: "edited unsaved rules" });
    useExperienceVisualDraftStore.getState().ensure(seamVisual);
    useExperienceVisualDraftStore.getState().patch(seamVisual.id, { source: "edited unsaved visual" });
    const before = draftSnapshot();

    const utils = renderPlayground();
    const { getByText, queryByText } = utils;
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    fireEvent.click(getByText("Score"));
    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(1));
    // After reset, the turn section (novice view) is gone.
    fireEvent.click(getByText("experience_playground_reset"));
    await waitFor(() => expect(queryByText("experience_playground_turn_title")).toBeNull());

    // The core safety property: every authoring draft is byte-identical.
    expect(draftSnapshot()).toBe(before);
    expect(useScriptDraftStore.getState().drafts[seamScript.id]?.values.code).toBe("edited unsaved rules");
    expect(useExperienceVisualDraftStore.getState().drafts[seamVisual.id]?.values.source).toBe("edited unsaved visual");
  });

  it("frame isolation: the visual renders inside the isolated ExperienceFrame and reset tears it down without leaking", async () => {
    installUrlSpies();
    const { container, getByText, findByText } = renderPlayground(VALID_CODE, VISUAL_SOURCE);
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(await findByText("experience_playground_visual_label")).toBeTruthy();

    // The iframe is the opaque-origin sandbox: allow-scripts WITHOUT
    // allow-same-origin.
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");

    // The blob document handed TO the frame carries the REAL visual source
    // (state reaches the frame through the bridge; the host DOM only holds
    // the sandboxed iframe element).
    expect(createdBlobs.length).toBe(1);
    const doc = await createdBlobs[0]!.text();
    expect(doc).toContain(VISUAL_SOURCE.split("\n")[0]!);
    expect(doc).toContain("Content-Security-Policy");

    // Reset tears the frame down: iframe removed, blob URL revoked.
    fireEvent.click(getByText("experience_playground_reset"));
    await waitFor(() => expect(container.querySelector("iframe")).toBeNull());
    expect(revokedUrls.length).toBe(1);
  });

  it("editor seam: mounts inside ExperienceEditor and drives the CURRENT UNSAVED buffer", async () => {
    listAllScripts.mockImplementation(async () => [{ ...seamScript }]);
    const { container, findByText, getByText } = render(<ExperienceEditor />);

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

    // ER-13 moved the playground out of the inline IR-84B seam into the
    // copilot shell; XU-6 unified the tabs, so it now lives inline under the
    // "Try it" tab (the "Test it" toolbar modal is gone). Switch to the tab
    // first, then the playground's start button is reachable inside it. (The
    // boundary pinned here is unchanged: the playground still drives the
    // CURRENT UNSAVED rules buffer that the editor owns.)
    fireEvent.click(getByText("experience_copilot_try_it"));
    fireEvent.click(getByText("experience_playground_start"));

    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground.mock.calls[0]?.[0]).toMatchObject({
      rulesCode: `${SEAM_CODE}\n// unsaved edit`,
    });
    expect(await findByText("experience_playground_turn_title")).toBeTruthy();
    // No visual is selected in this fixture: the frame stays hidden.
    expect(await findByText("experience_playground_no_visual")).toBeTruthy();
  });

  // IR-90A: the roster row must keep every control inside the panel at narrow
  // widths and with long (RU) labels — no horizontal overflow, no clipped
  // placeholder. happy-dom has no layout engine, so this pins the STRUCTURAL
  // contract that guarantees it: the row wraps (flex-wrap) and the flexible
  // label input carries a min-width floor (it wraps to a usable line instead
  // of shrinking to a clipped sliver). A best-effort scrollWidth<=clientWidth
  // check is included for any layout-capable runner.
  it("roster rows wrap at narrow widths with long RU labels (no overflow, seed visible)", async () => {
    document.body.style.width = "320px";
    const { container, getByText, getAllByPlaceholderText } = renderPlayground();

    // Add two more participants and give them long Cyrillic (RU) labels.
    fireEvent.click(getByText("experience_setup_add_participant"));
    fireEvent.click(getByText("experience_setup_add_participant"));
    const labelInputs = getAllByPlaceholderText("experience_setup_participant_name_placeholder");
    fireEvent.change(labelInputs[1]!, { target: { value: "Управляемый моделью дилер" } });
    fireEvent.change(labelInputs[2]!, { target: { value: "Очень длинное имя участника" } });

    // XU-1: the id moved out of the row (now a muted "ID: …" line under the
    // card), so the wrap contract is pinned on the NAME input's flex-wrap row.
    const nameInputs = container.querySelectorAll('input[placeholder="experience_setup_participant_name_placeholder"]');
    expect(nameInputs.length).toBeGreaterThanOrEqual(3);
    nameInputs.forEach((nameInput) => {
      const row = nameInput.parentElement;
      if (!row) throw new Error("roster card row missing");
      const rowCls = row.getAttribute("class") ?? "";
      expect(rowCls).toContain("flex-wrap");
      expect(nameInput.getAttribute("class") ?? "").toContain("min-w-[7rem]");
      // Best-effort layout boundary: under happy-dom these are 0/0 (no layout);
      // a layout-capable runner would report the real overflow — either way the
      // wrapped row never scrolls past its container.
      const sw = row.scrollWidth;
      const cw = row.clientWidth;
      if (typeof sw === "number" && typeof cw === "number") {
        expect(sw <= cw).toBe(true);
      }
    });

    // The seed input is rendered and stays in the layout (never clipped out).
    // Random start defaults ON in this fixture, so the placeholder is the
    // "random on every launch" key (the OFF placeholder only shows after the
    // toggle is switched).
    const seedInput = container.querySelector('input[placeholder="experience_playground_seed_random_on"]') as HTMLInputElement | null;
    expect(seedInput).not.toBeNull();
    expect(seedInput!.offsetParent === null ? true : seedInput!.parentElement?.contains(seedInput)).toBe(true);

    document.body.style.width = "";
  });

  // IR-90E: the UNCHANGED shipped Model Conversation rules + Conversation visual
  // pair is playable in the authoring playground with auto-derived setup.
  // Discovery is mocked BEFORE render; on mount the starter's
  // declared capabilities auto-populate human+model seats and grants. The
  // author then ONLY selects provider + model for the model seat — no manual
  // capability checking, seat adding, or controller changing. This test asserts
  // the REAL component flow: auto-derive → provider/model select → start (body
  // carries derived seats/grants + pinned ids) → reply/model turn → finish.
  // The API is mocked at the client-function boundary.
  it("IR-90E: Model Conversation + Conversation pair — auto-derive, provider/model select, reply, model turn, finish", async () => {
    const { getRulesStarter } = await import("../../../lib/experience-rules-starters.js");
    const { CONVERSATION_VISUAL_SOURCE } = await import("../../experience/starters/conversation.js");
    const STARTER = getRulesStarter("model_conversation")!;

    // ── Step 0: configure discovery mock BEFORE render ──
    // The starter declares participants + model; auto-derive reads this to
    // populate seats and grants without user action.
    runExperienceTest.mockImplementation(async () => ({
      definition: {
        apiVersion: 1,
        manifest: { id: "model_conversation", name: "Model Conversation", mode: "turn" },
        declaredCapabilities: [
          { capability: "participants", reason: "human and model seats" },
          { capability: "model", reason: "AI replies" },
        ],
        hasChoose: false,
        hasFlavor: false,
      },
      sourceHash: "abc",
      initialState: { messages: [], turn: 0 },
      finalState: { messages: [], turn: 0 },
      revision: 0,
      status: "active" as const,
      projection: { state: { messages: [], turn: 0 }, actions: [] },
      events: [],
      effects: [],
      console: [],
      steps: [],
    }));

    // Start: initial state with reply + finish actions.
    startExperiencePlayground.mockImplementation(async () => ({
      playgroundSessionId: "pg-mc-1",
      definition: {
        apiVersion: 1,
        manifest: { id: "model_conversation", name: "Model Conversation", mode: "turn" },
        declaredCapabilities: [{ capability: "participants", reason: "seats" }, { capability: "model", reason: "replies" }],
        hasChoose: false,
        hasFlavor: false,
      },
      initialState: { messages: [], turn: 0 },
      state: { messages: [], turn: 0 },
      projection: {
        state: { messages: [], turn: 0 },
        actions: [
          { type: "reply", label: "Reply", allowsText: true },
          { type: "finish", label: "Finish" },
        ],
      },
      events: [],
      effects: [],
      pendingTimers: 0,
      console: [],
      revision: 0,
      status: "active",
      stopReason: "awaiting_human",
    }));

    // Advance: simulates the adapter chaining the model turn.
    let advanceCount = 0;
    advanceExperiencePlayground.mockImplementation(async (body: Record<string, unknown>) => {
      advanceCount += 1;
      const humanAction = body.humanAction as { type: string; payload?: { text?: string } };
      if (humanAction.type === "finish") {
        return {
          playgroundSessionId: "pg-mc-1",
          initialState: { messages: [], turn: 0 },
          state: { messages: [{ from: "you", text: "Hello!" }, { from: "them", text: "Hi there!" }], turn: 2 },
          projection: { state: { messages: [{ from: "you", text: "Hello!" }, { from: "them", text: "Hi there!" }], turn: 2 }, actions: [] },
          events: [{ visibility: "public", type: "finished" }],
          effects: [],
          pendingTimers: 0,
          console: [],
          revision: 3,
          status: "completed",
          stopReason: "completed",
        };
      }
      return {
        playgroundSessionId: "pg-mc-1",
        initialState: { messages: [], turn: 0 },
        state: { messages: [{ from: "you", text: "Hello!" }, { from: "them", text: "Hi there!" }], turn: 2 },
        projection: {
          state: { messages: [{ from: "you", text: "Hello!" }, { from: "them", text: "Hi there!" }], turn: 2 },
          actions: [{ type: "reply", label: "Reply", allowsText: true }, { type: "finish", label: "Finish" }],
        },
        events: [{ visibility: "public", type: "user_replied" }, { visibility: "public", type: "model_replied" }],
        effects: [],
        pendingTimers: 0,
        console: [],
        revision: 2,
        status: "active",
        stopReason: "awaiting_human",
      };
    });

    installUrlSpies();
    const utils = render(<ExperiencePlayground code={STARTER.source} visualSource={CONVERSATION_VISUAL_SOURCE} />);
    const { container, getByText, findByText } = utils;

    // ── Step 1: wait for auto-derive (effect fires on mount) ──
    // The discovery mock returns participants + model → seats and grants
    // are populated WITHOUT any manual clicks.
    await waitFor(() => {
      const seatIds = container.querySelectorAll('[data-testid="playground-seat-id"]');
      expect(seatIds.length).toBe(2);
    });
    expect(runExperienceTest).toHaveBeenCalledTimes(1);

    // Verify auto-derived roster: human seat "you" + model seat "ai".
    const seatIds = container.querySelectorAll('[data-testid="playground-seat-id"]');
    expect(seatIds[0]?.textContent).toBe("you");
    expect(seatIds[1]?.textContent).toBe("ai");

    // ── Step 2: ONLY select provider + model on the model seat ──
    // No manual capability toggles, no "add participant" click, no controller
    // change — those are all auto-derived.
    await pickDropdown(utils, container, "experience_setup_provider_placeholder", "Test Provider");
    await pickDropdown(utils, container, "experience_setup_model_placeholder", "GPT Test");

    // ── Step 3: start the ephemeral session ──
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // Assert the start body carries auto-derived seats + grants AND the pinned
    // provider/model ids selected above.
    const startCall = startExperiencePlayground.mock.calls[0]?.[0] as Record<string, unknown>;
    const sentParticipants = startCall.participants as Array<Record<string, unknown>>;
    expect(sentParticipants).toHaveLength(2);
    const humanParticipant = sentParticipants.find((p) => p.controller === "human");
    expect(humanParticipant).toMatchObject({ id: "you" });
    const modelParticipant = sentParticipants.find((p) => p.controller === "model");
    expect(modelParticipant).toMatchObject({ id: "ai", providerProfileId: "pp_test", modelId: "gpt-test" });
    expect(startCall.capabilityGrants).toEqual(["participants", "model"]);

    // ── Step 4: verify the visual iframe + legal actions + status ──
    expect(await findByText("experience_playground_visual_label")).toBeTruthy();
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe!.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(createdBlobs.length).toBeGreaterThanOrEqual(1);
    const doc = await createdBlobs[createdBlobs.length - 1]!.text();
    expect(doc).toContain("xp-conv");

    expect(await findByText("experience_playground_status_your_turn")).toBeTruthy();
    expect(await findByText("experience_playground_turn_title")).toBeTruthy();
    expect(getByText("Reply")).toBeTruthy();
    expect(getByText("Finish")).toBeTruthy();

    // ── Step 5: reply → adapter chains model turn transparently ──
    fireEvent.click(getByText("Reply"));
    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(await findByText("experience_playground_status_your_turn")).toBeTruthy();
    expect(advanceCount).toBe(1);

    // ── Step 6: finish ──
    fireEvent.click(getByText("Finish"));
    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(2));
    expect(await findByText("experience_playground_status_completed")).toBeTruthy();
  });

  // IR-90E blocker-1: the unchanged shipped Model Conversation starter
  // auto-derives a usable human+model roster and grants WITHOUT the user
  // manually creating seats or checking raw capability checkboxes. Discovery
  // uses the REAL runExperienceTest API (not brittle display-text parsing).
  it("IR-90E: auto-derive — Model Conversation starter opens with human+model seats and grants pre-configured", async () => {
    // Mock runExperienceTest to return a definition declaring participants + model.
    runExperienceTest.mockImplementation(async () => ({
      definition: {
        apiVersion: 1,
        manifest: { id: "model_conversation", name: "Model Conversation", mode: "turn" },
        declaredCapabilities: [
          { capability: "participants", reason: "human and model seats" },
          { capability: "model", reason: "AI-driven conversation replies" },
        ],
        hasChoose: false,
        hasFlavor: false,
      },
      sourceHash: "abc",
      initialState: { messages: [], turn: 0 },
      finalState: { messages: [], turn: 0 },
      revision: 0,
      status: "active",
      projection: { state: { messages: [], turn: 0 }, actions: [] },
      events: [],
      effects: [],
      console: [],
      steps: [],
    }));

    const { getByText, container } = renderPlayground(VALID_CODE);

    // Wait for auto-derive to complete (the effect fires on open, then the
    // async discovery resolves and updates the roster).
    await waitFor(() => {
      const seatIds = container.querySelectorAll('[data-testid="playground-seat-id"]');
      expect(seatIds.length).toBe(2);
    });
    expect(runExperienceTest).toHaveBeenCalledTimes(1);

    // The roster now has TWO seats: the default human seat AND an auto-derived
    // model seat — without the user manually adding or configuring anything.
    const seatIds = container.querySelectorAll('[data-testid="playground-seat-id"]');
    expect(seatIds[0]?.textContent).toBe("you");
    expect(seatIds[1]?.textContent).toBe("ai");

    // The capability grants are auto-checked (both participants + model).
    const grantCheckboxes = container.querySelectorAll('[role="checkbox"]');
    const checkedGrants = [...grantCheckboxes].filter((cb) => cb.getAttribute("aria-checked") === "true");
    expect(checkedGrants.length).toBe(2);

    // The model seat's controller dropdown shows the friendly model role label.
    const controllerTriggers = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "experience_playground_role_human" || b.textContent?.trim() === "experience_playground_role_model",
    );
    // One human + one model controller visible.
    expect(controllerTriggers.some((b) => b.textContent?.trim() === "experience_playground_role_human")).toBe(true);
    expect(controllerTriggers.some((b) => b.textContent?.trim() === "experience_playground_role_model")).toBe(true);
  });

  // XU-2: the "Which seat you play" dropdown lists ALL roster seats (not just
  // human seats) and picks send that humanSeatId; the seed toggle governs
  // whether a random seed or the manual seed reaches the Start request.
  it("seat choice (XU-2): the dropdown lists ALL roster seats incl. a model seat, and picking one sends that humanSeatId", async () => {
    runExperienceTest.mockImplementation(async () => makeTestRunData());
    const utils = renderPlayground(VALID_CODE);
    const { container, getByText, getByRole } = utils;
    // Auto-derive → human "you" + model "ai".
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="playground-seat-id"]').length).toBe(2);
    });
    // Turn "Random start" OFF for a deterministic payload (no random seed).
    fireEvent.click(getByRole("switch"));
    // The MODEL seat is listed (the list is built uniformly from participants
    // for every controller, so the script branch shares this code path).
    await pickDropdown(utils, container, "experience_playground_human_seat_auto", "AI (experience_playground_role_short_model)");
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground).toHaveBeenCalledWith(expect.objectContaining({ humanSeatId: "ai" }));
  });

  it("seed (XU-2): Random start ON generates a fresh non-empty seed per launch (two starts differ)", async () => {
    const utils = renderPlayground();
    const { getByText, getByRole } = utils;
    // Fresh config → the toggle defaults to ON.
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    const restart = getByText("experience_playground_restart");
    fireEvent.click(restart);
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(2));
    const first = startExperiencePlayground.mock.calls[0]![0] as { seed: string };
    const second = startExperiencePlayground.mock.calls[1]![0] as { seed: string };
    expect(first.seed).toBeTruthy();
    expect(second.seed).toBeTruthy();
    expect(first.seed).not.toBe(second.seed);
  });

  it("seed (XU-2): Random start OFF sends the manually entered seed verbatim", async () => {
    const utils = renderPlayground();
    const { getByText, getByRole, getByPlaceholderText } = utils;
    fireEvent.click(getByRole("switch")); // ON → OFF
    fireEvent.change(getByPlaceholderText("experience_tester_seed_placeholder"), { target: { value: "my-seed-42" } });
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground).toHaveBeenCalledWith(expect.objectContaining({ seed: "my-seed-42" }));
  });

  it("seed (XU-2): Random start OFF + empty seed keeps the deterministic-default path (no seed key)", async () => {
    const utils = renderPlayground();
    const { getByText, getByRole } = utils;
    fireEvent.click(getByRole("switch")); // ON → OFF
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground.mock.calls[0]![0]).not.toHaveProperty("seed");
  });

  // XU-3: the collapsed launch-setup accordion header summarizes the roster
  // (label + friendly role) and the random-start flag.
  it("setup summary (XU-3): the collapsed accordion header summarizes seats + random start", () => {
    const { getByText, getByTestId } = renderPlayground();
    fireEvent.click(getByText("experience_playground_setup_title"));
    const summary = getByTestId("playground-setup-summary");
    expect(summary.textContent).toBe(
      "You (experience_playground_role_human) · experience_playground_setup_summary_random_on",
    );
  });
});

// ── ER-14: send diagnostics to assistant ────────────────────────────────────

describe("ExperiencePlayground — send diagnostics to assistant (ER-14)", () => {
  it("renders the send button inside the open diagnostics disclosure when a session is live, and posts the digest on click", async () => {
    const onSendToCopilot = mock();
    const utils = render(<ExperiencePlayground code={VALID_CODE} visualSource={null} onSendToCopilot={onSendToCopilot} />);
    const { getByText, queryByTestId } = utils;

    // Before start: no session → the diagnostics disclosure is not rendered
    // (it only mounts inside `{session !== null && ...}`), so the button is absent.
    expect(queryByTestId("playground-send-to-copilot")).toBeNull();

    // Start a session.
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // Open the Developer-diagnostics disclosure (it now exists; the button lives inside).
    expandDiagnostics(utils);

    const btn = queryByTestId("playground-send-to-copilot");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("experience_playground_send_diagnostics");

    fireEvent.click(btn!);
    expect(onSendToCopilot).toHaveBeenCalledTimes(1);
    const digest = onSendToCopilot.mock.calls[0][0];
    expect(digest.feedback.ok).toBe(true);
    expect(digest.feedback.revision).toBe(0);
    expect(digest.feedback.stopReason).toBe("awaiting_human");
  });

  it("does NOT render the send button when onSendToCopilot is undefined (standalone use)", async () => {
    const utils = renderPlayground();
    const { getByText, queryByTestId } = utils;
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expandDiagnostics(utils);
    expect(queryByTestId("playground-send-to-copilot")).toBeNull();
  });
});

// ── XU-3: error copilot escape hatch + technical-details disclosure ─────────

describe("ExperiencePlayground — error copilot escape hatch (XU-3)", () => {
  it("error block shows the human line + ask-copilot button, with technical details under a closed-by-default disclosure", async () => {
    startExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(422, "Unexpected token", "vm_error", {
      kind: "syntax",
      console: [{ level: "error", args: ["boom"] }],
    }));
    const onSendToCopilot = mock();
    const { getByText, findByText, getByTestId, queryByText } = render(
      <ExperiencePlayground code={VALID_CODE} visualSource={null} onSendToCopilot={onSendToCopilot} />,
    );
    fireEvent.click(getByText("experience_playground_start"));

    // Human first line + ask-copilot button are immediately visible.
    expect(await findByText("Unexpected token")).toBeTruthy();
    expect(getByTestId("playground-error-ask-copilot")).toBeTruthy();
    // Technical fields are NOT rendered until the disclosure is opened.
    expect(queryByText("vm_error")).toBeNull();
    expect(queryByText("syntax")).toBeNull();
    expect(queryByText("boom")).toBeNull();

    fireEvent.click(getByText("experience_playground_error_tech_details"));
    expect(await findByText("vm_error")).toBeTruthy();
    expect(await findByText("syntax")).toBeTruthy();
    expect(await findByText("boom")).toBeTruthy();
  });

  it("ask-copilot posts the fail-path digest when a START fails (no session)", async () => {
    startExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(422, "Unexpected token", "vm_error", {
      kind: "syntax",
      console: [{ level: "error", args: ["boom"] }],
    }));
    const onSendToCopilot = mock();
    const { getByText, getByTestId } = render(
      <ExperiencePlayground code={VALID_CODE} visualSource={null} onSendToCopilot={onSendToCopilot} />,
    );
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(getByTestId("playground-error-ask-copilot")).toBeTruthy());

    fireEvent.click(getByTestId("playground-error-ask-copilot"));
    expect(onSendToCopilot).toHaveBeenCalledTimes(1);
    const digest = onSendToCopilot.mock.calls[0][0];
    expect(digest.feedback.ok).toBe(false);
    expect(digest.feedback.errorCode).toBe("vm_error");
    expect(digest.feedback.errorKind).toBe("syntax");
  });
});

// ── Fix item 9a: config persistence ─────────────────────────────────────────

describe("ExperiencePlayground — config persistence (fix item 9a)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists the roster + grants + seed + settings after a manual change and restores them on remount", async () => {
    // First mount: configure a model seat + grant + seed, then start so the
    // change is flushed (the persist effect runs on touched state).
    runExperienceTest.mockImplementation(async () => makeTestRunData());
    const first = renderPlayground(VALID_CODE, null, { scriptId: "script_persist" });
    await first.findByText("experience_playground_start");
    // Touch the roster: add a seat and set its controller to model.
    fireEvent.click(first.getByText("experience_setup_add_participant"));
    await pickDropdown(first, first.baseElement, "experience_playground_role_human", "experience_playground_role_model");
    // Persist effect fires on the touched change. The discovery mock declares
    // participants+model, so auto-derive may have already added its own model
    // seat before the manual touch — what matters is that the TOUCHED seat
    // (the added one, set to model) is persisted.
    await waitFor(() => {
      const raw = window.localStorage.getItem("experience.playground.script_persist");
      expect(raw).toBeTruthy();
      const saved = JSON.parse(raw!) as { seats: Array<{ controller: string }> };
      expect(saved.seats.length).toBeGreaterThanOrEqual(2);
      expect(saved.seats.some((s) => s.controller === "model")).toBe(true);
    });
    first.unmount();

    // Second mount with the same scriptId: the config is restored and counts
    // as touched (auto-derive must not override it).
    const second = renderPlayground(VALID_CODE, null, { scriptId: "script_persist" });
    await second.findByText("experience_playground_start");
    // The restored model seat is visible in the roster UI (its controller
    // dropdown now shows the model label) and auto-derive did not override it.
    await waitFor(() => {
      expect(second.baseElement.textContent).toContain("experience_playground_role_model");
      expect(second.baseElement.textContent).not.toContain("experience_playground_add_seat");
    });
    second.unmount();
  });

  it("without a scriptId nothing is persisted (standalone panel keeps the old behavior)", async () => {
    runExperienceTest.mockImplementation(async () => makeTestRunData());
    const view = renderPlayground(VALID_CODE, null);
    await view.findByText("experience_playground_start");
    fireEvent.click(view.getByText("experience_setup_add_participant"));
    await waitFor(() => expect(window.localStorage.length).toBe(0));
  });

  it("a malformed saved envelope is discarded (no half-restore)", () => {
    runExperienceTest.mockImplementation(async () => makeTestRunData());
    window.localStorage.setItem("experience.playground.script_bad", "{not json");
    const view = renderPlayground(VALID_CODE, null, { scriptId: "script_bad" });
    // Falls back to the default single human seat — the roster shows the
    // friendly human role label, not a broken restored row.
    expect(view.baseElement.textContent).toContain("experience_playground_role_human");
  });

  it("persists randomStart and restores it; a pre-XU-2 envelope without the flag restores as OFF", async () => {
    // Part 1: toggle ON → OFF, persist, remount → restored OFF.
    const first = renderPlayground(VALID_CODE, null, { scriptId: "script_rs" });
    await first.findByText("experience_playground_start");
    fireEvent.click(first.getByRole("switch")); // ON → OFF
    await waitFor(() => {
      const raw = window.localStorage.getItem("experience.playground.script_rs");
      expect(raw).toBeTruthy();
      const saved = JSON.parse(raw!) as { randomStart: boolean };
      expect(saved.randomStart).toBe(false);
    });
    first.unmount();

    const second = renderPlayground(VALID_CODE, null, { scriptId: "script_rs" });
    await second.findByText("experience_playground_start");
    expect(second.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    second.unmount();

    // Part 2: an OLD envelope (no randomStart flag) restores as OFF (false).
    window.localStorage.setItem("experience.playground.script_old", JSON.stringify({
      version: 1,
      seats: [{ id: "you", label: "You", controller: "human" }],
      grants: [],
      seed: "",
      settingsJson: "",
      humanSeatId: "",
    }));
    const third = renderPlayground(VALID_CODE, null, { scriptId: "script_old" });
    await third.findByText("experience_playground_start");
    expect(third.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    third.unmount();
  });
});

// ── Fix item 9b: one-click restart ──────────────────────────────────────────

describe("ExperiencePlayground — one-click restart (fix item 9b)", () => {
  it("restart re-runs Start with the same config from the CURRENT rules buffer", async () => {
    const view = renderPlayground(VALID_CODE);
    await view.findByText("experience_playground_start");
    fireEvent.click(view.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // The restart button appears once a session exists.
    const restart = view.getByText("experience_playground_restart");
    fireEvent.click(restart);
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(2));
    // Both starts ran against the same unsaved buffer.
    const firstCall = startExperiencePlayground.mock.calls[0]![0] as { rulesCode: string };
    const secondCall = startExperiencePlayground.mock.calls[1]![0] as { rulesCode: string };
    expect(secondCall.rulesCode).toBe(firstCall.rulesCode);
    expect(secondCall.rulesCode).toBe(VALID_CODE);
  });
});

// ── XU-4: the absorbed tester (discover / simulate / single-action participant) ─
// The retired InteractiveTester's one-shot capabilities moved into the
// playground's collapsed diagnostics accordion. The SAME boundary is pinned
// here: the STATELESS runExperienceTest / simulateExperienceTest endpoints are
// mocked at the client boundary; the component under test is real.

describe("ExperiencePlayground — absorbed tester (XU-4)", () => {
  it("discover: the 'Validate rules' button re-runs create-only discovery over the current context and renders definition, projection, and legal actions", async () => {
    const utils = renderPlayground();
    const { getByText, findByText } = utils;
    // Auto-derive fires runExperienceTest once on mount (default reject → safe
    // default single human seat + empty grants). Settle it first so the
    // explicit discover is the SECOND call and the grants stay [] (the same
    // context the retired tester's discover test pinned).
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockImplementationOnce(async () => makeDiscoverData());
    expandDiagnostics(utils);
    fireEvent.click(getByText("experience_tester_run"));

    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(2));
    expect(runExperienceTest.mock.calls[1]?.[0]).toMatchObject({
      rulesCode: VALID_CODE,
      participants: [{ id: "you", label: "You", controller: "human" }],
      capabilityGrants: [],
      actions: [],
    });

    // The result renders: definition summary + projection + legal actions.
    expect(await findByText("Round")).toBeTruthy();
    expect(await findByText("(round)")).toBeTruthy();
    expect(await findByText("experience_tester_projection")).toBeTruthy();
    expect(await findByText("score")).toBeTruthy();
    expect(await findByText("pass")).toBeTruthy();
  });

  it("discover: renders the per-seat legality matrix when the server supplies seatLegality", async () => {
    const utils = renderPlayground();
    const { getByText, findByText } = utils;
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockImplementationOnce(async () =>
      makeDiscoverData({
        seatLegality: {
          seats: [
            { participantId: "you", label: "You", controller: "human", actionTypes: ["score"], count: 1 },
            { participantId: "bot", label: "Bot", controller: "script", actionTypes: [], count: 0 },
          ],
          turnOwners: ["you"],
        },
      }),
    );
    expandDiagnostics(utils);
    fireEvent.click(getByText("experience_tester_run"));

    expect(await findByText("experience_tester_seat_legality")).toBeTruthy();
    expect(await findByText("You · human")).toBeTruthy();
    expect(await findByText("Bot · script")).toBeTruthy();
    expect(await findByText(/experience_tester_turn/)).toBeTruthy();
  });

  it("discover: a broken rules body renders the typed vm_error with the kernel kind and console behind the tech-details disclosure", async () => {
    const utils = renderPlayground();
    const { getByText, findByText, queryByText } = utils;
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockRejectedValueOnce(new ExperienceApiError(422, "Unexpected token", "vm_error", {
      kind: "syntax",
      console: [{ level: "error", args: ["boom"] }],
    }));
    expandDiagnostics(utils);
    fireEvent.click(getByText("experience_tester_run"));

    // The shared error block renders the human first line immediately; the
    // technical fields (code/kind/console) sit behind the closed disclosure.
    expect(await findByText("Unexpected token")).toBeTruthy();
    expect(queryByText("vm_error")).toBeNull();
    fireEvent.click(getByText("experience_playground_error_tech_details"));
    expect(await findByText("vm_error")).toBeTruthy();
    expect(await findByText("syntax")).toBeTruthy();
    expect(await findByText("boom")).toBeTruthy();
  });

  it("discover: malformed settings JSON shows the detailed diagnostic and never fires the request", async () => {
    const utils = renderPlayground();
    const { getByText, getByTestId, container } = utils;
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    expandDiagnostics(utils);

    // The settings JSON lives under the collapsed "advanced" disclosure
    // (LOBBY-A); open it, type malformed JSON, and run.
    fireEvent.click(getByTestId("playground-settings-advanced-toggle"));
    const jsonArea = await waitFor(() => {
      const el = container.querySelector('[data-testid="auto-textarea"]');
      expect(el).not.toBeNull();
      return el as HTMLTextAreaElement;
    });
    fireEvent.change(jsonArea, { target: { value: "{\n  \"seed\": 1" } });
    fireEvent.click(getByText("experience_tester_run"));

    await waitFor(() => expect(container.textContent ?? "").toContain("experience_tester_settings_invalid"));
    expect(container.textContent).toContain("unclosed '{' opened at line 1");
    // Still exactly the auto-derive call — the discover never fired.
    expect(runExperienceTest).toHaveBeenCalledTimes(1);
  });

  it("simulate: auto-play sends the current context and renders the typed stop reason + iterations", async () => {
    const utils = renderPlayground();
    const { getByText, findByText } = utils;
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));
    expandDiagnostics(utils);

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
    // Simulate never touches the run endpoint or the live playground.
    expect(runExperienceTest).toHaveBeenCalledTimes(1);
    expect(startExperiencePlayground).not.toHaveBeenCalled();
  });

  it("apply action: the custom-action form's participant selector sends participantId on advance", async () => {
    const utils = renderPlayground();
    const { container, getByText, getByPlaceholderText } = utils;
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expandDiagnostics(utils);

    // Pick the default seat "You" from the NEW participant selector, then apply.
    await pickDropdown(utils, container, "experience_tester_action_participant_default", "You (experience_playground_role_human)");
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "score" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(advanceExperiencePlayground).toHaveBeenCalledWith({
      playgroundSessionId: "pg-session-1",
      humanAction: { type: "score", requestId: "pg-req-1", expectedRevision: 0, participantId: "you" },
    });
  });

  it("sends the discover result digest to the copilot (the retired tester's run digest)", async () => {
    const onSendToCopilot = mock();
    const utils = render(<ExperiencePlayground code={VALID_CODE} visualSource={null} onSendToCopilot={onSendToCopilot} />);
    const { getByText, getByTestId } = utils;
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1));

    runExperienceTest.mockImplementationOnce(async () => makeDiscoverData());
    expandDiagnostics(utils);
    fireEvent.click(getByText("experience_tester_run"));
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(2));

    fireEvent.click(getByTestId("playground-tester-send-to-copilot"));
    expect(onSendToCopilot).toHaveBeenCalledTimes(1);
    const digest = onSendToCopilot.mock.calls[0][0];
    expect(digest.feedback.ok).toBe(true);
    expect(digest.feedback.legalActionTypes).toEqual(["score", "pass"]);
    expect(typeof digest.text).toBe("string");
    expect(digest.text.length).toBeGreaterThan(0);
  });
});

// ── LOBBY-A: declared setup fields render as the launch form ────────────────

describe("ExperiencePlayground — setup form (LOBBY-A / EXPERIENCE_ENGINE_LOBBY_REPORT fix step 1)", () => {
  /** Declared setup fields: a defaulted select, a defaulted number, a
   *  defaulted boolean, and (when `withRequiredText`) a required no-default
   *  text field. */
  function makeSetupFields(withRequiredText: boolean): ExperienceSetupFieldDto[] {
    const fields: ExperienceSetupFieldDto[] = [
      { id: "difficulty", kind: "select", label: "Difficulty", required: true, default: "easy", options: [{ value: "easy", label: "Easy" }, { value: "hard", label: "Hard" }] },
      { id: "rounds", kind: "number", label: "Rounds", default: 3, min: 1, max: 9, step: 1 },
      { id: "hints", kind: "boolean", label: "Hints", default: false },
    ];
    if (withRequiredText) fields.push({ id: "nickname", kind: "text", label: "Nickname", required: true });
    return fields;
  }

  function mockDiscoveryWithSetup(fields: ExperienceSetupFieldDto[]): void {
    runExperienceTest.mockImplementation(async () =>
      makeDiscoverData({
        definition: {
          apiVersion: 1,
          manifest: { id: "round", name: "Round", mode: "turn" },
          declaredCapabilities: [{ capability: "participants", reason: "scores" }],
          hasChoose: false,
          hasFlavor: false,
          setup: { fields },
        },
      }),
    );
  }

  /** Wait for the debounced discovery to land the setup form (400ms debounce
   *  + promise resolution; headroom over the 1s waitFor default). */
  async function waitForSetupForm(utils: { container: HTMLElement }): Promise<void> {
    await waitFor(() => expect(utils.container.querySelector('[data-testid="playground-setup-form"]')).toBeTruthy(), { timeout: 4000 });
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("declared fields render as a form; author defaults seed into the launch; the raw JSON hides under the advanced disclosure", async () => {
    mockDiscoveryWithSetup(makeSetupFields(false));
    const utils = renderPlayground();
    await waitForSetupForm(utils);

    // The declared fields render (required fields carry the required mark —
    // match by substring); the raw JSON textarea is NOT directly rendered
    // (collapsed advanced disclosure) — only its toggle is.
    expect(utils.getByText(/Difficulty/)).toBeTruthy();
    expect(utils.getByText("Rounds")).toBeTruthy();
    // A boolean's label renders twice (the row label + the checkbox label).
    expect(utils.getAllByText("Hints").length).toBeGreaterThan(1);
    expect(utils.getByTestId("playground-settings-advanced-toggle")).toBeTruthy();
    expect(utils.container.querySelectorAll('[data-testid="auto-textarea"]').length).toBe(0);

    // Start sends the seeded author defaults (write-through seeding — the
    // same values the hidden JSON now carries; modal omission semantics).
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground.mock.calls[0]![0].settings).toEqual({ difficulty: "easy", rounds: 3, hints: false });
  });

  it("a field edit writes into the settings JSON; undeclared extra keys and derived defaults ride along", async () => {
    mockDiscoveryWithSetup(makeSetupFields(false));
    const utils = renderPlayground();
    await waitForSetupForm(utils);

    // Hand-write JSON with an UNDECLARED extra key and no declared keys (the
    // author defaults re-derive for display and for the launch payload).
    fireEvent.click(utils.getByTestId("playground-settings-advanced-toggle"));
    const jsonArea = utils.container.querySelector('[data-testid="auto-textarea"]') as HTMLTextAreaElement;
    await waitFor(() => expect(jsonArea).toBeTruthy());
    fireEvent.change(jsonArea, { target: { value: '{"mystery":"x"}' } });

    // Pick Hard through the form: the edit merges into the JSON object (the
    // extra key is preserved), and Start sends extra + chosen + defaults.
    await pickDropdown(utils, utils.container, "Easy", "Hard");
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground.mock.calls[0]![0].settings).toEqual({ mystery: "x", difficulty: "hard", rounds: 3, hints: false });
  });

  it("a required empty field blocks Start with the panel error + inline per-field error; filling it launches", async () => {
    mockDiscoveryWithSetup(makeSetupFields(true));
    const utils = renderPlayground();
    await waitForSetupForm(utils);

    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(utils.getByText("experience_playground_settings_field_errors")).toBeTruthy());
    expect(startExperiencePlayground).not.toHaveBeenCalled();
    // Inline per-field error (identity i18n — the key verbatim).
    expect(utils.getAllByText("experience_setup_field_required_error").length).toBeGreaterThan(0);

    // Fill the required text field (the only auto-textarea while the advanced
    // JSON stays collapsed) → Start carries the typed value.
    const nickname = utils.container.querySelector('[data-testid="auto-textarea"]') as HTMLTextAreaElement;
    fireEvent.change(nickname, { target: { value: "Ada" } });
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground.mock.calls[0]![0].settings).toEqual({ difficulty: "easy", rounds: 3, hints: false, nickname: "Ada" });
  });

  it("a no-default boolean cycles absent ↔ true (unchecking restores absence)", async () => {
    mockDiscoveryWithSetup([{ id: "turbo", kind: "boolean", label: "Turbo" }]);
    const utils = renderPlayground();
    await waitForSetupForm(utils);

    // Toggle through the checkbox control (a boolean's text lives twice — the
    // row label and the checkbox label; the control is the [role=checkbox]).
    // Both toggles happen BEFORE any start so the launch-setup accordion
    // stays mounted (a live session collapses it — XU-3).
    const turboCheckbox = () => utils.getAllByText("Turbo").find((el) => el.closest('[role="checkbox"]'))!;

    // Check → the JSON write-through carries turbo:true (read it through the
    // advanced disclosure instead of launching).
    fireEvent.click(utils.getByTestId("playground-settings-advanced-toggle"));
    const jsonArea = () => utils.container.querySelector('[data-testid="auto-textarea"]') as HTMLTextAreaElement;
    fireEvent.click(turboCheckbox());
    await waitFor(() => expect(jsonArea().value).toBe('{"turbo":true}'));

    // Uncheck → absence restored (the key is deleted, not written false).
    fireEvent.click(turboCheckbox());
    await waitFor(() => expect(jsonArea().value).toBe("{}"));

    // Start sends the absent boolean (omission semantics — never a written false).
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(startExperiencePlayground.mock.calls[0]![0].settings).toEqual({});
  });

  it("a package with no declared fields hides the JSON under the advanced disclosure too (no form, but never a raw textarea in the default view)", async () => {
    runExperienceTest.mockImplementation(async () => makeDiscoverData());
    const utils = renderPlayground();
    await waitFor(() => expect(runExperienceTest).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(utils.container.querySelector('[data-testid="playground-setup-form"]')).toBeNull();
    // LB-1: a package with no declared fields shows an explicit line (no bare
    // empty space above the advanced disclosure).
    expect(utils.getByTestId("playground-no-fields").textContent).toBe("experience_playground_no_fields");
    // The JSON is collapsed behind the advanced toggle — NOT rendered directly.
    expect(utils.getByTestId("playground-settings-advanced-toggle")).toBeTruthy();
    expect(utils.container.querySelector('[data-testid="auto-textarea"]')).toBeNull();
    // Opening the disclosure still exposes the textarea (technical users).
    fireEvent.click(utils.getByTestId("playground-settings-advanced-toggle"));
    await waitFor(() => expect(utils.container.querySelector('[data-testid="auto-textarea"]')).toBeTruthy());
  });

  it("broken settings JSON disables the form and warns; the JSON stays reachable under the advanced disclosure", async () => {
    mockDiscoveryWithSetup(makeSetupFields(false));
    const utils = renderPlayground();
    await waitForSetupForm(utils);

    fireEvent.click(utils.getByTestId("playground-settings-advanced-toggle"));
    const jsonArea = utils.container.querySelector('[data-testid="auto-textarea"]') as HTMLTextAreaElement;
    fireEvent.change(jsonArea, { target: { value: "{" } });

    await waitFor(() => expect(utils.container.querySelector('[data-testid="playground-setup-form"]')).toBeNull());
    expect(utils.getByText("experience_playground_settings_json_invalid")).toBeTruthy();
    // The broken JSON stays directly editable (the technical-user escape hatch).
    expect(utils.container.querySelector('[data-testid="auto-textarea"]')).toBeTruthy();
    // Start keeps the pre-LOBBY-A behavior: the detailed JSON diagnostic, no request.
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(utils.getByText(/experience_tester_settings_invalid/)).toBeTruthy());
    expect(startExperiencePlayground).not.toHaveBeenCalled();
  });

  it("a settings-only edit persists without a roster edit, and a restored config still gets the form", async () => {
    mockDiscoveryWithSetup(makeSetupFields(false));
    const first = renderPlayground(VALID_CODE, null, { scriptId: "script_lobby" });
    await waitForSetupForm(first);

    // Pick Hard through the form — a settings-only edit (no roster edit).
    await pickDropdown(first, first.container, "Easy", "Hard");
    await waitFor(() => expect(window.localStorage.getItem("experience.playground.script_lobby")).toBeTruthy());
    const raw = JSON.parse(window.localStorage.getItem("experience.playground.script_lobby")!) as { settingsJson: string };
    expect(JSON.parse(raw.settingsJson)).toEqual({ difficulty: "hard", rounds: 3, hints: false });
    first.unmount();

    // Remount: the config restores (Hard persists) and — despite the restored
    // roster (seatsTouched) — the discovery STILL captures the declared fields:
    // the form is there for a restored config too (the pre-LOBBY-A discovery
    // was skipped entirely for touched configs).
    const second = renderPlayground(VALID_CODE, null, { scriptId: "script_lobby" });
    await waitForSetupForm(second);
    expect(second.getByText("Hard")).toBeTruthy();
  });
});

// ── LB-6: post-game strip (EXPERIENCE_ENGINE_LOBBY_REPORT) ─────────────

/** LB-6: a completed envelope — status/stopReason completed, no legal actions. */
function makeCompletedData(overrides: Partial<ExperiencePlaygroundData> = {}): ExperiencePlaygroundData {
  return makeStartData({
    status: "completed",
    stopReason: "completed",
    projection: { state: { round: 9 }, actions: [] },
    ...overrides,
  });
}

describe("ExperiencePlayground — post-game strip (LB-6)", () => {
  it("completed: the strip renders next to the status line with both actions", async () => {
    startExperiencePlayground.mockImplementation(async () => makeCompletedData());
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    const strip = await utils.findByTestId("playground-postgame-strip");
    expect(strip.textContent).toContain("experience_playground_postgame_title");
    expect(utils.getByText("experience_restart_play_again")).toBeTruthy();
    expect(utils.getByText("experience_restart_change_settings")).toBeTruthy();
  });

  it("active: no strip — the surface is completed-only (header buttons unchanged)", async () => {
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    expect(utils.queryByTestId("playground-postgame-strip")).toBeNull();
    // The pre-existing header controls are still there (unchanged by LB-6).
    expect(utils.getByText("experience_playground_restart")).toBeTruthy();
    expect(utils.getByText("experience_playground_reset")).toBeTruthy();
  });

  it("play-again: restarts with the SAME config and a fresh seed, landing on a live run", async () => {
    let call = 0;
    startExperiencePlayground.mockImplementation(async () => {
      call += 1;
      return call === 1 ? makeCompletedData() : makeStartData();
    });
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    fireEvent.click(utils.getByText("experience_restart_play_again"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(2));

    type StartCall = {
      rulesCode: string;
      settings: Record<string, unknown>;
      participants: unknown[];
      capabilityGrants: unknown[];
      seed?: string;
    };
    const first = startExperiencePlayground.mock.calls[0]![0] as StartCall;
    const second = startExperiencePlayground.mock.calls[1]![0] as StartCall;
    // Same settings/seats/roster (randomStart is ON by default → fresh seed).
    expect(second.rulesCode).toBe(first.rulesCode);
    expect(second.settings).toEqual(first.settings);
    expect(second.participants).toEqual(first.participants);
    expect(second.capabilityGrants).toEqual(first.capabilityGrants);
    expect(first.seed).toBeTruthy();
    expect(second.seed).toBeTruthy();
    expect(second.seed).not.toBe(first.seed);
    // The restarted run is live again: legal actions render, strip is gone.
    await waitFor(() => expect(utils.queryByTestId("playground-postgame-strip")).toBeNull());
    expect(await utils.findByText("Score")).toBeTruthy();
  });

  it("change-settings: tears the run down and restores the expanded setup state", async () => {
    startExperiencePlayground.mockImplementation(async () => makeCompletedData());
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // While live the setup accordion auto-collapsed (XU-3) — the reset must
    // restore the expanded default.
    const setupToggle = () => utils.getByText("experience_playground_setup_title").closest("button") as HTMLButtonElement;
    expect(setupToggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(utils.getByText("experience_restart_change_settings"));
    await waitFor(() => expect(utils.queryByTestId("playground-postgame-strip")).toBeNull());
    expect(utils.queryByText("experience_playground_turn_title")).toBeNull();
    await waitFor(() => expect(setupToggle().getAttribute("aria-expanded")).toBe("true"));
  });
});

describe("ExperiencePlayground — timer beat loop (playground timers)", () => {
  it("a live session with pendingTimers > 0 issues a beat and applies its response", async () => {
    startExperiencePlayground.mockImplementation(async () => makeStartData({ pendingTimers: 1 }));
    runExperiencePlaygroundTimer.mockImplementation(async () => makeAdvanceData({ pendingTimers: 0 }));
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // The beat was issued for the live session and its ticked state landed
    // (the turn block renders the advanced projection).
    await waitFor(() => expect(runExperiencePlaygroundTimer).toHaveBeenCalledWith({ playgroundSessionId: "pg-session-1" }));
    expect(await utils.findByText("experience_playground_turn_title")).toBeTruthy();
  });

  it("the loop stops once a beat response reports pendingTimers 0", async () => {
    startExperiencePlayground.mockImplementation(async () => makeStartData({ pendingTimers: 1 }));
    runExperiencePlaygroundTimer.mockImplementation(async () => makeAdvanceData({ pendingTimers: 0 }));
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(runExperiencePlaygroundTimer).toHaveBeenCalledTimes(1));

    // No re-arm in the response → no further beat (settle window for a would-be
    // second call that must never come).
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runExperiencePlaygroundTimer).toHaveBeenCalledTimes(1);
  });

  it("the loop re-issues while the rules keep re-arming timers", async () => {
    startExperiencePlayground.mockImplementation(async () => makeStartData({ pendingTimers: 1 }));
    let calls = 0;
    runExperiencePlaygroundTimer.mockImplementation(async () => {
      calls += 1;
      return makeAdvanceData({ pendingTimers: calls < 2 ? 1 : 0, revision: 40 + calls });
    });
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(runExperiencePlaygroundTimer).toHaveBeenCalledTimes(2));
  });

  it("a session without pending timers never issues a beat", async () => {
    startExperiencePlayground.mockImplementation(async () => makeStartData());
    const utils = renderPlayground();
    fireEvent.click(utils.getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runExperiencePlaygroundTimer).not.toHaveBeenCalled();
  });
});

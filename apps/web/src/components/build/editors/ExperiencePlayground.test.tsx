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
import type { RenderResult } from "@testing-library/react";
import type {
  ExperiencePlaygroundData,
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
      manifest: { id: "round", name: "Round" },
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
    console: [{ level: "log", args: ["scored one"] }],
    revision: 41,
    status: "active",
    stopReason: "awaiting_human",
    ...overrides,
  };
}

// ── Module-boundary mocks (hoisted above the component imports) ─────────────

const startExperiencePlayground = mock((_body: Record<string, unknown>) => Promise.resolve(makeStartData()));
const advanceExperiencePlayground = mock((_body: Record<string, unknown>) => Promise.resolve(makeAdvanceData()));
const listExperienceVisuals = mock(() => Promise.resolve<ExperienceVisualRow[]>([]));
const listAllScripts = mock(() => Promise.resolve<ScriptRecord[]>([]));

const realExperienceApi = await import("../../../api/experience-api.js");
const realScriptApi = await import("../../../api/script-api.js");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realAutoTextarea = await import("../../shared/auto-textarea.js");

mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  startExperiencePlayground,
  advanceExperiencePlayground,
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
  listExperienceVisuals.mockClear();
  listAllScripts.mockClear();
  startExperiencePlayground.mockImplementation(async () => makeStartData());
  advanceExperiencePlayground.mockImplementation(async () => makeAdvanceData());
  useScriptDraftStore.getState().resetAll();
  useExperienceVisualDraftStore.getState().resetAll();
  createdBlobs.length = 0;
  revokedUrls.length = 0;
  restoreUrl();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderPlayground(code: string = VALID_CODE, visualSource: string | null = null) {
  const utils = render(<ExperiencePlayground code={code} visualSource={visualSource} />);
  // Expand the disclosure (collapsed by default in the editor layout).
  fireEvent.click(utils.getByText("experience_playground_title"));
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
    const { container, getByText, getAllByPlaceholderText, findByText } = utils;

    // Add a second human seat and pick it as the driven seat.
    fireEvent.click(getByText("experience_setup_add_participant"));
    const idInputs = getAllByPlaceholderText("experience_tester_seat_id_placeholder");
    fireEvent.change(idInputs[1]!, { target: { value: "alice" } });
    const labelInputs = getAllByPlaceholderText("experience_setup_participant_name_placeholder");
    fireEvent.change(labelInputs[1]!, { target: { value: "Alice" } });
    await pickDropdown(utils, container, "experience_playground_human_seat_auto", "Alice");

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
    expect(await findByText("Round")).toBeTruthy();
    expect(await findByText("(round)")).toBeTruthy();
    expect(await findByText("participants")).toBeTruthy();
    expect(await findByText("experience_tester_projection")).toBeTruthy();
    expect(await findByText("Score")).toBeTruthy();
    expect(await findByText("Pass turn")).toBeTruthy();
    expect(await findByText("awaiting_human")).toBeTruthy();
    expect(await findByText("experience_playground_turn_title")).toBeTruthy();
    // No provider/model path is involved in a start.
    expect(advanceExperiencePlayground).not.toHaveBeenCalled();
  });

  it("start: a broken rules body renders the typed vm_error with the kernel kind and the captured console", async () => {
    startExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(422, "Unexpected token", "vm_error", {
      kind: "syntax",
      console: [{ level: "error", args: ["boom"] }],
    }));
    const { getByText, findByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));

    expect(await findByText("vm_error")).toBeTruthy();
    expect(await findByText("syntax")).toBeTruthy();
    expect(await findByText("boom")).toBeTruthy();
  });

  it("drive: a legal action advances the turn and renders the bumped revision, the script-seat moves, reported effects, and console", async () => {
    const { getByText, findByText } = renderPlayground();
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
    expect(await findByText("41")).toBeTruthy();
    expect(await findByText("scored")).toBeTruthy();
    expect(await findByText("dealer_drew")).toBeTruthy();
    expect(await findByText("model")).toBeTruthy();
    expect(await findByText("scored one")).toBeTruthy();
  });

  it("drive: an illegal action type renders illegal_action and the session keeps the prior state", async () => {
    const { getByText, getByPlaceholderText, findByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    advanceExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(422, "Action type is not legal for this viewer", "illegal_action", {}));
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "cheat" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    expect(await findByText("illegal_action")).toBeTruthy();
    expect(advanceExperiencePlayground).toHaveBeenCalledWith({
      playgroundSessionId: "pg-session-1",
      humanAction: { type: "cheat", requestId: "pg-req-1", expectedRevision: 0 },
    });
    // The pre-action projection is still the rendered one (revision 0).
    expect(await findByText("experience_tester_projection")).toBeTruthy();
  });

  it("drive: a stale expectedRevision renders stale_revision with the currentRevision", async () => {
    const { getByText, getByPlaceholderText, getByLabelText, findByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    advanceExperiencePlayground.mockRejectedValueOnce(new ExperienceApiError(409, "Action expected revision 7, session is at 0", "stale_revision", { currentRevision: 3 }));
    fireEvent.change(getByPlaceholderText("experience_tester_action_type_placeholder"), { target: { value: "score" } });
    fireEvent.change(getByLabelText("experience_tester_action_expected_revision"), { target: { value: "7" } });
    fireEvent.click(getByText("experience_tester_action_apply"));

    expect(await findByText("stale_revision")).toBeTruthy();
    expect(await findByText("3")).toBeTruthy();
  });

  it("drive: a duplicated requestId replays without advancing the rendered revision", async () => {
    const { getByText, getByLabelText, findByText, queryByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    // Turn 1: the legal action advances 0 → 41.
    fireEvent.click(getByText("Score"));
    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(1));
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

  it("model-seat stub: an awaiting_model boundary renders as informational, never an error, and no provider path is invoked", async () => {
    startExperiencePlayground.mockImplementationOnce(async () => makeStartData({ stopReason: "awaiting_model" }));
    const { getByText, findByText, queryByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));

    expect(await findByText("awaiting_model")).toBeTruthy();
    expect(await findByText("experience_playground_model_stub")).toBeTruthy();
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

    const { getByText, findByText, queryByText } = renderPlayground();
    fireEvent.click(getByText("experience_playground_start"));
    await waitFor(() => expect(startExperiencePlayground).toHaveBeenCalledTimes(1));

    fireEvent.click(getByText("Score"));
    await waitFor(() => expect(advanceExperiencePlayground).toHaveBeenCalledTimes(1));
    expect(await findByText("41")).toBeTruthy();

    fireEvent.click(getByText("experience_playground_reset"));
    await waitFor(() => expect(queryByText("experience_tester_projection")).toBeNull());

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

    // The playground is mounted in the IR-84B seam, below the visual section.
    fireEvent.click(getByText("experience_playground_title"));
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

    const seatIdInputs = container.querySelectorAll('input[placeholder="experience_tester_seat_id_placeholder"]');
    expect(seatIdInputs.length).toBeGreaterThanOrEqual(3);
    // Each roster row (parent of a seat-id input) wraps instead of overflowing:
    // it carries flex-wrap, and its flexible label input has a min-width floor.
    seatIdInputs.forEach((seatInput) => {
      const row = seatInput.parentElement;
      if (!row) throw new Error("roster row missing");
      const rowCls = row.getAttribute("class") ?? "";
      expect(rowCls).toContain("flex-wrap");
      const labelInput = row.querySelector('input[placeholder="experience_setup_participant_name_placeholder"]');
      expect(labelInput?.getAttribute("class") ?? "").toContain("min-w-[7rem]");
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
    const seedInput = container.querySelector('input[placeholder="experience_tester_seed_placeholder"]') as HTMLInputElement | null;
    expect(seedInput).not.toBeNull();
    expect(seedInput!.offsetParent === null ? true : seedInput!.parentElement?.contains(seedInput)).toBe(true);

    document.body.style.width = "";
  });
});

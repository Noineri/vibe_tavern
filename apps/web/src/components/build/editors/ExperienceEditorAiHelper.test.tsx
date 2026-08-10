/**
 * ExperienceEditor — IR-82 AI-helper wiring boundary tests.
 *
 * Boundary under test: API mocks (script-api) → the REAL ExperienceEditor with
 * the REAL draft stores (script-draft-store, the IR-81A trust invariant
 * included) → DOM + store observations. The universal AiAssistantModal is
 * mocked with a thin double that captures its props (so we assert the launch
 * wiring: apiMode="interactive_rules", existingContent = the current rules
 * source) and exposes the onInsert/onReplace callbacks the real modal invokes
 * after its diff/replace review. i18n and Tooltip are mocked (keys verbatim /
 * passthrough), matching ExperienceEditor.test.tsx.
 *
 * Pinned behavior (per the IR-82 contract):
 *  6. Dirty-buffer protection: accepting AI output flows through the reviewed
 *     onReplace path → the normal updateScriptDraft({ code }) action — the draft
 *     buffer is updated, the base is NOT touched, and nothing is auto-persisted
 *     (no silent blind overwrite of a dirty draft or a server save).
 *  7. No-auto-enable: after an AI write-back the rules draft is UNTRUSTED and
 *     the enable toggle stays LOCKED — the IR-81A store invariant (any code
 *     change drops enabled=false) is automatic; the AI write-back is just
 *     another source edit.
 *
 * Runner: bun:test with scoped happy-dom (one file per process — mock.module()
 * is process-global).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";
import { useScriptDraftStore } from "../../../stores/script-draft-store.js";
import { useExperienceVisualDraftStore } from "../../../stores/experience-authoring-store.js";
import { getVisualStarter } from "../../experience/starters/index.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const EXISTING_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'existing', name: 'Existing' }, capabilities: [], create() { return {}; }, project() { return {}; }, actions() { return []; }, reduce(context) { return { state: context.state, status: 'active', events: [] }; } });";
const AI_GENERATED_CODE = "context.experience.register({ apiVersion: 1, manifest: { id: 'ai_game', name: 'AI Game' }, capabilities: [{ capability: 'participants', reason: 'turns' }], create(c) { return { s: 0 }; }, project(c) { return { s: c.state.s }; }, actions() { return [{ type: 'go' }]; }, reduce(c, a) { return { state: { s: c.state.s + 1 }, status: 'active', events: [] }; } });";

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
  enabled: true,
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
const createExperienceVisual = mock((_body: Record<string, unknown>) => Promise.resolve<ExperienceVisualRow>({ ...baseVisual }));
const updateExperienceVisual = mock((_id: string, _patch: Record<string, unknown>) => Promise.resolve<ExperienceVisualRow>({ ...baseVisual }));

const realScriptApi = await import("../../../api/script-api.js");
const realExperienceApi = await import("../../../api/experience-api.js");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realAiAssistantModal = await import("../../shared/AiAssistantModal.js");

/** Captured props from the last AiAssistantModal render. The double renders
 *  nothing — the test drives acceptance by invoking onInsert/onReplace directly
 *  (simulating the modal's post-review accept), pinning the editor WIRING +
 *  store invariant, not the modal's own diff UI. */
interface CapturedAiProps {
  apiMode?: string;
  isOpen?: boolean;
  existingContent?: string;
  interactiveRulesSource?: string;
  onInsert?: (text: string) => void;
  onReplace?: (text: string) => void;
}
let lastAiProps: CapturedAiProps | null = null;
/** Captured props from the last VISUAL AiAssistantModal render (IR-83B). The
 *  editor mounts TWO modal instances (rules + visual); the double routes by
 *  apiMode so the existing IR-82 assertions on lastAiProps stay untouched. */
let lastVisualAiProps: CapturedAiProps | null = null;

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

mock.module("../../shared/AiAssistantModal.js", () => ({
  ...realAiAssistantModal,
  AiAssistantModal: (props: CapturedAiProps) => {
    if (props.apiMode === "interactive_visual") {
      lastVisualAiProps = props;
    } else {
      lastAiProps = props;
    }
    return null;
  },
}));

let ExperienceEditor: typeof import("./ExperienceEditor.js").ExperienceEditor;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;

beforeAll(async () => {
  ({ act, fireEvent, render } = await import("@testing-library/react"));
  ({ ExperienceEditor } = await import("./ExperienceEditor.js"));
});

let serverScripts: ScriptRecord[];

beforeEach(() => {
  listAllScripts.mockClear();
  createScript.mockClear();
  updateScript.mockClear();
  listExperienceVisuals.mockClear();
  createExperienceVisual.mockClear();
  updateExperienceVisual.mockClear();
  useScriptDraftStore.getState().resetAll();
  useExperienceVisualDraftStore.getState().resetAll();
  lastAiProps = null;
  lastVisualAiProps = null;
  serverScripts = [];
  listAllScripts.mockImplementation(async () => serverScripts.map((s) => ({ ...s })));
  listExperienceVisuals.mockImplementation(async () => []);
  createScript.mockImplementation(async (body) => ({ ...baseScript, id: `srv_${serverScripts.length + 1}`, name: String(body.name ?? ""), code: String(body.code ?? ""), enabled: Boolean(body.enabled) }));
  updateScript.mockImplementation(async (id, patch) => {
    const current = serverScripts.find((s) => s.id === id) ?? { ...baseScript, id };
    return { ...current, ...(patch.code !== undefined ? { code: String(patch.code) } : {}), ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}) };
  });
});

describe("ExperienceEditor AI helper (IR-82)", () => {
  it("launches the assistant in interactive_rules mode with the current rules source as existingContent", async () => {
    serverScripts = [{ ...baseScript, enabled: true }];
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));

    fireEvent.click(getByRole("button", { name: "experience_editor_ai_helper" }));
    expect(lastAiProps).not.toBeNull();
    expect(lastAiProps!.apiMode).toBe("interactive_rules");
    expect(lastAiProps!.existingContent).toBe(EXISTING_CODE);
  });

  it("accepting AI output replaces the draft via the reviewed onReplace path without a silent blind overwrite", async () => {
    serverScripts = [{ ...baseScript, enabled: true }];
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    // A saved+enabled script starts trusted; the toggle is available.
    expect((getByRole("switch") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(getByRole("button", { name: "experience_editor_ai_helper" }));
    const replaceProps = lastAiProps;
    if (!replaceProps?.onReplace) throw new Error("onReplace not wired");

    // Simulate the user reviewing the diff and accepting AI-generated source.
    act(() => { replaceProps.onReplace!(AI_GENERATED_CODE); });

    const draft = useScriptDraftStore.getState().drafts["srv_1"];
    // The AI output landed in the draft buffer via the normal draft action…
    expect(draft?.values.code).toBe(AI_GENERATED_CODE);
    // …the base (last-saved source) is UNTOUCHED, so the buffer is now dirty…
    expect(draft?.base.code).toBe(EXISTING_CODE);
    expect(draft?.values.code).not.toBe(draft?.base.code);
    // …and nothing was silently persisted to the server.
    expect(updateScript).not.toHaveBeenCalled();
    expect(createScript).not.toHaveBeenCalled();
  });

  it("keeps an AI-written rules draft UNTRUSTED and the enable toggle LOCKED (IR-81A invariant)", async () => {
    serverScripts = [{ ...baseScript, enabled: true }];
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("button", { name: "experience_editor_ai_helper" }));
    const replaceProps = lastAiProps;
    if (!replaceProps?.onReplace) throw new Error("onReplace not wired");

    act(() => { replaceProps.onReplace!(AI_GENERATED_CODE); });

    // The store invariant: any interactive code change drops enabled=false.
    const draft = useScriptDraftStore.getState().drafts["srv_1"];
    expect(draft?.values.enabled).toBe(false);
    expect(draft?.values.code).toBe(AI_GENERATED_CODE);
    // Surfaced in the UI: untrusted badge + locked toggle.
    const toggle = getByRole("switch") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
    expect(await findByText("experience_editor_untrusted")).toBeTruthy();
  });

  it("onInsert writes the accepted source through the same draft action (insert path)", async () => {
    serverScripts = [{ ...baseScript, enabled: true }];
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules"));
    fireEvent.click(getByRole("button", { name: "experience_editor_ai_helper" }));
    const insertProps = lastAiProps;
    if (!insertProps?.onInsert) throw new Error("onInsert not wired");

    act(() => { insertProps.onInsert!(AI_GENERATED_CODE); });

    const draft = useScriptDraftStore.getState().drafts["srv_1"];
    // The editor stores exactly what the modal hands to onInsert (the append-vs-
    // replace decision lives inside the universal modal, not this wiring — it
    // mirrors the ScriptEditor integration exactly).
    expect(draft?.values.code).toBe(AI_GENERATED_CODE);
    // Same trust invariant: a changed interactive source is untrusted.
    expect(draft?.values.enabled).toBe(false);
    const toggle = getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});

describe("ExperienceEditor visual AI helper (IR-83B)", () => {
  const choiceStarter = getVisualStarter("choice");
  if (!choiceStarter) throw new Error("choice starter missing");
  const CHOICE_SOURCE = choiceStarter.source;
  const AI_GENERATED_VISUAL = "<!doctype html><html><body>ai-generated visual</body></html>";

  /** The single visual draft entry (the starter-created active visual). */
  function activeVisualDraft() {
    const entries = Object.values(useExperienceVisualDraftStore.getState().drafts);
    if (entries.length !== 1) throw new Error(`expected exactly one visual draft, got ${entries.length}`);
    return entries[0];
  }

  /** Render the detail view with an active rules record (provides the
   *  interactiveRulesSource channel) AND an active visual (from the Choice
   *  starter — avoids the DropdownSelect, the established starter-click pattern). */
  async function renderWithRulesAndVisual() {
    serverScripts = [{ ...baseScript, enabled: true }];
    const utils = render(<ExperienceEditor />);
    // Activate the rules so the detail view renders and interactiveRulesSource
    // is the current rules code.
    fireEvent.click(await utils.findByText("Existing Rules"));
    // Create + activate a visual from the Choice starter.
    fireEvent.click(await utils.findByText("Choice"));
    return utils;
  }

  it("launches in interactive_visual mode with the current visual source and the active rules source", async () => {
    const { getByRole } = await renderWithRulesAndVisual();
    fireEvent.click(getByRole("button", { name: "experience_editor_visual_ai_helper" }));
    expect(lastVisualAiProps).not.toBeNull();
    expect(lastVisualAiProps!.apiMode).toBe("interactive_visual");
    expect(lastVisualAiProps!.existingContent).toBe(CHOICE_SOURCE);
    expect(lastVisualAiProps!.interactiveRulesSource).toBe(EXISTING_CODE);
  });

  it("onReplace writes AI output into the visual draft without touching the base, the rules, or the server", async () => {
    const { getByRole } = await renderWithRulesAndVisual();
    fireEvent.click(getByRole("button", { name: "experience_editor_visual_ai_helper" }));
    const props = lastVisualAiProps;
    if (!props?.onReplace) throw new Error("visual onReplace not wired");

    const baseSourceBefore = activeVisualDraft()?.base.source;

    act(() => { props.onReplace!(AI_GENERATED_VISUAL); });

    const draft = activeVisualDraft();
    // AI output landed in the visual buffer via the normal draft action…
    expect(draft?.values.source).toBe(AI_GENERATED_VISUAL);
    // …the base is UNTOUCHED (no silent blind overwrite)…
    expect(draft?.base.source).toBe(baseSourceBefore);
    // …the RULES draft/code is UNCHANGED (rules immutability)…
    expect(useScriptDraftStore.getState().drafts["srv_1"]?.values.code).toBe(EXISTING_CODE);
    // …and nothing was silently persisted anywhere.
    expect(updateExperienceVisual).not.toHaveBeenCalled();
    expect(createExperienceVisual).not.toHaveBeenCalled();
    expect(updateScript).not.toHaveBeenCalled();
    expect(createScript).not.toHaveBeenCalled();
  });

  it("onInsert writes the accepted visual source through the same draft action (insert path)", async () => {
    const { getByRole } = await renderWithRulesAndVisual();
    fireEvent.click(getByRole("button", { name: "experience_editor_visual_ai_helper" }));
    const props = lastVisualAiProps;
    if (!props?.onInsert) throw new Error("visual onInsert not wired");

    act(() => { props.onInsert!(AI_GENERATED_VISUAL); });

    expect(activeVisualDraft()?.values.source).toBe(AI_GENERATED_VISUAL);
    expect(useScriptDraftStore.getState().drafts["srv_1"]?.values.code).toBe(EXISTING_CODE);
    expect(updateExperienceVisual).not.toHaveBeenCalled();
    expect(createExperienceVisual).not.toHaveBeenCalled();
  });

  it("disables the visual assistant when there is no rules source to discover a contract from", async () => {
    serverScripts = [{ ...baseScript, code: "", enabled: false }];
    const { findByText, getByRole } = render(<ExperienceEditor />);
    fireEvent.click(await findByText("Existing Rules")); // empty rules code
    fireEvent.click(await findByText("Choice")); // a visual is active

    const button = getByRole("button", { name: "experience_editor_visual_ai_helper" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(await findByText("experience_editor_visual_ai_helper_no_rules")).toBeTruthy();
  });
});

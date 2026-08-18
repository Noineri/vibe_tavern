/**
 * ExperienceSetupModal — IR-73A boundary tests.
 *
 * Boundary under test: mocked API + Experience store seams → the REAL
 * ExperienceSetupModal with the REAL shared primitives (Modal, DropdownSelect,
 * SegmentedControl, Checkbox, NumberInput, AutoTextarea) → DOM observations +
 * action-call assertions. No pure-helper substitutes; the modal drives the full
 * validate → start → capture → prepare → continue flow.
 *
 * Runner: bun:test + happy-dom (useDomEnv). i18n returns keys verbatim. The
 * Experience store is replaced by a tiny useSyncExternalStore-backed fake so
 * the component's store reads/actions are controllable while the modal itself
 * stays real. RTL cleanup() runs after every test so no stale mounted component
 * leaks across tests.
 *
 * Pinned contract areas (numbered to the IR-73A spec):
 *  1. closed/no-config/loading/discovery-error states + exact scope hydration
 *  2. all four setup fields/defaults/constraints + optional omission
 *  3. invalid required/range/select/step blocks Start with inline errors
 *  4. roster hidden without capability; with grant: exactly-one-human + validation
 *  5. model controller hidden without model grant; distinct provider/model pairs
 *  6. no providers/models and server failure → inline error, no crash/invalid start
 *  7. context UI progressive disclosure + all five canonical modes
 *  8. config update+rehydrate precedes start; noncompact capture success/failure
 *  9. compact summary starts first, never auto-generates; explicit generation/cancel/retry
 * 10. prompt overrides hidden without model grant; independent layer writes; failure blocks ready
 * 11. A→B scope switch ignores late A discovery/provider/start/capture results
 * 12. close aborts generation but never ends the session
 * 13. mobile layout contract + EN/RU labels do not rely on fixed widths
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  ExperienceChatConfigRow,
  ExperiencePromptOverridesResponse,
  ExperienceSessionResponse,
} from "../../api/types.js";
import type { ExperienceDefinitionDto } from "@vibe-tavern/api-contracts";
import type { ExperienceCapability } from "@vibe-tavern/domain";

// react-dom's event system initializes against the global window/document, so
// @testing-library/react (and react) MUST load AFTER useDomEnv() registers the
// happy-dom globals — a static hoisted import captures a DOM-less environment
// and React's delegated event listeners never attach (controlled-input onChange
// silently stops firing). Mirrors the ObjectiveConfig.test import order.
useDomEnv();
const { render, fireEvent, waitFor, cleanup } = await import("@testing-library/react");
const { useSyncExternalStore } = await import("react");

const CHAT_ID = "chat_1";
const BRANCH_ID = "branch_1";
const SCOPE_KEY = JSON.stringify([CHAT_ID, BRANCH_ID]);

// ─── fake Experience store (useSyncExternalStore-backed) ────────────────────
interface FakeState {
  config: ExperienceChatConfigRow | null;
  session: ExperienceSessionResponse | null;
  loading: boolean;
  lastError: string | null;
  activeScope: { chatId: string; branchId: string } | null;
}
let state: FakeState = { config: null, session: null, loading: false, lastError: null, activeScope: null };
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const emit = () => listeners.forEach((l) => l());
function setFakeState(patch: Partial<FakeState>): void {
  state = { ...state, ...patch };
  emit();
}

const mocks = {
  testScript: mock(),
  listProviderProfiles: mock(),
  fetchProviderProfileModels: mock(),
  getExperiencePromptOverrides: mock(),
  updateExperienceConfig: mock(),
  updateGlobalOverride: mock(),
  updateCharacterOverride: mock(),
  setScope: mock(),
  startSession: mock(),
  captureContext: mock(),
  rehydrate: mock(),
  endSession: mock(),
};

const realI18n = await import("../../i18n/context.js");
const realStore = await import("../../stores/experience-store.js");
const realSnapshotStore = await import("../../stores/snapshot-store.js");
const realScriptApi = await import("../../api/script-api.js");
const realExperienceApi = await import("../../api/experience-api.js");
const realProviderApi = await import("../../api/provider-api.js");
const realTooltip = await import("../shared/Tooltip.js");
const realMobile = await import("../../hooks/use-mobile.js");

// RP-context source picker data (report item 6): mutable fakes consumed by the
// (otherwise real) snapshot-store hooks the modal subscribes to.
let fakeAllCharacters: Array<{ id: string; name: string }> = [];
let fakeChatList: Array<{ id: string; title: string; characterId: string; lastMessageAt: string }> = [];
mock.module("../../stores/snapshot-store.js", () => ({
  ...realSnapshotStore,
  useAllCharacters: () => fakeAllCharacters,
  useChatList: () => fakeChatList,
}));

// Stable `t` object so its identity is preserved across renders — the modal's
// discovery effect depends on `t`, and a per-render closure would loop.
const stableT = {
  t: (k: string) => k,
  tDynamic: (k: string) => k,
  locale: "en",
  setLocale: () => {},
  ready: true,
};

mock.module("../../i18n/context.js", () => ({ ...realI18n, useT: () => stableT }));

mock.module("../../stores/experience-store.js", () => ({
  ...realStore,
  useExperienceConfig: () => useSyncExternalStore(subscribe, () => state.config),
  useExperienceLoading: () => useSyncExternalStore(subscribe, () => state.loading),
  useExperienceSession: () => useSyncExternalStore(subscribe, () => state.session),
  useExperienceStore: {
    getState: () => ({
      activeScope: state.activeScope,
      byScope: { [SCOPE_KEY]: { lastError: state.lastError } },
      setScope: mocks.setScope,
      startSession: mocks.startSession,
      captureContext: mocks.captureContext,
      rehydrate: mocks.rehydrate,
      endSession: mocks.endSession,
    }),
  },
}));

mock.module("../../api/script-api.js", () => ({ ...realScriptApi, testScript: mocks.testScript }));
mock.module("../../api/experience-api.js", () => ({
  ...realExperienceApi,
  getExperiencePromptOverrides: mocks.getExperiencePromptOverrides,
  updateExperienceConfig: mocks.updateExperienceConfig,
  updateExperienceGlobalOverride: mocks.updateGlobalOverride,
  updateExperienceCharacterOverride: mocks.updateCharacterOverride,
}));
mock.module("../../api/provider-api.js", () => ({
  ...realProviderApi,
  listProviderProfiles: mocks.listProviderProfiles,
  fetchProviderProfileModels: mocks.fetchProviderProfileModels,
}));

// SegmentedControl wraps options in CustomTooltip; passthrough (InsightsPanel.test pattern).
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let mobileOverride: boolean | null = null;
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => (mobileOverride !== null ? mobileOverride : false),
}));

const { ExperienceSetupModal } = await import("./ExperienceSetupModal.js");

// ─── fixtures ───────────────────────────────────────────────────────────────

function makeConfig(over: Partial<ExperienceChatConfigRow> = {}): ExperienceChatConfigRow {
  return {
    id: "cfg_1",
    chatId: CHAT_ID,
    enabled: true,
    scriptId: "s1",
    visualId: null,
    capabilityGrants: [],
    contextMode: "none",
    contextSourceCharacterId: null,
    contextSourceChatId: null,
    contextSourcePersonaId: null,
    launcherVisible: true,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

function def(
  declaredCapabilities: Array<{ capability: ExperienceCapability; reason?: string }>,
  fields?: NonNullable<ExperienceDefinitionDto["setup"]>["fields"],
): ExperienceDefinitionDto {
  const d: ExperienceDefinitionDto = {
    apiVersion: 1,
    manifest: { id: "m", name: "Game" },
    declaredCapabilities,
  };
  if (fields) d.setup = { fields };
  return d;
}

function interactiveOk(d: ExperienceDefinitionDto) {
  return { kind: "interactive", definition: d, discoveryError: null };
}

function makeSession(id = "sess_1"): ExperienceSessionResponse {
  return {
    sessionId: id,
    chatId: CHAT_ID,
    branchId: BRANCH_ID,
    manifest: { id: "m", name: "Game" },
    apiVersion: 1,
    status: "active",
    revision: 1,
    reportFrontier: 0,
    capabilityGrants: [],
    contextMode: "none",
    participants: [],
    view: { revision: 1, state: {}, actions: [], events: [], status: "active" },
    rulesRevision: 1,
    rulesSourceHash: "h",
    visualId: null,
    visualSource: null,
    visualSourceHash: null,
  } as ExperienceSessionResponse;
}

function profile(id: string, name: string, defaultModel: string | null = null) {
  return { id, name, defaultModel };
}

function makeOverrides(global: string | null, character: string | null): ExperiencePromptOverridesResponse {
  return {
    global: global === null ? null : { scope: "global", content: global, characterId: null, createdAt: "t", updatedAt: "t" },
    character: character === null ? null : { scope: "character", content: character, characterId: "c1", createdAt: "t", updatedAt: "t" },
  };
}

function setupDefaultMocks(): void {
  mocks.testScript.mockResolvedValue(interactiveOk(def([])));
  mocks.listProviderProfiles.mockResolvedValue([profile("p1", "Acme", "model-a"), profile("p2", "Beta")]);
  mocks.fetchProviderProfileModels.mockResolvedValue({ models: [{ id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }] });
  mocks.getExperiencePromptOverrides.mockResolvedValue(makeOverrides(null, null));
  mocks.updateExperienceConfig.mockResolvedValue(makeConfig());
  mocks.updateGlobalOverride.mockResolvedValue(makeOverrides("", null));
  mocks.updateCharacterOverride.mockResolvedValue(makeOverrides(null, ""));
  mocks.setScope.mockImplementation((chatId: string, branchId: string) => {
    setFakeState({ activeScope: { chatId, branchId } });
  });
  mocks.startSession.mockImplementation(async () => {
    const session = makeSession();
    setFakeState({ session, lastError: null });
    return session;
  });
  mocks.captureContext.mockImplementation(async () => ({
    sessionId: "sess_1",
    mode: "current_branch",
    branchFrontierRevision: 5,
    messageFrontierPosition: 4,
    providerProfileId: null,
    modelId: null,
    createdAt: "t",
    updatedAt: "t",
  }));
  mocks.rehydrate.mockResolvedValue(undefined);
  mocks.endSession.mockResolvedValue({});
}

function renderModal(over: Partial<React.ComponentProps<typeof ExperienceSetupModal>> = {}): RenderResult {
  return render(
    <ExperienceSetupModal
      open
      chatId={CHAT_ID}
      branchId={BRANCH_ID}
      onClose={() => {}}
      onReady={over.onReady}
      {...(over as object)}
    />,
  );
}

/** Wait until discovery completes and the Start button is actionable. */
async function whenReady(view: RenderResult): Promise<void> {
  await waitFor(() => expect(view.getByTestId("experience-setup-start")).toBeTruthy());
}

/** Set a controlled text input/textarea value via the native setter + `input`
 *  event. The modal is portaled to document.body, where React's valueTracker
 *  does not pick up a bare `fireEvent.change` target override — the native
 *  setter + dispatched `input` event is what `userEvent` does and reliably
 *  triggers React's onChange on controlled text controls. */
function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Click a SegmentedControl option by its visible label text (radios carry the
 *  label in a child span; Radix does not expose `value` as a DOM attribute). */
function clickSegment(container: ParentNode, labelText: string): void {
  const radios = container.querySelectorAll('[role="radio"]');
  const target = [...radios].find((r) => r.textContent?.trim() === labelText);
  if (!target) throw new Error(`no radio labelled "${labelText}"`);
  fireEvent.click(target);
}

/** Open a DropdownSelect (by its trigger showing `placeholderText`) and pick the
 *  item whose text matches `optionLabel` (cmdk items are matched by textContent). */
async function pickDropdown(view: RenderResult, scope: ParentNode, placeholderText: string, optionLabel: string): Promise<void> {
  const trigger = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === placeholderText,
  ) as HTMLButtonElement | undefined;
  if (!trigger) throw new Error(`no dropdown trigger "${placeholderText}"`);
  fireEvent.click(trigger);
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
  const item = [...view.baseElement.querySelectorAll("[cmdk-item]")].find(
    (i) => i.textContent?.trim() === optionLabel,
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`no cmdk item "${optionLabel}"`);
  fireEvent.click(item);
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull());
}

beforeEach(() => {
  state = { config: null, session: null, loading: false, lastError: null, activeScope: null };
  mobileOverride = null;
  setupDefaultMocks();
});

afterEach(() => {
  cleanup();
  Object.values(mocks).forEach((m) => m.mockReset());
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. States + scope hydration
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — states + scope hydration", () => {
  it("renders nothing when closed", () => {
    setFakeState({ config: makeConfig() });
    const view = render(<ExperienceSetupModal open={false} chatId={CHAT_ID} branchId={BRANCH_ID} onClose={() => {}} />);
    expect(view.queryByTestId("experience-setup-modal")).toBeNull();
  });

  it("calls setScope with exact chatId/branchId on open", async () => {
    renderModal();
    await waitFor(() => expect(mocks.setScope).toHaveBeenCalledWith(CHAT_ID, BRANCH_ID));
  });

  it("shows the loading-config state before config arrives", async () => {
    setFakeState({ loading: true, config: null });
    const view = renderModal();
    expect(view.getByText("experience_setup_loading_config")).toBeTruthy();
  });

  it("shows the no-script state when config has no scriptId", async () => {
    setFakeState({ config: makeConfig({ scriptId: null }) });
    const view = renderModal();
    expect(view.getByText("experience_setup_no_script")).toBeTruthy();
    expect(mocks.testScript).not.toHaveBeenCalled();
  });

  it("shows a discovery error box when discovery fails", async () => {
    setFakeState({ config: makeConfig() });
    mocks.testScript.mockResolvedValue({ kind: "interactive", definition: null, discoveryError: "boom" });
    const view = renderModal();
    await waitFor(() => expect(view.getByText("boom")).toBeTruthy());
    // No Start control until a clean interactive definition is discovered.
    expect(view.queryByTestId("experience-setup-start")).toBeNull();
  });

  it("does not start on a wrong-kind script", async () => {
    setFakeState({ config: makeConfig() });
    mocks.testScript.mockResolvedValue({ kind: "prompt" });
    const view = renderModal();
    await waitFor(() => expect(view.getByText("experience_setup_discovery_error")).toBeTruthy());
    expect(view.queryByTestId("experience-setup-start")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 + 3. Setup fields: defaults, constraints, validation, omission
// ═══════════════════════════════════════════════════════════════════════════

function fieldDefs() {
  return def([], [
    { kind: "text", id: "name", label: "Name", required: true, default: "Hero", minLength: 2, maxLength: 10 },
    { kind: "number", id: "rounds", label: "Rounds", default: 5, min: 1, max: 9, step: 2 },
    { kind: "boolean", id: "hardcore", label: "Hardcore", default: false },
    { kind: "select", id: "style", label: "Style", default: "aggressive", options: [{ value: "aggressive", label: "Aggressive" }, { value: "calm", label: "Calm" }] },
    { kind: "text", id: "optional_note", label: "Note" }, // no default, optional → must be omitted
  ]);
}

describe("ExperienceSetupModal — setup fields", () => {
  beforeEach(() => {
    setFakeState({ config: makeConfig() });
    mocks.testScript.mockResolvedValue(interactiveOk(fieldDefs()));
  });

  it("seeds author defaults into the four field controls", async () => {
    const view = renderModal();
    await whenReady(view);
    const text = view.baseElement.querySelector('[data-field-id="name"] textarea') as HTMLTextAreaElement;
    expect(text).toBeTruthy();
    expect(text.value).toBe("Hero");
    // NumberInput mirrors its value prop into internal state via useEffect, so
    // the seeded default lands on the DOM one effect flush AFTER whenReady's
    // Start-button condition — await it rather than racing the flush.
    const num = await waitFor(() => {
      const el = view.baseElement.querySelector('[data-field-id="rounds"] input') as HTMLInputElement;
      expect(el.value).toBe("5");
      return el;
    });
    expect(num).toBeTruthy();
    const checkbox = view.baseElement.querySelector('[data-field-id="hardcore"] [role="checkbox"]');
    expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    // select default renders as the trigger's selected label
    expect(view.getByText("Aggressive")).toBeTruthy();
  });

  it("submits seeded defaults and OMITS the optional untouched no-default field", async () => {
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    const [settings] = mocks.startSession.mock.calls[0];
    expect(settings).toEqual({ name: "Hero", rounds: 5, hardcore: false, style: "aggressive" });
    expect("optional_note" in settings).toBe(false);
  });

  it("blocks Start and shows an inline error when a required text field is cleared", async () => {
    const view = renderModal();
    await whenReady(view);
    const text = view.baseElement.querySelector('[data-field-id="name"] textarea') as HTMLTextAreaElement;
    setText(text, "");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByText("experience_setup_field_required_error")).toBeTruthy());
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("validates number range + step", async () => {
    const view = renderModal();
    await whenReady(view);
    const num = view.baseElement.querySelector('[data-field-id="rounds"] input') as HTMLInputElement;
    // step is 2, min 1 → 4 is not a whole multiple from base 1 (4-1=3, 3/2=1.5)
    setText(num, "4");
    fireEvent.blur(num);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByText("experience_setup_field_number_step")).toBeTruthy());
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("validates select membership via a real dropdown selection", async () => {
    const view = renderModal();
    await whenReady(view);
    await pickDropdown(view, view.baseElement.querySelector('[data-field-id="style"]')!, "Aggressive", "Calm");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    expect(mocks.startSession.mock.calls[0][0].style).toBe("calm");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Roster (participants capability)
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — participant roster", () => {
  it("hides the roster without the participants grant and submits participants: []", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: [] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }])));
    const view = renderModal();
    await whenReady(view);
    expect(view.queryByText("experience_setup_participants_label")).toBeNull();
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    expect(mocks.startSession.mock.calls[0][1]).toEqual([]);
  });

  it("shows the roster with one seeded human seat when granted", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["participants"] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }])));
    const view = renderModal();
    await whenReady(view);
    expect(view.getByText("experience_setup_participants_label")).toBeTruthy();
    expect(view.baseElement.querySelector('[data-seat-id="seat_1"]')).toBeTruthy();
  });

  it("blocks Start when the human seat label is blank", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["participants"] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }])));
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByText("experience_setup_roster_label_blank")).toBeTruthy());
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("blocks Start with >1 human controller", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["participants"] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }])));
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "A");
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    setText(view.baseElement.querySelector('[data-seat-id="seat_2"] input[type="text"]')!, "B");
    clickSegment(view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_controller_human");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByText("experience_setup_roster_human_count")).toBeTruthy());
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("submits a valid one-human roster with the human's name", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["participants"] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }])));
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Alice");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    const participants = mocks.startSession.mock.calls[0][1];
    expect(participants).toEqual([{ id: "seat_1", label: "Alice", controller: "human" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4b. Character-backed seats (report item 6b)
// ═══════════════════════════════════════════════════════════════════════════

/** Click a multi-select character checkbox by its visible name (the Checkbox
 *  labeled variant renders a `role=checkbox` div whose text includes the name). */
function clickCharacterCheckbox(view: RenderResult, name: string): void {
  const checkbox = [...view.baseElement.querySelectorAll('[role="checkbox"]')].find(
    (c) => c.textContent?.includes(name),
  ) as HTMLElement | undefined;
  if (!checkbox) throw new Error(`no character checkbox "${name}"`);
  fireEvent.click(checkbox);
}

describe("ExperienceSetupModal — character-backed seats", () => {
  beforeEach(() => {
    fakeAllCharacters = [
      { id: "char_a", name: "Aria" },
      { id: "char_b", name: "Bruno" },
      { id: "char_c", name: "Cara" },
    ];
    fakeChatList = [];
    setFakeState({ config: makeConfig({ capabilityGrants: ["participants", "model"] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }, { capability: "model" }])));
  });

  it("multi-adds characters as model seats with pinned characterIds and name labels", async () => {
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-add-character"));
    await waitFor(() => expect(view.getByText("experience_setup_add_character_picker_title")).toBeTruthy());
    clickCharacterCheckbox(view, "Aria");
    clickCharacterCheckbox(view, "Bruno");
    fireEvent.click(view.getByTestId("experience-setup-add-character-confirm"));
    await waitFor(() => expect(view.baseElement.querySelector('[data-seat-id="seat_3"]')).toBeTruthy());

    const seat2 = view.baseElement.querySelector('[data-seat-id="seat_2"]')!;
    const seat3 = view.baseElement.querySelector('[data-seat-id="seat_3"]')!;
    // Label defaults to the character name; a character badge is shown.
    expect((seat2.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("Aria");
    expect((seat3.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("Bruno");
    expect(seat2.querySelector('[data-testid="experience-setup-seat-character"]')).toBeTruthy();
    expect(seat3.querySelector('[data-testid="experience-setup-seat-character"]')).toBeTruthy();
    // Controller defaults to model.
    expect([...seat2.querySelectorAll('[role="radio"]')].some((r) => r.getAttribute("data-state") === "checked" && r.textContent?.trim() === "experience_setup_controller_model")).toBe(true);
  });

  it("start payload includes characterId on character seats", async () => {
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-add-character"));
    await waitFor(() => expect(view.getByText("experience_setup_add_character_picker_title")).toBeTruthy());
    clickCharacterCheckbox(view, "Aria");
    fireEvent.click(view.getByTestId("experience-setup-add-character-confirm"));
    await waitFor(() => expect(view.baseElement.querySelector('[data-seat-id="seat_2"]')).toBeTruthy());
    const seat2 = view.baseElement.querySelector('[data-seat-id="seat_2"]')!;
    await pickDropdown(view, seat2, "experience_setup_provider_placeholder", "Acme");
    await pickDropdown(view, seat2, "experience_setup_model_placeholder", "Model A");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    const participants = mocks.startSession.mock.calls[0][1];
    expect(participants).toEqual([
      { id: "seat_1", label: "Host", controller: "human" },
      { id: "seat_2", label: "Aria", controller: "model", providerProfileId: "p1", modelId: "model-a", characterId: "char_a" },
    ]);
  });

  it("allows the same character on two seats (duplicates legal)", async () => {
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    // First add.
    fireEvent.click(view.getByTestId("experience-setup-add-character"));
    await waitFor(() => expect(view.getByText("experience_setup_add_character_picker_title")).toBeTruthy());
    clickCharacterCheckbox(view, "Aria");
    fireEvent.click(view.getByTestId("experience-setup-add-character-confirm"));
    await waitFor(() => expect(view.baseElement.querySelector('[data-seat-id="seat_2"]')).toBeTruthy());
    // Second add — same character again.
    fireEvent.click(view.getByTestId("experience-setup-add-character"));
    await waitFor(() => expect(view.getByText("experience_setup_add_character_picker_title")).toBeTruthy());
    clickCharacterCheckbox(view, "Aria");
    fireEvent.click(view.getByTestId("experience-setup-add-character-confirm"));
    await waitFor(() => expect(view.baseElement.querySelector('[data-seat-id="seat_3"]')).toBeTruthy());
    expect(view.baseElement.querySelectorAll('[data-testid="experience-setup-seat-character"]').length).toBe(2);
  });

  it("switching a character seat's controller away from model strips characterId", async () => {
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-add-character"));
    await waitFor(() => expect(view.getByText("experience_setup_add_character_picker_title")).toBeTruthy());
    clickCharacterCheckbox(view, "Aria");
    fireEvent.click(view.getByTestId("experience-setup-add-character-confirm"));
    await waitFor(() => expect(view.baseElement.querySelector('[data-seat-id="seat_2"]')).toBeTruthy());
    expect(view.baseElement.querySelector('[data-seat-id="seat_2"] [data-testid="experience-setup-seat-character"]')).toBeTruthy();
    // Switch to script → the badge disappears and characterId is dropped.
    clickSegment(view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_controller_script");
    await waitFor(() => expect(view.baseElement.querySelector('[data-seat-id="seat_2"] [data-testid="experience-setup-seat-character"]')).toBeNull());
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    const seat2 = mocks.startSession.mock.calls[0][1].find((p: { id: string }) => p.id === "seat_2");
    expect(seat2).toEqual({ id: "seat_2", label: "Aria", controller: "script" });
  });

  it("hides the add-character control at the participant ceiling", async () => {
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    // 1 human + 15 script = 16 = the participant ceiling.
    for (let i = 0; i < 15; i++) fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    await waitFor(() => expect(view.getByText("experience_setup_roster_full")).toBeTruthy());
    expect(view.queryByTestId("experience-setup-add-character")).toBeNull();
    expect(view.queryByTestId("experience-setup-add-seat")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 + 6. Model seats / providers / no-provider failure
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — model seats", () => {
  beforeEach(() => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["participants", "model"] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }, { capability: "model" }])));
  });

  it("hides the model controller option without the model grant", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["participants"] }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "participants" }, { capability: "model" }])));
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    const seat2 = view.baseElement.querySelector('[data-seat-id="seat_2"]')!;
    expect([...seat2.querySelectorAll('[role="radio"]')].some((r) => r.textContent?.trim() === "experience_setup_controller_model")).toBe(false);
  });

  it("two model seats pin distinct provider/model pairs", async () => {
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    // Model seats still require a bounded non-blank label (participant schema).
    setText(view.baseElement.querySelector('[data-seat-id="seat_2"] input[type="text"]')!, "Bot1");
    setText(view.baseElement.querySelector('[data-seat-id="seat_3"] input[type="text"]')!, "Bot2");
    for (const seatId of ["seat_2", "seat_3"]) {
      clickSegment(view.baseElement.querySelector(`[data-seat-id="${seatId}"]`)!, "experience_setup_controller_model");
    }
    await pickDropdown(view, view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_provider_placeholder", "Acme");
    await pickDropdown(view, view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_model_placeholder", "Model A");
    await pickDropdown(view, view.baseElement.querySelector('[data-seat-id="seat_3"]')!, "experience_setup_provider_placeholder", "Beta");
    await pickDropdown(view, view.baseElement.querySelector('[data-seat-id="seat_3"]')!, "experience_setup_model_placeholder", "Model B");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    const participants = mocks.startSession.mock.calls[0][1];
    const seat2 = participants.find((p: any) => p.id === "seat_2");
    const seat3 = participants.find((p: any) => p.id === "seat_3");
    expect(seat2).toEqual({ id: "seat_2", label: "Bot1", controller: "model", providerProfileId: "p1", modelId: "model-a" });
    expect(seat3).toEqual({ id: "seat_3", label: "Bot2", controller: "model", providerProfileId: "p2", modelId: "model-b" });
  });

  it("blocks Start and shows an inline error when a model seat lacks provider/model", async () => {
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    setText(view.baseElement.querySelector('[data-seat-id="seat_2"] input[type="text"]')!, "Bot");
    clickSegment(view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_controller_model");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByText("experience_setup_model_seat_incomplete")).toBeTruthy());
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("shows an inline no-providers error when no profiles are configured", async () => {
    mocks.listProviderProfiles.mockResolvedValue([]);
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    clickSegment(view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_controller_model");
    await waitFor(() => expect(view.getByText("experience_setup_no_providers")).toBeTruthy());
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).not.toHaveBeenCalled());
  });

  it("a server start failure surfaces as an inline error and never crashes", async () => {
    mocks.startSession.mockImplementation(async () => {
      setFakeState({ lastError: "no_provider" });
      return null;
    });
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByText("no_provider")).toBeTruthy());
    expect(view.getByTestId("experience-setup-start")).toBeTruthy();
  });

  it("switching a model seat's provider clears its pinned model", async () => {
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    setText(view.baseElement.querySelector('[data-seat-id="seat_2"] input[type="text"]')!, "Bot");
    clickSegment(view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_controller_model");
    const seat2 = view.baseElement.querySelector('[data-seat-id="seat_2"]')!;
    await pickDropdown(view, seat2, "experience_setup_provider_placeholder", "Acme");
    await pickDropdown(view, seat2, "experience_setup_model_placeholder", "Model A");
    // The model trigger now shows the selected model label.
    expect([...seat2.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Model A")).toBe(true);
    // Switch provider → the pinned model is cleared (trigger reverts to placeholder).
    await pickDropdown(view, seat2, "Acme", "Beta");
    expect([...seat2.querySelectorAll("button")].some((b) => b.textContent?.trim() === "experience_setup_model_placeholder")).toBe(true);
  });

  it("a configured profile's default model is selectable even when the listing omits it", async () => {
    // p1 lists only model-b; its configured defaultModel (model-a) must still be offered.
    mocks.fetchProviderProfileModels.mockResolvedValue({ models: [{ id: "model-b", label: "Model B" }] });
    const view = renderModal();
    await whenReady(view);
    setText(view.baseElement.querySelector('[data-seat-id="seat_1"] input[type="text"]')!, "Host");
    fireEvent.click(view.getByTestId("experience-setup-add-seat"));
    setText(view.baseElement.querySelector('[data-seat-id="seat_2"] input[type="text"]')!, "Bot");
    clickSegment(view.baseElement.querySelector('[data-seat-id="seat_2"]')!, "experience_setup_controller_model");
    const seat2 = view.baseElement.querySelector('[data-seat-id="seat_2"]')!;
    await pickDropdown(view, seat2, "experience_setup_provider_placeholder", "Acme");
    await pickDropdown(view, seat2, "experience_setup_model_placeholder", "model-a");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    const seat2p = mocks.startSession.mock.calls[0][1].find((p: any) => p.id === "seat_2");
    expect(seat2p.modelId).toBe("model-a");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 + 8. Context UI + start-prepare state machine
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — context mode", () => {
  beforeEach(() => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["rp_context"], contextMode: "none" }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "rp_context" }])));
  });

  it("hides context controls without the rp_context grant", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: [] }) });
    const view = renderModal();
    await whenReady(view);
    expect(view.queryByText("experience_setup_context_label")).toBeNull();
  });

  it("renders all five canonical context modes", async () => {
    const view = renderModal();
    await whenReady(view);
    const labels = [...view.baseElement.querySelectorAll('[role="radio"]')].map((r) => r.textContent?.trim());
    expect(labels).toEqual([
      "experience_context_none",
      "experience_context_current_branch",
      "experience_context_recent",
      "experience_context_summaries_recent",
      "experience_context_compact_summary",
    ]);
  });

  it("updates config + rehydrates before start when the local mode differs", async () => {
    const view = renderModal();
    await whenReady(view);
    clickSegment(view.baseElement, "experience_context_current_branch");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    // The source fields always ride along (nulls = ambient) — one patch, one
    // source of truth for the capture that follows start.
    await waitFor(() =>
      expect(mocks.updateExperienceConfig).toHaveBeenCalledWith(CHAT_ID, {
        contextMode: "current_branch",
        contextSourceCharacterId: null,
        contextSourceChatId: null,
      }),
    );
    await waitFor(() => expect(mocks.rehydrate).toHaveBeenCalledWith(CHAT_ID, BRANCH_ID));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    // config update precedes start
    expect(mocks.updateExperienceConfig.mock.invocationCallOrder[0]).toBeLessThan(mocks.startSession.mock.invocationCallOrder[0]);
  });

  it("noncompact capture succeeds then Continue fires onReady", async () => {
    const onReady = mock();
    setFakeState({ config: makeConfig({ capabilityGrants: ["rp_context"], contextMode: "current_branch" }) });
    const view = renderModal({ onReady });
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByTestId("experience-setup-continue")).toBeTruthy());
    expect(mocks.captureContext).toHaveBeenCalledTimes(1);
    expect(mocks.captureContext.mock.calls[0][0]).toEqual({ mode: "current_branch" });
    fireEvent.click(view.getByTestId("experience-setup-continue"));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it("noncompact capture failure blocks Continue (stays capturing with retry)", async () => {
    mocks.captureContext.mockImplementation(async () => null);
    setFakeState({ config: makeConfig({ capabilityGrants: ["rp_context"], contextMode: "recent" }) });
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByText("experience_setup_capture_error")).toBeTruthy());
    expect(view.queryByTestId("experience-setup-continue")).toBeNull();
    expect(view.getByTestId("experience-setup-retry-capture")).toBeTruthy();
  });

  it("none mode does not capture and Continue fires immediately", async () => {
    const onReady = mock();
    const view = renderModal({ onReady });
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByTestId("experience-setup-continue")).toBeTruthy());
    expect(mocks.captureContext).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Compact summary
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — compact summary", () => {
  beforeEach(() => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["rp_context"], contextMode: "compact_summary" }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "rp_context" }])));
  });

  it("starts first and never auto-generates; explicit Generate forwards mode/provider/model", async () => {
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    // NO automatic capture
    expect(mocks.captureContext).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByTestId("experience-setup-generate-summary")).toBeTruthy());
    await pickDropdown(view, view.baseElement, "experience_setup_provider_placeholder", "Acme");
    await pickDropdown(view, view.baseElement, "experience_setup_model_placeholder", "Model A");
    fireEvent.click(view.getByTestId("experience-setup-generate-summary"));
    await waitFor(() => expect(mocks.captureContext).toHaveBeenCalledTimes(1));
    const [body, signal] = mocks.captureContext.mock.calls[0];
    expect(body).toEqual({ mode: "compact_summary", providerProfileId: "p1", model: "model-a" });
    expect(signal).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(view.getByTestId("experience-setup-continue")).toBeTruthy());
  });

  it("cancel during generation aborts and retains the session (no endSession)", async () => {
    mocks.captureContext.mockImplementation(async (_body: any, signal: AbortSignal) => {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(null));
      });
    });
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByTestId("experience-setup-generate-summary")).toBeTruthy());
    fireEvent.click(view.getByTestId("experience-setup-generate-summary"));
    await waitFor(() => expect(view.getByTestId("experience-setup-cancel-generate")).toBeTruthy());
    fireEvent.click(view.getByTestId("experience-setup-cancel-generate"));
    await waitFor(() => expect(view.getByTestId("experience-setup-generate-summary")).toBeTruthy());
    expect(mocks.endSession).not.toHaveBeenCalled();
  });

  it("generation failure retains the session and allows retry", async () => {
    mocks.captureContext.mockResolvedValueOnce(null);
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByTestId("experience-setup-generate-summary")).toBeTruthy());
    fireEvent.click(view.getByTestId("experience-setup-generate-summary"));
    await waitFor(() => expect(view.getByText("experience_setup_generate_error")).toBeTruthy());
    expect(view.queryByTestId("experience-setup-continue")).toBeNull();
    fireEvent.click(view.getByTestId("experience-setup-generate-summary"));
    await waitFor(() => expect(view.getByTestId("experience-setup-continue")).toBeTruthy());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Prompt overrides (model grant gate)
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — prompt overrides", () => {
  beforeEach(() => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["model"], contextMode: "none" }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "model" }])));
  });

  it("never renders overrides without the model grant", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: [], contextMode: "none" }) });
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(view.getByTestId("experience-setup-continue")).toBeTruthy());
    expect(view.queryByText("experience_setup_overrides_label")).toBeNull();
  });

  it("loads both layers after start and writes only the independently changed layer", async () => {
    mocks.getExperiencePromptOverrides.mockResolvedValue(makeOverrides("global-old", "char-old"));
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    // Wait until the override layers have actually loaded into the drafts.
    await waitFor(() => expect((view.getByTestId("experience-setup-override-character") as HTMLTextAreaElement).value).toBe("char-old"));
    setText(view.getByTestId("experience-setup-override-character") as HTMLTextAreaElement, "char-new");
    fireEvent.click(view.getByTestId("experience-setup-continue"));
    await waitFor(() => expect(mocks.updateCharacterOverride).toHaveBeenCalledWith("sess_1", { content: "char-new" }));
    expect(mocks.updateGlobalOverride).not.toHaveBeenCalled();
  });

  it("empty content clears an existing layer; empty-from-null issues no write", async () => {
    mocks.getExperiencePromptOverrides.mockResolvedValue(makeOverrides("g", null));
    const view = renderModal();
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect((view.getByTestId("experience-setup-override-global") as HTMLTextAreaElement).value).toBe("g"));
    setText(view.getByTestId("experience-setup-override-global") as HTMLTextAreaElement, "");
    fireEvent.click(view.getByTestId("experience-setup-continue"));
    await waitFor(() => expect(mocks.updateGlobalOverride).toHaveBeenCalledWith("sess_1", { content: "" }));
    expect(mocks.updateCharacterOverride).not.toHaveBeenCalled();
  });

  it("a failing override write blocks onReady (stays visible with error)", async () => {
    mocks.getExperiencePromptOverrides.mockResolvedValue(makeOverrides("g", null));
    mocks.updateGlobalOverride.mockRejectedValue(new Error("boom"));
    const onReady = mock();
    const view = renderModal({ onReady });
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect((view.getByTestId("experience-setup-override-global") as HTMLTextAreaElement).value).toBe("g"));
    setText(view.getByTestId("experience-setup-override-global") as HTMLTextAreaElement, "changed");
    fireEvent.click(view.getByTestId("experience-setup-continue"));
    await waitFor(() => expect(view.getByText("experience_setup_overrides_save_error")).toBeTruthy());
    expect(onReady).not.toHaveBeenCalled();
    expect(mocks.endSession).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. A→B scope switch ignores late A results
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — scope switch", () => {
  it("a late A discovery result does not paint after switching to B", async () => {
    setFakeState({ config: makeConfig() });
    let resolveA!: (v: any) => void;
    mocks.testScript.mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    const view = renderModal();
    // switch to branch B before A resolves
    view.rerender(<ExperienceSetupModal open chatId={CHAT_ID} branchId="branch_B" onClose={() => {}} />);
    // resolve A late (would paint a ghost field if applied)
    resolveA(interactiveOk(def([], [{ kind: "text", id: "ghost", label: "Ghost" }])));
    await waitFor(() => expect(mocks.testScript).toHaveBeenCalledTimes(2));
    await whenReady(view);
    expect(view.baseElement.querySelector('[data-field-id="ghost"]')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Close aborts generation, never ends the session
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — close + session preservation", () => {
  it("closing during capture aborts the in-flight capture and never ends the session", async () => {
    setFakeState({ config: makeConfig({ capabilityGrants: ["rp_context"], contextMode: "current_branch" }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "rp_context" }])));
    let abortSignal: AbortSignal | null = null;
    mocks.captureContext.mockImplementation(async (_b: any, signal: AbortSignal) => {
      abortSignal = signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
    });
    const onClose = mock();
    const view = renderModal({ onClose });
    await whenReady(view);
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(abortSignal).not.toBeNull());
    fireEvent.click(view.getByTestId("experience-setup-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(abortSignal!.aborted).toBe(true));
    expect(mocks.endSession).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Mobile layout + no fixed-width labels
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — layout", () => {
  it("mobile uses a full-bleed panel; desktop uses a viewport-relative width (no fixed px)", async () => {
    setFakeState({ config: makeConfig() });
    mocks.testScript.mockResolvedValue(interactiveOk(def([])));
    mobileOverride = true;
    const view = renderModal();
    await whenReady(view);
    const panel = view.getByTestId("experience-setup-modal");
    expect(panel.className).toContain("h-full");
    expect(panel.className).toContain("w-full");
  });

  it("desktop panel width is viewport-relative (min/vw), not a fixed pixel width", async () => {
    setFakeState({ config: makeConfig() });
    mocks.testScript.mockResolvedValue(interactiveOk(def([])));
    mobileOverride = false;
    const view = renderModal();
    await whenReady(view);
    const panel = view.getByTestId("experience-setup-modal");
    expect(panel.className).toContain("94vw");
    const labels = view.baseElement.querySelectorAll("span.uppercase");
    labels.forEach((l) => expect(l.className).not.toContain("w-["));
  });

  // IR-90A: the opaque panel surfaces must use an ESTABLISHED color token.
  // `bg-s1` is a nonexistent token (renders transparent) — both the mobile
  // and the desktop panel must render with `bg-surface` and never `bg-s1`.
  it("mobile + desktop panels use the bg-surface token, never the nonexistent bg-s1", async () => {
    setFakeState({ config: makeConfig() });
    mocks.testScript.mockResolvedValue(interactiveOk(def([])));

    mobileOverride = true;
    const mobileView = renderModal();
    await whenReady(mobileView);
    const mobilePanel = mobileView.getByTestId("experience-setup-modal");
    expect(mobilePanel.className).toContain("bg-surface");
    expect(mobilePanel.className).not.toContain("bg-s1");
    cleanup();

    mobileOverride = false;
    const desktopView = renderModal();
    await whenReady(desktopView);
    const desktopPanel = desktopView.getByTestId("experience-setup-modal");
    expect(desktopPanel.className).toContain("bg-surface");
    expect(desktopPanel.className).not.toContain("bg-s1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. RP-context source picker (report item 6)
// ═══════════════════════════════════════════════════════════════════════════

describe("ExperienceSetupModal — context source picker", () => {
  beforeEach(() => {
    fakeAllCharacters = [
      { id: "char_a", name: "Aria" },
      { id: "char_b", name: "Bruno" },
    ];
    fakeChatList = [
      { id: "chat_b1", title: "Bruno thread", characterId: "char_b", lastMessageAt: "2026-01-02T00:00:00Z" },
      { id: "chat_b2", title: "Bruno older", characterId: "char_b", lastMessageAt: "2026-01-01T00:00:00Z" },
    ];
    setFakeState({ config: makeConfig({ capabilityGrants: ["rp_context"], contextMode: "recent" }) });
    mocks.testScript.mockResolvedValue(interactiveOk(def([{ capability: "rp_context" }])));
  });

  it("shows the ambient preview when nothing is chosen; no config write at start", async () => {
    const view = renderModal();
    await whenReady(view);
    expect(view.getByTestId("experience-setup-source-preview").textContent).toBe("experience_setup_source_preview_ambient");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    expect(mocks.updateExperienceConfig).not.toHaveBeenCalled();
  });

  it("picking a chat auto-substitutes its character; both persist at start", async () => {
    const view = renderModal();
    await whenReady(view);
    await pickDropdown(view, view.baseElement, "experience_setup_source_chat_placeholder", "Bruno thread");
    expect(view.getByTestId("experience-setup-source-preview").textContent).toBe("experience_setup_source_preview_both");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() =>
      expect(mocks.updateExperienceConfig).toHaveBeenCalledWith(CHAT_ID, {
        contextSourceCharacterId: "char_b",
        contextSourceChatId: "chat_b1",
      }),
    );
  });

  it("picking a character scopes the chat list; switching character drops the mismatched chat", async () => {
    const view = renderModal();
    await whenReady(view);
    // Pick the character first — the chat list is then scoped to his chats.
    await pickDropdown(view, view.baseElement, "experience_setup_source_character_placeholder", "Bruno");
    await pickDropdown(view, view.baseElement, "experience_setup_source_chat_placeholder", "Bruno older");
    expect(view.getByTestId("experience-setup-source-preview").textContent).toBe("experience_setup_source_preview_both");
    // Switch to Aria — the Bruno chat no longer fits and is dropped.
    await pickDropdown(view, view.baseElement, "Bruno", "Aria");
    expect(view.getByTestId("experience-setup-source-preview").textContent).toBe("experience_setup_source_preview_character");
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() =>
      expect(mocks.updateExperienceConfig).toHaveBeenCalledWith(CHAT_ID, {
        contextSourceCharacterId: "char_a",
        contextSourceChatId: null,
      }),
    );
  });

  it("initializes from the confirmed config source (init-once)", async () => {
    setFakeState({
      config: makeConfig({
        capabilityGrants: ["rp_context"],
        contextMode: "recent",
        contextSourceCharacterId: "char_b",
        contextSourceChatId: "chat_b2",
      }),
    });
    const view = renderModal();
    await whenReady(view);
    expect(view.getByTestId("experience-setup-source-preview").textContent).toBe("experience_setup_source_preview_both");
    // No config write happens when nothing differs.
    fireEvent.click(view.getByTestId("experience-setup-start"));
    await waitFor(() => expect(mocks.startSession).toHaveBeenCalledTimes(1));
    expect(mocks.updateExperienceConfig).not.toHaveBeenCalled();
  });
});

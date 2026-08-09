/**
 * ExperienceAssignment — IR-72A boundary tests.
 *
 * Boundary under test: API mocks (listAllScripts / testScript /
 * listExperienceVisuals) → the REAL ExperienceAssignment with the REAL shared
 * primitives (DropdownSelect, Toggle, SegmentedControl, EmptyState) → DOM +
 * onPatch / onValidityChange observations. No pure-helper substitutes.
 *
 * Pinned behavior (per the IR-72A contract):
 *  1. The script selector lists ONLY interactive-kind scripts; the visual
 *     selector is independent and optional.
 *  2. A valid no-capability package is READY and shows the offline message —
 *     no model/context controls appear.
 *  3. Capability rows show the localized label + author reason; grant patches
 *     contain only values from the CURRENT declaration (stale preexisting
 *     grants are never re-emitted).
 *  4. Selecting a script immediately patches {scriptId, grants: [], context:
 *     "none"}; a stale discovery from a previous selection never renders.
 *  5. Loading / wrong-kind / null-definition / discovery-error / rejected
 *     discovery states are all NOT ready and hide capability controls.
 *  6. Context modes appear only when rp_context is declared AND granted; all
 *     five canonical modes patch through; revocation resets context to none.
 *  7. The model note appears only when model is declared AND granted (Variant
 *     A: provider/model pinning lives in IR-73A setup, never here).
 *  8. The launcher toggle patches only launcherVisible; pending disables
 *     every control.
 *  9. Rejected list loads and unmount mid-discovery write no stale state.
 *
 * Runner: bun:test + happy-dom (useDomEnv). The i18n context returns keys
 * verbatim; assertions check key strings (jest-dom matchers are avoided on
 * purpose — plain getAttribute keeps the file typecheck-clean).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { render, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceAssignmentProps } from "./ExperienceAssignment.js";

useDomEnv();

// Shared mock state is defined before the module registrations.
const mocks = {
  listAllScripts: mock(),
  testScript: mock(),
  listExperienceVisuals: mock(),
  onPatch: mock(),
  onValidityChange: mock(),
};

const realI18nContext = await import("../../../i18n/context.js");
const realScriptApi = await import("../../../api/script-api.js");
const realExperienceApi = await import("../../../api/experience-api.js");
const realTooltip = await import("../../shared/Tooltip.js");

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    // Return the key verbatim — assertions check for key strings.
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("../../../api/script-api.js", () => ({
  ...realScriptApi,
  listAllScripts: mocks.listAllScripts,
  testScript: mocks.testScript,
}));

mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  listExperienceVisuals: mocks.listExperienceVisuals,
}));

// SegmentedControl wraps tooltip'd options in CustomTooltip, which needs a
// Radix TooltipProvider. Presentational here — passthrough (same pattern as
// InsightsPanel.test.tsx) so the real SegmentedControl radios are exercised.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const { ExperienceAssignment } = await import("./ExperienceAssignment.js");

const CHAT_ID = brandId<ChatId>("chat_1");

/** Minimal script row; the component only reads id/name/scriptKind. */
function scriptRec(id: string, name: string, scriptKind: string) {
  return {
    id,
    name,
    description: "",
    code: "",
    scriptKind,
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    enabled: true,
    sortOrder: 0,
  };
}

/** Minimal global visual row; the component only reads id/name. */
function visualRec(id: string, name: string) {
  return { id, name };
}

/** Clean interactive discovery result (IR-12 registration succeeded). */
function interactiveOk(manifestId: string, name: string, declaredCapabilities: Array<{ capability: string; reason?: string }>) {
  return {
    kind: "interactive",
    definition: { apiVersion: 1, manifest: { id: manifestId, name }, declaredCapabilities },
    discoveryError: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function propsFor(overrides: Partial<ExperienceAssignmentProps> = {}): ExperienceAssignmentProps {
  return {
    chatId: CHAT_ID,
    scriptId: null,
    visualId: null,
    capabilityGrants: [],
    contextMode: "none",
    launcherVisible: false,
    onPatch: mocks.onPatch,
    pending: false,
    onValidityChange: mocks.onValidityChange,
    ...overrides,
  };
}

function renderAssignment(overrides: Partial<ExperienceAssignmentProps> = {}): RenderResult {
  return render(<ExperienceAssignment {...propsFor(overrides)} />);
}

/** The DropdownSelect trigger button currently showing `text` (role-scoped —
 *  the discovered manifest can repeat the same text outside the trigger). */
function triggerWithText(view: RenderResult, text: string): HTMLElement {
  return view.getByRole("button", { name: text });
}

/** Open a DropdownSelect and return the mounted cmdk items (portaled to body).
 *  Waits for the trigger to leave its disabled (pointer-events-none) state so
 *  callers don't race the list loads. */
async function openDropdown(view: RenderResult, triggerText: string): Promise<HTMLElement[]> {
  await waitFor(() => expect(triggerWithText(view, triggerText).className).not.toContain("pointer-events-none"));
  fireEvent.click(triggerWithText(view, triggerText));
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
  return [...view.baseElement.querySelectorAll("[cmdk-item]")] as HTMLElement[];
}

/** Wait for the portaled dropdown content to unmount after a selection. */
async function closeDropdown(view: RenderResult): Promise<void> {
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull());
}

/** The grant Toggle inside the capability row labeled `labelKey`. */
function capabilitySwitch(view: RenderResult, labelKey: string): HTMLElement {
  const label = view.getByText(labelKey);
  const row = label.parentElement?.parentElement;
  if (!row) throw new Error(`no capability row for ${labelKey}`);
  return within(row as HTMLElement).getByRole("switch");
}

function validityCalls(): unknown[] {
  return mocks.onValidityChange.mock.calls.map((c) => c[0]);
}

afterEach(() => {
  mocks.listAllScripts.mockReset();
  mocks.testScript.mockReset();
  mocks.listExperienceVisuals.mockReset();
  mocks.onPatch.mockReset();
  mocks.onValidityChange.mockReset();
});

describe("ExperienceAssignment (IR-72A)", () => {
  beforeEach(() => {
    mocks.listAllScripts.mockResolvedValue([]);
    mocks.listExperienceVisuals.mockResolvedValue([]);
    mocks.testScript.mockResolvedValue(interactiveOk("m", "M", []));
  });

  it("lists only interactive-kind scripts; selecting one clears grants + context; visual is independent and optional", async () => {
    mocks.listAllScripts.mockResolvedValue([
      scriptRec("p1", "Prompt Helper", "prompt"),
      scriptRec("d1", "Fate Die", "dice"),
      scriptRec("s1", "Tic-Tac-Toe", "interactive"),
      scriptRec("s2", "Durak", "interactive"),
    ]);
    mocks.listExperienceVisuals.mockResolvedValue([visualRec("v1", "Grid Board")]);

    const view = renderAssignment();

    // No selection → no discovery request, reported not-ready once (mount).
    await view.findByRole("button", { name: "experience_assign_script_placeholder" });
    expect(mocks.testScript).not.toHaveBeenCalled();
    expect(validityCalls()).toEqual([false]);

    // Script dropdown contains ONLY the interactive scripts (+ the none row).
    const scriptItems = await openDropdown(view, "experience_assign_script_placeholder");
    const scriptTexts = scriptItems.map((i) => i.textContent);
    expect(scriptTexts).toContain("Tic-Tac-Toe");
    expect(scriptTexts).toContain("Durak");
    expect(scriptTexts).toContain("experience_assign_no_script_option");
    expect(scriptTexts).not.toContain("Prompt Helper");
    expect(scriptTexts).not.toContain("Fate Die");

    // Selecting a script immediately patches the selection with cleared
    // grants + context (BEFORE any discovery of the new script).
    fireEvent.click(scriptItems.find((i) => i.textContent === "Tic-Tac-Toe")!);
    expect(mocks.onPatch).toHaveBeenCalledWith({ scriptId: "s1", capabilityGrants: [], contextMode: "none" });
    await closeDropdown(view);

    // The visual selector is independent: it lists global visuals and patches
    // ONLY visualId — never the script or grants.
    const visualItems = await openDropdown(view, "experience_assign_visual_placeholder");
    const visualTexts = visualItems.map((i) => i.textContent);
    expect(visualTexts).toContain("Grid Board");
    expect(visualTexts).toContain("experience_assign_no_visual_option");
    fireEvent.click(visualItems.find((i) => i.textContent === "Grid Board")!);
    expect(mocks.onPatch).toHaveBeenCalledWith({ visualId: "v1" });
  });

  it("clears the selection through the none option with an immediate grants/context reset", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Tic-Tac-Toe", "interactive")]);
    const view = renderAssignment({ scriptId: "s1", capabilityGrants: ["participants"], contextMode: "recent" });
    // Discovery of the default no-capability package finished.
    await view.findByText("experience_assign_no_capabilities");
    const items = await openDropdown(view, "Tic-Tac-Toe");
    fireEvent.click(items.find((i) => i.textContent === "experience_assign_no_script_option")!);
    expect(mocks.onPatch).toHaveBeenCalledWith({ scriptId: null, capabilityGrants: [], contextMode: "none" });
  });

  it("a valid no-capability package reports ready, shows the offline message, and has no model/context controls", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Tic-Tac-Toe", "interactive")]);
    mocks.testScript.mockResolvedValue(interactiveOk("tic-tac-toe", "Tic-Tac-Toe", []));

    const view = renderAssignment({ scriptId: "s1" });

    // Manifest identity + the explicit offline/no-capabilities state.
    await view.findByText("experience_assign_no_capabilities");
    expect(view.getByText("tic-tac-toe")).toBeTruthy(); // manifest id (unique)
    expect(view.getAllByText("Tic-Tac-Toe").length).toBeGreaterThan(0);
    expect(mocks.testScript).toHaveBeenCalledWith("s1", {});

    // Empty-but-valid is READY.
    await waitFor(() => expect(validityCalls().at(-1)).toBe(true));

    // No capability toggles (only the launcher switch), no context radios, no
    // model note — an offline package gets zero capability UI.
    expect(view.getAllByRole("switch")).toHaveLength(1);
    expect(view.queryByRole("radiogroup")).toBeNull();
    expect(view.queryByText("experience_assign_model_note")).toBeNull();
  });

  it("renders declared capability labels + author reasons; granting emits only the declared subset", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Durak", "interactive")]);
    mocks.testScript.mockResolvedValue(
      interactiveOk("durak", "Durak", [
        { capability: "participants", reason: "Needs the seat roster." },
        { capability: "deterministic_random" },
      ]),
    );

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_cap_participants");
    // Localized label + author-supplied reason rendered as data.
    expect(view.getByText("Needs the seat roster.")).toBeTruthy();
    expect(view.getByText("experience_cap_deterministic_random")).toBeTruthy();

    // Grant participants: the patch is exactly the granted subset.
    fireEvent.click(capabilitySwitch(view, "experience_cap_participants"));
    expect(mocks.onPatch).toHaveBeenCalledWith({ capabilityGrants: ["participants"] });

    // Parent applies the patch (controlled) → granting the second capability
    // appends to the live grants.
    view.rerender(<ExperienceAssignment {...propsFor({ scriptId: "s1", capabilityGrants: ["participants"] })} />);
    await view.findByText("experience_cap_participants");
    fireEvent.click(capabilitySwitch(view, "experience_cap_deterministic_random"));
    expect(mocks.onPatch).toHaveBeenCalledWith({ capabilityGrants: ["participants", "deterministic_random"] });
  });

  it("never re-emits stale preexisting grants outside the current declaration", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Tic-Tac-Toe", "interactive")]);
    // The package declares ONLY participants; the stored config carries a
    // stale "model" grant (e.g. left over from a previously selected script).
    mocks.testScript.mockResolvedValue(
      interactiveOk("tic-tac-toe", "Tic-Tac-Toe", [{ capability: "participants" }]),
    );

    const view = renderAssignment({ scriptId: "s1", capabilityGrants: ["model", "participants"] });
    await view.findByText("experience_cap_participants");

    // The stale grant is display-off (no model row, no model note).
    expect(view.queryByText("experience_cap_model")).toBeNull();
    expect(view.queryByText("experience_assign_model_note")).toBeNull();

    // Revoking the live grant emits [] — "model" is filtered, never re-shipped.
    fireEvent.click(capabilitySwitch(view, "experience_cap_participants"));
    expect(mocks.onPatch).toHaveBeenCalledWith({ capabilityGrants: [] });

    // Granting from a stale-only baseline likewise drops the stale value.
    mocks.onPatch.mockReset();
    view.rerender(<ExperienceAssignment {...propsFor({ scriptId: "s1", capabilityGrants: ["model"] })} />);
    await view.findByText("experience_cap_participants");
    fireEvent.click(capabilitySwitch(view, "experience_cap_participants"));
    expect(mocks.onPatch).toHaveBeenCalledWith({ capabilityGrants: ["participants"] });
  });

  it("a stale discovery from a previous selection never renders against the current one", async () => {
    mocks.listAllScripts.mockResolvedValue([
      scriptRec("s1", "Tic-Tac-Toe", "interactive"),
      scriptRec("s2", "Durak", "interactive"),
    ]);
    const d1 = deferred<unknown>();
    const d2 = deferred<unknown>();
    mocks.testScript.mockImplementation((id: string) => (id === "s1" ? d1.promise : d2.promise));

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_discovering");

    // Switch to s2 BEFORE s1's discovery resolves.
    view.rerender(<ExperienceAssignment {...propsFor({ scriptId: "s2" })} />);
    await view.findByText("experience_assign_discovering");
    d2.resolve(interactiveOk("durak", "Durak", [{ capability: "participants" }]));
    await view.findByText("experience_cap_participants");
    expect(view.getByText("durak")).toBeTruthy(); // manifest id (unique)

    // Now s1's stale discovery lands — it must not paint s1's package.
    d1.resolve(interactiveOk("tic-tac-toe", "Tic-Tac-Toe", [{ capability: "rp_context" }]));
    await new Promise((r) => setTimeout(r, 30));
    expect(view.queryByText("experience_cap_rp_context")).toBeNull();
    expect(view.getByText("durak")).toBeTruthy();
    // Readiness transitioned exactly false → true; no flap from the stale result.
    expect(validityCalls()).toEqual([false, true]);
  });

  it("discovery loading is not-ready and hides capability controls", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Tic-Tac-Toe", "interactive")]);
    mocks.testScript.mockImplementation(() => new Promise(() => {}));

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_discovering");
    expect(validityCalls()).toEqual([false]);
    // Only the launcher switch exists while discovery is in flight.
    expect(view.getAllByRole("switch")).toHaveLength(1);
    expect(view.queryByRole("radiogroup")).toBeNull();
  });

  it("a discovery VM error shows the raw message and is not-ready", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Broken", "interactive")]);
    mocks.testScript.mockResolvedValue({ kind: "interactive", definition: null, discoveryError: "SyntaxError: Unexpected token" });

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_error_discovery");
    // ScriptTester precedent: the raw discovery error is local validation feedback.
    expect(view.getByText("SyntaxError: Unexpected token")).toBeTruthy();
    expect(validityCalls().at(-1)).toBe(false);
    expect(view.getAllByRole("switch")).toHaveLength(1);
  });

  it("a wrong-kind test result is invalid", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Prompt Helper", "interactive")]);
    mocks.testScript.mockResolvedValue({ kind: "prompt", personality: "", scenario: "", state: {}, injectedMessages: [], console: [], shared: {}, errors: [] });

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_error_wrong_kind");
    expect(validityCalls().at(-1)).toBe(false);
    expect(view.getAllByRole("switch")).toHaveLength(1);
  });

  it("a null definition without a discovery error is invalid", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Empty", "interactive")]);
    mocks.testScript.mockResolvedValue({ kind: "interactive", definition: null, discoveryError: null });

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_error_invalid");
    expect(validityCalls().at(-1)).toBe(false);
    expect(view.getAllByRole("switch")).toHaveLength(1);
  });

  it("a rejected discovery request is invalid and shows the API error message", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Gone", "interactive")]);
    mocks.testScript.mockRejectedValue(new Error("Request failed: 404"));

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_error_load");
    expect(view.getByText("Request failed: 404")).toBeTruthy();
    expect(validityCalls().at(-1)).toBe(false);
    expect(view.getAllByRole("switch")).toHaveLength(1);
  });

  it("a selected script missing from the interactive list shows the missing state and is invalid", async () => {
    // The stored scriptId is no longer an interactive script (deleted or its
    // kind changed) even though the raw test endpoint still answers.
    mocks.listAllScripts.mockResolvedValue([scriptRec("s2", "Durak", "interactive")]);
    mocks.testScript.mockResolvedValue(interactiveOk("tic-tac-toe", "Tic-Tac-Toe", [{ capability: "participants" }]));

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_script_missing");
    expect(validityCalls().at(-1)).toBe(false);
    expect(view.queryByText("experience_cap_participants")).toBeNull();
    expect(view.getAllByRole("switch")).toHaveLength(1);
  });

  it("context modes appear only when rp_context is declared AND granted; all five modes patch canonical values; revocation resets to none", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Echo", "interactive")]);
    mocks.testScript.mockResolvedValue(interactiveOk("echo", "Echo", [{ capability: "rp_context" }]));

    // Declared but NOT granted → no context control.
    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_cap_rp_context");
    expect(view.queryByRole("radiogroup")).toBeNull();

    // Granted → the five-mode segmented control appears.
    view.rerender(<ExperienceAssignment {...propsFor({ scriptId: "s1", capabilityGrants: ["rp_context"] })} />);
    await view.findByRole("radiogroup");
    const modes = ["experience_context_none", "experience_context_current_branch", "experience_context_recent", "experience_context_summaries_recent", "experience_context_compact_summary"];
    for (const m of modes) expect(view.getByRole("radio", { name: m })).toBeTruthy();

    // Every mode patches its canonical value (the parent applies each patch
    // between clicks — RadioGroup ignores clicks on the checked item).
    const sequence: Array<[string, ExperienceAssignmentProps["contextMode"]]> = [
      ["experience_context_current_branch", "current_branch"],
      ["experience_context_recent", "recent"],
      ["experience_context_summaries_recent", "summaries_recent"],
      ["experience_context_compact_summary", "compact_summary"],
      ["experience_context_none", "none"],
    ];
    let current: ExperienceAssignmentProps["contextMode"] = "none";
    for (const [label, canonical] of sequence) {
      view.rerender(<ExperienceAssignment {...propsFor({ scriptId: "s1", capabilityGrants: ["rp_context"], contextMode: current })} />);
      await view.findByRole("radiogroup");
      fireEvent.click(view.getByRole("radio", { name: label }));
      expect(mocks.onPatch).toHaveBeenCalledWith({ contextMode: canonical });
      current = canonical;
    }

    // Revoking rp_context collapses grants AND resets the context mode in one patch.
    mocks.onPatch.mockReset();
    view.rerender(<ExperienceAssignment {...propsFor({ scriptId: "s1", capabilityGrants: ["rp_context"], contextMode: "recent" })} />);
    await view.findByText("experience_cap_rp_context");
    fireEvent.click(capabilitySwitch(view, "experience_cap_rp_context"));
    expect(mocks.onPatch).toHaveBeenCalledWith({ capabilityGrants: [], contextMode: "none" });
  });

  it("the model note appears only when model is declared AND granted; offline/declared-only shows nothing", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Debate", "interactive")]);
    mocks.testScript.mockResolvedValue(interactiveOk("debate", "Debate", [{ capability: "model" }]));

    // Declared-only → no note (and no provider/model selector of any kind).
    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_cap_model");
    expect(view.queryByText("experience_assign_model_note")).toBeNull();

    // Declared + granted → the launch-time pinning note, still no selectors.
    view.rerender(<ExperienceAssignment {...propsFor({ scriptId: "s1", capabilityGrants: ["model"] })} />);
    await view.findByText("experience_assign_model_note");
    // Exactly the two DropdownSelect triggers (script + visual) — no provider
    // or model combobox joined them (DropdownSelect trigger = the only button
    // with the justify-between flex layout; switches are plain buttons).
    const dropdownTriggers = [...view.container.querySelectorAll("button")].filter((b) => b.className.includes("justify-between"));
    expect(dropdownTriggers).toHaveLength(2);
    expect(view.getAllByRole("switch")).toHaveLength(2); // model grant + launcher
  });

  it("the launcher toggle patches only launcherVisible", async () => {
    const view = renderAssignment({ launcherVisible: false });
    await view.findByText("experience_assign_no_scripts_title");
    await waitFor(() => {
      expect(triggerWithText(view, "experience_assign_visual_placeholder").className).not.toContain("pointer-events-none");
    });
    fireEvent.click(view.getByRole("switch"));
    expect(mocks.onPatch).toHaveBeenCalledWith({ launcherVisible: true });
    expect(mocks.onPatch).toHaveBeenCalledTimes(1);
  });

  it("pending disables every control", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Echo", "interactive")]);
    mocks.testScript.mockResolvedValue(interactiveOk("echo", "Echo", [{ capability: "rp_context" }]));

    const view = renderAssignment({
      scriptId: "s1",
      capabilityGrants: ["rp_context"],
      contextMode: "none",
      pending: true,
    });
    await view.findByText("experience_cap_rp_context");

    // Launcher + capability switches disabled (Radix Switch → disabled attr).
    for (const sw of view.getAllByRole("switch")) expect(sw.getAttribute("disabled")).not.toBeNull();
    // Context radios disabled.
    for (const radio of view.getAllByRole("radio")) expect(radio.getAttribute("disabled")).not.toBeNull();
    // DropdownSelect triggers carry no disabled attr; they go inert via class.
    expect(triggerWithText(view, "Echo").className).toContain("pointer-events-none");
    expect(triggerWithText(view, "experience_assign_visual_placeholder").className).toContain("pointer-events-none");
  });

  it("a rejected script list shows the load error and never reports ready", async () => {
    mocks.listAllScripts.mockRejectedValue(new Error("offline"));
    const view = renderAssignment();
    await view.findByText("experience_assign_scripts_load_error");
    expect(validityCalls()).toEqual([false]);
  });

  it("a selected script cannot become ready when the authoritative script list failed", async () => {
    mocks.listAllScripts.mockRejectedValue(new Error("offline"));
    mocks.testScript.mockResolvedValue(interactiveOk("tic-tac-toe", "Tic-Tac-Toe", []));

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_scripts_load_error");
    await waitFor(() => expect(mocks.testScript).toHaveBeenCalledWith("s1", {}));
    expect(validityCalls()).toEqual([false]);
    expect(view.queryByText("experience_assign_no_capabilities")).toBeNull();
    expect(view.queryByText("Tic-Tac-Toe")).toBeNull();
  });

  it("a rejected visual list still leaves script assignment fully usable", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Tic-Tac-Toe", "interactive")]);
    mocks.listExperienceVisuals.mockRejectedValue(new Error("offline"));
    mocks.testScript.mockResolvedValue(interactiveOk("tic-tac-toe", "Tic-Tac-Toe", []));

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_no_capabilities");
    expect(view.getByText("experience_assign_visuals_load_error")).toBeTruthy();
    await waitFor(() => expect(validityCalls().at(-1)).toBe(true));
  });

  it("unmounting mid-discovery writes no stale state and fires no late validity callback", async () => {
    mocks.listAllScripts.mockResolvedValue([scriptRec("s1", "Tic-Tac-Toe", "interactive")]);
    const d = deferred<unknown>();
    mocks.testScript.mockImplementation(() => d.promise);

    const view = renderAssignment({ scriptId: "s1" });
    await view.findByText("experience_assign_discovering");
    view.unmount();
    d.resolve(interactiveOk("tic-tac-toe", "Tic-Tac-Toe", []));
    await new Promise((r) => setTimeout(r, 30));
    // Only the initial not-ready report; nothing after unmount.
    expect(validityCalls()).toEqual([false]);
  });
});

/**
 * InsightsPanel — INS-2 characterization + IR-72B Experience integration.
 *
 * Pins:
 *  1. The no-chat empty state renders (Build Mode opened standalone — Insights
 *     are chat-level config, so dead toggles must not render).
 *  2. The toggle rows reflect the live chat config (objective / tracker / dice).
 *  3. Flipping an Objective/Tracker/Dice toggle dispatches the right partial
 *     patch through the INS-1b pipe — `{ insightsConfig: { objectiveEnabled } }` —
 *     so the adapter-side merge preserves the other toggles.
 *  4. (IR-72B) Experience is a FOURTH independent feature: it hydrates the
 *     Experience store for the exact {chatId, branchId}, persists only through
 *     the dedicated Experience endpoint (never insightsConfig), rehydrates the
 *     exact origin before clearing pending, rolls back on failure, stays
 *     scope-safe across a mid-flight chat switch, normalizes broad DB strings
 *     fail-closed, and the all-off hint now includes Experience.
 *
 * Runner: bun:test + happy-dom.
 * The snapshot store + the actions are mocked; the real Toggle (Radix Switch) is
 * exercised end-to-end so the click → onCheckedChange → onChange → persist path
 * is covered, not stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { EXPERIENCE_CAPABILITY, EXPERIENCE_CONTEXT_MODE } from "@vibe-tavern/domain";
import type { ExperienceChatConfigRow } from "../../../api/types.js";
import type { ExperienceAssignmentProps } from "./ExperienceAssignment.js";

useDomEnv();

// Shared mock state is defined before the module registrations.
const mocks = {
  activeChat: null as
    | null
    | { id: string; insightsConfig: { objectiveEnabled: boolean; trackerEnabled: boolean; diceEnabled?: boolean; diceMode?: "normal" | "immersive"; diceScriptIds?: string[] | null; diceActorBindings?: Record<string, ("persona" | "character")[]> | null } },
  activeBranch: null as null | { id: string },
  experienceConfig: null as ExperienceChatConfigRow | null,
  updateInsightsConfigAction: mock(),
  getDiceDefinitions: mock(),
  listAllScripts: mock(),
  setScope: mock(),
  rehydrate: mock(),
  updateExperienceConfig: mock(),
};

/** Inline ExperienceChatConfigRow factory (per-file, no shared fixtures). */
function makeConfig(over: Partial<ExperienceChatConfigRow> & { chatId: string }): ExperienceChatConfigRow {
  return {
    id: "cfg",
    chatId: over.chatId,
    enabled: over.enabled ?? false,
    scriptId: over.scriptId ?? null,
    visualId: over.visualId ?? null,
    capabilityGrants: over.capabilityGrants ?? [],
    contextMode: over.contextMode ?? "none",
    contextSourceCharacterId: over.contextSourceCharacterId ?? null,
    contextSourceChatId: over.contextSourceChatId ?? null,
    launcherVisible: over.launcherVisible ?? false,
    createdAt: "",
    updatedAt: "",
  };
}

const realI18nContext = await import("../../../i18n/context.js");
const realSnapshotStore = await import("../../../stores/snapshot-store.js");
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");
const realDiceApi = await import("../../../api/dice-api.js");
const realScriptApi = await import("../../../api/script-api.js");
const realExperienceStore = await import("../../../stores/experience-store.js");
const realExperienceApi = await import("../../../api/experience-api.js");
const realExperienceAssignment = await import("./ExperienceAssignment.js");
const realUseMobile = await import("../../../hooks/use-mobile.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realAiAssistantModal = await import("../../shared/AiAssistantModal.js");

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

mock.module("../../../stores/snapshot-store.js", () => ({
  ...realSnapshotStore,
  // The component subscribes with a selector; invoke it against a stub state.
  useSnapshotStore: (selector: (s: { activeChat: typeof mocks.activeChat; activeBranch: typeof mocks.activeBranch; messageOrder: string[]; messagesById: Record<string, { role?: string }> }) => unknown) =>
    selector({ activeChat: mocks.activeChat, activeBranch: mocks.activeBranch, messageOrder: [], messagesById: {} }),
  // TrackerConfig (rendered as a child) reads these for the scene_schema AI modal scopeContext.
  useActiveCharacter: () => ({ id: "char_1", name: "Hero" }),
  useActivePersona: () => ({ id: "persona_1", name: "User" }),
  // IR-72B: the panel reads the active branch for the Experience scope.
  useActiveBranch: () => mocks.activeBranch,
}));

mock.module("../../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  updateInsightsConfigAction: mocks.updateInsightsConfigAction,
}));

mock.module("../../../api/dice-api.js", () => ({
  ...realDiceApi,
  getDiceDefinitions: mocks.getDiceDefinitions,
}));

mock.module("../../../api/script-api.js", () => ({
  ...realScriptApi,
  listAllScripts: mocks.listAllScripts,
}));

// IR-72B: the Experience store selector + getState seam (setScope/rehydrate).
// The real store's race/idempotency logic has its own broad tests; here we only
// stub the narrow seam the panel touches.
mock.module("../../../stores/experience-store.js", () => ({
  ...realExperienceStore,
  useExperienceConfig: () => mocks.experienceConfig,
  useExperienceStore: Object.assign(() => ({}), {
    getState: () => ({ setScope: mocks.setScope, rehydrate: mocks.rehydrate }),
  }),
}));

// IR-72B: the Experience config endpoint (PUT) is the ONLY Experience write.
mock.module("../../../api/experience-api.js", () => ({
  ...realExperienceApi,
  updateExperienceConfig: mocks.updateExperienceConfig,
}));

// IR-72A's ExperienceAssignment has its own standalone component test. In this
// PANEL integration file a small real-shaped stub is acceptable: it exposes the
// received controlled props and invokes onPatch so the panel's forwarding can be
// asserted at the API/store → real panel → stub child → DOM boundary.
mock.module("./ExperienceAssignment.js", () => ({
  ...realExperienceAssignment,
  ExperienceAssignment: (props: ExperienceAssignmentProps) => (
    <div data-testid="experience-assignment" data-chat-id={props.chatId}>
      <span data-prop="scriptId">{String(props.scriptId)}</span>
      <span data-prop="visualId">{String(props.visualId)}</span>
      <span data-prop="capabilityGrants">{JSON.stringify(props.capabilityGrants)}</span>
      <span data-prop="contextMode">{String(props.contextMode)}</span>
      <span data-prop="sourceCharacterId">{String(props.sourceCharacterId ?? null)}</span>
      <span data-prop="sourceChatId">{String(props.sourceChatId ?? null)}</span>
      <span data-prop="launcherVisible">{String(props.launcherVisible)}</span>
      <button
        data-act="patch"
        type="button"
        onClick={() => props.onPatch({ scriptId: "s_x", capabilityGrants: [EXPERIENCE_CAPABILITY.model], contextMode: EXPERIENCE_CONTEXT_MODE.none })}
      >
        experience-stub-patch
      </button>
    </div>
  ),
}));

// DiceAssignment calls useIsMobile(); happy-dom has no matchMedia, so stub it.
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => false,
}));

// ObjectiveConfig is a separate boundary (covered by its own test file). Stub
// it so the PANEL test stays focused on the toggle behavior and does not drag
// in the config editor's provider/model dependencies.
mock.module("./ObjectiveConfig.js", () => ({
  ObjectiveConfig: () => <div data-testid="objective-config" />,
}));

// TrackerConfig renders CustomTooltip (icon buttons); presentational here —
// passthrough so no Radix TooltipProvider is needed.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// TrackerConfig renders the shared AiAssistantModal (scene_schema generator).
// Stub it so this panel-level test doesn't pull the modal's snapshot/app-client deps.
mock.module("../../shared/AiAssistantModal.js", () => ({
  ...realAiAssistantModal,
  AiAssistantModal: () => null,
}));

const { InsightsPanel } = await import("./InsightsPanel.js");

afterEach(() => {
  mocks.activeChat = null;
  mocks.activeBranch = null;
  mocks.experienceConfig = null;
  mocks.updateInsightsConfigAction.mockReset();
  mocks.getDiceDefinitions.mockReset();
  mocks.listAllScripts.mockReset();
  mocks.setScope.mockReset();
  mocks.rehydrate.mockReset();
  mocks.updateExperienceConfig.mockReset();
});

describe("InsightsPanel (INS-2)", () => {
  beforeEach(() => {
    mocks.updateInsightsConfigAction.mockResolvedValue(undefined);
    mocks.getDiceDefinitions.mockResolvedValue({ scripts: [] });
    mocks.listAllScripts.mockResolvedValue([]);
    mocks.setScope.mockImplementation(() => {});
    mocks.rehydrate.mockResolvedValue(undefined);
    mocks.updateExperienceConfig.mockResolvedValue(
      makeConfig({ chatId: "chat_mock", enabled: false }),
    );
  });

  it("renders the no-chat empty state when no chat is active", () => {
    mocks.activeChat = null;
    const { getByText, queryByRole } = render(<InsightsPanel />);
    expect(getByText("insights_no_chat_title")).toBeTruthy();
    // No toggle rows in the empty state.
    expect(queryByRole("switch")).toBeNull();
    // No Experience hydration or write is issued without an active chat.
    expect(mocks.setScope).not.toHaveBeenCalled();
    expect(mocks.updateExperienceConfig).not.toHaveBeenCalled();
  });

  it("renders all four toggles unchecked when the config is all-off (default)", () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    const { getByText, getAllByRole } = render(<InsightsPanel />);
    expect(getByText("insights_objective_title")).toBeTruthy();
    expect(getByText("insights_tracker_title")).toBeTruthy();
    expect(getByText("insights_experience_title")).toBeTruthy();
    const switches = getAllByRole("switch");
    expect(switches).toHaveLength(4);
    for (const sw of switches) {
      expect(sw.getAttribute("aria-checked")).toBe("false");
    }
    // The all-off hint appears only when Objective, Tracker, Dice AND Experience
    // are all off.
    expect(getByText("insights_coming_soon_hint")).toBeTruthy();
  });

  it("reflects the live config — objective on, tracker off", () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: true, trackerEnabled: false },
    };
    const { getAllByRole } = render(<InsightsPanel />);
    const switches = getAllByRole("switch");
    expect(switches[0].getAttribute("aria-checked")).toBe("true");
    expect(switches[1].getAttribute("aria-checked")).toBe("false");
  });

  it("flipping the Objective toggle dispatches the objective-only patch", () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    const { getAllByRole } = render(<InsightsPanel />);
    fireEvent.click(getAllByRole("switch")[0]);
    expect(mocks.updateInsightsConfigAction).toHaveBeenCalledWith("chat_1", {
      insightsConfig: { objectiveEnabled: true },
    });
  });

  it("flipping the Tracker toggle dispatches the tracker-only patch", () => {
    mocks.activeChat = {
      id: "chat_7",
      insightsConfig: { objectiveEnabled: true, trackerEnabled: false },
    };
    const { getAllByRole } = render(<InsightsPanel />);
    fireEvent.click(getAllByRole("switch")[1]);
    expect(mocks.updateInsightsConfigAction).toHaveBeenCalledWith("chat_7", {
      insightsConfig: { trackerEnabled: true },
    });
  });

  it("flips optimistically without dimming either row while the PATCH is pending", () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.updateInsightsConfigAction.mockImplementation(() => new Promise<void>(() => {}));

    const { container, getAllByRole } = render(<InsightsPanel />);
    const switches = getAllByRole("switch");
    fireEvent.click(switches[0]);

    // The selected thumb responds immediately instead of waiting for the RPC.
    expect(switches[0].getAttribute("aria-checked")).toBe("true");
    expect(switches[1].getAttribute("aria-checked")).toBe("false");
    // The global saving lock may block another click, but it must be invisible:
    // previously both feature rows received opacity-60 and flashed together.
    expect(container.querySelector(".opacity-60")).toBeNull();
  });

  it("rolls the optimistic value back to store state when the PATCH fails", async () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.updateInsightsConfigAction.mockRejectedValue(new Error("offline"));

    const { getAllByRole } = render(<InsightsPanel />);
    const objectiveSwitch = getAllByRole("switch")[0];
    fireEvent.click(objectiveSwitch);
    expect(objectiveSwitch.getAttribute("aria-checked")).toBe("true");

    await waitFor(() => expect(objectiveSwitch.getAttribute("aria-checked")).toBe("false"));
  });

  it("lists effective rules as rows with provenance + actor chips; Add/Create always visible, no mode verbs", async () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal" },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Fate Die", description: "", code: "", scriptKind: "dice", scopeType: "persona", characterId: null, personaId: "persona_1", chatId: null, enabled: true, sortOrder: 0 },
      { id: "s2", name: "Stealth", description: "", code: "", scriptKind: "dice", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 1 },
      // Prompt scripts must never appear in the dice assignment surface.
      { id: "s3", name: "Prompt Helper", description: "", code: "", scriptKind: "prompt", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 2 },
    ]);
    mocks.getDiceDefinitions.mockResolvedValue({
      scripts: [
        { scriptId: "s1", scriptLabel: "Fate Die", scriptRevision: 1, checks: [] },
        { scriptId: "s2", scriptLabel: "Stealth", scriptRevision: 1, checks: [] },
      ],
    });

    const { getByText, queryByText, findByText, getByRole, getAllByRole } = render(<InsightsPanel />);
    expect(mocks.getDiceDefinitions).toHaveBeenCalledWith("chat_1");
    await findByText("Fate Die");
    expect(getByText("Stealth")).toBeTruthy();
    expect(queryByText("Prompt Helper")).toBeNull();
    // Provenance notes distinguish inherited vs global (fixes "unexplained active count").
    expect(getByText(/insights_dice_prov_persona/)).toBeTruthy();
    expect(getByText(/insights_dice_prov_global/)).toBeTruthy();
    // The unified editor has NO mode verbs and no dead-end browse redirect.
    expect(queryByText("insights_dice_manage")).toBeNull();
    expect(queryByText("insights_dice_override")).toBeNull();
    expect(queryByText("insights_dice_use_inherited")).toBeNull();
    expect(queryByText("insights_dice_override_active")).toBeNull();
    // Add + Create are always present; reset is hidden while following automatic.
    expect(getByRole("button", { name: "insights_dice_add" })).toBeTruthy();
    expect(getByText("insights_dice_create_new")).toBeTruthy();
    expect(queryByText("insights_dice_reset_auto")).toBeNull();
    // Each row carries its own remove button (one per effective rule).
    expect(getAllByRole("button", { name: "insights_dice_remove" })).toHaveLength(2);
  });

  it("shows the zero-scripts EmptyState only when no dice scripts exist at all", async () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal" },
    };
    // listAllScripts empty → genuinely no dice scripts anywhere → Fate quick-start.
    mocks.listAllScripts.mockResolvedValue([]);
    mocks.getDiceDefinitions.mockResolvedValue({ scripts: [] });

    const { findByText, getByText } = render(<InsightsPanel />);
    await findByText("insights_dice_empty_title");
    // Create remains reachable even from the zero state.
    expect(getByText("insights_dice_create_new")).toBeTruthy();
  });

  it("removing a rule silently snapshots the remaining effective ids (first edit freezes the set)", async () => {
    mocks.activeChat = {
      id: "chat_9",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal" },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Fate Die", description: "", code: "", scriptKind: "dice", scopeType: "persona", characterId: null, personaId: "persona_1", chatId: null, enabled: true, sortOrder: 0 },
      { id: "s2", name: "Stealth", description: "", code: "", scriptKind: "dice", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 1 },
    ]);
    mocks.getDiceDefinitions.mockResolvedValue({
      scripts: [
        { scriptId: "s1", scriptLabel: "Fate Die", scriptRevision: 1, checks: [] },
        { scriptId: "s2", scriptLabel: "Stealth", scriptRevision: 1, checks: [] },
      ],
    });

    const { findAllByRole } = render(<InsightsPanel />);
    const removeBtns = await findAllByRole("button", { name: "insights_dice_remove" });
    // Remove Fate Die (first row) — the chat set freezes to the remainder.
    fireEvent.click(removeBtns[0]);
    expect(mocks.updateInsightsConfigAction).toHaveBeenCalledWith("chat_9", {
      insightsConfig: { diceScriptIds: ["s2"] },
    });
  });

  it("Reset to automatic patches diceScriptIds back to null and only appears with a local set", async () => {
    mocks.activeChat = {
      id: "chat_9",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal", diceScriptIds: ["s1"] },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Fate Die", description: "", code: "", scriptKind: "dice", scopeType: "persona", characterId: null, personaId: "persona_1", chatId: null, enabled: true, sortOrder: 0 },
    ]);
    mocks.getDiceDefinitions.mockResolvedValue({
      scripts: [
        { scriptId: "s1", scriptLabel: "Fate Die", scriptRevision: 1, checks: [] },
      ],
    });

    const { findByText } = render(<InsightsPanel />);
    const resetBtn = await findByText("insights_dice_reset_auto");
    fireEvent.click(resetBtn);
    expect(mocks.updateInsightsConfigAction).toHaveBeenCalledWith("chat_9", {
      insightsConfig: { diceScriptIds: null },
    });
  });

  // ── Unified editor: actor chips in every row (no override/inherit modes) ──

  it("shows actor chips in every row — editable while following automatic, defaulting to declared actors", async () => {
    mocks.activeChat = {
      id: "chat_1",
      // NO diceScriptIds — the chat follows the automatic union, and the
      // distribution must still be visible + editable.
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal" },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Stealth", description: "", code: "", scriptKind: "dice", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 0 },
    ]);
    mocks.getDiceDefinitions.mockResolvedValue({
      scripts: [
        { scriptId: "s1", scriptLabel: "Stealth", scriptRevision: 1, checks: [{ id: "st", label: "Stealth", notation: "1d20", actors: ["persona"], resolution: "narrative", faceShape: "d20" }] },
      ],
    });

    const { findByText, getByText } = render(<InsightsPanel />);
    await findByText("Stealth");
    // Declared actors = persona only → persona chip on, character chip off.
    const personaChip = getByText("dice_persona").closest("button")!;
    const charChip = getByText("dice_character").closest("button")!;
    await waitFor(() => expect(personaChip.getAttribute("data-state")).toBe("on"));
    expect(charChip.getAttribute("data-state")).toBe("off");
  });

  it("toggling an actor patches ONLY diceActorBindings — it must not freeze a live set", async () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal" },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Stealth", description: "", code: "", scriptKind: "dice", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 0 },
    ]);
    mocks.getDiceDefinitions.mockResolvedValue({
      scripts: [
        { scriptId: "s1", scriptLabel: "Stealth", scriptRevision: 1, checks: [{ id: "st", label: "Stealth", notation: "1d20", actors: ["persona"], resolution: "narrative", faceShape: "d20" }] },
      ],
    });

    const { findByText, getByText } = render(<InsightsPanel />);
    await findByText("Stealth");
    // Persona is the declared default; clicking Character adds it (expand).
    // The patch must carry the bindings ONLY — tuning actors is not a set edit.
    fireEvent.click(getByText("dice_character").closest("button")!);
    expect(mocks.updateInsightsConfigAction).toHaveBeenCalledWith("chat_1", {
      insightsConfig: { diceActorBindings: { s1: ["persona", "character"] } },
    });
  });

  it("an explicit diceActorBindings override narrows the chips below declared", async () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal", diceScriptIds: ["s1"], diceActorBindings: { s1: ["persona"] } },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Attack", description: "", code: "", scriptKind: "dice", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 0 },
    ]);
    // Script declares BOTH actors, but the chat binding narrows to persona only.
    mocks.getDiceDefinitions.mockResolvedValue({
      scripts: [
        { scriptId: "s1", scriptLabel: "Attack", scriptRevision: 1, checks: [{ id: "atk", label: "Attack", notation: "1d20", actors: ["persona", "character"], resolution: "strict", faceShape: "d20" }] },
      ],
    });

    const { findByText, getByText } = render(<InsightsPanel />);
    await findByText("Attack");
    const personaChip = getByText("dice_persona").closest("button")!;
    const charChip = getByText("dice_character").closest("button")!;
    await waitFor(() => expect(personaChip.getAttribute("data-state")).toBe("on"));
    expect(charChip.getAttribute("data-state")).toBe("off");
  });

  it("shows the empty hint + Add when scripts exist but none are effective", async () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal" },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Fate Die", description: "", code: "", scriptKind: "dice", scopeType: "persona", characterId: null, personaId: "persona_2", chatId: null, enabled: true, sortOrder: 0 },
    ]);
    mocks.getDiceDefinitions.mockResolvedValue({ scripts: [] });

    const { findByText, getByRole } = render(<InsightsPanel />);
    // The hint points at add/create — never "assign an inherited script".
    await findByText("insights_dice_none_effective");
    expect(getByRole("button", { name: "insights_dice_add" })).toBeTruthy();
  });

  it("removing a rule prunes its actor binding in the same patch", async () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false, diceEnabled: true, diceMode: "normal", diceScriptIds: ["s1", "s2"], diceActorBindings: { s1: ["persona"] } },
    };
    mocks.listAllScripts.mockResolvedValue([
      { id: "s1", name: "Fate Die", description: "", code: "", scriptKind: "dice", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 0 },
      { id: "s2", name: "Stealth", description: "", code: "", scriptKind: "dice", scopeType: "global", characterId: null, personaId: null, chatId: null, enabled: true, sortOrder: 1 },
    ]);
    mocks.getDiceDefinitions.mockResolvedValue({
      scripts: [
        { scriptId: "s1", scriptLabel: "Fate Die", scriptRevision: 1, checks: [] },
        { scriptId: "s2", scriptLabel: "Stealth", scriptRevision: 1, checks: [] },
      ],
    });

    const { findAllByRole } = render(<InsightsPanel />);
    const removeBtns = await findAllByRole("button", { name: "insights_dice_remove" });
    fireEvent.click(removeBtns[0]); // remove Fate Die (s1)
    expect(mocks.updateInsightsConfigAction).toHaveBeenCalledWith("chat_1", {
      insightsConfig: { diceScriptIds: ["s2"], diceActorBindings: {} },
    });
  });

  // ── IR-72B: Interactive Experience integration ──────────────────────────

  it("hydrates the Experience store for the exact {chatId, branchId} and renders the assignment with controlled values", async () => {
    mocks.activeChat = {
      id: "chat_42",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_7" };
    mocks.experienceConfig = makeConfig({
      chatId: "chat_42",
      enabled: true,
      scriptId: "rules_1",
      visualId: "vis_2",
      capabilityGrants: ["model", "rp_context"],
      contextMode: "current_branch",
      contextSourceCharacterId: "char_9",
      contextSourceChatId: "chat_42",
      launcherVisible: true,
    });

    const { container, findByTestId } = render(<InsightsPanel />);
    // setScope hydrates for the EXACT active chat + branch.
    await waitFor(() => expect(mocks.setScope).toHaveBeenCalledWith("chat_42", "branch_7"));
    const assignment = await findByTestId("experience-assignment");
    expect(assignment.getAttribute("data-chat-id")).toBe("chat_42");
    const prop = (name: string): string =>
      container.querySelector(`[data-prop="${name}"]`)!.textContent!;
    // Exact controlled values flow through to the assignment unchanged.
    expect(prop("scriptId")).toBe("rules_1");
    expect(prop("visualId")).toBe("vis_2");
    expect(prop("capabilityGrants")).toBe(JSON.stringify(["model", "rp_context"]));
    expect(prop("contextMode")).toBe("current_branch");
    // The confirmed context-source pointers flow through too (report item 6).
    expect(prop("sourceCharacterId")).toBe("char_9");
    expect(prop("sourceChatId")).toBe("chat_42");
    expect(prop("launcherVisible")).toBe("true");
  });

  it("flipping the Experience toggle writes only via updateExperienceConfig, flips optimistically, and rehydrates the exact origin before clearing pending", async () => {
    mocks.activeChat = {
      id: "chat_3",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_3" };
    mocks.experienceConfig = makeConfig({ chatId: "chat_3", enabled: false });

    let resolveUpdate: () => void = () => {};
    let resolveRehydrate: () => void = () => {};
    mocks.updateExperienceConfig.mockImplementation(
      () => new Promise<void>((r) => { resolveUpdate = r; }),
    );
    mocks.rehydrate.mockImplementation(
      () => new Promise<void>((r) => { resolveRehydrate = r; }),
    );

    const { container, getAllByRole } = render(<InsightsPanel />);
    const experienceSwitch = getAllByRole("switch")[3];
    fireEvent.click(experienceSwitch);

    // Optimistic flip — immediate, no dimming.
    expect(experienceSwitch.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector(".opacity-60")).toBeNull();
    // Only the Experience endpoint; never the insights-config action.
    expect(mocks.updateExperienceConfig).toHaveBeenCalledWith("chat_3", { enabled: true });
    expect(mocks.updateInsightsConfigAction).not.toHaveBeenCalled();

    // update resolves → rehydrate starts for the EXACT origin (chat_3/branch_3).
    resolveUpdate();
    await waitFor(() => expect(mocks.rehydrate).toHaveBeenCalledWith("chat_3", "branch_3"));
    // rehydrate still in flight → the shared pending lock still holds every row.
    await waitFor(() => expect(getAllByRole("switch")[0].hasAttribute("disabled")).toBe(true));

    // rehydrate resolves → pending clears → rows re-enable.
    resolveRehydrate();
    await waitFor(() => expect(getAllByRole("switch")[0].hasAttribute("disabled")).toBe(false));
  });

  it("ExperienceAssignment onPatch routes only through the Experience endpoint with fields unchanged", async () => {
    mocks.activeChat = {
      id: "chat_4",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_4" };
    mocks.experienceConfig = makeConfig({ chatId: "chat_4", enabled: true });

    const { findByTestId } = render(<InsightsPanel />);
    const assignment = await findByTestId("experience-assignment");
    fireEvent.click(assignment.querySelector('[data-act="patch"]')!);

    // The patch is forwarded unchanged to the Experience endpoint; the
    // insights-config action is never involved.
    expect(mocks.updateExperienceConfig).toHaveBeenCalledWith("chat_4", {
      scriptId: "s_x",
      capabilityGrants: ["model"],
      contextMode: "none",
    });
    expect(mocks.updateInsightsConfigAction).not.toHaveBeenCalled();
  });

  it("rolls the optimistic Experience value back to the confirmed config on API rejection without touching Objective/Tracker/Dice", async () => {
    mocks.activeChat = {
      id: "chat_5",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_5" };
    mocks.experienceConfig = makeConfig({ chatId: "chat_5", enabled: false });
    mocks.updateExperienceConfig.mockRejectedValue(new Error("server down"));

    const { getAllByRole } = render(<InsightsPanel />);
    const experienceSwitch = getAllByRole("switch")[3];
    fireEvent.click(experienceSwitch);
    // Optimistic flip before the rejection settles.
    expect(experienceSwitch.getAttribute("aria-checked")).toBe("true");

    // After rejection, the display reverts to the confirmed config (enabled: false).
    await waitFor(() => expect(experienceSwitch.getAttribute("aria-checked")).toBe("false"));
    // The other three features are untouched — no insights-config spillover.
    expect(mocks.updateInsightsConfigAction).not.toHaveBeenCalled();
  });

  it("a mid-flight chat/branch switch cannot apply the pending Experience patch to the new chat", async () => {
    mocks.activeChat = {
      id: "chat_a",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_a" };
    mocks.experienceConfig = makeConfig({ chatId: "chat_a", enabled: false });
    let resolveUpdate: () => void = () => {};
    mocks.updateExperienceConfig.mockImplementation(
      () => new Promise<void>((r) => { resolveUpdate = r; }),
    );

    const { rerender, getAllByRole } = render(<InsightsPanel />);
    fireEvent.click(getAllByRole("switch")[3]); // enable Experience on chat_a
    expect(getAllByRole("switch")[3].getAttribute("aria-checked")).toBe("true");

    // Switch to a different chat/branch while the chat_a request is in flight.
    mocks.activeChat = {
      id: "chat_b",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_b" };
    mocks.experienceConfig = makeConfig({ chatId: "chat_b", enabled: false });
    rerender(<InsightsPanel />);

    // chat_b's Experience toggle reflects its OWN confirmed config (false), NOT
    // the leaked optimistic true from chat_a.
    expect(getAllByRole("switch")[3].getAttribute("aria-checked")).toBe("false");

    // Resolving the chat_a request rehydrates the EXACT origin (chat_a/branch_a),
    // never the newly-active chat_b.
    resolveUpdate();
    await waitFor(() => expect(mocks.rehydrate).toHaveBeenCalledWith("chat_a", "branch_a"));
    expect(mocks.rehydrate).not.toHaveBeenCalledWith("chat_b", "branch_b");
  });

  it("the all-off hint hides once Experience is on even with Objective/Tracker/Dice off (hint condition includes Experience)", () => {
    mocks.activeChat = {
      id: "chat_8",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_8" };
    mocks.experienceConfig = makeConfig({ chatId: "chat_8", enabled: true });

    const { getAllByRole, queryByText } = render(<InsightsPanel />);
    // Experience is on (index 3) while Objective/Tracker/Dice are off.
    expect(getAllByRole("switch")[3].getAttribute("aria-checked")).toBe("true");
    // The hint requires ALL four off, so it is hidden.
    expect(queryByText("insights_coming_soon_hint")).toBeNull();
  });

  it("normalizes malformed DB config strings fail-closed: unknown grants removed, unknown context mode -> none", async () => {
    mocks.activeChat = {
      id: "chat_9",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    mocks.activeBranch = { id: "branch_9" };
    mocks.experienceConfig = makeConfig({
      chatId: "chat_9",
      enabled: true,
      scriptId: "rules_9",
      capabilityGrants: ["model", "not_a_real_grant", "rp_context"],
      contextMode: "totally_invalid_mode",
    });

    const { container, findByTestId } = render(<InsightsPanel />);
    await findByTestId("experience-assignment");
    const prop = (name: string): string =>
      container.querySelector(`[data-prop="${name}"]`)!.textContent!;
    // Unknown grant "not_a_real_grant" is dropped; valid ones survive (order kept).
    expect(prop("capabilityGrants")).toBe(JSON.stringify(["model", "rp_context"]));
    // Unknown context mode collapses to "none" rather than passing through.
    expect(prop("contextMode")).toBe("none");
  });
});

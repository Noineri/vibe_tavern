/**
 * InsightsPanel — INS-2 characterization.
 *
 * Pins three things:
 *  1. The no-chat empty state renders (Build Mode opened standalone — Insights
 *     are chat-level config, so dead toggles must not render).
 *  2. The two toggle rows reflect the live chat config (objective / tracker).
 *  3. Flipping a toggle dispatches the right partial patch through the INS-1b
 *     pipe — `{ insightsConfig: { objectiveEnabled } }` / `{ trackerEnabled }` —
 *     so the adapter-side merge preserves the other toggle.
 *
 * Runner: vitest (apps/web — see vitest.config.ts; vi.mock is file-scoped).
 * The snapshot store + the action are mocked; the real Toggle (Radix Switch) is
 * exercised end-to-end so the click → onCheckedChange → onChange → persist path
 * is covered, not stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { InsightsPanel } from "./InsightsPanel.js";

// Hoisted mock state — vi.mock factories are hoisted above imports, so the
// shared objects they close over must be created with vi.hoisted too.
const mocks = vi.hoisted(() => ({
  activeChat: null as
    | null
    | { id: string; insightsConfig: { objectiveEnabled: boolean; trackerEnabled: boolean; diceEnabled?: boolean; diceMode?: "normal" | "immersive"; diceScriptIds?: string[] | null; diceActorBindings?: Record<string, ("persona" | "character")[]> | null } },
  updateInsightsConfigAction: vi.fn(),
  getDiceDefinitions: vi.fn(),
  listAllScripts: vi.fn(),
}));

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    // Return the key verbatim — assertions check for key strings.
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

vi.mock("../../../stores/snapshot-store.js", () => ({
  // The component subscribes with a selector; invoke it against a stub state.
  useSnapshotStore: (selector: (s: { activeChat: typeof mocks.activeChat; messageOrder: string[]; messagesById: Record<string, { role?: string }> }) => unknown) =>
    selector({ activeChat: mocks.activeChat, messageOrder: [], messagesById: {} }),
  // TrackerConfig (rendered as a child) reads these for the scene_schema AI modal scopeContext.
  useActiveCharacter: () => ({ id: "char_1", name: "Hero" }),
  useActivePersona: () => ({ id: "persona_1", name: "User" }),
}));

vi.mock("../../../stores/api-actions/chat-actions.js", () => ({
  updateInsightsConfigAction: mocks.updateInsightsConfigAction,
}));

vi.mock("../../../api/dice-api.js", () => ({
  getDiceDefinitions: mocks.getDiceDefinitions,
}));

vi.mock("../../../api/script-api.js", () => ({
  listAllScripts: mocks.listAllScripts,
}));

// DiceAssignment calls useIsMobile(); happy-dom has no matchMedia, so stub it.
vi.mock("../../../hooks/use-mobile.js", () => ({
  useIsMobile: () => false,
}));

// ObjectiveConfig is a separate boundary (covered by its own test file). Stub
// it so the PANEL test stays focused on the toggle behavior and does not drag
// in the config editor's provider/model dependencies.
vi.mock("./ObjectiveConfig.js", () => ({
  ObjectiveConfig: () => <div data-testid="objective-config" />,
}));

// TrackerConfig renders CustomTooltip (icon buttons); presentational here —
// passthrough so no Radix TooltipProvider is needed.
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// TrackerConfig renders the shared AiAssistantModal (scene_schema generator).
// Stub it so this panel-level test doesn't pull the modal's snapshot/app-client deps.
vi.mock("../../shared/AiAssistantModal.js", () => ({
  AiAssistantModal: () => null,
}));

afterEach(() => {
  cleanup();
  mocks.activeChat = null;
  mocks.updateInsightsConfigAction.mockReset();
  mocks.getDiceDefinitions.mockReset();
  mocks.listAllScripts.mockReset();
});

describe("InsightsPanel (INS-2)", () => {
  beforeEach(() => {
    mocks.updateInsightsConfigAction.mockResolvedValue(undefined);
    mocks.getDiceDefinitions.mockResolvedValue({ scripts: [] });
    mocks.listAllScripts.mockResolvedValue([]);
  });

  it("renders the no-chat empty state when no chat is active", () => {
    mocks.activeChat = null;
    const { getByText, queryByRole } = render(<InsightsPanel />);
    expect(getByText("insights_no_chat_title")).toBeTruthy();
    // No toggle rows in the empty state.
    expect(queryByRole("switch")).toBeNull();
  });

  it("renders both toggles unchecked when the config is all-off (default)", () => {
    mocks.activeChat = {
      id: "chat_1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    };
    const { getByText, getAllByRole } = render(<InsightsPanel />);
    expect(getByText("insights_objective_title")).toBeTruthy();
    expect(getByText("insights_tracker_title")).toBeTruthy();
    const switches = getAllByRole("switch");
    expect(switches).toHaveLength(3);
    expect(switches[0].getAttribute("aria-checked")).toBe("false");
    expect(switches[1].getAttribute("aria-checked")).toBe("false");
    expect(switches[2].getAttribute("aria-checked")).toBe("false");
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
});

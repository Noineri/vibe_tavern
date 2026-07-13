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
import { InsightsPanel } from "./InsightsPanel.js";

// Hoisted mock state — vi.mock factories are hoisted above imports, so the
// shared objects they close over must be created with vi.hoisted too.
const mocks = vi.hoisted(() => ({
  activeChat: null as
    | null
    | { id: string; insightsConfig: { objectiveEnabled: boolean; trackerEnabled: boolean } },
  updateInsightsConfigAction: vi.fn(),
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
  useSnapshotStore: (selector: (s: { activeChat: typeof mocks.activeChat }) => unknown) =>
    selector({ activeChat: mocks.activeChat }),
}));

vi.mock("../../../stores/api-actions/chat-actions.js", () => ({
  updateInsightsConfigAction: mocks.updateInsightsConfigAction,
}));

// ObjectiveConfig is a separate boundary (covered by its own test file). Stub
// it so the PANEL test stays focused on the toggle behavior and does not drag
// in the config editor's provider/model dependencies.
vi.mock("./ObjectiveConfig.js", () => ({
  ObjectiveConfig: () => <div data-testid="objective-config" />,
}));

afterEach(() => {
  cleanup();
  mocks.activeChat = null;
  mocks.updateInsightsConfigAction.mockReset();
});

describe("InsightsPanel (INS-2)", () => {
  beforeEach(() => {
    mocks.updateInsightsConfigAction.mockResolvedValue(undefined);
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
    expect(switches).toHaveLength(2);
    expect(switches[0].getAttribute("aria-checked")).toBe("false");
    expect(switches[1].getAttribute("aria-checked")).toBe("false");
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
});

/**
 * ObjectiveZone — INS-6 characterization.
 *
 * Pins the zone's own behavior: the collapsed summary reflects the live active
 * task + progress; clicking it expands (writing `objectiveOpen`); the expanded
 * route exposes regenerate/check actions and renders per-task rows; node click
 * cycles status; description click → inline rename. The visible-gate
 * backstop renders null when objective is off or no active task exists.
 *
 * The header-level concerns this zone plugs INTO — avatar growth, separators,
 * the 0-zone identity-only fallback, render-isolation across messages — live in
 * AssistantContextHeader.test.tsx + message-block-isolation.test.tsx (both run
 * green with this zone registered). This file covers the zone's OWN contract.
 *
 * Runner: vitest (apps/web). The snapshot store + header-zone-expansion store
 * are exercised for real (seeded/reset per test); `useT` + the objective action
 * actions are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ObjectiveZone } from "./objective-zone.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useHeaderZoneExpansionStore } from "../../../stores/header-zone-expansion.js";
import type { ObjectiveState } from "../../../api/types.js";

const mocks = vi.hoisted(() => ({
  updateObjectiveTaskAction: vi.fn(),
  generateObjectiveTasksAction: vi.fn(),
  checkObjectiveCompletionAction: vi.fn(),
}));

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

vi.mock("../../../stores/api-actions/chat-actions.js", () => ({
  updateObjectiveTaskAction: mocks.updateObjectiveTaskAction,
  generateObjectiveTasksAction: mocks.generateObjectiveTasksAction,
  checkObjectiveCompletionAction: mocks.checkObjectiveCompletionAction,
}));

afterEach(() => {
  cleanup();
  useSnapshotStore.setState({ activeChat: null });
  useHeaderZoneExpansionStore.setState({ open: {} });
  mocks.updateObjectiveTaskAction.mockReset();
  mocks.generateObjectiveTasksAction.mockReset();
  mocks.checkObjectiveCompletionAction.mockReset();
});

function seedState(state: ObjectiveState, objectiveEnabled: boolean) {
  useSnapshotStore.setState({
    activeChat: {
      id: "c1",
      insightsConfig: { objectiveEnabled, trackerEnabled: false },
      insightsObjectiveState: state,
    } as never,
  });
}

const ROUTE: ObjectiveState = {
  objectiveDescription: "Find the amulet",
  tasks: [
    { id: "t1", description: "Ask the innkeeper", status: "completed" },
    { id: "t2", description: "Enter the forest", status: "active" },
    { id: "t3", description: "Find the cave", status: "pending" },
  ],
  autoCheckFrequency: 0,
  injectionDepth: 1,
  generatePrompt: "",
  checkPrompt: "",
  injectPrompt: "",
  useChatModel: true,
  providerProfileId: null,
  model: null,
};

describe("ObjectiveZone (INS-6)", () => {
  beforeEach(() => {
    mocks.updateObjectiveTaskAction.mockResolvedValue(undefined);
    mocks.generateObjectiveTasksAction.mockResolvedValue(undefined);
    mocks.checkObjectiveCompletionAction.mockResolvedValue(undefined);
  });

  it("collapsed: shows the active task + progress and expands on click", () => {
    seedState(ROUTE, true);
    const { getByText, container, queryByText } = render(
      <ObjectiveZone chatId="c1" messageId="m1" />,
    );
    // Active task = "Enter the forest" (first active); progress = 1/3 completed.
    expect(getByText("Enter the forest")).toBeTruthy();
    expect(getByText("1/3")).toBeTruthy();
    // Collapsed → route label not yet shown.
    expect(queryByText("obj_zone_route")).toBeNull();

    // Click the summary → writes objectiveOpen for THIS message only.
    fireEvent.click(getByText("Enter the forest"));
    expect(useHeaderZoneExpansionStore.getState().open.m1?.objectiveOpen).toBe(true);

    // Now expanded → route label + all tasks visible.
    expect(getByText("obj_zone_route")).toBeTruthy();
    expect(getByText("Ask the innkeeper")).toBeTruthy();
    expect(getByText("Find the cave")).toBeTruthy();
    // Verify the zone rendered DOM (not null).
    expect(container.firstChild).not.toBeNull();
  });

  it("expanded: regenerate and check buttons dispatch the existing objective actions", async () => {
    seedState(ROUTE, true);
    useHeaderZoneExpansionStore.setState({ open: { m1: { objectiveOpen: true } } });
    const { getByTitle } = render(<ObjectiveZone chatId="c1" messageId="m1" />);

    const regenerate = getByTitle("obj_zone_regenerate");
    fireEvent.click(regenerate);
    expect(mocks.generateObjectiveTasksAction).toHaveBeenCalledWith("c1");
    await waitFor(() => expect((regenerate as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(getByTitle("obj_zone_check"));
    expect(mocks.checkObjectiveCompletionAction).toHaveBeenCalledWith("c1");
  });

  it("expanded: clicking a node cycles the task status via updateObjectiveTaskAction", () => {
    seedState(ROUTE, true);
    // Pre-open the zone (simulate a prior toggle).
    useHeaderZoneExpansionStore.setState({ open: { m1: { objectiveOpen: true } } });
    const { getAllByTitle } = render(<ObjectiveZone chatId="c1" messageId="m1" />);
    // Route renders in order: t1 (completed), t2 (active), t3 (pending).
    // nodes[1] = t2 (active) → cycles to completed.
    const nodes = getAllByTitle("obj_cycle_status");
    fireEvent.click(nodes[1]!);
    expect(mocks.updateObjectiveTaskAction).toHaveBeenCalledWith("c1", "t2", { status: "completed" });
  });

  it("expanded: click a task description → inline rename → blur saves via updateObjectiveTaskAction", () => {
    seedState(ROUTE, true);
    useHeaderZoneExpansionStore.setState({ open: { m1: { objectiveOpen: true } } });
    const { getByText, getByDisplayValue } = render(<ObjectiveZone chatId="c1" messageId="m1" />);
    // The active task's description is a <button>; click it to enter edit mode.
    fireEvent.click(getByText("Enter the forest"));
    const input = getByDisplayValue("Enter the forest") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Enter the dark forest" } });
    fireEvent.blur(input);
    expect(mocks.updateObjectiveTaskAction).toHaveBeenCalledWith("c1", "t2", { description: "Enter the dark forest" });
  });

  it("visible-gate backstop: renders nothing when objective is disabled", () => {
    seedState(ROUTE, false);
    const { container } = render(<ObjectiveZone chatId="c1" messageId="m1" />);
    expect(container.firstChild).toBeNull();
  });

  it("visible-gate backstop: renders nothing when no active task (route all completed/abandoned)", () => {
    const done: ObjectiveState = {
      ...ROUTE,
      tasks: [
        { id: "t1", description: "Done A", status: "completed" },
        { id: "t2", description: "Done B", status: "abandoned" },
      ],
    };
    seedState(done, true);
    const { container } = render(<ObjectiveZone chatId="c1" messageId="m1" />);
    expect(container.firstChild).toBeNull();
  });
});

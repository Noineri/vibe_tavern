/**
 * ObjectiveConfig — INS-5 characterization.
 *
 * Pins the config-panel boundary: the component reads objective state from the
 * snapshot store and dispatches the INS-5 actions (generate / check / add /
 * edit / cycle-status / delete). The store + actions are mocked; `t` returns
 * keys verbatim. This pins the SAME boundary the acceptance check exercises
 * (enable objective → generate → tree appears → edit a task → saved) without
 * pulling in the RPC/snapshot round-trip (covered by the action + backend tests).
 *
 * Runner: vitest (apps/web — vi.mock is file-scoped, no cross-file leak).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ObjectiveConfig } from "./ObjectiveConfig.js";
import type { ObjectiveState } from "../../../api/types.js";

const mocks = vi.hoisted(() => ({
  activeChat: null as null | { id: string; insightsObjectiveState: ObjectiveState },
  generateObjectiveTasksAction: vi.fn(),
  checkObjectiveCompletionAction: vi.fn(),
  addObjectiveTaskAction: vi.fn(),
  updateObjectiveTaskAction: vi.fn(),
  deleteObjectiveTaskAction: vi.fn(),
  setObjectiveDescriptionAction: vi.fn(),
  updateObjectiveConfigAction: vi.fn(),
}));

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

vi.mock("../../../stores/snapshot-store.js", () => ({
  useSnapshotStore: (selector: (s: { activeChat: typeof mocks.activeChat }) => unknown) =>
    selector({ activeChat: mocks.activeChat }),
}));

vi.mock("../../../stores/api-actions/chat-actions.js", () => ({
  generateObjectiveTasksAction: mocks.generateObjectiveTasksAction,
  checkObjectiveCompletionAction: mocks.checkObjectiveCompletionAction,
  addObjectiveTaskAction: mocks.addObjectiveTaskAction,
  updateObjectiveTaskAction: mocks.updateObjectiveTaskAction,
  deleteObjectiveTaskAction: mocks.deleteObjectiveTaskAction,
  setObjectiveDescriptionAction: mocks.setObjectiveDescriptionAction,
  updateObjectiveConfigAction: mocks.updateObjectiveConfigAction,
}));

afterEach(() => {
  cleanup();
  mocks.activeChat = null;
  mocks.generateObjectiveTasksAction.mockReset();
  mocks.checkObjectiveCompletionAction.mockReset();
  mocks.addObjectiveTaskAction.mockReset();
  mocks.updateObjectiveTaskAction.mockReset();
  mocks.deleteObjectiveTaskAction.mockReset();
  mocks.setObjectiveDescriptionAction.mockReset();
  mocks.updateObjectiveConfigAction.mockReset();
});

const EMPTY: ObjectiveState = {
  objectiveDescription: "",
  tasks: [],
  autoCheckFrequency: 0,
  injectionDepth: 1,
  generatePrompt: "",
  checkPrompt: "",
  injectPrompt: "",
};

function withState(state: ObjectiveState) {
  mocks.activeChat = { id: "chat_1", insightsObjectiveState: state };
}

describe("ObjectiveConfig (INS-5)", () => {
  it("renders the empty state when there are no tasks", () => {
    withState(EMPTY);
    const { getByText } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    expect(getByText("obj_empty_title")).toBeTruthy();
  });

  it("renders the task route when the state has tasks (generate → tree appears)", () => {
    withState({
      ...EMPTY,
      objectiveDescription: "Find the lost amulet",
      tasks: [
        { id: "t1", description: "Ask the innkeeper", status: "completed" },
        { id: "t2", description: "Enter the forest", status: "active" },
        { id: "t3", description: "Find the cave", status: "pending" },
      ],
    });
    const { getByText, getByDisplayValue } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    // Task descriptions render (the active/pending ones as buttons, completed as a strikethrough button).
    expect(getByText("Ask the innkeeper")).toBeTruthy();
    expect(getByText("Enter the forest")).toBeTruthy();
    expect(getByText("Find the cave")).toBeTruthy();
    // The objective description seeds the textarea.
    expect(getByDisplayValue("Find the lost amulet")).toBeTruthy();
  });

  it("clicking Generate dispatches generateObjectiveTasksAction", () => {
    withState(EMPTY);
    mocks.generateObjectiveTasksAction.mockResolvedValue(undefined);
    const { getByText } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(getByText("obj_generate_button"));
    expect(mocks.generateObjectiveTasksAction).toHaveBeenCalledWith("chat_1", expect.any(AbortSignal));
  });

  it("typing + Enter in the add-task field dispatches addObjectiveTaskAction", () => {
    withState({ ...EMPTY, tasks: [{ id: "t1", description: "First", status: "pending" }] });
    mocks.addObjectiveTaskAction.mockResolvedValue(undefined);
    const { getByPlaceholderText } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    const input = getByPlaceholderText("obj_add_task_placeholder");
    fireEvent.change(input, { target: { value: "Climb the tower" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.addObjectiveTaskAction).toHaveBeenCalledWith("chat_1", "Climb the tower");
  });

  it("clicking a task description to edit + blur dispatches updateObjectiveTaskAction", () => {
    withState({ ...EMPTY, tasks: [{ id: "t1", description: "Open the gate", status: "active" }] });
    mocks.updateObjectiveTaskAction.mockResolvedValue(undefined);
    const { getByText, getByDisplayValue } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    // Click the task text (a <button>) to enter edit mode → reveals an <input>.
    fireEvent.click(getByText("Open the gate"));
    const input = getByDisplayValue("Open the gate") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Open the heavy gate" } });
    fireEvent.blur(input);
    expect(mocks.updateObjectiveTaskAction).toHaveBeenCalledWith("chat_1", "t1", { description: "Open the heavy gate" });
  });

  it("clicking the status dot cycles the status (active → completed)", () => {
    withState({ ...EMPTY, tasks: [{ id: "t1", description: "A task", status: "active" }] });
    mocks.updateObjectiveTaskAction.mockResolvedValue(undefined);
    const { getByTitle } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(getByTitle("obj_cycle_status"));
    expect(mocks.updateObjectiveTaskAction).toHaveBeenCalledWith("chat_1", "t1", { status: "completed" });
  });

  it("hovering + clicking delete dispatches deleteObjectiveTaskAction", () => {
    withState({ ...EMPTY, tasks: [{ id: "t1", description: "A task", status: "pending" }] });
    mocks.deleteObjectiveTaskAction.mockResolvedValue(undefined);
    const { getByTitle } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(getByTitle("obj_delete_task"));
    expect(mocks.deleteObjectiveTaskAction).toHaveBeenCalledWith("chat_1", "t1");
  });
});

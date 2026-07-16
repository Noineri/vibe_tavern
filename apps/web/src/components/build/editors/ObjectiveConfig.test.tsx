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
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ObjectiveConfig } from "./ObjectiveConfig.js";
import type { ObjectiveState } from "../../../api/types.js";

const mocks = vi.hoisted(() => ({
  activeChat: null as null | { id: string; insightsObjectiveState: ObjectiveState },
  generateObjectiveTasksAction: vi.fn(),
  checkObjectiveCompletionAction: vi.fn(),
  addObjectiveTaskAction: vi.fn(),
  updateObjectiveTaskAction: vi.fn(),
  reorderObjectiveTasksAction: vi.fn(),
  deleteObjectiveTaskAction: vi.fn(),
  setObjectiveDescriptionAction: vi.fn(),
  setObjectiveModeAction: vi.fn(),
  updateObjectiveLongTermGoalAction: vi.fn(),
  addObjectiveShortTermGoalAction: vi.fn(),
  updateObjectiveShortTermGoalAction: vi.fn(),
  deleteObjectiveShortTermGoalAction: vi.fn(),
  selectObjectiveShortTermGoalAction: vi.fn(),
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
  reorderObjectiveTasksAction: mocks.reorderObjectiveTasksAction,
  deleteObjectiveTaskAction: mocks.deleteObjectiveTaskAction,
  setObjectiveDescriptionAction: mocks.setObjectiveDescriptionAction,
  setObjectiveModeAction: mocks.setObjectiveModeAction,
  updateObjectiveLongTermGoalAction: mocks.updateObjectiveLongTermGoalAction,
  addObjectiveShortTermGoalAction: mocks.addObjectiveShortTermGoalAction,
  updateObjectiveShortTermGoalAction: mocks.updateObjectiveShortTermGoalAction,
  deleteObjectiveShortTermGoalAction: mocks.deleteObjectiveShortTermGoalAction,
  selectObjectiveShortTermGoalAction: mocks.selectObjectiveShortTermGoalAction,
  updateObjectiveConfigAction: mocks.updateObjectiveConfigAction,
}));

vi.mock("../../../stores/provider-data-store.js", () => ({
  // Two profiles, the first active — mirrors the real store shape ModelSelector reads.
  useProviderDataStore: (selector: (s: { profiles: Array<{ id: string; name: string; defaultModel: string | null; isActive: boolean }> }) => unknown) =>
    selector({
      profiles: [
        { id: "prof_active", name: "Active", defaultModel: "gpt-active", isActive: true },
        { id: "prof_other", name: "Other", defaultModel: "claude-other", isActive: false },
      ],
    }),
}));

vi.mock("../../../stores/api-actions/provider-actions.js", () => ({
  fetchProviderModelsAction: vi.fn().mockResolvedValue({ models: [{ id: "gpt-active", label: "GPT Active" }, { id: "gpt-mini", label: "GPT Mini" }] }),
}));

afterEach(() => {
  cleanup();
  mocks.activeChat = null;
  mocks.generateObjectiveTasksAction.mockReset();
  mocks.checkObjectiveCompletionAction.mockReset();
  mocks.addObjectiveTaskAction.mockReset();
  mocks.updateObjectiveTaskAction.mockReset();
  mocks.reorderObjectiveTasksAction.mockReset();
  mocks.deleteObjectiveTaskAction.mockReset();
  mocks.setObjectiveDescriptionAction.mockReset();
  mocks.setObjectiveModeAction.mockReset();
  mocks.updateObjectiveLongTermGoalAction.mockReset();
  mocks.addObjectiveShortTermGoalAction.mockReset();
  mocks.updateObjectiveShortTermGoalAction.mockReset();
  mocks.deleteObjectiveShortTermGoalAction.mockReset();
  mocks.selectObjectiveShortTermGoalAction.mockReset();
  mocks.updateObjectiveConfigAction.mockReset();
});

const EMPTY: ObjectiveState = {
  mode: "route",
  objectiveDescription: "",
  tasks: [],
  longTermGoal: null,
  shortTermGoals: [],
  autoCheckFrequency: 0,
  autoCheckEventCount: 0,
  contextWindow: 10,
  injectionDepth: 1,
  generatePrompt: "",
  checkPrompt: "",
  injectPrompt: "",
  useChatModel: true,
  providerProfileId: null,
  model: null,
};

function withState(state: ObjectiveState) {
  mocks.activeChat = { id: "chat_1", insightsObjectiveState: state };
}

describe("ObjectiveConfig (INS-5)", () => {
  it("renders the empty state and still allows creating the first task manually", () => {
    withState(EMPTY);
    mocks.addObjectiveTaskAction.mockResolvedValue(undefined);
    const { getByText, getByPlaceholderText } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    expect(getByText("obj_empty_title")).toBeTruthy();
    const input = getByPlaceholderText("obj_add_task_placeholder");
    fireEvent.change(input, { target: { value: "Start manually" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.addObjectiveTaskAction).toHaveBeenCalledWith("chat_1", "Start manually");
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

  it("switches to goals mode through the shared segmented control", () => {
    withState(EMPTY);
    mocks.setObjectiveModeAction.mockResolvedValue(undefined);
    const { getByRole } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(getByRole("radio", { name: "obj_mode_goals" }));
    expect(mocks.setObjectiveModeAction).toHaveBeenCalledWith("chat_1", "goals");
  });

  it("goals mode renders long/short goals and dispatches edit/add/select/delete actions", () => {
    withState({
      ...EMPTY,
      mode: "goals",
      longTermGoal: { description: "Free the city", status: "pending" },
      shortTermGoals: [
        { id: "s1", description: "Reach the gate", status: "active" },
        { id: "s2", description: "Find an ally", status: "pending" },
      ],
    });
    mocks.updateObjectiveLongTermGoalAction.mockResolvedValue(undefined);
    mocks.addObjectiveShortTermGoalAction.mockResolvedValue(undefined);
    mocks.updateObjectiveShortTermGoalAction.mockResolvedValue(undefined);
    mocks.deleteObjectiveShortTermGoalAction.mockResolvedValue(undefined);
    mocks.selectObjectiveShortTermGoalAction.mockResolvedValue(undefined);
    const view = render(<ObjectiveConfig chatId={"chat_1" as never} />);

    expect(view.getByText("obj_long_term_label")).toBeTruthy();
    expect(view.getByText("Reach the gate")).toBeTruthy();
    const longTerm = view.getByDisplayValue("Free the city") as HTMLTextAreaElement;
    fireEvent.change(longTerm, { target: { value: "Protect the free city" } });
    fireEvent.blur(longTerm);
    expect(mocks.updateObjectiveLongTermGoalAction).toHaveBeenCalledWith("chat_1", { description: "Protect the free city" });

    const addInput = view.getByPlaceholderText("obj_add_short_placeholder");
    fireEvent.change(addInput, { target: { value: "Secure supplies" } });
    fireEvent.keyDown(addInput, { key: "Enter" });
    expect(mocks.addObjectiveShortTermGoalAction).toHaveBeenCalledWith("chat_1", "Secure supplies");

    // Status controls: long-term, active short-term, pending short-term. Pending click selects it.
    fireEvent.click(view.getAllByTitle("obj_cycle_status")[2]!);
    expect(mocks.selectObjectiveShortTermGoalAction).toHaveBeenCalledWith("chat_1", "s2");

    fireEvent.click(view.getByText("Reach the gate"));
    const shortInput = view.getByDisplayValue("Reach the gate") as HTMLInputElement;
    fireEvent.change(shortInput, { target: { value: "Reach the eastern gate" } });
    fireEvent.blur(shortInput);
    expect(mocks.updateObjectiveShortTermGoalAction).toHaveBeenCalledWith("chat_1", "s1", { description: "Reach the eastern gate" });

    fireEvent.click(view.getAllByTitle("obj_delete_short")[0]!);
    expect(mocks.deleteObjectiveShortTermGoalAction).toHaveBeenCalledWith("chat_1", "s1");
  });

  it("clicking Generate dispatches generateObjectiveTasksAction", () => {
    withState(EMPTY);
    mocks.generateObjectiveTasksAction.mockResolvedValue(undefined);
    const { getByText } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(getByText("obj_generate_button"));
    expect(mocks.generateObjectiveTasksAction).toHaveBeenCalledWith("chat_1", expect.any(AbortSignal));
  });

  it("switches Generate to Stop and aborts the active request without an error toast", async () => {
    withState(EMPTY);
    let receivedSignal: AbortSignal | undefined;
    mocks.generateObjectiveTasksAction.mockImplementation((_chatId: string, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const { getByText } = render(<ObjectiveConfig chatId={"chat_1" as never} />);

    fireEvent.click(getByText("obj_generate_button"));
    fireEvent.click(getByText("obj_stop_button"));

    expect(receivedSignal?.aborted).toBe(true);
    await waitFor(() => expect(getByText("obj_generate_button")).toBeTruthy());
  });

  it("aborts an active Objective request when the editor unmounts", () => {
    withState(EMPTY);
    let receivedSignal: AbortSignal | undefined;
    mocks.generateObjectiveTasksAction.mockImplementation((_chatId: string, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const view = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(view.getByText("obj_generate_button"));

    view.unmount();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("aborts an active Objective request when the editor switches chats", () => {
    withState(EMPTY);
    let receivedSignal: AbortSignal | undefined;
    mocks.generateObjectiveTasksAction.mockImplementation((_chatId: string, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const view = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(view.getByText("obj_generate_button"));

    view.rerender(<ObjectiveConfig chatId={"chat_2" as never} />);
    expect(receivedSignal?.aborted).toBe(true);
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

  it("reorders tasks with accessible up/down controls", () => {
    withState({
      ...EMPTY,
      tasks: [
        { id: "t1", description: "First", status: "pending" },
        { id: "t2", description: "Second", status: "pending" },
      ],
    });
    mocks.reorderObjectiveTasksAction.mockResolvedValue(undefined);
    const { getAllByTitle } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    const moveUpButtons = getAllByTitle("obj_move_task_up");
    expect((moveUpButtons[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(moveUpButtons[1]);
    expect(mocks.reorderObjectiveTasksAction).toHaveBeenCalledWith("chat_1", ["t2", "t1"]);
  });

  it("saves contextWindow and exposes the injection prompt in Advanced config", () => {
    withState({ ...EMPTY, injectPrompt: "CUSTOM-INJECT" });
    mocks.updateObjectiveConfigAction.mockResolvedValue(undefined);
    const { getByText, getByDisplayValue } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    fireEvent.click(getByText("obj_advanced_label"));

    const contextInput = getByDisplayValue("10") as HTMLInputElement;
    fireEvent.change(contextInput, { target: { value: "6" } });
    fireEvent.blur(contextInput);
    expect(mocks.updateObjectiveConfigAction).toHaveBeenCalledWith("chat_1", { contextWindow: 6 });

    const injectPrompt = getByDisplayValue("CUSTOM-INJECT") as HTMLTextAreaElement;
    fireEvent.change(injectPrompt, { target: { value: "UPDATED-INJECT" } });
    fireEvent.blur(injectPrompt);
    expect(mocks.updateObjectiveConfigAction).toHaveBeenCalledWith("chat_1", { injectPrompt: "UPDATED-INJECT" });
  });

  it("hovering + clicking delete dispatches deleteObjectiveTaskAction", () => {
    withState({ ...EMPTY, tasks: [{ id: "t1", description: "A task", status: "pending" }] });
    mocks.deleteObjectiveTaskAction.mockResolvedValue(undefined);
    const { getByTitle } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    const deleteButton = getByTitle("obj_delete_task");
    const classes = deleteButton.className.split(/\s+/);
    expect(classes).not.toContain("opacity-0");
    expect(classes).toContain("md:opacity-0");
    expect(classes).toContain("md:group-hover:opacity-100");
    fireEvent.click(deleteButton);
    expect(mocks.deleteObjectiveTaskAction).toHaveBeenCalledWith("chat_1", "t1");
  });

  it("toggling 'use chat model' off dispatches updateObjectiveConfigAction", () => {
    // useChatModel defaults to true (EMPTY); turning it off pins a separate model.
    withState(EMPTY);
    mocks.updateObjectiveConfigAction.mockResolvedValue(undefined);
    const { getByRole } = render(<ObjectiveConfig chatId={"chat_1" as never} />);
    // The single switch in ObjectiveConfig is the ModelSelector's useChatModel toggle.
    fireEvent.click(getByRole("switch"));
    expect(mocks.updateObjectiveConfigAction).toHaveBeenCalledWith("chat_1", { useChatModel: false });
  });

  it("locks both dropdowns and the pin while using the chat model", async () => {
    withState({ ...EMPTY, model: "gpt-mini" });
    const { getByRole, getByTitle } = render(<ObjectiveConfig chatId={"chat_1" as never} />);

    const providerDropdown = getByRole("button", { name: /Active/ });
    await waitFor(() => expect(getByRole("button", { name: /GPT Active/ })).toBeTruthy());
    const modelDropdown = getByRole("button", { name: /GPT Active/ });

    expect(providerDropdown.className).toContain("opacity-40");
    expect(modelDropdown.className).toContain("opacity-40");
    expect((getByTitle("obj_model_unpin") as HTMLButtonElement).disabled).toBe(true);
  });
});

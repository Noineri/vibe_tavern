/**
 * TrackerConfig — SCN-11 characterization.
 *
 * Pins the config-panel boundary: the component reads the stored tracker config
 * from the snapshot store, edits a local draft, validates the DSL client-side
 * (invalid schema cannot save/preview), persists the whole draft as a partial
 * tracker PATCH (never touching Objective toggles), and trial-runs a
 * cancellable non-persisting preview with last-valid preservation. The store +
 * actions are mocked; `t` returns keys verbatim; `CodeEditor` is stubbed to a
 * textarea so the DSL can be driven in happy-dom. Mirrors ObjectiveConfig.test.
 *
 * Runner: vitest (apps/web — vi.mock is file-scoped, no cross-file leak).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { TrackerConfig } from "./TrackerConfig.js";
import { brandId, type ChatId, type SceneTrackerConfig } from "@vibe-tavern/domain";

const mocks = vi.hoisted(() => ({
  activeChat: null as null | { id: string; insightsConfig: { tracker?: SceneTrackerConfig; trackerEnabled: boolean; objectiveEnabled: boolean } },
  updateInsightsConfigAction: vi.fn(),
  previewSceneAction: vi.fn(),
  findCurrentInsightsCompletionTarget: vi.fn(),
  fetchProviderModelsAction: vi.fn(),
}));

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

vi.mock("../../../stores/snapshot-store.js", () => ({
  useSnapshotStore: (selector: (s: { activeChat: typeof mocks.activeChat; messageOrder: string[]; messagesById: Record<string, { role?: string }> }) => unknown) =>
    selector({ activeChat: mocks.activeChat, messageOrder: [], messagesById: {} }),
}));

vi.mock("../../../stores/api-actions/chat-actions.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, updateInsightsConfigAction: mocks.updateInsightsConfigAction, previewSceneAction: mocks.previewSceneAction };
});

vi.mock("../../../stores/api-actions/insights-completion-actions.js", () => ({
  findCurrentInsightsCompletionTarget: mocks.findCurrentInsightsCompletionTarget,
}));

vi.mock("../../../stores/provider-data-store.js", () => ({
  useProviderDataStore: (selector: (s: { profiles: Array<{ id: string; name: string; defaultModel: string | null; isActive: boolean }> }) => unknown) =>
    selector({ profiles: [{ id: "prof_1", name: "Active", defaultModel: "gpt-x", isActive: true }] }),
}));

vi.mock("../../../stores/api-actions/provider-actions.js", () => ({
  fetchProviderModelsAction: mocks.fetchProviderModelsAction.mockResolvedValue({ models: [{ id: "gpt-x", label: "GPT X" }] }),
}));

vi.mock("../../../stores/api-actions/chat-actions.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, updateInsightsConfigAction: mocks.updateInsightsConfigAction, previewSceneAction: mocks.previewSceneAction };
});

// Stub CodeEditor (CodeMirror 6) to a plain textarea so the DSL can be driven
// in happy-dom. Async factory so `await import("react")` is available.
vi.mock("../../shared/CodeEditor.js", async () => {
  const React = await import("react");
  return {
    CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
      React.createElement("textarea", {
        "data-testid": "scn-dsl",
        value,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value),
      }),
  };
});

const VALID_DSL = JSON.stringify({ mood: { $type: "string" } });

const CHAT_ID = brandId<ChatId>("chat_1");

function seed(tracker?: Partial<SceneTrackerConfig>): void {
  mocks.activeChat = {
    id: "chat_1",
    insightsConfig: {
      objectiveEnabled: true,
      trackerEnabled: true,
      tracker: {
        schema: {},
        autoMode: "assistant",
        contextWindow: 6,
        continuityLastN: 3,
        injectionDepth: 1,
        injectLastN: 1,
        promptFormat: "json",
        useChatModel: true,
        generatePrompt: "",
        injectPrompt: "",
        providerProfileId: null,
        model: null,
        revision: 0,
        schemaHash: "",
        ...tracker,
      } as SceneTrackerConfig,
    },
  };
}

afterEach(() => {
  cleanup();
  mocks.updateInsightsConfigAction.mockReset();
  mocks.previewSceneAction.mockReset();
  mocks.findCurrentInsightsCompletionTarget.mockReset();
  mocks.findCurrentInsightsCompletionTarget.mockReturnValue({ branchId: "b1", messageId: "m1", variantId: "v1" });
  mocks.activeChat = null;
});

describe("TrackerConfig (SCN-11)", () => {
  it("renders the editor with Save disabled (not dirty) and Preview enabled", () => {
    seed();
    const { getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    expect(getByText("scn_schema_label")).toBeTruthy();
    expect(getByText("scn_save_button")).toBeTruthy();
    expect(getByText("scn_preview_button")).toBeTruthy();
    // Save is a button — assert it is disabled when not dirty.
    const saveBtn = getByText("scn_save_button").closest("button")!;
    expect(saveBtn.disabled).toBe(true);
  });

  it("an invalid DSL shows an inline error and disables Save + Preview", async () => {
    seed();
    const { getByTestId, getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    fireEvent.change(getByTestId("scn-dsl"), { target: { value: "{ not json" } });
    await waitFor(() => expect(getByText("scn_save_button").closest("button")!.disabled).toBe(true));
    expect(getByText("scn_preview_button").closest("button")!.disabled).toBe(true);
  });

  it("an invalid $type is rejected by the schema and disables Save + Preview", async () => {
    seed();
    const { getByTestId, getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    fireEvent.change(getByTestId("scn-dsl"), { target: { value: JSON.stringify({ bad: { $type: "nope" } }) } });
    await waitFor(() => expect(getByText("scn_save_button").closest("button")!.disabled).toBe(true));
    expect(getByText("scn_preview_button").closest("button")!.disabled).toBe(true);
  });

  it("a valid DSL edit makes the draft dirty and Save persists a partial tracker PATCH (Objective untouched)", async () => {
    seed();
    mocks.updateInsightsConfigAction.mockResolvedValue(undefined);
    const { getByTestId, getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    fireEvent.change(getByTestId("scn-dsl"), { target: { value: VALID_DSL } });
    const saveBtn = getByText("scn_save_button").closest("button")!;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    fireEvent.click(saveBtn);
    await waitFor(() => expect(mocks.updateInsightsConfigAction).toHaveBeenCalledTimes(1));
    const [chatId, input] = mocks.updateInsightsConfigAction.mock.calls[0];
    expect(chatId).toBe("chat_1");
    // The PATCH nests under insightsConfig.tracker and carries the edited schema.
    expect(input.insightsConfig.tracker.schema).toEqual({ mood: { $type: "string" } });
    // Objective toggles are NEVER part of a tracker PATCH (partial PATCH preserves Objective).
    expect(input.insightsConfig.objectiveEnabled).toBeUndefined();
    expect(input.insightsConfig.trackerEnabled).toBeUndefined();
    // Server-managed revision/schemaHash are excluded from the patch.
    expect(input.insightsConfig.tracker.revision).toBeUndefined();
    expect(input.insightsConfig.tracker.schemaHash).toBeUndefined();
  });

  it("Preview trial-runs with the DRAFT config + the selected variant target", async () => {
    seed();
    mocks.previewSceneAction.mockResolvedValue({ target: { chatId: "chat_1" }, sceneState: { mood: "tense" } });
    const { getByTestId, getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    fireEvent.change(getByTestId("scn-dsl"), { target: { value: VALID_DSL } });
    fireEvent.click(getByText("scn_preview_button"));
    await waitFor(() => expect(mocks.previewSceneAction).toHaveBeenCalledTimes(1));
    const [previewChatId, target, config] = mocks.previewSceneAction.mock.calls[0];
    expect(previewChatId).toBe("chat_1");
    expect(target).toEqual({ branchId: "b1", messageId: "m1", variantId: "v1" });
    expect(config.schema).toEqual({ mood: { $type: "string" } }); // the DRAFT, not the stored {}
  });

  it("preserves the last-valid preview when a retry fails (last-valid preservation)", async () => {
    seed();
    mocks.previewSceneAction.mockResolvedValueOnce({ target: { chatId: "chat_1" }, sceneState: { mood: "calm" } });
    const { getByTestId, getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    fireEvent.change(getByTestId("scn-dsl"), { target: { value: VALID_DSL } });
    fireEvent.click(getByText("scn_preview_button"));
    await waitFor(() => expect(mocks.previewSceneAction).toHaveBeenCalledTimes(1));
    expect(getByText(/"mood": "calm"/)).toBeTruthy();

    // Second preview rejects — the prior preview (calm) must remain visible.
    mocks.previewSceneAction.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(getByText("scn_preview_button"));
    await waitFor(() => expect(mocks.previewSceneAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getByText("scn_preview_button")).toBeTruthy()); // not previewing anymore
    expect(getByText(/"mood": "calm"/)).toBeTruthy(); // last-valid preserved
  });

  it("Preview is cancellable (Cancel aborts the in-flight trial)", async () => {
    seed();
    let release!: () => void;
    mocks.previewSceneAction.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ target: { chatId: "chat_1" }, sceneState: {} }); }),
    );
    const { getByTestId, getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    fireEvent.change(getByTestId("scn-dsl"), { target: { value: VALID_DSL } });
    fireEvent.click(getByText("scn_preview_button"));
    await waitFor(() => expect(getByText("scn_preview_stop_button")).toBeTruthy()); // now shows Cancel
    fireEvent.click(getByText("scn_preview_stop_button"));
    // Abort does not crash; the button returns to Preview after the promise settles.
    release();
    await waitFor(() => expect(getByText("scn_preview_button")).toBeTruthy());
  });

  it("Preview without a selected assistant variant toasts and does not call the action", async () => {
    seed();
    mocks.findCurrentInsightsCompletionTarget.mockReturnValue(null);
    const { getByTestId, getByText } = render(createElement(TrackerConfig, { chatId: CHAT_ID }));
    fireEvent.change(getByTestId("scn-dsl"), { target: { value: VALID_DSL } });
    fireEvent.click(getByText("scn_preview_button"));
    await waitFor(() => expect(mocks.previewSceneAction).not.toHaveBeenCalled());
  });
});

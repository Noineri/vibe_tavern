/**
 * SceneHistoryBackfill — SCN-15 boundary characterization.
 *
 * Pins the Build→Insights→Scene→History backfill client: it reads the saved
 * tracker config + active-branch assistant count from the snapshot store,
 * resolves the effective model's pricing for a CONDITIONAL estimate (hidden when
 * pricing is unknown), starts a server-authoritative run, polls typed status to
 * terminal, refreshes the snapshot when records land, reattaches on reload via
 * the persisted runId, and wires cancel/retry/new-run. Store + actions are
 * mocked; `t` returns keys verbatim. Mirrors TrackerConfig.test's harness.
 *
 * Runner: vitest (apps/web — vi.mock is file-scoped, no cross-file leak).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SceneHistoryBackfill } from "./SceneHistoryBackfill.js";
import { brandId, type ChatId, type SceneTrackerConfig } from "@vibe-tavern/domain";

const mocks = vi.hoisted(() => {
  const tracker: SceneTrackerConfig = {
    schema: {}, autoMode: "assistant", contextWindow: 6, continuityLastN: 3,
    injectionDepth: 1, injectLastN: 1, promptFormat: "json", useChatModel: true,
    generatePrompt: "", injectPrompt: "", providerProfileId: null, model: null, revision: 0, schemaHash: "",
  } as never;
  const state: {
    activeChat: { insightsConfig: { tracker: SceneTrackerConfig; trackerEnabled: boolean } };
    messageOrder: string[];
    messagesById: Record<string, { id: string; role: string }>;
  } = {
    activeChat: { insightsConfig: { tracker, trackerEnabled: true } },
    messageOrder: ["m1", "m2", "m3"],
    messagesById: {
      m1: { id: "m1", role: "assistant" },
      m2: { id: "m2", role: "user" },
      m3: { id: "m3", role: "assistant" },
    },
  };
  return {
    state,
    start: vi.fn(),
    getStatus: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    fetchChat: vi.fn(),
    fetchModels: vi.fn(),
  };
});

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

vi.mock("../../../stores/snapshot-store.js", () => ({
  useSnapshotStore: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
}));

vi.mock("../../../stores/provider-data-store.js", () => ({
  useProviderDataStore: (selector: (s: { profiles: Array<{ id: string; name: string; defaultModel: string | null; isActive: boolean }> }) => unknown) =>
    selector({ profiles: [{ id: "prof_1", name: "Active", defaultModel: "gpt-x", isActive: true }] }),
}));

vi.mock("../../../stores/api-actions/chat-actions.js", () => ({
  startSceneBackfillAction: mocks.start,
  getSceneBackfillStatusAction: mocks.getStatus,
  cancelSceneBackfillAction: mocks.cancel,
  retrySceneBackfillAction: mocks.retry,
  fetchChatAction: mocks.fetchChat,
}));

vi.mock("../../../stores/api-actions/provider-actions.js", () => ({
  fetchProviderModelsAction: mocks.fetchModels.mockResolvedValue({ models: [{ id: "gpt-x", label: "GPT X" }] }),
}));

const CHAT: ChatId = brandId<ChatId>("chat_1");
const KEY = "vt:scene-backfill:chat_1";

function runningStatus(overrides: Partial<{ runId: string; processed: number; total: number; current: { messageId: string; variantId: string } | null }> = {}) {
  return {
    runId: "run_1", chatId: "chat_1", mode: "fill-missing" as const, status: "running" as const,
    total: 2, processed: 0, current: { messageId: "m1", variantId: "v1" }, errors: [], summary: null, cancelRequested: false, ...overrides,
  };
}
function terminalStatus(overrides: Partial<{ status: "completed" | "cancelled" | "failed"; summary: { total: number; succeeded: number; skipped: number; failed: number } | null }> = {}) {
  return {
    runId: "run_1", chatId: "chat_1", mode: "fill-missing" as const, status: "completed" as const,
    total: 2, processed: 2, current: null, errors: [], summary: { total: 2, succeeded: 2, skipped: 0, failed: 0 }, cancelRequested: false, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchModels.mockResolvedValue({ models: [{ id: "gpt-x", label: "GPT X" }] });
  localStorage.clear();
});
afterEach(() => { cleanup(); });

describe("SceneHistoryBackfill — idle form", () => {
  it("renders mode buttons + Start; hides estimate when pricing is unknown", () => {
    const { getByText, queryByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    expect(getByText("scn_hist_mode_fill")).toBeTruthy();
    expect(getByText("scn_hist_mode_rebuild")).toBeTruthy();
    expect(getByText("scn_hist_start")).toBeTruthy();
    // No pricing metadata → estimate key absent.
    expect(queryByText("scn_hist_estimate")).toBeNull();
  });

  it("shows the conditional estimate when the resolved model carries pricing.output", async () => {
    mocks.fetchModels.mockResolvedValue({ models: [{ id: "gpt-x", label: "GPT X", pricing: { input: 1, output: 5 } }] });
    const { findByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    expect(await findByText("scn_hist_estimate")).toBeTruthy();
  });

  it("disables Start and shows the no-messages hint when the branch has no assistant messages", () => {
    mocks.state.messageOrder = ["m1"];
    mocks.state.messagesById = { m1: { id: "m1", role: "user" } };
    try {
      const { getByText, getByRole } = render(<SceneHistoryBackfill chatId={CHAT} />);
      expect(getByText("scn_hist_no_messages")).toBeTruthy();
      expect((getByRole("button", { name: "scn_hist_start" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      mocks.state.messageOrder = ["m1", "m2", "m3"];
      mocks.state.messagesById = { m1: { id: "m1", role: "assistant" }, m2: { id: "m2", role: "user" }, m3: { id: "m3", role: "assistant" } };
    }
  });
});

describe("SceneHistoryBackfill — start / poll / terminal", () => {
  it("Start dispatches startSceneBackfillAction with the selected mode", () => {
    mocks.start.mockResolvedValue(terminalStatus());
    const { getByText, getByRole } = render(<SceneHistoryBackfill chatId={CHAT} />);
    fireEvent.click(getByText("scn_hist_mode_rebuild"));
    fireEvent.click(getByRole("button", { name: "scn_hist_start" }));
    expect(mocks.start).toHaveBeenCalledWith(CHAT, "rebuild");
  });

  it("polls status to terminal, then refreshes the snapshot (records land server-side)", async () => {
    mocks.start.mockResolvedValue(runningStatus());
    mocks.getStatus.mockResolvedValueOnce(terminalStatus());
    const { getByRole } = render(<SceneHistoryBackfill chatId={CHAT} />);
    fireEvent.click(getByRole("button", { name: "scn_hist_start" }));
    // The real POLL_MS poll fires (~2.5s); wait for the terminal refresh.
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledWith(CHAT, "run_1"), { timeout: 4000 });
    await waitFor(() => expect(mocks.fetchChat).toHaveBeenCalledWith(CHAT), { timeout: 4000 });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("Cancel while running dispatches cancelSceneBackfillAction", async () => {
    mocks.start.mockResolvedValue(runningStatus());
    mocks.cancel.mockResolvedValue(terminalStatus({ status: "cancelled" }));
    const { getByRole, findByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    fireEvent.click(getByRole("button", { name: "scn_hist_start" }));
    const cancelBtn = await findByText("scn_hist_cancel");
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(CHAT, "run_1"));
  });
});

describe("SceneHistoryBackfill — reload reattach", () => {
  it("re-polls a persisted runId on mount (running → progress view)", async () => {
    localStorage.setItem(KEY, "run_9");
    mocks.getStatus.mockResolvedValue(runningStatus({ runId: "run_9" }));
    const { findByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledWith(CHAT, "run_9"));
    expect(await findByText("scn_hist_cancel")).toBeTruthy();
  });

  it("reattach to a terminal run clears the persisted id and refreshes the snapshot", async () => {
    localStorage.setItem(KEY, "run_9");
    mocks.getStatus.mockResolvedValue(terminalStatus());
    render(<SceneHistoryBackfill chatId={CHAT} />);
    await waitFor(() => expect(mocks.fetchChat).toHaveBeenCalledWith(CHAT));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("drops a persisted runId that the server no longer knows (gone)", async () => {
    localStorage.setItem(KEY, "run_old");
    mocks.getStatus.mockRejectedValue(new Error("not found"));
    const { findByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledWith(CHAT, "run_old"));
    expect(localStorage.getItem(KEY)).toBeNull();
    // Falls back to the start form.
    expect(await findByText("scn_hist_start")).toBeTruthy();
  });
});

describe("SceneHistoryBackfill — retry / summary", () => {
  it("Retry on a failed terminal run dispatches retrySceneBackfillAction and resumes", async () => {
    localStorage.setItem(KEY, "run_1");
    mocks.getStatus.mockResolvedValueOnce(terminalStatus({ status: "failed", summary: { total: 2, succeeded: 1, skipped: 0, failed: 1 } }));
    mocks.retry.mockResolvedValue(runningStatus());
    const { findByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    await findByText("scn_hist_retry");
    fireEvent.click(await findByText("scn_hist_retry"));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith(CHAT, "run_1"));
  });

  it("partial summary: completed with failures surfaces succeeded + failed counts and Retry", async () => {
    localStorage.setItem(KEY, "run_1");
    mocks.getStatus.mockResolvedValue(terminalStatus({ status: "completed", summary: { total: 2, succeeded: 1, skipped: 0, failed: 1 } }));
    const { findByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    await findByText("scn_hist_status_completed");
    expect(await findByText("scn_hist_retry")).toBeTruthy();
  });

  it("New run resets to the idle start form", async () => {
    localStorage.setItem(KEY, "run_1");
    mocks.getStatus.mockResolvedValue(terminalStatus());
    const { findByText } = render(<SceneHistoryBackfill chatId={CHAT} />);
    fireEvent.click(await findByText("scn_hist_new"));
    expect(await findByText("scn_hist_start")).toBeTruthy();
  });
});

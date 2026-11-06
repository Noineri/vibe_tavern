/**
 * SUM-4 pin persistence regression — the summary tab's pinned provider/model
 * pair must survive unpin/re-pin and never resurrect from a stale bootstrap
 * store on parent re-renders.
 *
 * Owner incident (2026-11, "сводка ломает выбор модели"): with a persisted pin
 * (nanoGPT + glm-5.2), unpinning the star and picking another model
 * (gate + gemini-3.8-flash) never stuck — generating or just letting AppShell
 * re-render snapped the picker back to the old pair, and "use chat model"
 * changed only the provider while the resurrected pin hijacked the model
 * (provider/model mismatch → generation error). Root cause was two-sided:
 *  1. SummaryTab wrote the pin through the bare `updateUiSettings` API — the
 *     server got the write, the bootstrap store never did.
 *  2. The hydration effect keyed on the `providers` ARRAY prop, whose identity
 *     changes on every AppShell render (a fresh `.map()` each render) — so
 *     every re-render re-applied the stale store pair over the user's fresh
 *     selection.
 * The fix routes pin writes through patchUiSettingsAction (store-merging) and
 * keys the effect on a stable provider-ids string.
 *
 * This file renders the REAL detail editor (AiAssistantConnectionFields +
 * DropdownSelect cmdk items + the pin star); only the network boundary is
 * mocked (settings write, model list, summary list/run reads).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { wireUiSettings } from "../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import type { ChatId } from "@vibe-tavern/domain";
import type { ChatSummaryRecord, UiSettingsRecord } from "../../api/types.js";

useDomEnv();

const { fireEvent, render: rtlRender, waitFor } = await import("@testing-library/react");
const { TooltipProvider } = await import("../shared/Tooltip.js");
function render(ui: React.ReactNode) {
  return rtlRender(ui, { wrapper: ({ children }) => <TooltipProvider delayDuration={0}>{children}</TooltipProvider> });
}

const originalFetch = globalThis.fetch;
async function stateFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname.replace(/^\/null/, "");
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method === "GET" && path === "/api/chats/chat/summaries/generate") return Response.json(null);
  throw new Error(`Unexpected fetch: ${method} ${path}`);
}
globalThis.fetch = stateFetch as typeof fetch;
afterAll(() => { globalThis.fetch = originalFetch; });

// Load-time copies (mock.module rewrites export slots in place — spreading the
// LIVE namespace inside a factory re-registers the current mock, R15).
const realSettingsApi = { ...(await import("../../api/settings-api.js")) };
const realChatActions = { ...(await import("../../stores/api-actions/chat-actions.js")) };

// The server echoes the full record; the mock merges the patch into the live
// record the same way (explicit nulls clear — mirrors SettingsAdapter).
let savedRecord: UiSettingsRecord = wireUiSettings();
const settingsUpdateMock = mock(async (patch: Partial<UiSettingsRecord>): Promise<UiSettingsRecord> => {
  savedRecord = { ...savedRecord, ...patch };
  return savedRecord;
});

mock.module("../../api/settings-api.js", () => ({
  ...realSettingsApi,
  updateUiSettings: settingsUpdateMock,
}));
mock.module("../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  listChatSummariesAction: mock(async (_chatId: ChatId): Promise<ChatSummaryRecord[]> => []),
}));
installI18nContextSeam();

let useSummaryTab: typeof import("./SummaryTab.js").useSummaryTab;
let useBootstrapStore: typeof import("../../stores/api-actions/bootstrap-actions.js").useBootstrapStore;

beforeAll(async () => {
  ({ useSummaryTab } = await import("./SummaryTab.js"));
  ({ useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js"));
});

// The owner's case: the persisted pin is nanoGPT + glm-5.2; she wants
// gate + gemini-3.8-flash.
const PROFILES = [
  { id: "nanogpt", name: "NanoGPT", defaultModel: "glm-5.2", hasStoredApiKey: true, isActive: true },
  { id: "gate", name: "Gate", defaultModel: "gemini-3.8-flash", hasStoredApiKey: true },
];
// No contextLength on purpose: the trigger renders label+detail as one text
// node — an exact-text match on the label stays stable.
const MODELS = [
  { id: "glm-5.2", label: "GLM 5.2" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
];

let currentProviders = [...PROFILES];

function Harness() {
  const tab = useSummaryTab({
    isOpen: true,
    onClose: () => {},
    activeChatId: "chat" as ChatId,
    providers: currentProviders,
    contextWindow: { used: 0, limit: 1000 },
    currentSummary: "",
    messageCount: 12,
    onSummarize: async () => "",
    onSaveSummary: async () => "",
    onFetchModelsForProfile: async () => MODELS,
  });
  return <>{tab.detailEditor}</>;
}

function starLabel(view: ReturnType<typeof render>): string | null {
  if (view.queryByRole("button", { name: "summary_unpin_model" })) return "summary_unpin_model";
  if (view.queryByRole("button", { name: "summary_pin_model" })) return "summary_pin_model";
  return null;
}

function triggerWithText(view: ReturnType<typeof render>, text: string): HTMLButtonElement | null {
  return (Array.from(view.container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined) ?? null;
}

/** Open the dropdown whose trigger shows `triggerText` and click the cmdk item
 *  carrying `itemValue` (cmdk exposes the Command.Item value as data-value).
 *  No act() wrappers here — act deadlocks on this hook chain under
 *  happy-dom (dom-env drains React 19 passive effects itself); clicks are
 *  synchronous and state settles via waitFor. */
async function pickFrom(view: ReturnType<typeof render>, triggerText: string, itemValue: string): Promise<void> {
  const trigger = triggerWithText(view, triggerText);
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger!);
  const item = await waitFor(() => {
    const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find(
      (i) => i.getAttribute("data-value") === itemValue,
    );
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  fireEvent.click(item);
  await waitFor(() => expect(document.body.querySelector("[cmdk-list]")).toBeNull());
}

/** AppShell maps a fresh providers array on every render — simulate that
 *  identity churn (same content, new array); state settles via waitFor. */
function rerenderWithFreshProviders(view: ReturnType<typeof render>): void {
  currentProviders = [...PROFILES];
  view.rerender(<Harness />);
}

beforeEach(() => {
  savedRecord = {
    ...wireUiSettings(),
    summaryProviderId: "nanogpt",
    summaryModelName: "glm-5.2",
  };
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: savedRecord,
      agentKindSettings: {},
      isArmServer: false,
    },
  });
  currentProviders = [...PROFILES];
  settingsUpdateMock.mockClear();
});

describe("SummaryTab pin persistence (SUM-4)", () => {
  test("hydrate: the persisted pair restores the pin on open", async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(starLabel(view)).toBe("summary_unpin_model"));
    await waitFor(() => expect(triggerWithText(view, "GLM 5.2")).toBeTruthy());
  });

  test("unpin clears the persisted pair in store AND survives parent re-renders", async () => {
    const view = render(<Harness />);
    // Settled state first (hydration + model list loaded)…
    await waitFor(() => expect(triggerWithText(view, "GLM 5.2")).toBeTruthy());
    // …then click the star on a freshly queried node.
    const star = view.getByRole("button", { name: "summary_unpin_model" });
    expect(star).toBeTruthy();
    fireEvent.click(star!);

    await waitFor(() =>
      expect(settingsUpdateMock).toHaveBeenCalledWith({ summaryProviderId: null, summaryModelName: null }),
    );
    // The write path must merge into the bootstrap store — this is the half
    // the bare updateUiSettings call skipped (the stale pair lived on in the
    // store for the whole session).
    await waitFor(() => expect(useBootstrapStore.getState().data?.uiSettings.summaryModelName).toBeNull());
    await waitFor(() => expect(starLabel(view)).toBe("summary_pin_model"));

    // AppShell re-renders (generation, SSE, toasts) hand the tab a NEW
    // providers array with the same content — the old pinned pair must NOT
    // resurrect from the store.
    rerenderWithFreshProviders(view);
    await waitFor(() => expect(starLabel(view)).toBe("summary_pin_model"));
    expect(useBootstrapStore.getState().data?.uiSettings.summaryProviderId).toBeNull();
  });

  test("model change while pinned persists the new pair and survives parent re-renders", async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(triggerWithText(view, "GLM 5.2")).toBeTruthy());

    await pickFrom(view, "GLM 5.2", "gemini-3.8-flash");

    await waitFor(() =>
      expect(settingsUpdateMock).toHaveBeenCalledWith({ summaryProviderId: "nanogpt", summaryModelName: "gemini-3.8-flash" }),
    );
    await waitFor(() =>
      expect(useBootstrapStore.getState().data?.uiSettings.summaryModelName).toBe("gemini-3.8-flash"),
    );
    await waitFor(() => expect(triggerWithText(view, "Gemini 3.8 Flash")).toBeTruthy());

    rerenderWithFreshProviders(view);
    // The pre-fix bug snapped the picker back to GLM 5.2 here.
    await waitFor(() => expect(triggerWithText(view, "Gemini 3.8 Flash")).toBeTruthy());
    expect(triggerWithText(view, "GLM 5.2")).toBeNull();
  });
});

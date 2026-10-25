/**
 * CoauthorMobileInputArea — E4 pin (MOBILE_DEFECTS_ROUND_2).
 *
 * The mobile co-author input must NOT send on Enter: the on-screen enter key
 * IS the newline key (same convention as the RP MobileInputArea, which has no
 * keydown-to-send handler at all). Sending happens via the send button only.
 * This pins the wiring boundary: bare Enter and Shift+Enter never reach
 * chat.handleSend from the textarea; the send button does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireProviderProfile, wireUiSettings } from "../../../test/wire-fixtures.js";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { TooltipProvider } from "../shared/Tooltip.js";
import type { CoauthorInputAreaData } from "./use-coauthor-input-area.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => key === "context_usage_percent" ? `Context: ${opts?.n}%` : key === "context_label" ? "Context" : key === "context_permanent" ? "Permanent" : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let act: typeof import("@testing-library/react").act;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let cleanup: typeof import("@testing-library/react").cleanup;
let CoauthorMobileInputArea: typeof import("./CoauthorMobileInputArea.js").CoauthorMobileInputArea;

beforeAll(async () => {
  ({ act, render, fireEvent, waitFor, cleanup } = await import("@testing-library/react"));
  ({ CoauthorMobileInputArea } = await import("./CoauthorMobileInputArea.js"));
});

const assets = await import("../../api/asset-api.js");
const imageRoutes = await import("../../api/image-route-api.js");
const controller = await import("../../hooks/use-chat-controller.js");
const chatActions = await import("../../stores/api-actions/chat-actions.js");
const { useChatStore } = await import("../../stores/chat-store.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
const { useProviderDataStore } = await import("../../stores/provider-data-store.js");
const { useCoauthorInputArea } = await import("./use-coauthor-input-area.js");
const initial = { chat: useChatStore.getState(), bootstrap: useBootstrapStore.getState(), data: useProviderDataStore.getState() };
const spies: Array<{ mockRestore(): void }> = [];
function restore() {
  cleanup?.();
  for (const spy of spies.splice(0)) spy.mockRestore();
  // Co-load guard (bun spyOn semantics, proven by probe): mockRestore on a
  // spy that wraps ANOTHER file's mock.module `mock()` fn resets that SHARED
  // fn's implementation — it still exists but resolves `undefined`, so a
  // pending `use-coauthor-input-area` effect flushing in a later describe
  // crashes on `.then` of undefined (only in hand-bundled multi-file runs;
  // the official runner isolates files). Re-prime it; per-file this is a
  // no-op — the real action fn has no `.mockImplementation` slot.
  const listFn = chatActions.listCoauthorModulesAction as unknown as {
    mockImplementation?: (impl: () => Promise<unknown[]>) => unknown;
  };
  if (typeof listFn?.mockImplementation === "function") {
    listFn.mockImplementation(async () => []);
  }
  useChatStore.setState(initial.chat, true);
  useBootstrapStore.setState(initial.bootstrap, true);
  useProviderDataStore.setState(initial.data, true);
}
beforeEach(restore);
afterEach(restore);
afterAll(restore);

// CA-3b: the added cases compose the REAL data hook, draft store and preview.
// Upload is the network seam; send is the existing controller boundary.
// Every spy/store restored; no paths, real i18n init, sleeps or DB setup.
function setupComposer() {
  const handleSend = mock(async () => {});
  spies.push(spyOn(controller, "useChatController").mockReturnValue({ handleSend, handleCancelGeneration: () => {} } as unknown as ReturnType<typeof controller.useChatController>));
  spies.push(spyOn(chatActions, "listCoauthorModulesAction").mockResolvedValue([]));
  useBootstrapStore.setState({ data: {
    initialChatId: null, snapshot: null, isFirstRun: false, allCharacters: [], promptPresets: [], agentKindSettings: {}, isArmServer: false,
    uiSettings: { ...wireUiSettings(), coauthorProviderId: "p1" },
  } });
  useProviderDataStore.setState({
    profiles: [{ ...wireProviderProfile(), id: "p1", defaultModel: "model", cachedModels: { cachedAt: "0", models: [{ id: "model", label: "Model", contextLength: 10000, capabilities: { tools: true } }] } }],
    coauthorFavoritesByProfile: { p1: [] },
    coauthorSettingsByProfile: { p1: { providerProfileId: "p1", modelName: "model", settings: { contextBudget: 6000, maxTokens: 1000 }, createdAt: "0", updatedAt: "0" } },
  });
  useChatStore.getState().setActiveChatId(brandId<ChatId>("chat1"));
  function Harness() {
    const data = useCoauthorInputArea();
    return <TooltipProvider><CoauthorMobileInputArea data={data} /></TooltipProvider>;
  }
  return { handleSend, view: render(<Harness />) };
}

describe("CoauthorMobileInputArea attachments (CA-3b)", () => {
  it("paperclip opens the multiple picker and sits before favorites with RP mobile chrome", async () => {
    const { view } = setupComposer();
    const clip = view.getByRole("button", { name: "attach_image" });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = spyOn(input, "click");
    spies.push(click);
    fireEvent.click(clip);
    expect(click).toHaveBeenCalledTimes(1);
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain(".md");
    expect(input.accept).not.toMatch(/audio|video/);
    expect(clip.className).toBe("ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-s3 text-t3 transition-colors active:bg-s2 disabled:opacity-45");
    expect(clip.nextElementSibling).toBe(view.getByTestId("coauthor-favorites-pill"));
    expect(view.getByTestId("coauthor-favorites-pill").className).not.toContain("ml-auto");
    await waitFor(() => expect(chatActions.listCoauthorModulesAction).toHaveBeenCalled());
  });

  it("pasted markdown lands in the draft, renders the shared chip and enables attachment-only send", async () => {
    const upload = spyOn(assets, "uploadAsset").mockResolvedValue({ assetId: "notes", url: "notes", tokenCount: 42 });
    spies.push(upload);
    const { view, handleSend } = setupComposer();
    expect((view.getByTestId("coauthor-send-btn") as HTMLButtonElement).disabled).toBe(true);
    const file = new File(["Notes"], "notes.md");
    fireEvent.paste(view.getByTestId("coauthor-input-textarea"), { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
    await waitFor(() => expect(useChatStore.getState().draftAttachments).toHaveLength(1));
    expect(upload).toHaveBeenCalledWith(file);
    expect(view.getByTestId("file-attachment-chip")).toBeDefined();
    expect((view.getByTestId("coauthor-send-btn") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByTestId("coauthor-send-btn"));
    expect(handleSend).toHaveBeenCalledTimes(1);
  });

  it("the shared warning stays above the mobile frame and never disables an attachment-only send", async () => {
    const { view } = setupComposer();
    act(() => useChatStore.getState().addDraftAttachment({ id: "file", assetId: "asset", name: "notes.md", type: "file", mimeType: "text/markdown", sizeBytes: 12, tokenCount: 5001 }));
    const warning = view.getByText("attachments_overflow_warning");
    expect(warning.closest('[role="status"]')).not.toBeNull();
    expect((view.getByTestId("coauthor-send-btn") as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(chatActions.listCoauthorModulesAction).toHaveBeenCalled());
  });
});

/** Minimal CoauthorInputAreaData — only the fields this component reads. */
function makeData(draft = "hello world") {
  const handleSend = mock();
  const data = {
    t: (k: string) => k,
    chat: { handleSend, handleCancelGeneration: mock() },
    draft,
    setDraft: mock(),
    isSending: false,
    activeChatId: "chat-1",
    canUseLiveApi: true,
    canSend: true,
    fileInputRef: { current: null }, accept: "image/png,.md", draftAttachments: [],
    onFileInputChange: mock(), handlePaste: mock(), remove: mock(), attachmentOverflow: null,
    activeProfileId: "p1",
    favorites: [],
    activeModelId: "m1",
    handleSelectModel: mock(),
    sendLabel: "Send",
    sendButtonText: "Send",
    buckets: { moduleTokens: 0, skillTokens: 0, profileTokens: 0, context: 0, memory: 0, history: 0 },
    inputTokens: 6000,
    permanent: 0,
    contextSize: 8192,
    maxTokens: 1024,
    availableBudget: 7168,
    tokenState: "mid",
  } as unknown as CoauthorInputAreaData;
  return { data, handleSend };
}

describe("CoauthorMobileInputArea — Enter does not send (E4)", () => {
  it("bare Enter and Shift+Enter never call chat.handleSend", () => {
    const { data, handleSend } = makeData();
    const { getByTestId } = render(<TooltipProvider><CoauthorMobileInputArea data={data} /></TooltipProvider>);
    const ta = getByTestId("coauthor-input-textarea");
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(handleSend).not.toHaveBeenCalled();
  });

  it("renders the Co-Author context ring with its computed percentage and state color", () => {
    const { data } = makeData();
    const { getByRole, getByTestId } = render(<TooltipProvider><CoauthorMobileInputArea data={data} /></TooltipProvider>);
    expect(getByRole("button", { name: "Context: 84%" })).toBe(getByTestId("coauthor-context-ring"));
    const ring = getByTestId("coauthor-context-ring").querySelector("svg");
    expect(ring?.getAttribute("data-token-state")).toBe("mid");
    expect(ring?.querySelector("circle:last-child")?.getAttribute("class")).toBe("stroke-warning-text");
  });

  it("opens the context breakdown sheet from the Co-Author ring", async () => {
    const { data } = makeData();
    const { getByRole, getByText } = render(<TooltipProvider><CoauthorMobileInputArea data={data} /></TooltipProvider>);
    await act(async () => { fireEvent.click(getByRole("button", { name: "Context: 84%" })); });
    expect(getByText("Context")).toBeDefined();
    expect(getByText("Permanent")).toBeDefined();
  });

  it("the send button still sends", () => {
    const { data, handleSend } = makeData();
    const { getByTestId } = render(<TooltipProvider><CoauthorMobileInputArea data={data} /></TooltipProvider>);
    fireEvent.click(getByTestId("coauthor-send-btn"));
    expect(handleSend).toHaveBeenCalledTimes(1);
  });
});

describe('Co-Author mobile image warning (CA-1h3)', () => {
  for (const route of ['none', 'describe'] as const) {
    it(`image route ${route}: shared warning=${route === 'none'}, attachment-only Send stays enabled`, async () => {
      const fetchRoute = spyOn(imageRoutes, 'fetchChatImageRoute').mockResolvedValue(route);
      spies.push(fetchRoute);
      const { view, handleSend } = setupComposer();
      expect(fetchRoute).not.toHaveBeenCalled();
      await act(async () => useChatStore.getState().addDraftAttachment({ id: 'image', assetId: 'image', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 }));
      expect(fetchRoute).toHaveBeenCalledWith('chat1');
      expect(Boolean(view.queryByText('attachment_vision_warning'))).toBe(route === 'none');
      expect((view.getByTestId('coauthor-send-btn') as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(view.getByTestId('coauthor-send-btn'));
      expect(handleSend).toHaveBeenCalledTimes(1);
    });
  }
});

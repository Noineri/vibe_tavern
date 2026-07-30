/**
 * AiAssistantModal — component-boundary characterization tests.
 *
 * Pins the contract the MAE-41 runner extraction must preserve at the SAME
 * boundary: request construction (script / lore_entry / md_import), provider/model
 * persistence, streaming + reasoning accumulation, stop/cancellation, error
 * display, line-diff preview, insert/replace callbacks, and quickpill settings
 * sync. Emitted request bodies are captured and compared field-by-field so a
 * silent wire-shape regression during extraction fails loudly.
 *
 * These tests render the FULL modal (not the hook) and drive it through its
 * real surface (generate / stop / insert / replace buttons). Hook-only tests
 * for provider/model persistence and done-metadata capture live next to the
 * extracted hook under `ai-assistant/use-ai-assistant-runner.test.tsx`.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { AiAssistantChunk, AiAssistantRequestBody, ProviderProfileRecord, UiSettingsRecord } from "../../api/types.js";

useDomEnv();
const { act, fireEvent, render, screen, waitFor } = await import("@testing-library/react");

const mockState = {
  /** Chunks the stream mock will yield on the next call. */
  chunks: [] as AiAssistantChunk[],
  /** Every request body passed to streamAiAssistant, in call order. */
  requests: [] as AiAssistantRequestBody[],
  /** Whether streamAiAssistant should throw on the next call. */
  shouldThrow: false as boolean,
};
const realAppClient = await import("../../app-client.js");
const realProviderActions = await import("../../stores/api-actions/provider-actions.js");
const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");

// Mock the app-client barrel: capture request bodies + control the stream.
mock.module("../../app-client.js", () => {
  return {
    ...realAppClient,
    streamAiAssistant: mock(async function* (body: AiAssistantRequestBody): AsyncGenerator<AiAssistantChunk> {
      mockState.requests.push(body);
      if (mockState.shouldThrow) throw new Error("network-down");
      for (const chunk of mockState.chunks) yield chunk;
    }),
    updateUiSettings: mock(async (input: Partial<UiSettingsRecord>) => baseSettings(input)),
    countAiAssistantTokens: mock(async () => ({ tokens: 42, model: "test-model", layerCount: 1, messageCount: 1 })),
    listAllLorebooks: mock(async () => []),
  };
});

// fetchProviderModelsAction must not hit the network.
mock.module("../../stores/api-actions/provider-actions.js", () => {
  return {
    ...realProviderActions,
    fetchProviderModelsAction: mock(async () => ({ models: [{ id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }] })),
  };
});

// useT must return a stable identity t() — the modal builds labels off it.
mock.module("../../i18n/context.js", () => {
  return {
    ...realI18nContext,
    useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
  };
});

// Force desktop layout so the Modal (not BottomSheet) path renders.
mock.module("../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => false }));

let AiAssistantModal: typeof import("./AiAssistantModal.js").AiAssistantModal;
let TooltipProvider: typeof import("./Tooltip.js").TooltipProvider;
let useProviderDataStore: typeof import("../../stores/provider-data-store.js").useProviderDataStore;
let useBootstrapStore: typeof import("../../stores/api-actions/bootstrap-actions.js").useBootstrapStore;

beforeAll(async () => {
  ({ AiAssistantModal } = await import("./AiAssistantModal.js"));
  ({ TooltipProvider } = await import("./Tooltip.js"));
  ({ useProviderDataStore } = await import("../../stores/provider-data-store.js"));
  ({ useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js"));
});

// ── Fixtures ──────────────────────────────────────────────────────────────

function baseSettings(over: Partial<UiSettingsRecord> = {}): UiSettingsRecord {
  return {
    id: "default",
    theme: "dark",
    chatFontSize: 15,
    uiFontSize: 14,
    messageWidth: 700,
    language: "en",
    activePromptPresetId: null,
    aiAssistantProviderId: null,
    aiAssistantModelName: null,
    coauthorProviderId: null,
    coauthorModelName: null,
    updatedAt: "2026-01-01",
    ...over,
  };
}

function makeProfile(id: string, name: string, over: Partial<ProviderProfileRecord> = {}): ProviderProfileRecord {
  return {
    id,
    name,
    providerPreset: "openaiCompat",
    coauthorTransport: "chat_completions",
    endpoint: "https://api.test/v1",
    defaultModel: null,
    visionModel: null,
    contextBudget: null,
    pinContextBudget: false,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
    topK: 0,
    minP: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: -1,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "default",
    showReasoning: true,
    streamResponse: true,
    customSamplers: false,
    isActive: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    hasStoredApiKey: true,
    ...over,
  };
}

function seedBootstrap(providerId: string | null, modelName: string | null) {
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      personas: [],
      uiSettings: baseSettings({ aiAssistantProviderId: providerId, aiAssistantModelName: modelName }),
      isArmServer: false,
    } as never,
  });
}

function setChunks(chunks: AiAssistantChunk[]) {
  mockState.chunks = chunks;
}

async function mocks() {
  const m = await import("../../app-client.js");
  return {
    streamAiAssistant: m.streamAiAssistant,
    updateUiSettings: m.updateUiSettings,
    fetchProviderModels: (await import("../../stores/api-actions/provider-actions.js")).fetchProviderModelsAction,
  };
}

// ── Helpers for driving the modal ─────────────────────────────────────────

/** Render the modal wrapped in TooltipProvider (full mode uses Tooltip via TokenCounter). */
function renderModal(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/** Type the prompt textarea and click the generate button. The Modal portals
 *  to document.body, so query at the document level. The prompt field is the
 *  only <textarea> in the modal (NumberInput renders <input>, not <textarea>). */
async function generateWithPrompt(prompt: string) {
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: prompt } });
  const generateBtn = await screen.findByText("script_ai_generate");
  await act(async () => { fireEvent.click(generateBtn); });
}

// ── Tests ─────────────────────────────────────────────────────────────────

// Reset mock call history between tests (keeps factory implementations).
beforeEach(() => { mock.clearAllMocks(); });

describe("AiAssistantModal — request construction", () => {
  beforeEach(() => {
    mockState.requests = [];
    mockState.chunks = [];
    mockState.shouldThrow = false;
    useProviderDataStore.setState({ profiles: [], favoritesByProfile: {} });
    useBootstrapStore.setState({ data: null });
  });

  it("script mode: emits the expected request body", async () => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
    const { updateUiSettings } = await mocks();

    renderModal(
      <AiAssistantModal
        mode="full"
        apiMode="script"
        isOpen={true}
        onClose={() => {}}
        existingContent="print('hello')"
        onInsert={() => {}}
        onReplace={() => {}}
        scopeContext={{ characterId: "char-1" }}
      />,
    );

    await generateWithPrompt("add a comment");

    await waitFor(() => expect(mockState.requests).toHaveLength(1));
    const body = mockState.requests[0];
    if (body === undefined) throw new Error("Expected the script request to be captured");
    expect(body).toMatchObject({
      mode: "script",
      instruction: "add a comment",
      existingContent: "print('hello')",
      providerProfileId: "prov-1",
      model: "model-a",
    });
    expect(body.enabledLayers).toContain("character_base");
    expect(updateUiSettings).toHaveBeenCalled();
  });

  it("lore_entry mode: emits the expected request body without lorebooks", async () => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", null);

    renderModal(
      <AiAssistantModal
        mode="full"
        apiMode="lore_entry"
        isOpen={true}
        onClose={() => {}}
        existingContent="existing entry"
        onReplace={() => {}}
        onInsert={() => {}}
      />,
    );

    await generateWithPrompt("rewrite this");

    await waitFor(() => expect(mockState.requests).toHaveLength(1));
    const body = mockState.requests[0];
    if (body === undefined) throw new Error("Expected the lore entry request to be captured");
    expect(body.mode).toBe("lore_entry");
    expect(body.instruction).toBe("rewrite this");
    expect(body.existingContent).toBe("existing entry");
    expect(body.providerProfileId).toBe("prov-1");
    expect(body.lorebookIds).toEqual([]);
  });

  it("md_import mode: emits request with mdContent as existingContent", async () => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", null);

    renderModal(
      <AiAssistantModal
        mode="full"
        apiMode="md_import"
        isOpen={true}
        onClose={() => {}}
        onMdImportApply={() => {}}
      />,
    );

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "# Imported\nSome content" } });

    const startBtn = screen.getByText("import_md_start");
    await act(async () => { fireEvent.click(startBtn); });

    await waitFor(() => expect(mockState.requests).toHaveLength(1));
    const body = mockState.requests[0];
    if (body === undefined) throw new Error("Expected the Markdown import request to be captured");
    expect(body).toMatchObject({
      mode: "md_import",
      instruction: "",
      existingContent: "# Imported\nSome content",
      providerProfileId: "prov-1",
      enabledLayers: [],
    });
    // md_import defaults temperature to 0 when unset.
    expect(body.temperature).toBe(0);
  });
});

describe("AiAssistantModal — streaming accumulation", () => {
  beforeEach(() => {
    mockState.requests = [];
    mockState.chunks = [];
    mockState.shouldThrow = false;
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("accumulates text chunks into the output preview", async () => {
    setChunks([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "done" },
    ]);

    renderModal(
      <AiAssistantModal mode="full" apiMode="script" isOpen={true} onClose={() => {}} />,
    );

    await generateWithPrompt("greet");

    await waitFor(() => {
      expect(screen.getByText(/Hello world/)).toBeTruthy();
    });
  });

  it("accumulates reasoning chunks into the reasoning view", async () => {
    setChunks([
      { type: "reasoning", text: "Thinking" },
      { type: "reasoning", text: " hard" },
      { type: "text", text: "result" },
      { type: "done" },
    ]);

    renderModal(
      <AiAssistantModal mode="full" apiMode="script" isOpen={true} onClose={() => {}} />,
    );

    await generateWithPrompt("think");

    // MessageReasoning starts collapsed; expand it to read the body.
    const reasoningHeader = await screen.findByText("reasoning");
    await act(async () => { fireEvent.click(reasoningHeader); });
    await waitFor(() => {
      expect(screen.getByText(/Thinking hard/)).toBeTruthy();
    });
  });

  it("displays the error from an error chunk", async () => {
    setChunks([{ type: "error", error: "model-overloaded" }]);

    renderModal(
      <AiAssistantModal mode="full" apiMode="script" isOpen={true} onClose={() => {}} />,
    );

    await generateWithPrompt("go");

    await waitFor(() => {
      expect(screen.getByText("model-overloaded")).toBeTruthy();
    });
  });

  it("displays the error from a thrown stream", async () => {
    mockState.shouldThrow = true;

    renderModal(
      <AiAssistantModal mode="full" apiMode="script" isOpen={true} onClose={() => {}} />,
    );

    await generateWithPrompt("go");

    await waitFor(() => {
      expect(screen.getByText(/network-down/)).toBeTruthy();
    });
  });
});

describe("AiAssistantModal — stop / cancellation", () => {
  beforeEach(() => {
    mockState.requests = [];
    mockState.chunks = [];
    mockState.shouldThrow = false;
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("stop button cancels the stream and returns to generate", async () => {
    // A chunk that we yield, then the test clicks stop before "done".
    setChunks([{ type: "text", text: "partial" }]);

    renderModal(
      <AiAssistantModal mode="full" apiMode="script" isOpen={true} onClose={() => {}} />,
    );

    await generateWithPrompt("go");

    // While the stream is mid-flight, the Stop button should be visible.
    const stopBtn = await screen.findByText("script_ai_stop");
    expect(stopBtn).toBeTruthy();
    await act(async () => { fireEvent.click(stopBtn); });

    // After stop, the generate button returns (streaming=false).
    await waitFor(() => {
      expect(screen.getByText("script_ai_generate")).toBeTruthy();
    });
  });
});

describe("AiAssistantModal — insert / replace callbacks", () => {
  beforeEach(() => {
    mockState.requests = [];
    mockState.chunks = [];
    mockState.shouldThrow = false;
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("insert: appends cleaned output to existing content", async () => {
    setChunks([{ type: "text", text: "new code" }, { type: "done" }]);
    const onInsert = mock();

    renderModal(
      <AiAssistantModal
        mode="full"
        apiMode="script"
        isOpen={true}
        onClose={() => {}}
        existingContent={"old code"}
        onInsert={onInsert}
        onReplace={() => {}}
      />,
    );

    await generateWithPrompt("add more");

    // Wait for stream completion: the Insert button appears.
    const insertBtn = await screen.findByText("script_ai_insert");
    await act(async () => { fireEvent.click(insertBtn); });

    expect(onInsert).toHaveBeenCalledTimes(1);
    // Modal appends: existingContent.trimEnd() + "\n\n" + cleanedOutput.
    expect(onInsert).toHaveBeenCalledWith("old code\n\nnew code");
  });

  it("replace: sends only the cleaned output", async () => {
    setChunks([{ type: "text", text: "replacement" }, { type: "done" }]);
    const onReplace = mock();

    renderModal(
      <AiAssistantModal
        mode="full"
        apiMode="script"
        isOpen={true}
        onClose={() => {}}
        existingContent={"old code"}
        onInsert={() => {}}
        onReplace={onReplace}
      />,
    );

    await generateWithPrompt("replace it");

    const replaceBtn = await screen.findByText("script_ai_apply");
    await act(async () => { fireEvent.click(replaceBtn); });

    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledWith("replacement");
  });
});

describe("AiAssistantModal — line diff preview", () => {
  beforeEach(() => {
    mockState.requests = [];
    mockState.chunks = [];
    mockState.shouldThrow = false;
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("renders the diff summary when editing existing content", async () => {
    setChunks([{ type: "text", text: "line one v2" }, { type: "done" }]);

    renderModal(
      <AiAssistantModal
        mode="full"
        apiMode="script"
        isOpen={true}
        onClose={() => {}}
        existingContent={"line one v1"}
        onInsert={() => {}}
        onReplace={() => {}}
      />,
    );

    await generateWithPrompt("edit");

    // The diff title "script_ai_changes" renders with +1/-1 counts.
    await waitFor(() => {
      expect(screen.getByText("script_ai_changes")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("+1")).toBeTruthy();
      expect(screen.getByText("-1")).toBeTruthy();
    });
  });
});

describe("AiAssistantModal — quickpill settings sync", () => {
  beforeEach(() => {
    mockState.requests = [];
    mockState.chunks = [];
    mockState.shouldThrow = false;
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("apply: calls onSettingsChange with current provider/model + closes", async () => {
    const onSettingsChange = mock();
    const onClose = mock();

    renderModal(
      <AiAssistantModal
        mode="quickpill"
        isOpen={true}
        onClose={onClose}
        settings={{ providerId: "prov-1", modelName: "model-a", appendMode: false, keyTarget: "both", recentMessageCount: 20 }}
        onSettingsChange={onSettingsChange}
        showAppendToggle={true}
        showKeyTarget={true}
        showMessageCount={true}
      />,
    );

    const doneBtn = screen.getByText("done_btn");
    await act(async () => { fireEvent.click(doneBtn); });

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "prov-1", modelName: "model-a", appendMode: false, keyTarget: "both", recentMessageCount: 20 }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("quickpill: does NOT persist provider/model to UI settings", async () => {
    const { updateUiSettings } = await mocks();

    renderModal(
      <AiAssistantModal
        mode="quickpill"
        isOpen={true}
        onClose={() => {}}
        settings={{ providerId: "prov-1", modelName: "model-a" }}
        onSettingsChange={() => {}}
      />,
    );

    // In quickpill mode, changing settings should not call updateUiSettings.
    // The only writes to ui settings come from full-mode persistence.
    expect(updateUiSettings).not.toHaveBeenCalled();
  });
});

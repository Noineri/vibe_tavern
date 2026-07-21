/**
 * MessageAiEditorModal — component-boundary characterization (MAE-51).
 *
 * Pins the contract for the message AI editor at the SAME boundary users
 * drive it: open-from-store, source construction from canonical snapshot +
 * editor star state, canonical request IDs (targetMessageId + sourceVariantIds
 * + instruction + chatId), edit word-diff preview, merge full-candidate
 * preview (NO diff), stop/error behavior, the non-destructive guarantees
 * (no action before Apply/Save; cancel/error/close/stale never mutate
 * canonical state), the 409 conflict path (modal stays open, no overwrite,
 * message untouched), and the two success paths (edit closes; merge clears
 * stars, appends/selects, and closes).
 *
 * Tests render the FULL modal (not the runner hook) and drive it through
 * its real surface (instruction textarea, Generate, Apply, Save). All API
 * surfaces are mocked at the module boundary so the assertions describe
 * observable behavior, not implementation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { brandId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { MessageAiEditorModal } from "./MessageAiEditorModal.js";
import { TooltipProvider } from "../shared/Tooltip.js";
import type { AiAssistantChunk, AiAssistantRequestBody, AppMessage, ProviderProfileRecord, UiSettingsRecord } from "../../api/types.js";
import type { SnapshotStore } from "../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useMessageAiEditorStore } from "../../stores/message-ai-editor-store.js";

// ─── Hoisted mock state (factories read this) ──────────────────────────
const mockState = vi.hoisted(() => ({
  chunks: [] as AiAssistantChunk[],
  requests: [] as AiAssistantRequestBody[],
  shouldThrow: false as boolean,
}));

// Capture emitted request bodies + control the stream.
vi.mock("../../app-client.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../app-client.js");
  return {
    ...real,
    streamAiAssistant: vi.fn(async function* (body: AiAssistantRequestBody): AsyncGenerator<AiAssistantChunk> {
      mockState.requests.push(body);
      if (mockState.shouldThrow) throw new Error("network-down");
      for (const chunk of mockState.chunks) yield chunk;
    }),
    updateUiSettings: vi.fn(async (input: Record<string, unknown>) => {
      return { ...baseSettings(), ...(input as Partial<UiSettingsRecord>) } as UiSettingsRecord;
    }),
    countAiAssistantTokens: vi.fn(async () => ({ tokens: 42, model: "model-a", layerCount: 3, messageCount: 4, activatedLoreCount: 2 })),
  };
});

vi.mock("../../stores/api-actions/provider-actions.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../stores/api-actions/provider-actions.js");
  return {
    ...real,
    fetchProviderModelsAction: vi.fn(async () => ({
      models: [{ id: "model-a", label: "Model A" }],
    })),
  };
});

vi.mock("../../i18n/context.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../i18n/context.js");
  return {
    ...real,
    useT: () => ({
      t: (key: string) => key,
      tDynamic: (key: string) => key,
      locale: "en",
      setLocale: () => {},
      ready: true,
    }),
  };
});

vi.mock("../../hooks/use-mobile.js", () => ({
  useIsMobile: () => false,
}));

// Mock the two actions the modal calls so we can assert call args + control
// resolution (success vs conflict vs error) without going to the wire.
const editMock = vi.hoisted(() => ({ fn: vi.fn(async () => {}) }));
const createVariantMock = vi.hoisted(() => ({ fn: vi.fn(async () => {}) }));

vi.mock("../../stores/api-actions/chat-actions.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../stores/api-actions/chat-actions.js");
  return {
    ...real,
    editMessageAction: editMock.fn,
    createMessageVariantAction: createVariantMock.fn,
  };
});

// ─── Fixtures ──────────────────────────────────────────────────────────

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
    id, name,
    providerPreset: "openaiCompat",
    endpoint: "https://api.test/v1",
    defaultModel: null, visionModel: null,
    contextBudget: null, pinContextBudget: false, bindPerModel: false,
    maxTokens: 4096, temperature: 0.7, topP: 1, topK: 0, minP: 0,
    topA: 0, typicalP: 1, tfsZ: 1, repeatLastN: -1,
    mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, drySequenceBreakers: [],
    xtcThreshold: 0.1, xtcProbability: 0,
    frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
    stopSequences: [], logitBias: [], seed: null,
    reasoningEffort: "default", showReasoning: true, streamResponse: true,
    customSamplers: false, isActive: false,
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
    hasStoredApiKey: true,
    ...over,
  };
}

const CID = brandId<ChatId>("chat-1");
const MID = brandId<MessageId>("msg-1");
const VA = brandId<MessageVariantId>("var-a");
const VB = brandId<MessageVariantId>("var-b");
const VC = brandId<MessageVariantId>("var-c");

function makeMessage(over: Partial<AppMessage> = {}): AppMessage {
  return {
    id: MID,
    chatId: CID,
    branchId: brandId("branch-1"),
    role: "assistant",
    content: "",
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    attachments: [],
    modelId: null,
    isSelected: true,
    isPending: false,
    isStreaming: false,
    variants: [],
    selectedVariantIndex: 0,
    sceneTracker: null,
    coauthorModuleId: null,
    coauthorSkillId: null,
    ...over,
  } as AppMessage;
}

function seedMessage(variants: AppMessage["variants"], selectedVariantIndex = 0) {
  useSnapshotStore.setState((s) => ({
    messagesById: { ...s.messagesById, [MID]: makeMessage({ variants, selectedVariantIndex }) },
  }));
}

function makeVariants(n: number): AppMessage["variants"] {
  return Array.from({ length: n }, (_, i) => ({
    id: brandId<MessageVariantId>(`var-${i}`),
    messageId: MID,
    variantIndex: i,
    content: `variant ${i}`,
    isSelected: i === 0,
  })) as AppMessage["variants"];
}

function seedBootstrap(providerId: string, modelName: string) {
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

function openEditorForEdit(selectedVariantId: MessageVariantId = VA) {
  useMessageAiEditorStore.getState().openEditor({
    requestedMode: "message_edit",
    targetChatId: CID,
    targetMessageId: MID,
    selectedVariantId,
  });
}

function openEditorForMerge() {
  useMessageAiEditorStore.getState().openEditor({
    requestedMode: "message_merge",
    targetChatId: CID,
    targetMessageId: MID,
  });
}

/** Type the instruction textarea (the only one in the modal body) and click
 *  the Generate button. The Modal portals to document.body. */
async function generateWithPrompt(prompt: string) {
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: prompt } });
  const generateBtn = await screen.findByText("message_ai_editor_generate");
  await act(async () => { fireEvent.click(generateBtn); });
}

function renderModal() {
  return render(<TooltipProvider><MessageAiEditorModal /></TooltipProvider>);
}

// ─── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockState.requests = [];
  mockState.chunks = [];
  mockState.shouldThrow = false;
  editMock.fn.mockReset();
  editMock.fn.mockImplementation(async () => {});
  createVariantMock.fn.mockReset();
  createVariantMock.fn.mockImplementation(async () => {});

  useMessageAiEditorStore.setState({ target: null, starredVariantIdsByMessage: {} });
  useSnapshotStore.setState({
    messagesById: {},
    messageOrder: [],
    activeChat: null,
    character: null,
    persona: null,
  } as Partial<SnapshotStore> as SnapshotStore);
  useProviderDataStore.setState({ profiles: [], favoritesByProfile: {} });
  useBootstrapStore.setState({ data: null });
});

describe("MessageAiEditorModal — merge-option variant-count gate", () => {
  it("hides the whole mode toggle when the message has ≤6 variants (no jump browser → merge sources cannot be starred)", () => {
    seedMessage(makeVariants(6));
    seedBootstrap("prov", "model-a");
    openEditorForEdit(brandId<MessageVariantId>("var-0"));
    renderModal();
    // With ≤6 variants there is no variant jump browser, so there is no way to
    // star merge sources — the edit/merge SegmentedControl is hidden entirely.
    expect(screen.queryByText("message_ai_editor_mode_edit")).toBeNull();
    expect(screen.queryByText("message_ai_editor_mode_merge")).toBeNull();
  });

  it("shows the edit+merge mode toggle when the message has >6 variants", () => {
    seedMessage(makeVariants(7));
    seedBootstrap("prov", "model-a");
    openEditorForEdit(brandId<MessageVariantId>("var-0"));
    renderModal();
    expect(screen.getByText("message_ai_editor_mode_edit")).toBeTruthy();
    expect(screen.getByText("message_ai_editor_mode_merge")).toBeTruthy();
  });
});

describe("MessageAiEditorModal — generation params + token estimate", () => {
  it("renders temperature / max-tokens / recent-messages controls and the token+context estimate", async () => {
    seedMessage(makeVariants(3));
    seedBootstrap("prov-1", "model-a");
    useProviderDataStore.setState({ profiles: [makeProfile("prov-1", "Provider One")] });
    openEditorForEdit(brandId<MessageVariantId>("var-0"));
    renderModal();
    // Generation params mirror the shared AiAssistantModal full path.
    expect(screen.getByText("ai_param_temperature")).toBeTruthy();
    expect(screen.getByText("ai_param_max_tokens")).toBeTruthy();
    expect(screen.getByText("ai_quickpill_recent_messages")).toBeTruthy();
    // Token + assembled-context estimate resolves from the (mocked) count endpoint.
    expect(await screen.findByText("message_ai_editor_context_lore: 2")).toBeTruthy();
    expect(screen.getByText("message_ai_editor_context_layers: 3")).toBeTruthy();
  });
});

describe("MessageAiEditorModal — closed state", () => {
  it("renders nothing meaningful when the editor store has no target", () => {
    const { container } = renderModal();
    // No panel is rendered when the modal is closed.
    expect(container.textContent).not.toContain("message_ai_editor_title");
    expect(mockState.requests).toHaveLength(0);
  });
});

describe("MessageAiEditorModal — source construction", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("edit mode shows the single variant captured at open as the only source row", () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first variant", isSelected: true, finishReason: "stop" },
      { id: VB, messageId: MID, variantIndex: 1, content: "second variant", isSelected: false, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);

    renderModal();

    // The selected source row shows the variant's display index.
    expect(screen.getByText(/#1/)).toBeTruthy();
    // The OTHER variant must not appear as a source row.
    expect(screen.queryByText(/#2/)).toBeNull();
    // Edit mode has no per-row unstar button (the single source is read-only).
    expect(screen.queryByLabelText("message_ai_editor_unstar_source")).toBeNull();
  });

  it("merge mode lists every starred variant as a removable source row", () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "alpha", isSelected: true, finishReason: "stop" },
      { id: VB, messageId: MID, variantIndex: 1, content: "beta", isSelected: false, finishReason: "stop" },
      { id: VC, messageId: MID, variantIndex: 2, content: "gamma", isSelected: false, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    useMessageAiEditorStore.getState().toggleStar(MID, VA);
    useMessageAiEditorStore.getState().toggleStar(MID, VC);
    openEditorForMerge();

    renderModal();

    // Both starred rows render; the middle (un-starred) one does not.
    expect(screen.getByText(/#1/)).toBeTruthy();
    expect(screen.queryByText(/#2/)).toBeNull();
    expect(screen.getByText(/#3/)).toBeTruthy();
    // Merge rows have a remove (unstar) button each.
    expect(screen.getAllByLabelText("message_ai_editor_unstar_source").length).toBe(2);
  });

  it("merge mode removes a source row via the unstar button (toggleStar)", () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "alpha", isSelected: true, finishReason: "stop" },
      { id: VB, messageId: MID, variantIndex: 1, content: "beta", isSelected: false, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    useMessageAiEditorStore.getState().toggleStar(MID, VA);
    useMessageAiEditorStore.getState().toggleStar(MID, VB);
    openEditorForMerge();

    renderModal();
    const removeBtns = screen.getAllByLabelText("message_ai_editor_unstar_source");
    act(() => { fireEvent.click(removeBtns[0]!); });

    expect(useMessageAiEditorStore.getState().starredVariantIdsByMessage[MID]).toEqual([VB]);
  });
});

describe("MessageAiEditorModal — merge minimum sources", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("merge mode with zero stars surfaces the below-minimum hint and disables Generate", () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "alpha", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForMerge();

    renderModal();

    expect(screen.getByText("message_ai_editor_merge_min_sources")).toBeTruthy();
    // Generate button is disabled (it has the disabled attribute).
    const generateBtn = screen.getByText("message_ai_editor_generate");
    expect((generateBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("merge mode with one star still surfaces the below-minimum hint", () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "alpha", isSelected: true, finishReason: "stop" },
      { id: VB, messageId: MID, variantIndex: 1, content: "beta", isSelected: false, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    useMessageAiEditorStore.getState().toggleStar(MID, VA);
    openEditorForMerge();

    renderModal();

    expect(screen.getByText("message_ai_editor_merge_min_sources")).toBeTruthy();
  });
});

describe("MessageAiEditorModal — canonical request IDs", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("edit: emits targetMessageId + the single selected sourceVariantIds + chatId + instruction", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);

    renderModal();
    await generateWithPrompt("tighten the prose");

    await waitFor(() => expect(mockState.requests).toHaveLength(1));
    expect(mockState.requests[0]).toMatchObject({
      mode: "message_edit",
      instruction: "tighten the prose",
      chatId: CID,
      targetMessageId: MID,
      sourceVariantIds: [VA],
      providerProfileId: "prov-1",
      model: "model-a",
    });
  });

  it("merge: emits targetMessageId + every starred sourceVariantIds (≥2) + chatId + instruction", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "alpha", isSelected: true, finishReason: "stop" },
      { id: VB, messageId: MID, variantIndex: 1, content: "beta", isSelected: false, finishReason: "stop" },
      { id: VC, messageId: MID, variantIndex: 2, content: "gamma", isSelected: false, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    useMessageAiEditorStore.getState().toggleStar(MID, VA);
    useMessageAiEditorStore.getState().toggleStar(MID, VC);
    openEditorForMerge();

    renderModal();
    await generateWithPrompt("combine best beats");

    await waitFor(() => expect(mockState.requests).toHaveLength(1));
    expect(mockState.requests[0]).toMatchObject({
      mode: "message_merge",
      instruction: "combine best beats",
      chatId: CID,
      targetMessageId: MID,
      sourceVariantIds: [VA, VC],
      providerProfileId: "prov-1",
    });
  });

  it("requires a non-empty instruction: empty/whitespace prompt does not emit a request", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);

    renderModal();
    const generateBtn = screen.getByText("message_ai_editor_generate");
    // Disabled with empty instruction.
    expect((generateBtn as HTMLButtonElement).disabled).toBe(true);

    // Type only whitespace — still disabled.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "    " } });
    expect((generateBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("MessageAiEditorModal — edit word-diff preview", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("edit mode: after generation, shows a word diff against the originally selected variant", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "the quick brown fox", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);
    setChunks([
      { type: "text", text: "the slow brown fox" },
      { type: "done" },
    ]);

    renderModal();
    await generateWithPrompt("swap quick for slow");

    // The word-diff title is rendered.
    await waitFor(() => expect(screen.getByText("message_ai_editor_changes")).toBeTruthy());
    // Added/removed badges are present (+1 -1).
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });
});

describe("MessageAiEditorModal — merge full preview", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("merge mode: shows the full candidate with NO diff", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "alpha", isSelected: true, finishReason: "stop" },
      { id: VB, messageId: MID, variantIndex: 1, content: "beta", isSelected: false, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    useMessageAiEditorStore.getState().toggleStar(MID, VA);
    useMessageAiEditorStore.getState().toggleStar(MID, VB);
    openEditorForMerge();
    setChunks([
      { type: "text", text: "merged candidate text" },
      { type: "done" },
    ]);

    renderModal();
    await generateWithPrompt("weave both");

    // Candidate label + full text present.
    await waitFor(() => expect(screen.getByText("message_ai_editor_candidate_label")).toBeTruthy());
    expect(screen.getByText(/merged candidate text/)).toBeTruthy();
    // The edit-mode diff title is NOT rendered in merge mode.
    expect(screen.queryByText("message_ai_editor_changes")).toBeNull();
  });
});

describe("MessageAiEditorModal — stop / stream error", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("stop button cancels and returns to the generate state without persisting", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);
    setChunks([{ type: "text", text: "partial" }]);

    renderModal();
    await generateWithPrompt("go");

    const stopBtn = await screen.findByText("script_ai_stop");
    await act(async () => { fireEvent.click(stopBtn); });

    await waitFor(() => expect(screen.getByText("message_ai_editor_generate")).toBeTruthy());
    expect(editMock.fn).not.toHaveBeenCalled();
    expect(createVariantMock.fn).not.toHaveBeenCalled();
  });

  it("stream error chunk surfaces an error and applies nothing", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);
    setChunks([{ type: "error", error: "provider-500" }]);

    renderModal();
    await generateWithPrompt("go");

    await waitFor(() => expect(screen.getByText("provider-500")).toBeTruthy());
    expect(editMock.fn).not.toHaveBeenCalled();
    expect(createVariantMock.fn).not.toHaveBeenCalled();
  });
});

describe("MessageAiEditorModal — edit Apply conflict (409) retention", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("409 conflict: modal stays open, conflict notice shown, no Apply overwrite, message untouched", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);
    setChunks([
      { type: "text", text: "revised candidate" },
      { type: "done" },
    ]);
    // The guarded edit rejects with the server's stable conflict message.
    editMock.fn.mockRejectedValueOnce(new Error("The selected message variant changed before this edit could be applied."));

    renderModal();
    await generateWithPrompt("rewrite");

    await waitFor(() => expect(screen.getByText("message_ai_editor_apply")).toBeTruthy());
    const applyBtn = screen.getByText("message_ai_editor_apply");
    await act(async () => { fireEvent.click(applyBtn); });

    // Conflict notice renders and the editor target stays open.
    await waitFor(() => expect(screen.getByText("message_ai_editor_conflict_title")).toBeTruthy());
    expect(useMessageAiEditorStore.getState().target).not.toBeNull();
    expect(editMock.fn).toHaveBeenCalledTimes(1);
    expect(editMock.fn).toHaveBeenCalledWith(CID, MID, "revised candidate", VA);
    // The canonical snapshot message content was NOT touched (no syncSnapshot
    // ran — the mock rejected before any state update).
    expect(useSnapshotStore.getState().messagesById[MID]?.variants[0]?.content).toBe("first");
  });
});

describe("MessageAiEditorModal — edit Apply success closes", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("edit Apply success: closes the editor and calls editMessageAction with expectedVariantId", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);
    setChunks([
      { type: "text", text: "revised candidate" },
      { type: "done" },
    ]);

    renderModal();
    await generateWithPrompt("rewrite");

    await waitFor(() => expect(screen.getByText("message_ai_editor_apply")).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText("message_ai_editor_apply")); });

    await waitFor(() => expect(useMessageAiEditorStore.getState().target).toBeNull());
    expect(editMock.fn).toHaveBeenCalledWith(CID, MID, "revised candidate", VA);
  });
});

describe("MessageAiEditorModal — merge Save success clears stars and closes", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("merge Save success: clearStars(messageId) + close; provenance captured from done metadata", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "alpha", isSelected: true, finishReason: "stop" },
      { id: VB, messageId: MID, variantIndex: 1, content: "beta", isSelected: false, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    useMessageAiEditorStore.getState().toggleStar(MID, VA);
    useMessageAiEditorStore.getState().toggleStar(MID, VB);
    openEditorForMerge();
    // Done metadata carries the editor generation provenance the merge must
    // record on the new variant.
    setChunks([
      { type: "text", text: "merged candidate text" },
      { type: "done", modelId: "model-a", promptPresetId: "preset-1", finishReason: "stop" },
    ]);

    renderModal();
    await generateWithPrompt("weave both");

    await waitFor(() => expect(screen.getByText("message_ai_editor_save_new_variant")).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText("message_ai_editor_save_new_variant")); });

    await waitFor(() => expect(useMessageAiEditorStore.getState().target).toBeNull());
    expect(useMessageAiEditorStore.getState().starredVariantIdsByMessage[MID]).toBeUndefined();
    expect(createVariantMock.fn).toHaveBeenCalledTimes(1);
    expect(createVariantMock.fn).toHaveBeenCalledWith(CID, MID, {
      content: "merged candidate text",
      sourceVariantIds: [VA, VB],
      modelId: "model-a",
      promptPresetId: "preset-1",
      finishReason: "stop",
    });
  });
});

describe("MessageAiEditorModal — zero persistence before acceptance", () => {
  beforeEach(() => {
    useProviderDataStore.setState({
      profiles: [makeProfile("prov-1", "Provider One")],
      favoritesByProfile: {},
    });
    seedBootstrap("prov-1", "model-a");
  });

  it("generate alone triggers NO edit/variant action", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);
    setChunks([
      { type: "text", text: "candidate" },
      { type: "done" },
    ]);

    renderModal();
    await generateWithPrompt("rewrite");

    await waitFor(() => expect(screen.getByText("message_ai_editor_apply")).toBeTruthy());
    expect(editMock.fn).not.toHaveBeenCalled();
    expect(createVariantMock.fn).not.toHaveBeenCalled();
  });

  it("cancel button closes the editor with no action call", async () => {
    seedMessage([
      { id: VA, messageId: MID, variantIndex: 0, content: "first", isSelected: true, finishReason: "stop" },
    ] as AppMessage["variants"], 0);
    openEditorForEdit(VA);
    setChunks([
      { type: "text", text: "candidate" },
      { type: "done" },
    ]);

    renderModal();
    await generateWithPrompt("rewrite");

    await waitFor(() => expect(screen.getByText("message_ai_editor_apply")).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText("cancel_btn")); });

    await waitFor(() => expect(useMessageAiEditorStore.getState().target).toBeNull());
    expect(editMock.fn).not.toHaveBeenCalled();
    expect(createVariantMock.fn).not.toHaveBeenCalled();
  });

  it("stale target (message gone from snapshot) renders the stale notice and applies nothing on generate", async () => {
    // Open the editor against a message that is NOT in the snapshot.
    openEditorForEdit(VA);
    // No seedMessage — messagesById has no MID.

    renderModal();

    expect(screen.getByText("message_ai_editor_stale_title")).toBeTruthy();
    // Generate button is absent because the body shows the stale-target
    // notice, not the generation surface.
    expect(screen.queryByText("message_ai_editor_generate")).toBeNull();
    expect(editMock.fn).not.toHaveBeenCalled();
    expect(createVariantMock.fn).not.toHaveBeenCalled();
  });
});

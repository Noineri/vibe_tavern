/**
 * MobileInputArea — the actions of the mobile composer stay reachable.
 *
 * Characterization (CM-2): written green against the pre-CM-2 layout and kept
 * as the parity guard — persona pick + manage, attach (incl. the 5-attachment
 * disable), preset pick, send / cancel switching, generate-more. Locators are
 * the accessible names the CM-2 layout adds; the pre-CM-2 run (12/12 green)
 * located the same buttons by their old classes (ml-auto / text-accent-t /
 * bg-accent / border-danger).
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { TooltipProvider } from "../shared/Tooltip.js";
import type { InputAreaData } from "./use-input-area.js";

useDomEnv();

// House i18n pattern via the shared co-load seam: raw keys render as-is
// (identity spec — this suite has no interpolated pins, but registers so a
// hand-bundled run never inherits a sibling's interpolating spec).
installI18nContextSeam();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let MobileInputArea: typeof import("./MobileInputArea.js").MobileInputArea;
let useModalStore: typeof import("../../stores/modal-store.js").useModalStore;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ MobileInputArea } = await import("./MobileInputArea.js"));
  ({ useModalStore } = await import("../../stores/modal-store.js"));
});

afterAll(() => {
  useModalStore.getState().setIsPersonaModalOpen(false);
});

const PERSONAS = [
  { id: "persona-1", name: "Noah", avatarExt: null, avatarAssetId: null, updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "persona-2", name: "Eve", avatarExt: null, avatarAssetId: null, updatedAt: "2026-01-01T00:00:00.000Z" },
];
const PRESETS = [
  { id: "preset-1", name: "Narrative" },
  { id: "preset-2", name: "Terse" },
];

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    t: (key: string) => key,
    chat: { handleSend: mock(), handleCancelGeneration: mock() },
    character: { handleSetChatPersona: mock() },
    preset: { handleSetActivePromptPresetId: mock() },
    draft: "hello world",
    setDraft: mock(),
    isSending: false,
    activeChatId: "chat-1",
    chatMeta: undefined,
    personas: PERSONAS,
    activePersonaId: "persona-1",
    promptPresets: PRESETS,
    activePromptPresetId: "preset-1",
    favoriteModels: [],
    activeModelId: null,
    handleSelectFavoriteModel: mock(),
    fileInputRef: { current: null },
    draftAttachments: [],
    onFileInputChange: mock(),
    handlePaste: mock(),
    canSend: true,
    showGenerateMore: false,
    handleGenerateMore: mock(),
    buckets: { system: 0, character: 0, persona: 0, lore: 0, memory: 0, tools: 0, history: 0 },
    inputTokens: 100,
    permanent: 0,
    contextSize: 8192,
    maxTokens: 1024,
    availableBudget: 7168,
    tokenState: "ok",
    perSendPrefillSupported: false,
    handleVoiceRecorded: mock(),
    provider: { activeProviderProfile: null },
    ...overrides,
  } as unknown as InputAreaData;
}

function mount(data: InputAreaData) {
  return render(<TooltipProvider><MobileInputArea data={data} /></TooltipProvider>);
}


type View = ReturnType<typeof mount>;
const byName = (v: View, name: string): HTMLButtonElement => v.getByRole("button", { name }) as HTMLButtonElement;
const attachBtn = (v: View): HTMLButtonElement => byName(v, "attach_image");
const presetBtn = (v: View): HTMLButtonElement => byName(v, "topbar_prompt_preset");
const sendBtn = (v: View): HTMLButtonElement => byName(v, "send");
const cancelBtn = (v: View): HTMLButtonElement => byName(v, "cancel");
const queryBtn = (v: View, name: string): HTMLButtonElement | null => v.queryByRole("button", { name }) as HTMLButtonElement | null;

describe("MobileInputArea persona chip", () => {
  it("opens the persona sheet; picking a persona sets it for the chat", async () => {
    const data = makeData();
    const view = mount(data);

    fireEvent.click(view.getByText("Noah").closest("button")!);
    fireEvent.click(await waitFor(() => view.getByText("Eve")));

    expect(data.character.handleSetChatPersona).toHaveBeenCalledTimes(1);
    expect((data.character.handleSetChatPersona as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("persona-2");
  });

  it("the manage row opens the persona modal", async () => {
    const view = mount(makeData());

    fireEvent.click(view.getByText("Noah").closest("button")!);
    fireEvent.click(await waitFor(() => view.getByText("manage_personas")));

    expect(useModalStore.getState().isPersonaModalOpen).toBe(true);
  });
});

describe("MobileInputArea attach", () => {
  it("clicking attach opens the file picker", () => {
    const data = makeData();
    const view = mount(data);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = mock();
    input.click = click;

    fireEvent.click(attachBtn(view));

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("is disabled at five attachments", () => {
    const attachments = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}` }));
    const view = mount(makeData({ draftAttachments: attachments }));

    expect((attachBtn(view) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays enabled below five attachments", () => {
    const attachments = Array.from({ length: 4 }, (_, i) => ({ id: `a${i}` }));
    const view = mount(makeData({ draftAttachments: attachments }));

    expect((attachBtn(view) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("MobileInputArea preset", () => {
  it("opens the preset sheet; picking a preset activates it", async () => {
    const data = makeData();
    const view = mount(data);

    fireEvent.click(presetBtn(view));
    fireEvent.click(await waitFor(() => view.getByText("Terse")));

    expect((data.preset.handleSetActivePromptPresetId as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("preset-2");
  });

  it("is disabled when there are no presets", () => {
    const view = mount(makeData({ promptPresets: [] }));

    expect((presetBtn(view) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("MobileInputArea send / cancel", () => {
  it("send calls handleSend", () => {
    const data = makeData();
    const view = mount(data);

    fireEvent.click(sendBtn(view));

    expect(data.chat.handleSend).toHaveBeenCalledTimes(1);
  });

  it("send is disabled when canSend is false", () => {
    const view = mount(makeData({ canSend: false }));

    expect((sendBtn(view) as HTMLButtonElement).disabled).toBe(true);
  });

  it("while sending only cancel is offered, and it cancels the generation", () => {
    const data = makeData({ isSending: true });
    const view = mount(data);

    expect(queryBtn(view, "send")).toBeNull();
    fireEvent.click(cancelBtn(view));

    expect(data.chat.handleCancelGeneration).toHaveBeenCalledTimes(1);
  });
});

describe("MobileInputArea generate-more", () => {
  it("shows the button when asked and triggers handleGenerateMore", () => {
    const data = makeData({ showGenerateMore: true });
    const view = mount(data);

    fireEvent.click(view.getByText("generate_more_label").closest("button")!);

    expect(data.handleGenerateMore).toHaveBeenCalledTimes(1);
  });

  it("is absent otherwise", () => {
    const view = mount(makeData());

    expect(view.queryByText("generate_more_label")).toBeNull();
  });
});

import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { TooltipProvider } from "../shared/Tooltip.js";
import type { InputAreaData } from "./use-input-area.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => key === "context_usage_percent" ? `Context: ${opts?.n}%` : key === "context_label" ? "Context" : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let render: typeof import("@testing-library/react").render;
let MobileInputArea: typeof import("./MobileInputArea.js").MobileInputArea;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ MobileInputArea } = await import("./MobileInputArea.js"));
});

function makeData() {
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
    personas: [],
    activePersonaId: null,
    promptPresets: [],
    activePromptPresetId: null,
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
    inputTokens: 6000,
    permanent: 0,
    contextSize: 8192,
    maxTokens: 1024,
    availableBudget: 7168,
    tokenState: "mid",
    perSendPrefillSupported: false,
    handleVoiceRecorded: mock(),
  } as unknown as InputAreaData;
}

describe("MobileInputArea context ring", () => {
  it("renders the RP context ring immediately before the send control", () => {
    const { getByRole, getByTestId } = render(<TooltipProvider><MobileInputArea data={makeData()} /></TooltipProvider>);
    const ring = getByRole("button", { name: "Context: 84%" });
    const send = getByTestId("chat-context-ring").nextElementSibling;

    expect(ring).toBe(getByTestId("chat-context-ring"));
    expect(send?.tagName).toBe("BUTTON");
  });
});

import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { TooltipProvider } from "../shared/Tooltip.js";
import type { InputAreaData } from "./use-input-area.js";
import { estimateAttachmentOverflow } from "../../hooks/attachment-overflow.js";
import type { Attachment } from "@vibe-tavern/domain";

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
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let MobileInputArea: typeof import("./MobileInputArea.js").MobileInputArea;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ MobileInputArea } = await import("./MobileInputArea.js"));
});

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
    provider: { activeProviderProfile: null },
    ...overrides,
  } as unknown as InputAreaData;
}

// behavior change: was "the RP context ring renders immediately before the send
// control" (standalone ring button in the input row) -> now the input row holds
// no ring; the ring is the outline of the model button. Basis: CM-2 (the ring
// leaves the input row). The new layout assertions live in
// MobileInputArea.layout.test.tsx.
describe("MobileInputArea context ring", () => {
  it("has no standalone ring button in the input row", () => {
    const { queryByTestId, queryByRole } = render(<TooltipProvider><MobileInputArea data={makeData()} /></TooltipProvider>);

    expect(queryByTestId("chat-context-ring")).toBeNull();
    expect(queryByRole("button", { name: "Context: 84%" })).toBeNull();
  });
});

describe("MobileInputArea attachment overflow warning (CA-1e)", () => {
  for (const [tokens, budget, warns] of [[100, 1000, false], [101, 1000, true], [101, 0, false]] as const) {
    it(`tokens=${tokens}, budget=${budget}: warning=${warns}, Send remains available`, () => {
      const attachments: Attachment[] = [{ id: "file", assetId: "asset_file", type: "file", name: "notes.md", mimeType: "text/markdown", sizeBytes: 10, tokenCount: tokens }];
      const data = makeData({
        draftAttachments: attachments,
        remove: mock(),
        attachmentOverflow: estimateAttachmentOverflow({ totalUsed: 900, availableBudget: budget, attachments }),
      });
      const view = render(<TooltipProvider><MobileInputArea data={data} /></TooltipProvider>);
      const warning = view.queryByRole("status");
      expect(Boolean(warning)).toBe(warns);
      if (warning) {
        expect(warning.textContent).toBe("attachments_overflow_warning");
        expect(warning.nextElementSibling?.className).toContain("rounded-xl");
        expect(warning.querySelector(".truncate")).toBeNull();
      }
      const send = view.getByRole("button", { name: "send" }) as HTMLButtonElement;
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      expect(data.chat.handleSend).toHaveBeenCalledTimes(1);
    });
  }
});

describe("MobileInputArea starred-models sheet", () => {
  const FAVORITES = [
    { modelId: "model-a", label: "Alpha" },
    { modelId: "model-b", label: "" },
  ];

  function openStarSheet(data: InputAreaData) {
    const view = render(<TooltipProvider><MobileInputArea data={data} /></TooltipProvider>);
    fireEvent.click(view.getByRole("button", { name: "model_label" }));
    return view;
  }

  it("lists the favorites (label, falling back to the model id) and marks the active one", async () => {
    const view = openStarSheet(makeData({ favoriteModels: FAVORITES, activeModelId: "model-a" }));
    const alpha = await waitFor(() => view.getByText("Alpha").closest("button"));
    const fallback = view.getByText("model-b").closest("button");

    expect(alpha?.querySelector("svg")).not.toBeNull();
    expect(fallback?.querySelector("svg")).toBeNull();
  });

  it("picking a favorite calls handleSelectFavoriteModel with its id and closes the sheet", async () => {
    const handleSelectFavoriteModel = mock();
    const view = openStarSheet(makeData({ favoriteModels: FAVORITES, handleSelectFavoriteModel }));

    fireEvent.click(await waitFor(() => view.getByText("model-b")));

    expect(handleSelectFavoriteModel).toHaveBeenCalledTimes(1);
    expect(handleSelectFavoriteModel.mock.calls[0]?.[0]).toBe("model-b");
    await waitFor(() => expect(view.queryByText("Alpha")).toBeNull());
  });

  it("shows the empty state when nothing is starred", async () => {
    const view = openStarSheet(makeData({ favoriteModels: [] }));
    await waitFor(() => expect(view.getByText("no_starred_models")).toBeTruthy());
  });
});

// Number formatting follows the runtime locale; derive the expectation the same way.
const fmt = (n: number): string => n.toLocaleString();

// behavior change: was "tapping the ring opens the ring's own sheet with the
// breakdown" -> now the breakdown is reached through the model sheet's context
// card (tap to expand); the asserted rows are the same. Basis: CM-2, the
// breakdown moves to the model sheet.
describe("MobileInputArea context breakdown (via the model sheet)", () => {
  it("opens the full breakdown: every permanent row, history, input, response budget, total", async () => {
    const data = makeData({
      buckets: { system: 1100, character: 1450, persona: 210, lore: 640, memory: 380, tools: 180, history: 2000 },
      permanent: 3960,
      inputTokens: 500,
    });
    const view = render(<TooltipProvider><MobileInputArea data={data} /></TooltipProvider>);
    fireEvent.click(view.getByRole("button", { name: "model_label" }));
    fireEvent.click(await waitFor(() => view.getByText("Context").closest("button")!));

    const body = await waitFor(() => view.getByText("context_permanent").parentElement as HTMLElement);
    const text = body.textContent ?? "";
    for (const [label, value] of [
      ["context_system", fmt(1100)], ["context_character", fmt(1450)], ["context_persona", "210"],
      ["context_lore", "640"], ["context_memory", "380"], ["context_tools", "180"],
      ["context_history", fmt(2000)], ["context_current_input", "500"],
      ["context_response_budget", `-${fmt(1024)}`], ["context_total_available", fmt(7168)],
    ] as const) {
      expect(text).toContain(`${label}${value}`);
    }
  });
});

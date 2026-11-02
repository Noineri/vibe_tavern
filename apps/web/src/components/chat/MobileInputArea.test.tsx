import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { TooltipProvider } from "../shared/Tooltip.js";
import type { InputAreaData } from "./use-input-area.js";
import { estimateAttachmentOverflow } from "../../hooks/attachment-overflow.js";
import { useImageRouteWarning } from "../../hooks/use-image-route-warning.js";
import type { Attachment } from "@vibe-tavern/domain";

useDomEnv();

// House i18n test pattern via the shared co-load seam: raw keys render as-is;
// the context-meter pins read the bundled EN templates ("Context: {n}%",
// "Context") — byte-identical to the previous hand-built values.
installI18nContextSeam({ interpolateKeys: ["context_usage_percent", "context_label"] });

let act: typeof import("@testing-library/react").act;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let MobileInputArea: typeof import("./MobileInputArea.js").MobileInputArea;

beforeAll(async () => {
  ({ act, render, fireEvent, waitFor } = await import("@testing-library/react"));
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

// CNR-7e characterization, written BEFORE the thin-scrollbar opt-in: the
// hand-rolled mobile growth — content height until 40% of the viewport, the
// same node kept across draft changes, clear recomputes the height. The
// opt-in must not disturb any of it.
describe("MobileInputArea draft growth (CNR-7e)", () => {
  const textbox = (v: ReturnType<typeof render>) => v.getByRole("textbox") as HTMLTextAreaElement;

  it("grows with the draft and caps the box at 40% of the viewport height", async () => {
    const view = render(<TooltipProvider><MobileInputArea data={makeData()} /></TooltipProvider>);
    await act(async () => {}); // the mounted voice button's STT fetch settles inside act
    const ta = textbox(view);
    expect(ta.classList.contains("max-h-[40vh]")).toBe(true);
    // Short draft: the box takes the measured content height.
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 60 });
    fireEvent.change(ta, { target: { value: "short" } });
    expect(ta.style.height).toBe("60px");
    // Long draft: the manual growth stops at window.innerHeight * 0.4 (the
    // same cap as the max-h-[40vh] class). The CSSOM read-back normalizes the
    // float, so compare parsed numbers, not the raw string.
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 5000 });
    fireEvent.change(ta, { target: { value: "a much longer draft" } });
    const capped = Math.min(5000, window.innerHeight * 0.4);
    expect(parseFloat(ta.style.height)).toBeCloseTo(capped, 6);
    expect(parseFloat(ta.style.height)).toBeLessThan(5000);
    expect(textbox(view)).toBe(ta);
  });

  it("keeps the same native textarea across draft changes and recomputes on clear", async () => {
    const view = render(<TooltipProvider><MobileInputArea data={makeData()} /></TooltipProvider>);
    await act(async () => {});
    const ta = textbox(view);
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 26 });
    view.rerender(<TooltipProvider><MobileInputArea data={makeData({ draft: "" })} /></TooltipProvider>);
    await act(async () => {});
    // draft "" runs the shrink effect (adjustTextareaHeight) without a change event.
    expect(ta.style.height).toBe("26px");
    expect(textbox(view)).toBe(ta);
  });

  // New boundary (fails before the CNR-7e opt-in): the textarea IS the thin
  // scroll-area viewport — no wrapper div, no Content node, native tab stop.
  it("composes the native textarea as the 3px thin-viewport and mounts the track only on overflow", async () => {
    const view = render(<TooltipProvider><MobileInputArea data={makeData()} /></TooltipProvider>);
    await act(async () => {});
    const ta = textbox(view);
    expect(ta.hasAttribute("data-scroll-viewport")).toBe(true);
    expect(ta.querySelector("[data-scroll-content]")).toBeNull();
    expect(ta.tabIndex).toBe(0);
    expect(view.container.querySelector("[data-scroll-track]")).toBeNull();
    Object.defineProperties(ta, {
      clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, get: () => 1000 },
      clientWidth: { configurable: true, value: 200 }, scrollWidth: { configurable: true, value: 200 },
    });
    view.rerender(<TooltipProvider><MobileInputArea data={makeData({ draft: "a long overflowing draft" })} /></TooltipProvider>);
    const track = await waitFor(() => {
      const el = view.container.querySelector("[data-scroll-track]")!;
      expect(el).not.toBeNull();
      return el;
    });
    // CNR-8b: the 3px is no longer a track class — the thin variant marker on
    // the ScrollArea root plus the track wiring carry it (styles.css owns the
    // geometry contract, pinned in scroll-area.test.tsx).
    expect(track.closest("[data-scroll-area]")!.getAttribute("data-scroll-area")).toBe("thin");
    expect(track.getAttribute("data-orientation")).toBe("vertical");
    expect(textbox(view)).toBe(ta);
  });
});

describe('mobile image warning (CA-1h2)', () => {
  it('route none renders before overflow and never disables Send', async () => {
    const attachments: Attachment[] = [
      { id: 'image', assetId: 'image', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 },
      { id: 'file', assetId: 'file', type: 'file', name: 'a.md', mimeType: 'text/markdown', sizeBytes: 12, tokenCount: 101 },
    ];
    const fetchRoute = mock(async () => 'none' as const);
    const handleSend = mock();
    function Harness() {
      const warning = useImageRouteWarning(attachments, 'rp-key', fetchRoute);
      return <TooltipProvider><MobileInputArea data={makeData({
        draftAttachments: attachments, remove: mock(), attachmentVisionWarning: warning,
        chat: { handleSend, handleCancelGeneration: mock() },
        attachmentOverflow: estimateAttachmentOverflow({ totalUsed: 900, availableBudget: 1000, attachments }),
      })} /></TooltipProvider>;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(view.getAllByRole('status')).toHaveLength(2));
    expect(view.getAllByRole('status')[0]?.textContent).toBe('attachment_vision_warning');
    const send = view.getByRole('button', { name: 'send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(handleSend).toHaveBeenCalledTimes(1);
  });
});

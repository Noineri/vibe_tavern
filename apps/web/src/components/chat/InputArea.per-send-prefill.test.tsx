/**
 * InputArea — per-send prefill chip + bubble (LS-8, owner design 2026-09-09).
 *
 * Pins the OWNER-SPECIFIED layout and behavior of the desktop input surface:
 *  - sandwich order inside the input frame: chat line → bubble → chip row
 *    (the bubble sits DIRECTLY above the chip button — corrected placement,
 *    the first build rendered it above the chat line);
 *  - the chip is icon + LABEL (per_send_prefill_chip_label), not a bare icon;
 *  - chip click opens the in-frame bubble, ✕ closes it; the armed dot stays
 *    while a one-shot prefill value is queued;
 *  - no chip and no bubble when the provider has no prefill channel.
 *
 * Doubles: only the `useInputArea` controller seam is faked (T1 — the real
 * hook drags the whole chat controller; its behavior is pinned in
 * use-chat-controller.test.ts). The per-send prefill zustand store is REAL
 * (T0) — tests drive it through the same actions the component uses.
 * Leaf chrome (Tooltip) is passthrough-mocked per the repo convention.
 *
 * Runner: bun:test + happy-dom (per-file process via scripts/test-web.ts).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
const realTokenizer = await import("../../utils/tokenizer.js");
const realTooltip = await import("../shared/Tooltip.js");
const realUseMobile = await import("../../hooks/use-mobile.js");
const realUseInputArea = await import("./use-input-area.js");

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// countTokens loads a real tiktoken encoding — heavy and irrelevant here.
mock.module("../../utils/tokenizer.js", () => ({ ...realTokenizer, countTokens: () => 0 }));

mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
}));

// Desktop layout is the test target (mobile has its own strip surface).
mock.module("../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => false }));

// The controller seam (T1): the real hook drags the whole chat controller +
// websocket wiring — its behavior is pinned in use-chat-controller.test.ts.
// The fake is a mutable module-level value so per-test tweaks (capability
// off) propagate into the component on render.
mock.module("./use-input-area.js", () => ({
  ...realUseInputArea,
  useInputArea: () => fakeData,
}));

/** Minimal fake of the useInputArea controller seam — only the fields the
 * desktop surface reads. All callbacks are inert spies. */
function makeFakeData() {
  return {
    t: (k: string) => k,
    chat: { handleSend: mock(), handleCancelGeneration: mock() },
    character: { handleSetChatPersona: mock() },
    provider: { activeProviderProfile: null, handleSelectFavoriteProviderModel: mock() },
    draft: "",
    setDraft: mock(),
    isSending: false,
    activeChatId: null as string | null,
    chatMeta: null,
    personas: [] as never[],
    activePersonaId: null as string | null,
    contextSize: 8192,
    maxTokens: 1024,
    favoriteModels: [] as { modelId: string; label?: string }[],
    activeModelId: null as string | null,
    fileInputRef: { current: null as HTMLInputElement | null },
    draftAttachments: [] as never[],
    onFileInputChange: () => {},
    handlePaste: () => {},
    canSend: false,
    buckets: { history: 0, system: 0, character: 0, persona: 0, lore: 0, memory: 0, tools: 0 },
    inputTokens: 0,
    showGenerateMore: false,
    handleGenerateMore: () => {},
    handleVoiceRecorded: mock(),
    permanent: false,
    perSendPrefillSupported: true,
  };
}

let fakeData: ReturnType<typeof makeFakeData>;
let usePerSendPrefillStore: typeof import("../../stores/per-send-prefill-store.js").usePerSendPrefillStore;
let InputArea: typeof import("./InputArea.js").InputArea;
let render: typeof import("@testing-library/react").render;
let within: typeof import("@testing-library/react").within;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ usePerSendPrefillStore } = await import("../../stores/per-send-prefill-store.js"));
  ({ InputArea } = await import("./InputArea.js"));
  ({ render, within, fireEvent } = await import("@testing-library/react"));
});

// One-shot queue is global store state — reset between tests so the armed
// dot/bubble behavior of one test cannot leak into the next.
beforeEach(() => {
  fakeData = makeFakeData();
  usePerSendPrefillStore.getState().clear();
});

describe("InputArea — per-send prefill chip + bubble (LS-8)", () => {
  it("renders the labeled chip and keeps the sandwich order: chat line → bubble → chip row", () => {
    const view = render(<InputArea />);
    const q = within(view.baseElement);

    const chip = q.getByTestId("per-send-prefill-chip");
    // Chip is icon + LABEL, not a bare icon (owner correction 2026-09-09).
    expect(within(chip).getByText("per_send_prefill_chip_label")).toBeTruthy();

    const bubble = q.getByTestId("per-send-prefill-bubble");
    const chatLine = q.getAllByPlaceholderText("placeholder")[0] as HTMLElement;
    expect(chatLine).toBeTruthy();

    // DOM order pin: chat line precedes the bubble, the bubble precedes the
    // chip row — the bubble sits directly above the chip button.
    expect(chatLine.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bubble.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the in-frame bubble on chip click, closes on ✕, keeps the armed dot once text is queued", async () => {
    const view = render(<InputArea />);
    const q = within(view.baseElement);

    const chip = q.getByTestId("per-send-prefill-chip");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    // Typing into the bubble queues the one-shot prefill in the REAL store.
    const input = q.getByTestId("per-send-prefill-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Sure, " } });
    expect(usePerSendPrefillStore.getState().value).toBe("Sure, ");

    // Armed dot is rendered on the chip while a value is queued.
    expect(chip.querySelector(".bg-accent")).toBeTruthy();

    // ✕ closes the bubble WITHOUT clearing the queued value.
    fireEvent.click(q.getByLabelText("close"));
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(usePerSendPrefillStore.getState().value).toBe("Sure, ");
  });

  it("renders no chip and no bubble when the provider has no prefill channel", () => {
    fakeData.perSendPrefillSupported = false;
    const view = render(<InputArea />);
    const q = within(view.baseElement);
    expect(q.queryByTestId("per-send-prefill-chip")).toBeNull();
    expect(q.queryByTestId("per-send-prefill-bubble")).toBeNull();
  });
});

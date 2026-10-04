/**
 * CoauthorMobileInputArea — E4 pin (MOBILE_DEFECTS_ROUND_2).
 *
 * The mobile co-author input must NOT send on Enter: the on-screen enter key
 * IS the newline key (same convention as the RP MobileInputArea, which has no
 * keydown-to-send handler at all). Sending happens via the send button only.
 * This pins the wiring boundary: bare Enter and Shift+Enter never reach
 * chat.handleSend from the textarea; the send button does.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
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
let CoauthorMobileInputArea: typeof import("./CoauthorMobileInputArea.js").CoauthorMobileInputArea;

beforeAll(async () => {
  ({ act, render, fireEvent } = await import("@testing-library/react"));
  ({ CoauthorMobileInputArea } = await import("./CoauthorMobileInputArea.js"));
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

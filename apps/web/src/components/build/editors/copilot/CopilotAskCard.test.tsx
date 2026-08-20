import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { CopilotAskState } from "../../../../stores/experience-copilot-turn-store.js";
import type { CopilotAskAnswerInput } from "../../../../api/experience-copilot-api.js";
import en from "../../../../i18n/locales/en.json";
import ru from "../../../../i18n/locales/ru.json";

useDomEnv();

// CustomTooltip wraps children in a Radix Tooltip that never anchors under
// happy-dom (same reason the panel + shell tests mock it). Render children
// inline — this test pins the card's render contract, not tooltip internals.
mock.module("../../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { render, fireEvent } = await import("@testing-library/react");
const { CopilotAskCard } = await import("./CopilotAskCard.js");

function ask(over: Partial<CopilotAskState>): CopilotAskState {
  return {
    question: "Which buffer should own the turn counter?",
    options: ["Rules", "Visual", "Neither"],
    recommended: "Rules",
    status: "awaiting_answer",
    ...over,
  };
}

function renderCard(askState: CopilotAskState, opts?: { interactive?: boolean; onSubmit?: (a: CopilotAskAnswerInput) => void }) {
  const calls: CopilotAskAnswerInput[] = [];
  const onSubmit = opts?.onSubmit ?? ((a: CopilotAskAnswerInput) => calls.push(a));
  const utils = render(
    <CopilotAskCard ask={askState} interactive={opts?.interactive ?? true} onSubmit={onSubmit} />,
  );
  return { ...utils, calls };
}

describe("CopilotAskCard (TAG-9)", () => {
  it("interactive awaiting: question + chips + recommended marker + input + skip", () => {
    const { getByTestId, getAllByTestId } = renderCard(ask({}));
    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    expect(getByTestId("copilot-ask-question").textContent).toContain("turn counter");
    // Three chips; the recommended one ("Rules", index 0) carries the marker.
    const chips = [0, 1, 2].map((i) => getByTestId(`copilot-ask-chip-${i}`));
    expect(chips.map((c) => c.textContent)).toEqual(["Rules", "Visual", "Neither"]);
    expect(chips[0]!.getAttribute("data-recommended")).toBe("true");
    expect(chips[1]!.getAttribute("data-recommended")).toBeNull();
    expect(getAllByTestId(/copilot-ask-chip-/).length).toBe(3);
    expect(getByTestId("copilot-ask-input")).toBeDefined();
    expect(getByTestId("copilot-ask-submit")).toBeDefined();
    expect(getByTestId("copilot-ask-skip")).toBeDefined();
  });

  it("chip click submits the chip's label as the answer text", () => {
    const { getByTestId, calls } = renderCard(ask({}));
    fireEvent.click(getByTestId("copilot-ask-chip-1"));
    expect(calls).toEqual([{ text: "Visual" }]);
  });

  it("recommended chip submits its own label (same path, no special-casing)", () => {
    const { getByTestId, calls } = renderCard(ask({}));
    fireEvent.click(getByTestId("copilot-ask-chip-0"));
    expect(calls).toEqual([{ text: "Rules" }]);
  });

  it("free text submits via Enter (Shift+Enter stays a newline) and clears the draft", () => {
    const { getByTestId, calls } = renderCard(ask({ options: undefined, recommended: undefined }));
    const input = getByTestId("copilot-ask-input") as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(calls).toEqual([]);
    fireEvent.change(input, { target: { value: "  keep it in rules  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls).toEqual([{ text: "keep it in rules" }]);
    expect(input.value).toBe("");
  });

  it("the submit button sends the trimmed draft; an empty draft submits nothing", () => {
    const { getByTestId, calls } = renderCard(ask({}));
    const submit = getByTestId("copilot-ask-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(calls).toEqual([]);
    const input = getByTestId("copilot-ask-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "via button" } });
    fireEvent.click(submit);
    expect(calls).toEqual([{ text: "via button" }]);
  });

  it("skip sends the deliberate non-answer", () => {
    const { getByTestId, calls } = renderCard(ask({}));
    fireEvent.click(getByTestId("copilot-ask-skip"));
    expect(calls).toEqual([{ skipped: true }]);
  });

  it("answered renders the answer read-only (no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(
      ask({ status: "answered", answer: "Rules, definitely" }),
    );
    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("answered");
    expect(getByTestId("copilot-ask-answer").textContent).toBe("Rules, definitely");
    expect(queryByTestId("copilot-ask-input")).toBeNull();
    expect(queryByTestId("copilot-ask-chip-0")).toBeNull();
    expect(queryByTestId("copilot-ask-skip")).toBeNull();
  });

  it("skipped renders the muted non-answer state (no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(ask({ status: "skipped" }));
    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("skipped");
    expect(getByTestId("copilot-ask-skipped").textContent).toBe("copilot_ask_skipped");
    expect(queryByTestId("copilot-ask-input")).toBeNull();
  });

  it("awaiting but NOT interactive (superseded / streaming) renders expired (no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(ask({}), { interactive: false });
    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("expired");
    expect(getByTestId("copilot-ask-expired").textContent).toBe("copilot_ask_expired");
    expect(queryByTestId("copilot-ask-input")).toBeNull();
    expect(queryByTestId("copilot-ask-chip-0")).toBeNull();
    expect(queryByTestId("copilot-ask-skip")).toBeNull();
  });

  it("open question (no options) renders the input without chips", () => {
    const { getByTestId, queryByTestId } = renderCard(ask({ options: undefined, recommended: undefined }));
    expect(queryByTestId("copilot-ask-chip-0")).toBeNull();
    expect(getByTestId("copilot-ask-input")).toBeDefined();
  });

  it("defensive: a recommended label that is NOT one of the options marks no chip", () => {
    const { getByTestId } = renderCard(ask({ recommended: "Not an option" }));
    for (const i of [0, 1, 2]) {
      expect(getByTestId(`copilot-ask-chip-${i}`).getAttribute("data-recommended")).toBeNull();
    }
  });

  it("i18n parity: every ask-card key exists in en + ru", () => {
    const KEYS = [
      "copilot_ask_skip",
      "copilot_ask_placeholder",
      "copilot_ask_submit",
      "copilot_ask_recommended",
      "copilot_ask_skipped",
      "copilot_ask_expired",
    ] as const;
    const enMap = en as Record<string, string>;
    const ruMap = ru as Record<string, string>;
    for (const key of KEYS) {
      expect(typeof enMap[key]).toBe("string");
      expect(typeof ruMap[key]).toBe("string");
      expect(ruMap[key]).not.toBe(enMap[key]);
    }
  });
});

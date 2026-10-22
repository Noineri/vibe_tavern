import { describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentAskState } from "../../../stores/agent-turn-store.js";
import type { CopilotAskAnswerInput } from "../../../api/experience-copilot-api.js";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";

useDomEnv();

const { render, fireEvent } = await import("@testing-library/react");
const { AgentAskCard } = await import("./AgentAskCard.js");

function ask(over: Partial<AgentAskState>): AgentAskState {
  return {
    question: "Which buffer should own the turn counter?",
    options: ["Rules", "Visual", "Neither"],
    recommended: "Rules",
    status: "awaiting_answer",
    ...over,
  };
}

function renderCard(askState: AgentAskState, opts?: { interactive?: boolean; onSubmit?: (a: CopilotAskAnswerInput) => void }) {
  const calls: CopilotAskAnswerInput[] = [];
  const onSubmit = opts?.onSubmit ?? ((a: CopilotAskAnswerInput) => calls.push(a));
  const utils = render(
    <AgentAskCard ask={askState} interactive={opts?.interactive ?? true} onSubmit={onSubmit} />,
  );
  return { ...utils, calls };
}

describe("CopilotAskCard (TAG-9, AP-7 redesign)", () => {
  it("interactive awaiting: header (label + quiet skip) + base-size question + numbered rows + badge, no inner form", () => {
    const { getByTestId, getAllByTestId, queryByTestId } = renderCard(ask({}));
    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("awaiting");
    // Accent left rule while awaiting.
    expect(card.className).toContain("border-l-accent");
    expect(getByTestId("copilot-ask-question").textContent).toContain("turn counter");
    // Question at the base ladder size in text-t1.
    expect(getByTestId("copilot-ask-question").className).toContain("text-t1");
    // Three full-width rows; the recommended one ("Rules", index 0) carries
    // the marker, the number label, and the badge — no star.
    const rows = [0, 1, 2].map((i) => getByTestId(`copilot-ask-chip-${i}`));
    expect(rows.map((r) => r.children[1]!.textContent)).toEqual(["Rules", "Visual", "Neither"]);
    expect(rows.map((r) => r.children[0]!.textContent)).toEqual(["1", "2", "3"]);
    expect(rows[0]!.getAttribute("data-recommended")).toBe("true");
    expect(rows[1]!.getAttribute("data-recommended")).toBeNull();
    expect(rows[0]!.textContent).toContain("copilot_ask_recommended_badge");
    expect(rows[1]!.textContent).not.toContain("copilot_ask_recommended_badge");
    expect(getAllByTestId(/copilot-ask-chip-/).length).toBe(3);
    expect(getByTestId("copilot-ask-skip").textContent).toBe("copilot_ask_skip");
    // AP-7: the inner input + submit are GONE (owner ruling + AP-5 — the
    // MAIN composer is the free-text answer path now).
    expect(queryByTestId("copilot-ask-input")).toBeNull();
    expect(queryByTestId("copilot-ask-submit")).toBeNull();
  });

  it("row click submits the row's label as the answer text", () => {
    const { getByTestId, calls } = renderCard(ask({}));
    fireEvent.click(getByTestId("copilot-ask-chip-1"));
    expect(calls).toEqual([{ text: "Visual" }]);
  });

  it("recommended row submits its own label (same path, no special-casing)", () => {
    const { getByTestId, calls } = renderCard(ask({}));
    fireEvent.click(getByTestId("copilot-ask-chip-0"));
    expect(calls).toEqual([{ text: "Rules" }]);
  });

  it("skip sends the deliberate non-answer", () => {
    const { getByTestId, calls } = renderCard(ask({}));
    fireEvent.click(getByTestId("copilot-ask-skip"));
    expect(calls).toEqual([{ skipped: true }]);
  });

  it("answered renders the muted-question + arrow-answer receipt (no green, no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(
      ask({ status: "answered", answer: "Rules, definitely" }),
    );
    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("answered");
    // Muted left rule on receipts, never the accent.
    expect(card.className).toContain("border-l-border");
    expect(card.className).not.toContain("border-l-accent");
    expect(getByTestId("copilot-ask-question").className).toContain("text-t4");
    const answer = getByTestId("copilot-ask-answer");
    expect(answer.textContent).toBe("→ Rules, definitely");
    expect(answer.className).toContain("text-t1");
    expect(card.className).not.toContain("success-text");
    expect(answer.className).not.toContain("success-text");
    expect(queryByTestId("copilot-ask-chip-0")).toBeNull();
    expect(queryByTestId("copilot-ask-skip")).toBeNull();
  });

  it("skipped renders the muted non-answer receipt (no form)", () => {
    const { getByTestId, queryByTestId } = renderCard(ask({ status: "skipped" }));
    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("skipped");
    expect(card.className).not.toContain("border-l-accent");
    expect(getByTestId("copilot-ask-skipped").textContent).toBe("copilot_ask_skipped");
    expect(queryByTestId("copilot-ask-chip-0")).toBeNull();
  });

  it("awaiting but NOT interactive (superseded / streaming) renders expired (no rows, no skip)", () => {
    const { getByTestId, queryByTestId } = renderCard(ask({}), { interactive: false });
    const card = getByTestId("copilot-ask-card");
    expect(card.getAttribute("data-state")).toBe("expired");
    expect(card.className).not.toContain("border-l-accent");
    expect(getByTestId("copilot-ask-expired").textContent).toBe("copilot_ask_expired");
    expect(queryByTestId("copilot-ask-chip-0")).toBeNull();
    expect(queryByTestId("copilot-ask-skip")).toBeNull();
  });

  it("open question (no options) renders header + question + skip, no rows — and no input", () => {
    const { getByTestId, queryByTestId } = renderCard(ask({ options: undefined, recommended: undefined }));
    expect(getByTestId("copilot-ask-card").getAttribute("data-state")).toBe("awaiting");
    expect(getByTestId("copilot-ask-question")).toBeDefined();
    expect(getByTestId("copilot-ask-skip")).toBeDefined();
    expect(queryByTestId("copilot-ask-chip-0")).toBeNull();
    // Was: the open question rendered the free-text input. Now (owner
    // ruling + AP-5): free text goes through the main composer.
    expect(queryByTestId("copilot-ask-input")).toBeNull();
  });

  it("defensive: a recommended label that is NOT one of the options marks no row", () => {
    const { getByTestId } = renderCard(ask({ recommended: "Not an option" }));
    for (const i of [0, 1, 2]) {
      expect(getByTestId(`copilot-ask-chip-${i}`).getAttribute("data-recommended")).toBeNull();
    }
  });

  it("i18n parity: every ask-card key exists in en + ru", () => {
    const KEYS = [
      "copilot_ask_title",
      "copilot_ask_skip",
      "copilot_ask_recommended_badge",
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
    expect(enMap["copilot_ask_title"]).toBe("Assistant question");
    expect(ruMap["copilot_ask_title"]).toBe("Вопрос помощника");
    expect(enMap["copilot_ask_recommended_badge"]).toBe("recommended");
    expect(ruMap["copilot_ask_recommended_badge"]).toBe("рекомендую");
  });
});

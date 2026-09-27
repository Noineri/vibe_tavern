import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { LocaleProvider } from "../../i18n/context.js";
import { i18next, initI18n } from "../../i18n/i18n.js";
import { normalizeLocale } from "../../i18n/registry.js";
import { flyVerdictKey, useFlyTribunalStore } from "../../stores/fly-tribunal-store.js";
import { FlyVerdictPanel } from "./FlyVerdictPanel.js";

useDomEnv();
const originalLocale = normalizeLocale(i18next.language);
initI18n("en");

const { act, fireEvent, render } = await import("@testing-library/react");

/**
 * Fly verdict panel content contract (FT-10).
 *
 * L1 checklist:
 * 1. Paths: none.
 * 2. Restores: Zustand state is reset after every test.
 * 3. Determinism: all state enters synchronously through Zustand; disclosure
 *    is asserted immediately after its click.
 * 4. Platform: no OS-dependent inputs.
 * 5. Shared worker pool: no module mocks, globals, or registries.
 * 6. Stable state: assertions inspect settled store-backed DOM projections.
 */

function resetFlyStore(): void {
  useFlyTribunalStore.setState({
    courtState: "silent",
    transientState: null,
    precedentCount: 0,
    lastPrecedentAt: null,
    justFellSilent: false,
    verdicts: {},
    workerClient: null,
  });
}

function renderPanel() {
  return render(
    <LocaleProvider initialLocale="en">
      <FlyVerdictPanel />
    </LocaleProvider>,
  );
}

afterEach(() => {
  resetFlyStore();
});

afterAll(() => {
  initI18n(originalLocale);
});

describe("FlyVerdictPanel", () => {
  test("shows the cold-start panel below the 25-precedent gate", () => {
    act(() => useFlyTribunalStore.setState({ precedentCount: 7, courtState: "silent" }));
    const view = renderPanel();

    expect(view.getByTestId("fly-verdict-cold-start").textContent).toContain("the young judge is studying cases: 7/25");
    expect(view.getByTestId("fly-verdict-cold-start").textContent).toContain("learning from your choices");
  });

  test("renders precedent evidence, match count, and per-span channel disclosure", () => {
    const messageId = "msg_1";
    const variantIndex = 2;
    act(() => useFlyTribunalStore.setState({
      courtState: "active",
      precedentCount: 25,
      verdicts: {
        [flyVerdictKey(messageId, variantIndex)]: {
          messageId,
          variantIndex,
          confidence: 0.64,
          evaluatedAt: 100,
          drivingSpans: [
            { ngram: "violet lantern", channel: 17, activation: 0.8, activeKcGlobalIndexes: [4, 9] },
            { ngram: "harbor", channel: 3, activation: 0.5, activeKcGlobalIndexes: [4, 9] },
          ],
        },
      },
    }));
    const view = renderPanel();

    expect(view.getByTestId("fly-verdict-evidence").textContent).toContain("Verdict by precedents");
    expect(view.getByTestId("fly-verdict-signal").textContent).toBe("Precedent signal: 0.64");
    expect(view.getByTestId("fly-verdict-match-count").textContent).toBe("Matches: 2");
    const disclosure = view.getByRole("button", { name: "violet lantern" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(disclosure);
    expect(view.getByText("Channel 17 · activation 0.80")).not.toBeNull();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });

  test("shows an honest empty state after the gate when no variant was evaluated", () => {
    act(() => useFlyTribunalStore.setState({ precedentCount: 25, courtState: "active", verdicts: {} }));
    const view = renderPanel();

    expect(view.getByTestId("fly-verdict-empty").textContent).toContain("No precedent scent yet");
    expect(view.getByTestId("fly-verdict-empty").textContent).toContain("has not smelled this variant yet");
  });
});

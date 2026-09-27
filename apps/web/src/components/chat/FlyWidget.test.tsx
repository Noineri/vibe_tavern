import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { LocaleProvider } from "../../i18n/context.js";
import { useFlyTribunalStore } from "../../stores/fly-tribunal-store.js";
import { FlyWidget } from "./FlyWidget.js";

useDomEnv();

const { act, fireEvent, render } = await import("@testing-library/react");

/**
 * Fly widget presentation contract (FT-10).
 *
 * L1 checklist:
 * 1. Paths: none.
 * 2. Restores: Zustand state is reset after every test.
 * 3. Determinism: state is set synchronously; transient clearing is driven by
 *    a terminal CSS animation event, never a sleep.
 * 4. Platform: no OS-dependent inputs.
 * 5. Shared worker pool: no module mocks, globals, or registries.
 * 6. Stable state: assertions read the rendered state after a completed act.
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

function renderWidget() {
  return render(
    <LocaleProvider initialLocale="en">
      <FlyWidget compact />
    </LocaleProvider>,
  );
}

afterEach(() => {
  resetFlyStore();
});

describe("FlyWidget", () => {
  test("renders the resting and every transient fly CSS state", () => {
    const states = [
      { courtState: "silent" as const, transientState: null, expected: "silent" },
      { courtState: "active" as const, transientState: null, expected: "active" },
      { courtState: "active" as const, transientState: "notes-a-precedent" as const, expected: "notes-a-precedent" },
      { courtState: "active" as const, transientState: "alert" as const, expected: "alert" },
      { courtState: "active" as const, transientState: "verdict" as const, expected: "verdict" },
      { courtState: "active" as const, transientState: "escapes" as const, expected: "escapes" },
      { courtState: "active" as const, transientState: "sleeps" as const, expected: "sleeps" },
    ];

    for (const state of states) {
      act(() => useFlyTribunalStore.setState(state));
      const view = renderWidget();
      expect(view.getByTestId("fly-tribunal-widget").getAttribute("data-fly-state")).toBe(state.expected);
      view.unmount();
    }
  });

  test("uses N/25 below the gate and a plain count after it", () => {
    act(() => useFlyTribunalStore.setState({ precedentCount: 24, courtState: "silent" }));
    const view = renderWidget();
    expect(view.getByTestId("fly-tribunal-counter").textContent).toBe("24/25");

    act(() => useFlyTribunalStore.setState({ precedentCount: 25, courtState: "active" }));
    expect(view.getByTestId("fly-tribunal-counter").textContent).toBe("25");
  });

  test("clears a transient when its CSS animation ends", () => {
    act(() => useFlyTribunalStore.setState({ courtState: "active", transientState: "alert" }));
    const view = renderWidget();
    const widget = view.getByTestId("fly-tribunal-widget");
    expect(widget.getAttribute("data-fly-state")).toBe("alert");

    fireEvent.animationEnd(widget);
    expect(useFlyTribunalStore.getState().transientState).toBeNull();
    expect(widget.getAttribute("data-fly-state")).toBe("active");
  });
});

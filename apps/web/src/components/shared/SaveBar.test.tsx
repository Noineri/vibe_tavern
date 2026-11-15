import { afterEach, describe, expect, jest, test } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import { MIN_SAVING_DISPLAY_MS, SaveButton } from "./SaveBar.js";

useDomEnv();

const { act, cleanup, render } = await import("@testing-library/react");
afterEach(cleanup);

describe("SaveButton feedback", () => {
  test("keeps stable geometry and makes a fast save readable", () => {
    jest.useFakeTimers();
    try {
      const view = render(
        <SaveButton dirty={true} saveState="idle" label="save" onClick={() => {}} />,
      );

      const initial = view.getByRole("button", { name: "save" });
      expect(initial.classList.contains("min-w-[124px]")).toBe(true);
      expect(initial.querySelectorAll("[class*='grid-area']")).toHaveLength(3);

      view.rerender(
        <SaveButton dirty={true} saveState="saving" label="save" onClick={() => {}} />,
      );
      expect(view.getByRole("button", { name: "saving" })).toBeTruthy();

      const elapsedWhileSaving = 50;
      act(() => {
        jest.advanceTimersByTime(elapsedWhileSaving);
      });

      view.rerender(
        <SaveButton dirty={false} saveState="saved" label="save" onClick={() => {}} />,
      );
      expect(view.getByRole("button", { name: "saving" })).toBeTruthy();

      // Just before MIN_SAVING_DISPLAY_MS has elapsed, the button stays in "saving".
      act(() => {
        jest.advanceTimersByTime(MIN_SAVING_DISPLAY_MS - elapsedWhileSaving - 1);
      });
      expect(view.getByRole("button", { name: "saving" })).toBeTruthy();
      expect(view.queryByRole("button", { name: "saved" })).toBeNull();

      // At exact MIN_SAVING_DISPLAY_MS, the queued transition flips to "saved".
      act(() => {
        jest.advanceTimersByTime(1);
      });
      const saved = view.getByRole("button", { name: "saved" }) as HTMLButtonElement;
      expect(saved.classList.contains("min-w-[124px]")).toBe(true);
      expect(saved.disabled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("icon mode renders a 36px floppy square with the state exposed via aria-label", () => {
    const view = render(
      <SaveButton dirty={true} saveState="idle" label="save" icon={<svg data-testid="floppy" />} onClick={() => {}} />,
    );
    const btn = view.getByRole("button", { name: "save" });
    // Fixed touch square, not the text-button min-width floor.
    expect(btn.classList.contains("h-9")).toBe(true);
    expect(btn.classList.contains("w-9")).toBe(true);
    expect(btn.classList.contains("min-w-[124px]")).toBe(false);
    // The three-layer text swap is replaced by the single glyph; no text body.
    expect(btn.querySelectorAll("[class*='grid-area']")).toHaveLength(0);
    expect(btn.querySelector("[data-testid='floppy']")).toBeTruthy();
    expect(btn.textContent).toBe("");
  });
});

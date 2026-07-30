/**
 * Behavior pin for `useMobileFilePicker` (plan unit IF-3).
 *
 * Locks the contract the mobile rail orchestrators (IF-5) will rely on:
 *   • the returned `inputElement` renders a hidden `<input type="file">` with
 *     the caller-supplied `accept`;
 *   • `open()` triggers the native picker via `input.click()` click-through;
 *   • a successful selection forwards the picked `File` to `onFile`;
 *   • dismissing the native picker (no file selected) is a no-op;
 *   • the input value is cleared after each change so the same file can be
 *     reselected.
 *
 * Runner: bun:test with the scoped happy-dom harness.
 */
import { afterEach, beforeAll, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { createElement, type ReactNode } from "react";

useDomEnv();
const { render, fireEvent } = await import("@testing-library/react");

let useMobileFilePicker: typeof import("./use-mobile-file-picker.js").useMobileFilePicker;

beforeAll(async () => {
  ({ useMobileFilePicker } = await import("./use-mobile-file-picker.js"));
});

afterEach(() => {
  jest.restoreAllMocks();
});

function Harness({ accept, onFile }: { accept: string; onFile: (file: File) => void }) {
  const { open, inputElement } = useMobileFilePicker({ accept, onFile });
  return createElement(
    "div",
    null,
    inputElement as ReactNode,
    createElement("button", { type: "button", onClick: open }, "trigger"),
  );
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  // `input.files` is a readonly `FileList`; overwrite via defineProperty so
  // the change handler reads the synthetic selection.
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

describe("useMobileFilePicker", () => {
  it("renders a hidden file input that carries the caller's accept", () => {
    const { container } = render(createElement(Harness, { accept: ".png,.json", onFile: () => {} }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.className).toBe("hidden");
    expect(input.accept).toBe(".png,.json");
  });

  it("open() triggers the native picker via input.click() click-through", () => {
    const { container } = render(createElement(Harness, { accept: ".jsonl", onFile: () => {} }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const button = container.querySelector("button") as HTMLButtonElement;
    const clickSpy = spyOn(input, "click");
    fireEvent.click(button);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards the picked file to onFile and clears the input value", () => {
    const onFile = mock();
    const { container } = render(createElement(Harness, { accept: ".png", onFile }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "card.png", { type: "image/png" });
    setFiles(input, [file]);
    fireEvent.change(input);
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("does not call onFile when the picker is dismissed without a selection", () => {
    const onFile = mock();
    const { container } = render(createElement(Harness, { accept: ".png", onFile }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, []);
    fireEvent.change(input);
    expect(onFile).not.toHaveBeenCalled();
    // Value reset is still a no-op-safe (no selection to leak).
    expect(input.value).toBe("");
  });

  it("allows reselecting the same file after a prior change", () => {
    const onFile = mock();
    const { container } = render(createElement(Harness, { accept: ".png", onFile }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "card.png", { type: "image/png" });
    setFiles(input, [file]);
    fireEvent.change(input);
    expect(onFile).toHaveBeenCalledTimes(1);
    // Reselect the same file — second change still fires because value was cleared.
    setFiles(input, [file]);
    fireEvent.change(input);
    expect(onFile).toHaveBeenCalledTimes(2);
  });
});

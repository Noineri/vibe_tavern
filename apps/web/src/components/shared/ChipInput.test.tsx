/**
 * ChipInput — paste interceptor tests (LOCAL_SAMPLERS_ADDITION_REPORT B3).
 *
 * Pins the JSON-array paste contract: an ST-style JSON array of strings
 * (`[" finger", " moan"]`) pasted into the chip input is committed as MANY
 * deduped chips instead of one literal chip — ST migrants paste their existing
 * antislop/stop lists verbatim. Plain text must take the unchanged path (no
 * chips from paste; the normal Enter commit still applies).
 *
 * Runner: bun:test with the scoped happy-dom harness.
 */
import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
const realTooltip = await import("./Tooltip.js");

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("./Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const { render, fireEvent } = await import("@testing-library/react");
const { ChipInput } = await import("./ChipInput.js");

function renderChipInput(values: string[] = [], onChange = mock()) {
  const { container, getByRole } = render(<ChipInput values={values} onChange={onChange} />);
  const input = getByRole("textbox") as HTMLInputElement;
  return { container, input, onChange };
}

function paste(input: HTMLInputElement, text: string) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

describe("ChipInput paste interceptor (B3)", () => {
  it("commits an ST-style JSON array as many chips instead of one literal chip", () => {
    const onChange = mock();
    const { input } = renderChipInput([], onChange);
    paste(input, '[" finger", " moan"]');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([" finger", " moan"]);
  });

  it("keeps leading/trailing spaces significant and dedupes within the batch", () => {
    const onChange = mock();
    const { input } = renderChipInput([" purr"], onChange);
    paste(input, '[" purr", "purr", " purr", ""]');
    // " purr" already present, second " purr" is a within-batch dupe, "" is empty
    expect(onChange).toHaveBeenCalledWith([" purr", "purr"]);
  });

  it("leaves plain text on the unchanged paste path (no chips from paste)", () => {
    const onChange = mock();
    const { input } = renderChipInput([], onChange);
    paste(input, " just a phrase");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls through for clipboard text that looks like JSON but is not a string array", () => {
    const onChange = mock();
    const { input } = renderChipInput([], onChange);
    paste(input, '{"not":"an array"}');
    paste(input, "[1, 2, 3]");
    paste(input, "[not valid json");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("typed input still commits via Enter as a single chip (existing contract)", () => {
    const onChange = mock();
    const { input } = renderChipInput([], onChange);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(["hello"]);
  });
});

describe("ChipInput words mode (FS-8c simple-words semantics)", () => {
  function renderWords(values: string[] = [], onChange = mock()) {
    const { container } = render(
      <ChipInput values={values} onChange={onChange} mode="words" placeholder="add key…" />,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    return { container, input, onChange };
  }

  it("plain Enter commits — no newline insertion, no Shift requirement", () => {
    const onChange = mock();
    const { input } = renderWords([], onChange);
    fireEvent.change(input, { target: { value: "dragon" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["dragon"]);
    expect(input.value).toBe("");
  });

  it("Shift+Enter commits too, and Tab is NOT intercepted (single-line words)", () => {
    const onChange = mock();
    const { input } = renderWords([], onChange);
    fireEvent.change(input, { target: { value: "wyrm" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(["wyrm"]);

    fireEvent.change(input, { target: { value: "keep" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onChange).toHaveBeenCalledTimes(1); // Tab did not commit; draft kept
    expect(input.value).toBe("keep");
  });

  it("trims and skips empties; escape sequences are NOT parsed", () => {
    const empty = mock();
    const r1 = renderWords([], empty);
    fireEvent.change(r1.input, { target: { value: "  " } });
    fireEvent.keyDown(r1.input, { key: "Enter" });
    expect(empty).not.toHaveBeenCalled();

    const r2 = renderWords([], mock());
    fireEvent.change(r2.input, { target: { value: "  dragon  " } });
    fireEvent.keyDown(r2.input, { key: "Enter" });
    expect(r2.onChange).toHaveBeenCalledWith(["dragon"]); // trimmed

    // `a\nb` (literal backslash-n) stays literal — words never parse escapes
    const r3 = renderWords(["dragon"], mock());
    fireEvent.change(r3.input, { target: { value: "a\\nb" } });
    fireEvent.keyDown(r3.input, { key: "Enter" });
    expect(r3.onChange).toHaveBeenCalledWith(["dragon", "a\\nb"]);
  });

  it("dedupes, comma commits, blur commits, Backspace on empty removes last", () => {
    const dup = mock();
    const r1 = renderWords(["one"], dup);
    fireEvent.change(r1.input, { target: { value: "one" } });
    fireEvent.keyDown(r1.input, { key: "," });
    expect(dup).not.toHaveBeenCalled(); // dup dropped, draft cleared

    const r2 = renderWords(["one"], mock());
    fireEvent.change(r2.input, { target: { value: "two" } });
    fireEvent.blur(r2.input);
    expect(r2.onChange).toHaveBeenCalledWith(["one", "two"]); // blur commits

    const r3 = renderWords(["one"], mock());
    fireEvent.keyDown(r3.input, { key: "Backspace" }); // empty draft → removes last
    expect(r3.onChange).toHaveBeenCalledWith([]);
  });

  it("uses the UI font ladder, not mono (words are prose, not tokens)", () => {
    const { container, input } = renderWords(["k"]);
    expect(input.className).toContain("font-ui");
    expect(input.className).not.toContain("font-mono");
    const chip = container.querySelector("span.group");
    expect(chip).toBeTruthy();
    expect(chip!.className).toContain("font-ui");
  });

  it("tokens mode (default) keeps its mono ladder; plain Enter does NOT commit", () => {
    const onChange = mock();
    const { input } = renderChipInput([], onChange);
    expect(input.className).toContain("font-mono");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Plain Enter inserts a draft newline (state-only — single-line inputs strip
    // \n from the DOM value per spec) and must NOT commit. Shift+Enter commits
    // the draft WITH its invisible newline → the ⏎ chip rendering.
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("a");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(["a\n"]);
  });
});

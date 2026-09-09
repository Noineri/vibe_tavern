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

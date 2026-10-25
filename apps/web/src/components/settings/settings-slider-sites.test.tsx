import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState, type ReactNode } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { useScriptSafetySettingsStore } from "../../stores/script-safety-settings-store.js";

useDomEnv();

installI18nContextSeam();

const realTooltip = await import("../shared/Tooltip.js");
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let LogitBiasPanel: typeof import("./provider/LogitBiasPanel.js").LogitBiasPanel;
let MobileSettings: typeof import("./popovers/MobileSettings.js").MobileSettings;
let AiGenParamsRow: typeof import("../shared/ai-assistant/AiGenParamsRow.js").AiGenParamsRow;
const originalSuppressImportWarnings = useScriptSafetySettingsStore.getState().suppressImportWarnings;
const originalAiGenParamsOpen = localStorage.getItem("ai:gen-params:open");

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ LogitBiasPanel } = await import("./provider/LogitBiasPanel.js"));
  ({ MobileSettings } = await import("./popovers/MobileSettings.js"));
  ({ AiGenParamsRow } = await import("../shared/ai-assistant/AiGenParamsRow.js"));
});

beforeEach(() => {
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  localStorage.removeItem("ai:gen-params:open");
});

afterAll(() => {
  if (originalAiGenParamsOpen === null) localStorage.removeItem("ai:gen-params:open");
  else localStorage.setItem("ai:gen-params:open", originalAiGenParamsOpen);
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: originalSuppressImportWarnings });
});

function range(view: ReturnType<typeof render>, name: string): HTMLInputElement {
  const input = view.getByLabelText(name) as HTMLInputElement;
  if (input.type !== "range") throw new Error(`Expected range input for ${name}`);
  return input;
}

function fieldShell(view: ReturnType<typeof render>, name: string): HTMLElement {
  const shell = range(view, name).closest<HTMLElement>("[data-slider-field-shell]");
  if (!shell) throw new Error(`Expected ${name} to live inside a slider field`);
  return shell;
}

/** The field's value text; absent while the inline editor replaces it. */
function fieldValue(view: ReturnType<typeof render>, name: string) {
  return fieldShell(view, name).querySelector("[data-slider-field-value]")?.textContent;
}

/** Seam: the number box beside the slider is now the field's inline editor, opened by double-click. */
function openEditor(view: ReturnType<typeof render>, name: string): HTMLInputElement {
  const shell = fieldShell(view, name);
  const field = shell.querySelector<HTMLElement>("[data-slider-field]");
  if (!field) throw new Error(`Missing field box for ${name}`);
  fireEvent.doubleClick(field);
  const editor = shell.querySelector<HTMLInputElement>("[data-slider-field-editor] input");
  if (!editor) throw new Error(`Inline editor did not open for ${name}`);
  return editor;
}

function typeInto(editor: HTMLInputElement, text: string) {
  fireEvent.change(editor, { target: { value: text } });
  fireEvent.keyDown(editor, { key: "Enter" });
}

function biasRow(view: ReturnType<typeof render>): HTMLElement {
  const row = range(view, "logit_bias_label #42").closest<HTMLElement>(".group.rounded-lg");
  if (!row) throw new Error("Missing logit bias row");
  return row;
}

function biasButton(view: ReturnType<typeof render>, text: string): HTMLButtonElement {
  const button = Array.from(biasRow(view).querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing logit bias button ${text}`);
  return button;
}

function ControlledAiGenParamsRow({ onTemperatureChange }: { onTemperatureChange: (value: number) => void }) {
  const [temperature, setTemperature] = useState(0.7);
  return (
    <AiGenParamsRow
      temperature={temperature}
      onTemperatureChange={(value) => {
        setTemperature(value);
        onTemperatureChange(value);
      }}
      maxTokens={512}
      onMaxTokensChange={() => {}}
    />
  );
}

describe("SL-3 settings slider sites", () => {
  it("steps logit bias by ten and clamps both shortcut bounds", () => {
    const onChange = mock();
    const entry = { tokenId: 42, bias: 10, model: "model-a" };
    const view = render(<LogitBiasPanel entries={[entry]} onChange={onChange} supported model="model-a" />);

    fireEvent.click(biasButton(view, "−"));
    expect(onChange).toHaveBeenNthCalledWith(1, [{ ...entry, bias: 0 }]);
    view.rerender(<LogitBiasPanel entries={[{ ...entry, bias: 95 }]} onChange={onChange} supported model="model-a" />);
    fireEvent.click(biasButton(view, "+"));
    expect(onChange).toHaveBeenNthCalledWith(2, [{ ...entry, bias: 100 }]);
    view.rerender(<LogitBiasPanel entries={[{ ...entry, bias: -95 }]} onChange={onChange} supported model="model-a" />);
    fireEvent.click(biasButton(view, "−"));
    expect(onChange).toHaveBeenNthCalledWith(3, [{ ...entry, bias: -100 }]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("bans a logit bias token and hides the ban shortcut at minus one hundred", () => {
    const onChange = mock();
    const entry = { tokenId: 42, bias: 10, model: "model-a" };
    const view = render(<LogitBiasPanel entries={[entry]} onChange={onChange} supported model="model-a" />);

    fireEvent.click(biasButton(view, "🚫"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([{ ...entry, bias: -100 }]);
    view.rerender(<LogitBiasPanel entries={[{ ...entry, bias: -100 }]} onChange={onChange} supported model="model-a" />);
    expect(biasRow(view).textContent?.includes("🚫")).toBe(false);
  });

  it("disables all logit bias shortcuts for stale and disabled rows without writes", () => {
    const onChange = mock();
    const entry = { tokenId: 42, bias: 10, model: "model-a" };
    const view = render(<LogitBiasPanel entries={[entry]} onChange={onChange} supported model="model-b" />);

    for (const disabled of [false, true]) {
      view.rerender(<LogitBiasPanel entries={[entry]} onChange={onChange} supported disabled={disabled} model={disabled ? "model-a" : "model-b"} />);
      for (const text of ["−", "+", "🚫"]) {
        const button = biasButton(view, text);
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
      }
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it("preserves signed logit bias values and their success danger and neutral colors", () => {
    const onChange = mock();
    const entry = { tokenId: 42, bias: 20, model: "model-a" };
    const view = render(<LogitBiasPanel entries={[entry]} onChange={onChange} supported model="model-a" />);
    const cases = [[20, "+20", "text-success"], [-35, "-35", "text-danger"], [0, "0", "text-t3"]] as const;

    for (const [bias, text, color] of cases) {
      view.rerender(<LogitBiasPanel entries={[{ ...entry, bias }]} onChange={onChange} supported model="model-a" />);
      // Seam change: was the separate w-10 span -> now the field's value span; sign and color stay unchanged.
      const value = fieldShell(view, "logit_bias_label #42").querySelector("[data-slider-field-value]");
      expect(value?.textContent).toBe(text);
      expect(value?.classList.contains(color)).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders logit bias as a value-only field in the old flex slider slot", () => {
    const view = render(<LogitBiasPanel entries={[{ tokenId: 42, bias: 10, model: "model-a" }]} onChange={() => {}} supported model="model-a" />);
    const shell = fieldShell(view, "logit_bias_label #42");

    expect(shell.classList.contains("flex-1")).toBe(true);
    expect(shell.classList.contains("min-w-0")).toBe(true);
    expect(shell.querySelector("[data-slider-field]")).not.toBeNull();
    expect(shell.querySelector("[data-slider-field-label], [data-slider-field-label-above]")).toBeNull();
    expect(shell.querySelector("[data-slider-field-help]")).toBeNull();
    expect(biasRow(view).querySelector("span.w-10")).toBeNull();
    expect(biasRow(view).querySelectorAll("[data-slider-field-value]")).toHaveLength(1);
  });

  it("rounds typed logit bias to integers and clamps both editor bounds", () => {
    const onChange = mock();
    const entry = { tokenId: 42, bias: 10, model: "model-a" };
    const view = render(<LogitBiasPanel entries={[entry]} onChange={onChange} supported model="model-a" />);

    for (const [typed, expected] of [["12.6", 13], ["250", 100], ["-250", -100]] as const) {
      typeInto(openEditor(view, "logit_bias_label #42"), typed);
      expect(onChange).toHaveBeenLastCalledWith([{ ...entry, bias: expected }]);
    }
    expect(onChange).toHaveBeenCalledTimes(3);
    for (const [entries] of onChange.mock.calls) expect(Number.isInteger(entries[0].bias)).toBe(true);
  });

  it("updates a logit bias entry immediately and suppresses stale and disabled rows", () => {
    const onChange = mock();
    const entry = { tokenId: 42, bias: 10, model: "model-a" };
    const view = render(
      <LogitBiasPanel entries={[entry]} onChange={onChange} supported model="model-a" />,
    );
    const slider = range(view, "logit_bias_label #42");

    expect(slider.min).toBe("-100");
    expect(slider.max).toBe("100");
    expect(slider.step).toBe("1");
    fireEvent.change(slider, { target: { value: "25" } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...entry, bias: 25 }]);

    view.rerender(<LogitBiasPanel entries={[entry]} onChange={onChange} supported model="model-b" />);
    expect(range(view, "logit_bias_label #42").disabled).toBe(true);
    fireEvent.change(range(view, "logit_bias_label #42"), { target: { value: "30" } });
    fireEvent.doubleClick(fieldShell(view, "logit_bias_label #42").querySelector("[data-slider-field]")!);
    expect(fieldShell(view, "logit_bias_label #42").querySelector("[data-slider-field-editor]")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);

    view.rerender(<LogitBiasPanel entries={[entry]} onChange={onChange} supported disabled model="model-a" />);
    expect(range(view, "logit_bias_label #42").disabled).toBe(true);
    fireEvent.doubleClick(fieldShell(view, "logit_bias_label #42").querySelector("[data-slider-field]")!);
    expect(fieldShell(view, "logit_bias_label #42").querySelector("[data-slider-field-editor]")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("updates both mobile font settings immediately with their bounds and value-only field readouts", () => {
    const setSetting = mock();
    const view = render(
      <MobileSettings
        open
        onClose={() => {}}
        settings={{ theme: "coffee", fontSize: 17, uiFontSize: 16, messageWidth: "medium", lang: "en", showRail: true }}
        setSetting={setSetting}
        onOpenMobileAccess={() => {}}
      />,
    );
    const chatFont = range(view, "tweaks_font_size");
    const uiFont = range(view, "tweaks_ui_font_size");

    expect(chatFont.min).toBe("14");
    expect(chatFont.max).toBe("22");
    expect(chatFont.step).toBe("1");
    expect(uiFont.min).toBe("14");
    expect(uiFont.max).toBe("20");
    expect(uiFont.step).toBe("1");
    // Behavior change: was a separate "17px" header readout beside the slider -> now the field's own value text "17 px" (the header readout is gone); basis: SL-9 contract.
    expect(view.queryByText("17px")).toBeNull();
    expect(view.queryByText("16px")).toBeNull();
    expect(fieldValue(view, "tweaks_font_size")).toBe("17 px");
    expect(fieldValue(view, "tweaks_ui_font_size")).toBe("16 px");
    // The header row already carries icon + label, so the fields hold no label of their own.
    expect(fieldShell(view, "tweaks_font_size").querySelector("[data-slider-field-label]")).toBeNull();
    expect(fieldShell(view, "tweaks_ui_font_size").querySelector("[data-slider-field-label]")).toBeNull();
    fireEvent.change(chatFont, { target: { value: "19" } });
    fireEvent.change(uiFont, { target: { value: "18" } });
    expect(setSetting).toHaveBeenNthCalledWith(1, "fontSize", 19);
    expect(setSetting).toHaveBeenNthCalledWith(2, "uiFontSize", 18);
  });

  it("types a mobile font size through the inline editor, rounded to whole pixels and clamped to the bounds", () => {
    const setSetting = mock();
    const view = render(
      <MobileSettings
        open
        onClose={() => {}}
        settings={{ theme: "coffee", fontSize: 17, uiFontSize: 16, messageWidth: "medium", lang: "en", showRail: true }}
        setSetting={setSetting}
        onOpenMobileAccess={() => {}}
      />,
    );

    typeInto(openEditor(view, "tweaks_font_size"), "20.4");
    expect(setSetting).toHaveBeenLastCalledWith("fontSize", 20);
    typeInto(openEditor(view, "tweaks_ui_font_size"), "30");
    expect(setSetting).toHaveBeenLastCalledWith("uiFontSize", 20);
    typeInto(openEditor(view, "tweaks_font_size"), "3");
    expect(setSetting).toHaveBeenLastCalledWith("fontSize", 14);
    expect(setSetting).toHaveBeenCalledTimes(3);
  });

  it("renders the kept-mounted AI temperature as one field with its label inside and no separate number box", () => {
    const onTemperatureChange = mock();
    const view = render(<ControlledAiGenParamsRow onTemperatureChange={onTemperatureChange} />);
    fireEvent.click(view.getByText("ai_advanced_settings"));
    const slider = range(view, "ai_param_temperature");
    const shell = fieldShell(view, "ai_param_temperature");

    expect(slider.min).toBe("0");
    expect(slider.max).toBe("2");
    expect(slider.step).toBe("0.1");
    expect(shell.querySelector("[data-slider-field-label]")?.textContent).toBe("ai_param_temperature");
    // Behavior change: was a number box at the slider's right -> now only the max-tokens box remains; the temperature is typed through the field.
    expect(view.container.querySelectorAll('input[type="text"]')).toHaveLength(1);
    expect(fieldValue(view, "ai_param_temperature")).toBe("0.7");

    fireEvent.change(slider, { target: { value: "1.2" } });
    expect(onTemperatureChange).toHaveBeenLastCalledWith(1.2);
    expect(fieldValue(view, "ai_param_temperature")).toBe("1.2");
    typeInto(openEditor(view, "ai_param_temperature"), "0.8");
    expect(onTemperatureChange).toHaveBeenLastCalledWith(0.8);
    expect(onTemperatureChange).toHaveBeenCalledTimes(2);
    expect(slider.value).toBe("0.8");
    expect(fieldValue(view, "ai_param_temperature")).toBe("0.8");

    fireEvent.click(view.getByText("ai_advanced_settings"));
    expect(range(view, "ai_param_temperature").value).toBe("0.8");
    expect(fieldValue(view, "ai_param_temperature")).toBe("0.8");
  });

  it("keeps a typed temperature exactly between steps and clamps it to the 0 to 2 bounds", () => {
    const onTemperatureChange = mock();
    const view = render(<ControlledAiGenParamsRow onTemperatureChange={onTemperatureChange} />);
    fireEvent.click(view.getByText("ai_advanced_settings"));

    typeInto(openEditor(view, "ai_param_temperature"), "0.85");
    expect(onTemperatureChange).toHaveBeenLastCalledWith(0.85);
    expect(fieldValue(view, "ai_param_temperature")).toBe("0.85");
    typeInto(openEditor(view, "ai_param_temperature"), "5");
    expect(onTemperatureChange).toHaveBeenLastCalledWith(2);
    expect(fieldValue(view, "ai_param_temperature")).toBe("2.0");
    typeInto(openEditor(view, "ai_param_temperature"), "-1");
    expect(onTemperatureChange).toHaveBeenLastCalledWith(0);
    expect(fieldValue(view, "ai_param_temperature")).toBe("0.0");
  });
});

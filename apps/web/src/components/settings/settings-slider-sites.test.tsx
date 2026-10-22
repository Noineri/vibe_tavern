import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState, type ReactNode } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { useScriptSafetySettingsStore } from "../../stores/script-safety-settings-store.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
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
  localStorage.removeItem("ai:gen-params:open");
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: null });
});

function range(view: ReturnType<typeof render>, name: string): HTMLInputElement {
  const input = view.getByLabelText(name) as HTMLInputElement;
  if (input.type !== "range") throw new Error(`Expected range input for ${name}`);
  return input;
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
    expect(onChange).toHaveBeenCalledTimes(1);

    view.rerender(<LogitBiasPanel entries={[entry]} onChange={onChange} supported disabled model="model-a" />);
    expect(range(view, "logit_bias_label #42").disabled).toBe(true);
  });

  it("updates both mobile font settings immediately with their bounds and readouts", () => {
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
    expect(view.getByText("17px")).toBeTruthy();
    expect(view.getByText("16px")).toBeTruthy();
    fireEvent.change(chatFont, { target: { value: "19" } });
    fireEvent.change(uiFont, { target: { value: "18" } });
    expect(setSetting).toHaveBeenNthCalledWith(1, "fontSize", 19);
    expect(setSetting).toHaveBeenNthCalledWith(2, "uiFontSize", 18);
  });

  it("synchronizes the kept-mounted AI temperature slider and number input", () => {
    const onTemperatureChange = mock();
    const view = render(<ControlledAiGenParamsRow onTemperatureChange={onTemperatureChange} />);
    fireEvent.click(view.getByText("ai_advanced_settings"));
    const slider = range(view, "ai_param_temperature");
    const number = view.container.querySelector<HTMLInputElement>('input[type="text"]');
    if (!number) throw new Error("Missing temperature number input");

    expect(slider.min).toBe("0");
    expect(slider.max).toBe("2");
    expect(slider.step).toBe("0.1");
    fireEvent.change(slider, { target: { value: "1.2" } });
    expect(onTemperatureChange).toHaveBeenLastCalledWith(1.2);
    expect(number.value).toBe("1.2");
    fireEvent.change(number, { target: { value: "0.8" } });
    fireEvent.blur(number);
    expect(onTemperatureChange).toHaveBeenLastCalledWith(0.8);
    expect(slider.value).toBe("0.8");

    fireEvent.click(view.getByText("ai_advanced_settings"));
    expect(range(view, "ai_param_temperature").value).toBe("0.8");
  });
});

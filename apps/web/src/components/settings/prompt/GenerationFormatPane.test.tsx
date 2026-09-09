/**
 * The Generation-format pane (LOCAL_SUPPORT_PLAN LS-3d): render states.
 * Active (TC mode on the active provider profile): mode status default view +
 * the collapsed advanced manual-sequences editor. Inactive: the pane renders
 * GREYED with the enable-raw-mode hint (owner decision 2026-09-09 — visible
 * always, discoverability before enabling raw mode).
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let GenerationFormatPane: typeof import("./GenerationFormatPane.js").GenerationFormatPane;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

// Radix Tooltip needs a global Provider the isolated render here doesn't
// mount — passthrough stub (same pattern as ExperienceCopilotShell.test.tsx).
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ GenerationFormatPane } = await import("./GenerationFormatPane.js"));
});

const MANUAL_FORMAT = {
  mode: "manual" as const,
  inputSequence: "<|im_start|>user",
  outputSequence: "<|im_start|>assistant",
  wrap: true,
};

function renderPane(props: Partial<Parameters<typeof GenerationFormatPane>[0]> = {}) {
  const onFormatChange = mock((_next: unknown) => {});
  const utils = render(
    <GenerationFormatPane
      hasPreset
      format={null}
      onFormatChange={onFormatChange}
      tcTemplateSource="default"
      onImportClick={() => {}}
      {...props}
    />,
  );
  return { ...utils, onFormatChange };
}

describe("GenerationFormatPane (LS-3d)", () => {
  it("default view = auto mode with the ACTIVE status line per template source (default template)", () => {
    const { getByText, getByRole } = renderPane();
    expect(getByText("promptManager.format.modeAuto")).toBeTruthy();
    expect(getByRole("radio", { name: "promptManager.format.modeAuto" }).getAttribute("aria-checked")).toBe("true");
    expect(getByText("promptManager.format.statusDefault")).toBeTruthy();
  });

  it("auto on llama-server reports the BACKEND template status", () => {
    const { getByText } = renderPane({ tcTemplateSource: "backend" });
    expect(getByText("promptManager.format.statusBackend")).toBeTruthy();
  });

  it("auto on KoboldCPP reports the NATIVE no-op status", () => {
    const { getByText } = renderPane({ tcTemplateSource: "native" });
    expect(getByText("promptManager.format.statusNative")).toBeTruthy();
  });

  it("WITHOUT TC mode the pane renders greyed with the hint", () => {
    const { getByText, getByRole } = renderPane({ tcTemplateSource: null });
    expect(getByText("promptManager.format.inactiveTitle")).toBeTruthy();
    expect(getByText("promptManager.format.inactiveHint")).toBeTruthy();
    const autoRadio = getByRole("radio", { name: "promptManager.format.modeAuto" });
    expect(autoRadio.getAttribute("aria-checked")).toBe("true");
  });

  it("a stored manual format stays DISPLAYED (greyed, not hidden) without TC mode", () => {
    const { getByText, getByRole } = renderPane({ tcTemplateSource: null, format: MANUAL_FORMAT });
    expect(getByText("promptManager.format.modeManual")).toBeTruthy();
    expect(getByRole("radio", { name: "promptManager.format.modeManual" }).getAttribute("aria-checked")).toBe("true");
  });

  it("a manual preset auto-opens the advanced accordion with the ST sequences editor", () => {
    const { getByText, getByDisplayValue } = renderPane({ format: MANUAL_FORMAT });
    expect(getByText("promptManager.format.advancedTitle")).toBeTruthy();
    expect(getByDisplayValue("<|im_start|>user")).toBeTruthy();
    expect(getByDisplayValue("<|im_start|>assistant")).toBeTruthy();
  });

  it("switching to manual emits the format with mode=manual (fields kept for switch-back)", () => {
    const { getByRole, onFormatChange } = renderPane({ format: { mode: "auto", inputSequence: "U:" } });
    fireEvent.click(getByRole("radio", { name: "promptManager.format.modeManual" }));
    expect(onFormatChange).toHaveBeenCalledTimes(1);
    const next = onFormatChange.mock.calls[0][0] as { mode: string; inputSequence?: string };
    expect(next.mode).toBe("manual");
    expect(next.inputSequence).toBe("U:");
  });

  it("editing a sequence field emits the updated format object", () => {
    const { getByDisplayValue, onFormatChange } = renderPane({ format: MANUAL_FORMAT });
    const input = getByDisplayValue("<|im_start|>user");
    fireEvent.change(input, { target: { value: "U:" } });
    expect(onFormatChange).toHaveBeenCalledTimes(1);
    const next = onFormatChange.mock.calls[0][0] as { inputSequence?: string; outputSequence?: string };
    expect(next.inputSequence).toBe("U:");
    expect(next.outputSequence).toBe("<|im_start|>assistant");
  });

  it("without a preset the pane shows the select-a-preset hint", () => {
    const { getByText } = renderPane({ hasPreset: false });
    expect(getByText("promptManager.format.noPreset")).toBeTruthy();
  });
});

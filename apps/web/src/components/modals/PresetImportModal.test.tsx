import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");

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
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile: () => true,
}));

let PresetImportModal: typeof import("./PresetImportModal.js").PresetImportModal;
let render: typeof import("@testing-library/react").render;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ PresetImportModal } = await import("./PresetImportModal.js"));
});

function presetFile(blockContent: string): File {
  return new File(
    [
      JSON.stringify({
        name: "Probe preset",
        prompts: [
          {
            identifier: "main",
            name: "Main",
            role: "system",
            content: blockContent,
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            enabled: true,
          },
        ],
      }),
    ],
    "probe-preset.json",
    { type: "application/json" },
  );
}

describe("PresetImportModal", () => {
  it("opens the fullscreen preview directly when the mobile picker supplies a file", async () => {
    const file = new File([
      JSON.stringify({ name: "Mobile preset", prompts: [] }),
    ], "mobile-preset.json", { type: "application/json" });
    const view = render(
      <PresetImportModal initialFile={file} onClose={() => {}} onImport={() => {}} />,
    );

    expect(await view.findByText("Mobile preset.json")).toBeTruthy();
    expect(view.queryByText("preset_import_drop_title")).toBeNull();
  });

  // st-macro-parity step 8: importing a preset that uses an ST macro VT
  // deliberately does not support shows the import warning in the preview.
  it("shows the dropped-macro warning for a preset block using {{wiBefore}}", async () => {
    const view = render(
      <PresetImportModal
        initialFile={presetFile("Prefix {{wiBefore}} suffix")}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    expect(
      await view.findByText(
        "Macro {{wiBefore}} is not supported in VT — use preset layers and the generation format instead.",
      ),
    ).toBeTruthy();
  });

  it("shows no dropped-macro warning for a preset using only supported macros", async () => {
    const view = render(
      <PresetImportModal
        initialFile={presetFile("{{trim}} {{user}} said {{pick::a::b}}")}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    expect(await view.findByText("Probe preset.json")).toBeTruthy();
    expect(view.queryByText(/is not supported in VT/)).toBeNull();
  });
});

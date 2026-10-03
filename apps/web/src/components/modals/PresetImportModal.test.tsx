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
});

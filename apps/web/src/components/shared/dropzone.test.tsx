import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");
const mobileState = { isMobile: false };

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
  useIsMobile: () => mobileState.isMobile,
}));

let Dropzone: typeof import("./dropzone.js").Dropzone;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;

beforeAll(async () => {
  ({ fireEvent, render } = await import("@testing-library/react"));
  ({ Dropzone } = await import("./dropzone.js"));
});

afterEach(() => {
  mobileState.isMobile = false;
});

describe("Dropzone", () => {
  it("accepts a desktop drop and exposes the requested file-input contract", () => {
    const onFiles = mock(() => {});
    const { container } = render(
      <Dropzone
        accept="image/*"
        multiple
        title="Desktop title"
        subtitle="Desktop subtitle"
        onFiles={onFiles}
      />,
    );
    const zone = container.querySelector("div");
    const input = container.querySelector("input");
    if (!(zone instanceof HTMLDivElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("dropzone elements missing");
    }
    const file = new File(["image"], "image.png", { type: "image/png" });

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(zone.className).toBe("flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-5 py-10 font-ui text-t3 transition-all hover:border-accent hover:bg-s2 hover:text-t2");
  });

  it("opens the desktop file picker when clicked", () => {
    const { container } = render(
      <Dropzone accept=".json" title="Desktop title" onFiles={() => {}} />,
    );
    const zone = container.querySelector("div");
    const input = container.querySelector("input");
    if (!(zone instanceof HTMLDivElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("dropzone elements missing");
    }
    const click = mock(() => {});
    input.click = click;

    fireEvent.click(zone);

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("preserves the compact AI-assistant desktop classes", () => {
    const { container } = render(
      <Dropzone size="compact" accept=".md" title="Markdown file" onFiles={() => {}} />,
    );
    const zone = container.querySelector("div");
    if (!(zone instanceof HTMLDivElement)) throw new Error("compact dropzone missing");

    expect(zone.className).toBe("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 transition-colors border-border bg-s2 hover:border-accent hover:bg-accent-dim/30");
  });

  it("uses a drag-free mobile picker target with plural-aware copy", () => {
    mobileState.isMobile = true;
    const { container, getByText } = render(
      <Dropzone accept="image/*" multiple title="Desktop title" onFiles={() => {}} />,
    );
    const zone = container.querySelector("button");
    const input = container.querySelector("input");
    if (!(zone instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("mobile dropzone elements missing");
    }
    const click = mock(() => {});
    input.click = click;

    fireEvent.click(zone);

    expect(getByText("dropzone_select_files")).toBeTruthy();
    expect(container.textContent?.includes("Desktop title")).toBe(false);
    expect(zone.className).toContain("py-10");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("mobile keeps the consumer subtitle under the generic title (formats/location info, not drag wording)", () => {
    mobileState.isMobile = true;
    const { container, getByText } = render(
      <Dropzone
        accept="image/*"
        title="Импорт изображения"
        subtitle="Поддерживаются PNG и JPEG"
        onFiles={() => {}}
      />,
    );
    const subtitleEl = getByText("Поддерживаются PNG и JPEG");
    expect(subtitleEl.className).toBe("font-ui text-xs text-t4");
    // Under the generic mobile title, in order.
    expect(container.textContent).toBe("dropzone_select_fileПоддерживаются PNG и JPEG");
  });

  it("mobile without a subtitle renders only the generic title — nothing extra", () => {
    mobileState.isMobile = true;
    const { container } = render(
      <Dropzone accept="image/*" multiple title="Desktop title" onFiles={() => {}} />,
    );
    expect(container.textContent).toBe("dropzone_select_files");
  });
});

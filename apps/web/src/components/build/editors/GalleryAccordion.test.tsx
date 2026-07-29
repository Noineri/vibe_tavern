import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realTokenCount = await import("../../../hooks/use-token-count.js");

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
mock.module("../../../hooks/use-token-count.js", () => ({
  ...realTokenCount,
  useTokenCount: () => 0,
}));

let GalleryAccordion: typeof import("./GalleryAccordion.js").GalleryAccordion;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ GalleryAccordion } = await import("./GalleryAccordion.js"));
});

afterEach(() => {
  localStorage.clear();
});

describe("GalleryAccordion disclosure", () => {
  it("opens the real gallery body from its collapsed header", () => {
    const load = mock(async () => {});
    const reload = mock(async () => {});
    useGalleryStore.setState({
      byCharacter: { "char-1": [] },
      loading: {},
      uploading: {},
      describing: {},
      error: {},
      load,
      reload,
      upload: mock(async () => {}),
      updateCaption: mock(async () => {}),
      updateDescription: mock(async () => {}),
      setIncludeInPrompt: mock(async () => {}),
      reorder: mock(async () => {}),
      remove: mock(async () => {}),
      describe: mock(async () => {}),
      cancelDescribe: mock(() => {}),
      reset: mock(() => {}),
    });

    const { getByText, queryByText } = render(<GalleryAccordion characterId="char-1" />);
    expect(queryByText("gallery_empty")).toBeNull();

    fireEvent.click(getByText("gallery_title"));

    expect(getByText("gallery_empty")).toBeTruthy();
    expect(reload).toHaveBeenCalledWith("char-1");
  });
});

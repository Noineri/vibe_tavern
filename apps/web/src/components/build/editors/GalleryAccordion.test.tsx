import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import type { CharacterAsset } from "@vibe-tavern/domain";

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

const realGalleryViewer = await import("./GalleryViewer.js");
// The viewer is the gallery's tested surface; here we pin the SEAM — the
// host renders GalleryViewer with the characterId it was opened with. The
// real adapter still resolves the src under test (the ImageBlock.test.tsx
// pattern — deterministic, no zoom/pan machinery).
mock.module("./GalleryViewer.js", () => ({
  ...realGalleryViewer,
  FloatingImageViewer: ({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) => (
    <div data-testid="floating-viewer" data-src={src} data-alt={alt} onClick={onClose} />
  ),
}));

let GalleryAccordion: typeof import("./GalleryAccordion.js").GalleryAccordion;
let FloatingGalleryViewers: typeof import("./FloatingGalleryViewers.js").FloatingGalleryViewers;
let useFloatingGalleryStore: typeof import("../../../stores/floating-gallery-store.js").useFloatingGalleryStore;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ GalleryAccordion } = await import("./GalleryAccordion.js"));
  ({ FloatingGalleryViewers } = await import("./FloatingGalleryViewers.js"));
  ({ useFloatingGalleryStore } = await import("../../../stores/floating-gallery-store.js"));
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

describe("GalleryAccordion floating viewer across a character switch", () => {
  function makeAsset(characterId: string, id: string, caption: string): CharacterAsset {
    return {
      id,
      characterId,
      ext: "png",
      mimeType: "image/png",
      caption,
      description: null,
      includeInPrompt: false,
      avatarCropJson: null,
      order: 0,
      createdAt: "2026-01-01T00:00:00Z",
    } as CharacterAsset;
  }

  beforeEach(() => {
    useGalleryStore.setState({
      byCharacter: {
        "char-A": [makeAsset("char-A", "row-a1", "A one")],
        "char-B": [makeAsset("char-B", "row-b1", "B one")],
      },
      loading: {},
      uploading: {},
      describing: {},
      error: {},
      load: mock(async () => {}),
      reload: mock(async () => {}),
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
    useFloatingGalleryStore.setState({ viewers: [] });
  });

  afterEach(() => {
    useFloatingGalleryStore.setState({ viewers: [] });
  });

  it("keeps A's image with B's accordion collapsed AND open", async () => {
    const view = render(
      <>
        <GalleryAccordion characterId="char-A" />
        <FloatingGalleryViewers />
      </>,
    );

    // Open A's accordion and expand its tile → floating viewer appears.
    fireEvent.click(view.getByText("gallery_title"));
    fireEvent.click(view.getByTitle("gallery_expand"));
    expect(view.getByTestId("floating-viewer").getAttribute("data-src"))
      .toContain("characters/char-A/assets/row-a1");

    // Switch to B (collapsed → the grid unmounts): the viewer stays open
    // with A's URL, not B's.
    view.rerender(
      <>
        <GalleryAccordion characterId="char-B" />
        <FloatingGalleryViewers />
      </>,
    );
    // AnimatePresence holds A's exiting grid briefly; waitFor polls until it
    // is gone (the CoauthorCharacterForm.test.tsx precedent). SC-14: the
    // persisted hook re-reads B's key on the switch, so B is genuinely
    // collapsed here — no longer A's leaked open state.
    await waitFor(() => expect(view.queryByAltText("A one")).toBeNull());
    const kept = view.getByTestId("floating-viewer");
    expect(kept.getAttribute("data-src")).toContain("characters/char-A/assets/row-a1");
    expect(kept.getAttribute("data-src")).not.toContain("char-B");
    expect(kept.getAttribute("data-alt")).toBe("A one");

    // Open B's accordion too: B's grid shows B's image, the viewer still A's.
    fireEvent.click(view.getByText("gallery_title"));
    expect(view.getByAltText("B one")).toBeTruthy();
    expect(view.getByTestId("floating-viewer").getAttribute("data-src"))
      .toContain("characters/char-A/assets/row-a1");
  });
});

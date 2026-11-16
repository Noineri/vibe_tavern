import type { ReactElement } from "react";
/**
 * GalleryLightbox scroll chrome + navigation pins (CNR-8k).
 *
 * The lightbox's image + description stack rides the shared thin ScrollArea
 * lane; paging (prev/next buttons) and keyboard nav (Escape/arrows) live
 * OUTSIDE the scroller and must survive the migration untouched.
 *
 * Locator note (CNR-8k brief): the brief's "film strip" does not exist in
 * this component — GalleryLightbox pages via prev/next buttons + keyboard
 * only, so no strip scroller ref exists to repoint. The image is a plain
 * fit-to-view img, not a zoom/pan stage (the gesture stages live in
 * MediaLightbox and GalleryViewer, both left native).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import type { CharacterAsset } from "@vibe-tavern/domain";

useDomEnv();

installI18nContextSeam();

let GalleryLightbox: typeof import("./GalleryLightbox.js").GalleryLightbox;
let TooltipProvider: typeof import("../../shared/Tooltip.js").TooltipProvider;
let rtlRender: typeof import("@testing-library/react").render;
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: ({ children }) => <TooltipProvider delayDuration={0}>{children}</TooltipProvider> });
}
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ TooltipProvider } = await import("../../shared/Tooltip.js"));
  const testing = await import("@testing-library/react");
  ({ fireEvent } = testing);
  rtlRender = testing.render;
  ({ GalleryLightbox } = await import("./GalleryLightbox.js"));
});

function makeAsset(id: string, caption: string, description: string | null): CharacterAsset {
  return {
    id,
    characterId: "char-1",
    ext: "png",
    mimeType: "image/png",
    caption,
    description,
    includeInPrompt: false,
    avatarCropJson: null,
    order: 0,
    createdAt: "2026-01-01T00:00:00Z",
  } as CharacterAsset;
}

const ASSETS: CharacterAsset[] = [
  makeAsset("gal-1", "First shot", "A long description of the first shot"),
  makeAsset("gal-2", "Second shot", null),
  makeAsset("gal-3", "Third shot", "Third description"),
];

beforeEach(() => {
  useGalleryStore.setState({
    byCharacter: { "char-1": ASSETS },
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
});

afterEach(() => {
  localStorage.clear();
});

describe("GalleryLightbox description stack scroll chrome (CNR-8k)", () => {
  it("rides the thin vertical lane with the cap and stack layout preserved", () => {
    const view = render(
      <GalleryLightbox
        characterId="char-1"
        assets={ASSETS}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
      />,
    );
    const lane = view.container.querySelector<HTMLElement>('[data-scroll-area="thin"]')!;
    expect(lane).toBeTruthy();
    // Caps as today (max-h-full) + width (max-w-2xl) on the ROOT; the
    // centered stack layout and the old p-2 padding ride the content element
    // (padding scrolls with content, the 8e idiom).
    expect(lane.classList.contains("max-h-full")).toBe(true);
    expect(lane.classList.contains("max-w-2xl")).toBe(true);
    const viewport = lane.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    // The stack only ever scrolled vertically — the lane clips X.
    expect(viewport.style.overflowX).toBe("hidden");
    const content = lane.querySelector<HTMLElement>("[data-scroll-content]")!;
    expect(content.classList.contains("flex-col")).toBe(true);
    expect(content.classList.contains("items-center")).toBe(true);
    expect(content.classList.contains("p-2")).toBe(true);
    // Image, caption and description all live inside the lane.
    expect(lane.querySelector("img[alt='First shot']")).toBeTruthy();
    expect(content.textContent).toContain("A long description of the first shot");
  });

  it("exposes the edit and regenerate actions through named themed hints", async () => {
    const view = render(<GalleryLightbox characterId="char-1" assets={ASSETS} index={0} onIndexChange={() => {}} onClose={() => {}} />);
    const edit = view.getByLabelText("gallery_edit_description");
    fireEvent.focus(edit);
    expect((await view.findByRole("tooltip")).textContent).toContain("gallery_edit_description");
    fireEvent.click(edit);
    expect(view.getByPlaceholderText("gallery_add_description…")).toBeTruthy();
    fireEvent.click(view.getByText("cancel"));
    fireEvent.click(view.getByLabelText("gallery_regenerate"));
    expect(useGalleryStore.getState().describe).toHaveBeenCalledWith("char-1", ["gal-1"]);
  });

  it("keeps keyboard paging and Escape close outside the lane (untouched by CNR-8k)", () => {
    const onIndexChange = mock((_index: number) => {});
    const onClose = mock(() => {});
    render(
      <GalleryLightbox
        characterId="char-1"
        assets={ASSETS}
        index={0}
        onIndexChange={onIndexChange}
        onClose={onClose}
      />,
    );
    // useKeyDown listens on window — arrows page, wrapping around the set.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenCalledWith(1);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onIndexChange).toHaveBeenCalledWith(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onIndexChange).toHaveBeenCalledTimes(2);
  });
});

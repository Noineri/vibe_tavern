/**
 * MediaMenu floating viewers across a character switch (owner fix 2026-10-20).
 *
 * The defect: a floating GalleryViewer opened from character A's media stayed
 * mounted after switching the chat to character B, but its image URL rebuilt
 * from the CURRENT characterId prop — A's asset under B's path (404, broken
 * image). Now open viewers live in the shared floating-gallery store with
 * their own pinned characterId, so the switch neither closes nor re-targets
 * them.
 *
 * The viewer itself is stubbed at the FloatingImageViewer seam (the
 * ImageBlock.test.tsx pattern — deterministic, no zoom/pan machinery); the
 * real GalleryViewer adapter still resolves the src under test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import type { CharacterAsset } from "@vibe-tavern/domain";

useDomEnv();

installI18nContextSeam();

const realGalleryViewer = await import("../build/editors/GalleryViewer.js");
mock.module("../build/editors/GalleryViewer.js", () => ({
  ...realGalleryViewer,
  FloatingImageViewer: ({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) => (
    <div data-testid="floating-viewer" data-src={src} data-alt={alt} onClick={onClose} />
  ),
}));

const realChatStore = await import("../../stores/chat-store.js");
mock.module("../../stores/chat-store.js", () => ({
  ...realChatStore,
  useChatStore: (selector: (state: object) => unknown) =>
    selector({ draftAttachments: [], addDraftAttachment: mock(async () => {}) }),
}));

const realStores = await import("../../stores/index.js");
mock.module("../../stores/index.js", () => ({
  ...realStores,
  useNavigationStore: (selector: (state: object) => unknown) => selector({ setMode: mock(() => {}) }),
}));

let MediaMenu: typeof import("./MediaMenu.js").MediaMenu;
let FloatingGalleryViewers: typeof import("../build/editors/FloatingGalleryViewers.js").FloatingGalleryViewers;
const { render: renderBase } = await import("@testing-library/react");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const render = (ui: import("react").ReactElement) => renderBase(ui, { wrapper: ({ children }) => <TooltipProvider delayDuration={0}>{children}</TooltipProvider> });
let fireEvent: typeof import("@testing-library/react").fireEvent;
let useGalleryStore: typeof import("../../stores/gallery-store.js").useGalleryStore;
let useFloatingGalleryStore: typeof import("../../stores/floating-gallery-store.js").useFloatingGalleryStore;

beforeAll(async () => {
  ({ fireEvent } = await import("@testing-library/react"));
  ({ MediaMenu } = await import("./MediaMenu.js"));
  ({ FloatingGalleryViewers } = await import("../build/editors/FloatingGalleryViewers.js"));
  ({ useGalleryStore } = await import("../../stores/gallery-store.js"));
  ({ useFloatingGalleryStore } = await import("../../stores/floating-gallery-store.js"));
});

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

function seedGallery() {
  useGalleryStore.setState({
    byCharacter: { "char-A": [makeAsset("char-A", "row-a1", "A shot")] },
    loading: {},
    uploading: {},
    describing: {},
    error: {},
    load: mock(async () => {}),
    reload: mock(async () => {}),
  });
}

beforeEach(() => {
  seedGallery();
  useFloatingGalleryStore.setState({ viewers: [] });
});

afterEach(() => {
  useFloatingGalleryStore.setState({ viewers: [] });
});

describe("MediaMenu floating viewer across a character switch", () => {
  it("keeps showing A's image URL after switching the chat to B", () => {
    const view = render(
      <>
        <MediaMenu characterId="char-A" characterName="A" />
        <FloatingGalleryViewers />
      </>,
    );

    // Open the popover and click A's tile → floating viewer appears.
    fireEvent.click(view.getByLabelText("media_button"));
    fireEvent.click(view.getByAltText("A shot"));
    const viewer = view.getByTestId("floating-viewer");
    expect(viewer.getAttribute("data-src")).toContain("characters/char-A/assets/row-a1");

    // Switch the chat to B: the viewer stays open with A's URL, not B's.
    view.rerender(
      <>
        <MediaMenu characterId="char-B" characterName="B" />
        <FloatingGalleryViewers />
      </>,
    );
    const kept = view.getByTestId("floating-viewer");
    expect(kept.getAttribute("data-src")).toContain("characters/char-A/assets/row-a1");
    expect(kept.getAttribute("data-src")).not.toContain("char-B");
    expect(kept.getAttribute("data-alt")).toBe("A shot");
  });

  it("shows the send hint while retaining its accessible name", async () => {
    const view = render(<MediaMenu characterId="char-A" characterName="A" />);
    fireEvent.click(view.getByLabelText("media_button"));
    const send = view.getAllByLabelText("media_send_to_chat")[0]!;
    fireEvent.pointerMove(send, { pointerType: "mouse" });
    expect((await view.findByRole("tooltip")).textContent).toBe("media_send_to_chat");
  });

  it("opening the same image twice keeps one window", () => {
    const view = render(
      <>
        <MediaMenu characterId="char-A" characterName="A" />
        <FloatingGalleryViewers />
      </>,
    );

    fireEvent.click(view.getByLabelText("media_button"));
    fireEvent.click(view.getByAltText("A shot"));
    expect(view.getAllByTestId("floating-viewer").length).toBe(1);

    fireEvent.click(view.getByLabelText("media_button"));
    fireEvent.click(view.getByAltText("A shot"));
    expect(view.getAllByTestId("floating-viewer").length).toBe(1);
  });

  it("rides the thin vertical lane in the desktop popover with the cap on the root (CNR-8k)", () => {
    const view = render(
      <>
        <MediaMenu characterId="char-A" characterName="A" />
        <FloatingGalleryViewers />
      </>,
    );

    fireEvent.click(view.getByLabelText("media_button"));
    // The popover portals into document.body (no modal-portal anchor here).
    const lane = document.querySelector<HTMLElement>('[data-scroll-area="thin"]')!;
    expect(lane).toBeTruthy();
    // 8d popup-caps idiom: the 240px cap and 360px width sit on the ROOT,
    // the grid layout on the content element.
    expect(lane.classList.contains("max-h-[240px]")).toBe(true);
    expect(lane.classList.contains("w-[360px]")).toBe(true);
    const viewport = lane.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    expect(viewport.style.overflowX).toBe("hidden");
    const content = lane.querySelector<HTMLElement>("[data-scroll-content]")!;
    expect(content.classList.contains("grid-cols-3")).toBe(true);
    expect(content.querySelector("img[alt='A shot']")).toBeTruthy();
    // The tile click still opens the floating viewer through the lane.
    fireEvent.click(view.getByAltText("A shot"));
    expect(view.getByTestId("floating-viewer").getAttribute("data-src"))
      .toContain("characters/char-A/assets/row-a1");
  });
});

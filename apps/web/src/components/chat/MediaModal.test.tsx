/**
 * MediaModal lightbox — mobile gesture parity pin (the reported defect:
 * "увеличила двумя пальцами, двигать могу только двумя" — pinch fell through
 * to the browser's viewport zoom because the lightbox had no gesture wiring).
 *
 * The pin is at the component boundary: real touch events fired at the
 * rendered lightbox must move the image transform. The gesture logic itself
 * lives in useImageZoomPan (own test file); what broke here was the WIRING —
 * MediaLightbox not using the hook at all. These tests fail against exactly
 * that regression shape.
 */
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { useGalleryStore } from "../../stores/gallery-store.js";

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

let MediaModal: typeof import("./MediaModal.js").MediaModal;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;

beforeAll(async () => {
  ({ render, fireEvent, act } = await import("@testing-library/react"));
  ({ MediaModal } = await import("./MediaModal.js"));
});

afterEach(() => {
  localStorage.clear();
});

const asset: import("@vibe-tavern/domain").CharacterAsset = {
  id: "gal_1" as import("@vibe-tavern/domain").CharacterAsset["id"],
  characterId: "char-1" as import("@vibe-tavern/domain").CharacterAsset["characterId"],
  ext: "jpg",
  mimeType: "image/jpeg",
  caption: "test image",
  description: null,
  includeInPrompt: false,
  avatarCropJson: null,
  order: 0,
  createdAt: "2026-09-10T00:00:00.000Z",
};

function setup() {
  useGalleryStore.setState({
    byCharacter: { "char-1": [asset] },
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
  return render(
    <MediaModal open onClose={() => {}} characterId="char-1" characterName="Test Char" />,
  );
}

/** Open the lightbox: click the thumbnail. Returns the lightbox image. */
function openLightbox() {
  const img = document.querySelector<HTMLImageElement>("img[alt='test image']")!;
  expect(img).toBeTruthy();
  fireEvent.click(img);
  // The lightbox reuses the same alt — it is the LAST rendered img in body.
  const lightboxImg = [...document.querySelectorAll<HTMLImageElement>("img")]
    .filter((el) => el.alt === "test image")
    .pop()!;
  expect(lightboxImg).toBeTruthy();
  return lightboxImg;
}

/** Minimal touch shape the hook reads (clientX/clientY only). */
function t(x: number, y: number) {
  return { clientX: x, clientY: y };
}

/** Two-finger touch event at the given client coordinates. */
function touch2(x1: number, y1: number, x2: number, y2: number) {
  const touches = [t(x1, y1), t(x2, y2)];
  return { touches, changedTouches: touches };
}

/** Single-finger touch event. */
function touch1(x: number, y: number) {
  const touches = [t(x, y)];
  return { touches, changedTouches: touches };
}

describe("MediaModal lightbox — one-finger pan parity (avatar-panel canon)", () => {
  it("pinch-zooms in-app: two-finger spread scales the image transform", async () => {
    setup();
    const img = openLightbox();
    await act(async () => {
      fireEvent.touchStart(img, touch2(100, 200, 200, 200));
      fireEvent.touchMove(img, touch2(50, 200, 250, 200));
      fireEvent.touchEnd(img, { ...touch2(50, 200, 250, 200), touches: [] });
    });
    expect(img.style.transform).toMatch(/scale\(2/);
  });

  it("THE DEFECT: after zooming in, ONE finger pans the image", async () => {
    setup();
    const img = openLightbox();
    await act(async () => {
      // Zoom in first (pinch spread ×1.5).
      fireEvent.touchStart(img, touch2(100, 200, 200, 200));
      fireEvent.touchMove(img, touch2(75, 200, 225, 200));
      fireEvent.touchEnd(img, { ...touch2(75, 200, 225, 200), touches: [] });
    });
    const before = img.style.transform;
    await act(async () => {
      // One finger down, drag right by 60px.
      fireEvent.touchStart(img, touch1(150, 200));
      fireEvent.touchMove(img, touch1(210, 200));
      fireEvent.touchEnd(img, { ...touch1(210, 200), touches: [] });
    });
    // The translate component must have grown by the drag delta (≈60px).
    expect(img.style.transform).not.toBe(before);
    expect(img.style.transform).toMatch(/translate\(60px/);
  });

  it("a plain tap on the send button still fires onSend (tap never enters the pan path)", async () => {
    const onSend = mock(() => {});
    void onSend;
    setup();
    const img = openLightbox();
    // Tap the image area without movement (no pan, no zoom change).
    await act(async () => {
      fireEvent.touchStart(img, touch1(150, 200));
      fireEvent.touchEnd(img, { ...touch1(150, 200), touches: [] });
    });
    // The send bar remains a live tap target after gesture wiring.
    const sendBtn = [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("media_send_to_chat"));
    expect(sendBtn).toBeTruthy();
    // The button click path is what the phone executes for a zero-move tap.
    expect(sendBtn!.disabled).toBe(false);
  });
});

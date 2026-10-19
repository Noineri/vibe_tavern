/**
 * Floating gallery viewers — the one shared home for open GalleryViewer
 * windows (owner fix 2026-10-20).
 *
 * Pins the outcome: each open viewer remembers its own characterId + asset,
 * opening the same image twice keeps one window, and a viewer whose image is
 * deleted closes — while a viewer whose character list is merely absent
 * (never loaded / dropped via reset) stays open across a character switch.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CharacterAsset } from "@vibe-tavern/domain";

// ─── Mocked gallery-api (the ...real spread keeps every other export live) ─

const deleteCharacterAsset = mock((_cid: string, _rowId: string) => Promise.resolve());
const realGalleryApi = await import("../api/gallery-api.js");
mock.module("../api/gallery-api.js", () => ({ ...realGalleryApi, deleteCharacterAsset }));

const toastError = mock((_msg: string) => {});
const realSonner = await import("sonner");
mock.module("sonner", () => ({ ...realSonner, toast: { ...realSonner.toast, error: toastError } }));

const { useGalleryStore } = await import("./gallery-store.js");
const { useFloatingGalleryStore } = await import("./floating-gallery-store.js");

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeAsset(characterId: string, id: string, caption = ""): CharacterAsset {
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

function resetStores() {
  useGalleryStore.setState({ byCharacter: {}, loading: {}, uploading: {}, describing: {}, error: {} });
  useFloatingGalleryStore.setState({ viewers: [] });
}

beforeEach(() => {
  resetStores();
  deleteCharacterAsset.mockReset();
  deleteCharacterAsset.mockImplementation(() => Promise.resolve());
  toastError.mockReset();
});

describe("floating gallery viewers", () => {
  test("open pins its own characterId + asset", () => {
    const asset = makeAsset("char-A", "row-a1", "A one");
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", asset);

    const viewers = useFloatingGalleryStore.getState().viewers;
    expect(viewers.length).toBe(1);
    expect(viewers[0]?.characterId).toBe("char-A");
    expect(viewers[0]?.asset).toBe(asset);
  });

  test("opening the same image twice keeps one window", () => {
    const asset = makeAsset("char-A", "row-a1");
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", asset);
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", asset);

    expect(useFloatingGalleryStore.getState().viewers.length).toBe(1);
  });

  test("viewers from two characters coexist", () => {
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", makeAsset("char-A", "row-a1"));
    useFloatingGalleryStore.getState().openGalleryViewer("char-B", makeAsset("char-B", "row-b1"));

    const viewers = useFloatingGalleryStore.getState().viewers;
    expect(viewers.length).toBe(2);
    expect(viewers.map((v) => v.characterId)).toEqual(["char-A", "char-B"]);
  });

  test("close removes only that window", () => {
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", makeAsset("char-A", "row-a1"));
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", makeAsset("char-A", "row-a2"));

    useFloatingGalleryStore.getState().closeGalleryViewer("char-A", "row-a1");

    const viewers = useFloatingGalleryStore.getState().viewers;
    expect(viewers.length).toBe(1);
    expect(viewers[0]?.asset.id as string).toBe("row-a2");
  });

  test("deleting the image closes its viewer (real remove() path)", async () => {
    const asset = makeAsset("char-A", "row-a1");
    useGalleryStore.setState({
      byCharacter: { "char-A": [asset, makeAsset("char-A", "row-a2")] },
      loading: {},
      uploading: {},
      describing: {},
      error: {},
    });
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", asset);

    await useGalleryStore.getState().remove("char-A", "row-a1");

    expect(deleteCharacterAsset).toHaveBeenCalledWith("char-A", "row-a1");
    expect(useGalleryStore.getState().byCharacter["char-A"]?.length).toBe(1);
    expect(useFloatingGalleryStore.getState().viewers.length).toBe(0);
  });

  test("a server-side removal surfacing through setState closes the viewer", () => {
    const asset = makeAsset("char-A", "row-a1");
    useGalleryStore.setState({
      byCharacter: { "char-A": [asset] },
      loading: {},
      uploading: {},
      describing: {},
      error: {},
    });
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", asset);

    // The reloaded list no longer contains the row — nothing to show.
    useGalleryStore.setState({ byCharacter: { "char-A": [] } });

    expect(useFloatingGalleryStore.getState().viewers.length).toBe(0);
  });

  test("an absent list keeps the viewer — the character-switch case", () => {
    const asset = makeAsset("char-A", "row-a1");
    useGalleryStore.setState({
      byCharacter: { "char-A": [asset] },
      loading: {},
      uploading: {},
      describing: {},
      error: {},
    });
    useFloatingGalleryStore.getState().openGalleryViewer("char-A", asset);

    // Switching to a character whose gallery was never loaded (or was reset)
    // leaves char-A's entry alone — the viewer stays open.
    useGalleryStore.getState().reset("char-B");
    expect(useFloatingGalleryStore.getState().viewers.length).toBe(1);
    useGalleryStore.setState({ byCharacter: {} });
    expect(useFloatingGalleryStore.getState().viewers.length).toBe(1);
  });
});

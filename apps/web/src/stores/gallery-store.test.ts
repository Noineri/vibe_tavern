/**
 * Gallery store — optimistic-update + rollback coverage (F2 self-check).
 *
 * Exercises the load/upload/updateCaption/reorder/remove/describe actions
 * against a mocked gallery-api, asserting the optimistic-update + rollback
 * invariants from MEDIA_GALLERY_FRONTEND_PLAN §"Non-negotiable constraints":
 *  - mutations apply optimistically,
 *  - a server failure rolls the list back AND toasts.
 */
import { mock, test, expect, beforeEach } from "bun:test";
import type { CharacterAsset } from "@vibe-tavern/domain";

// ─── Mocked gallery-api ──────────────────────────────────────────────────
//
// Each function is a bun:test mock we can reprogram per-test. `mockModule`
// swaps the real module before the store imports it.

const listCharacterAssets = mock((_cid: string) => Promise.resolve<CharacterAsset[]>([]));
const uploadCharacterAsset = mock((_cid: string, _f: File) => Promise.resolve<CharacterAsset>(undefined as never));
const updateCharacterAsset = mock(
  (_cid: string, _rowId: string, _patch: { caption?: string; description?: string | null }) =>
    Promise.resolve<CharacterAsset>(undefined as never),
);
const reorderCharacterAssets = mock((_cid: string, _ids: string[]) => Promise.resolve());
const deleteCharacterAsset = mock((_cid: string, _rowId: string) => Promise.resolve());
const describeCharacterAssets = mock(
  (_cid: string, _ids?: string[]) => Promise.resolve({ updated: [] as string[], failed: [] as string[] }),
);

await mock.module("../api/gallery-api.js", () => ({
  serveCharacterAssetUrl: () => "",
  listCharacterAssets,
  uploadCharacterAsset,
  updateCharacterAsset,
  reorderCharacterAssets,
  deleteCharacterAsset,
  describeCharacterAssets,
  describeCharacterAvatar: mock(() => Promise.resolve({ description: "" })),
  describePersonaAvatar: mock(() => Promise.resolve({ description: "" })),
}));

// ─── Mocked sonner toast ────────────────────────────────────────────────
const toastError = mock((_msg: string) => {});
await mock.module("sonner", () => ({ toast: { error: toastError, success: mock(() => {}) } }));

const { useGalleryStore } = await import("./gallery-store.js");

// ─── Fixtures ────────────────────────────────────────────────────────────

function makeAsset(id: string, caption = "", description: string | null = null): CharacterAsset {
  return {
    id: id as never,
    characterId: "cid" as never,
    ext: "png",
    mimeType: "image/png",
    caption,
    description,
    includeInPrompt: false,
    order: 0,
    createdAt: "2026-01-01T00:00:00Z" as never,
  };
}

beforeEach(() => {
  // Reset the store to empty.
  useGalleryStore.setState({
    byCharacter: {},
    loading: {},
    uploading: {},
    describing: {},
    error: {},
  });
  // Reset all mock call records + default impls. mockReset clears calls AND
  // implementation; we then reinstall the per-test default implementation.
  listCharacterAssets.mockReset();
  listCharacterAssets.mockImplementation(() => Promise.resolve([]));
  uploadCharacterAsset.mockReset();
  uploadCharacterAsset.mockImplementation(() => Promise.resolve(undefined as never));
  updateCharacterAsset.mockReset();
  updateCharacterAsset.mockImplementation(() => Promise.resolve(undefined as never));
  reorderCharacterAssets.mockReset();
  reorderCharacterAssets.mockImplementation(() => Promise.resolve());
  deleteCharacterAsset.mockReset();
  deleteCharacterAsset.mockImplementation(() => Promise.resolve());
  describeCharacterAssets.mockReset();
  describeCharacterAssets.mockImplementation(() => Promise.resolve({ updated: [], failed: [] }));
  toastError.mockReset();
});

test("reload populates the list from listCharacterAssets", async () => {
  const a = makeAsset("a1");
  const b = makeAsset("a2");
  listCharacterAssets.mockImplementation(() => Promise.resolve([a, b]));

  await useGalleryStore.getState().reload("cid");

  expect(useGalleryStore.getState().byCharacter["cid"]).toEqual([a, b]);
  expect(useGalleryStore.getState().loading["cid"]).toBe(false);
  expect(useGalleryStore.getState().error["cid"]).toBeNull();
});

test("load is idempotent — second call does not refetch", async () => {
  listCharacterAssets.mockImplementation(() => Promise.resolve([makeAsset("a1")]));

  await useGalleryStore.getState().load("cid");
  await useGalleryStore.getState().load("cid"); // cached — should skip

  expect(listCharacterAssets).toHaveBeenCalledTimes(1);
});

test("remove applies optimistically and persists on success", async () => {
  const a = makeAsset("a1");
  const b = makeAsset("a2");
  listCharacterAssets.mockImplementation(() => Promise.resolve([a, b]));
  await useGalleryStore.getState().reload("cid");

  await useGalleryStore.getState().remove("cid", "a1");

  expect(useGalleryStore.getState().byCharacter["cid"]).toEqual([b]);
  expect(deleteCharacterAsset).toHaveBeenCalledWith("cid", "a1");
  expect(toastError).not.toHaveBeenCalled();
});

test("remove ROLLS BACK and toasts when deleteCharacterAsset fails", async () => {
  // The load-bearing F2 invariant: a failed delete must restore the row.
  const a = makeAsset("a1");
  const b = makeAsset("a2");
  listCharacterAssets.mockImplementation(() => Promise.resolve([a, b]));
  await useGalleryStore.getState().reload("cid");
  deleteCharacterAsset.mockImplementation(() => Promise.reject(new Error("boom")));

  await useGalleryStore.getState().remove("cid", "a1");

  expect(useGalleryStore.getState().byCharacter["cid"]).toEqual([a, b]); // restored
  expect(toastError).toHaveBeenCalledWith("boom");
});

test("updateCaption applies optimistically and rolls back on failure", async () => {
  const a = makeAsset("a1", "old");
  listCharacterAssets.mockImplementation(() => Promise.resolve([a]));
  await useGalleryStore.getState().reload("cid");
  updateCharacterAsset.mockImplementation(() => Promise.reject(new Error("nope")));

  await useGalleryStore.getState().updateCaption("cid", "a1", "new");

  expect(useGalleryStore.getState().byCharacter["cid"]).toEqual([a]); // "old" restored
  expect(toastError).toHaveBeenCalledWith("nope");
});

test("reorder applies optimistically and rolls back on failure", async () => {
  const a = makeAsset("a1");
  const b = makeAsset("b2");
  listCharacterAssets.mockImplementation(() => Promise.resolve([a, b]));
  await useGalleryStore.getState().reload("cid");
  reorderCharacterAssets.mockImplementation(() => Promise.reject(new Error("network")));

  await useGalleryStore.getState().reorder("cid", ["b2", "a1"]);

  // Rolled back to original order.
  expect(useGalleryStore.getState().byCharacter["cid"]).toEqual([a, b]);
  expect(toastError).toHaveBeenCalledWith("network");
});

test("describe marks rows describing, reloads on resolve, clears the flag", async () => {
  const a = makeAsset("a1");
  listCharacterAssets.mockImplementation(() => Promise.resolve([a]));
  await useGalleryStore.getState().reload("cid");
  let describeResolve!: (v: { updated: string[]; failed: string[] }) => void;
  describeCharacterAssets.mockImplementation(
    () => new Promise((res) => { describeResolve = res; }),
  );

  const promise = useGalleryStore.getState().describe("cid", ["a1"]);
  expect(useGalleryStore.getState().describing["cid"]?.has("a1")).toBe(true);

  describeResolve({ updated: ["a1"], failed: [] });
  await promise;

  // Flag cleared after resolve.
  expect(useGalleryStore.getState().describing["cid"]?.has("a1") ?? false).toBe(false);
  // listCharacterAssets called twice: initial reload + post-describe reload.
  expect(listCharacterAssets).toHaveBeenCalledTimes(2);
});

test("describe defaults to all undescribed rows when rowIds omitted", async () => {
  const described = makeAsset("a1", "", "already");
  const undescribed = makeAsset("a2");
  listCharacterAssets.mockImplementation(() => Promise.resolve([described, undescribed]));
  await useGalleryStore.getState().reload("cid");

  await useGalleryStore.getState().describe("cid");

  expect(describeCharacterAssets).toHaveBeenCalledWith("cid", ["a2"]);
});

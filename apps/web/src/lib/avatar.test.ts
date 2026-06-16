import { describe, expect, test } from "bun:test";
import { resolveEntityAvatarUrl } from "./avatar.js";

/**
 * Characterization test for the thumbnail/full avatar resolver.
 *
 * Storage model (folder-resident):
 *  - {id}/avatar.{ext}      → thumbnail/crop (small slots)
 *  - {id}/avatar-full.{ext} → uncropped original (large slots)
 *
 * Legacy model (flat assets):
 *  - avatarAssetId      → crop
 *  - avatarFullAssetId  → uncropped original
 *
 * The contract:
 *  - Folder-resident (avatarExt set) + preferFull  → /avatar/full
 *  - Folder-resident (avatarExt set) + !preferFull → /avatar
 *  - Legacy + preferFull  → avatarFullAssetId ?? avatarAssetId
 *  - Legacy + !preferFull → avatarAssetId
 *  - No avatar at all → null
 *
 * In Bun's test env there is no window, so getGatewayBaseUrl() returns the
 * SSR fallback "http://127.0.0.1:8787" — assertions use that base.
 */
const BASE = "http://127.0.0.1:8787";

describe("resolveEntityAvatarUrl", () => {
  test("folder-resident: preferFull → /avatar/full endpoint", () => {
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: "webp",
      avatarAssetId: null,
      avatarFullExt: "png",
      avatarFullAssetId: null,
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar/full`);
  });

  test("folder-resident: !preferFull → /avatar thumbnail endpoint", () => {
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: "webp",
      avatarAssetId: null,
      preferFull: false,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar`);
  });

  test("folder-resident: default (no preferFull) → thumbnail endpoint", () => {
    const url = resolveEntityAvatarUrl({
      kind: "personas",
      id: "pers-1",
      avatarExt: "jpg",
      avatarAssetId: null,
    });
    expect(url).toBe(`${BASE}/api/personas/pers-1/avatar`);
  });

  test("folder-resident: preferFull uses /avatar/full even when avatarFullExt is null (server-side fallback)", () => {
    // Upload-without-crop case: only avatar.{ext} exists. The /avatar/full
    // endpoint must still be requested so the server can fall back to the
    // thumbnail — this is what makes single-image uploads work for large slots.
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: "webp",
      avatarAssetId: null,
      avatarFullExt: null,
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar/full`);
  });

  test("folder-resident ignores legacy asset ids (folder wins)", () => {
    // Once migrated to the folder model, legacy columns are not consulted.
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: "webp",
      avatarAssetId: "legacy-asset-1",
      avatarFullAssetId: "legacy-full-1",
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar/full`);
  });

  test("legacy flat: preferFull → avatarFullAssetId", () => {
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: null,
      avatarAssetId: "crop-asset",
      avatarFullAssetId: "full-asset",
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/assets/full-asset`);
  });

  test("legacy flat: !preferFull → avatarAssetId", () => {
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: null,
      avatarAssetId: "crop-asset",
      avatarFullAssetId: "full-asset",
      preferFull: false,
    });
    expect(url).toBe(`${BASE}/api/assets/crop-asset`);
  });

  test("legacy flat: preferFull with no full asset → falls back to crop asset", () => {
    // Character never had a separate full; preferFull still yields something
    // viewable rather than null.
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: null,
      avatarAssetId: "crop-asset",
      avatarFullAssetId: null,
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/assets/crop-asset`);
  });

  test("no avatar at all → null", () => {
    expect(
      resolveEntityAvatarUrl({
        kind: "characters",
        id: "char-1",
        avatarExt: null,
        avatarAssetId: null,
        preferFull: true,
      }),
    ).toBeNull();
  });

  test("legacy flat with neither asset id → null even with preferFull", () => {
    expect(
      resolveEntityAvatarUrl({
        kind: "personas",
        id: "pers-1",
        avatarExt: null,
        avatarAssetId: null,
        avatarFullAssetId: null,
        preferFull: true,
      }),
    ).toBeNull();
  });
});

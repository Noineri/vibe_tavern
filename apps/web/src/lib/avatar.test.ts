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
  test("folder-resident: preferFull → /avatar/full endpoint with ?v= cache-bust", () => {
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: "webp",
      avatarAssetId: null,
      avatarFullExt: "png",
      avatarFullAssetId: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar/full?v=1704067200000`);
  });

  test("folder-resident: !preferFull → /avatar thumbnail endpoint with ?v= cache-bust", () => {
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: "webp",
      avatarAssetId: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
      preferFull: false,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar?v=1704067200000`);
  });

  test("folder-resident: default (no preferFull) → thumbnail endpoint with ?v=", () => {
    const url = resolveEntityAvatarUrl({
      kind: "personas",
      id: "pers-1",
      avatarExt: "jpg",
      avatarAssetId: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(url).toBe(`${BASE}/api/personas/pers-1/avatar?v=1704067200000`);
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
      updatedAt: "2024-01-01T00:00:00.000Z",
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar/full?v=1704067200000`);
  });

  test("folder-resident ignores legacy asset ids (folder wins)", () => {
    // Once migrated to the folder model, legacy columns are not consulted.
    const url = resolveEntityAvatarUrl({
      kind: "characters",
      id: "char-1",
      avatarExt: "webp",
      avatarAssetId: "legacy-asset-1",
      avatarFullAssetId: "legacy-full-1",
      updatedAt: "2024-01-01T00:00:00.000Z",
      preferFull: true,
    });
    expect(url).toBe(`${BASE}/api/characters/char-1/avatar/full?v=1704067200000`);
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

  // ── Bug #2 regression: cache-bust must change when updatedAt changes ──
  // The avatar serve path uses Cache-Control: public, max-age=31536000 (1yr,
  // immutable). The ONLY thing that busts it is the ?v={ms} suffix derived
  // from updatedAt. If updatedAt is missing (a DTO regression), the suffix
  // collapses to "" and the browser pins the stale image for a year — this is
  // exactly the original Bug #2 (avatar doesn't update on swap / direct upload,
  // survives reload + server restart because the cache lives in the browser).
  describe("Bug #2 cache-bust (updatedAt → ?v=)", () => {
    test("a bumped updatedAt produces a different ?v= on the SAME path", () => {
      // Two uploads with the same extension yield the same path; only ?v=
      // differs. This is the invariant that makes re-uploads visible.
      const before = resolveEntityAvatarUrl({
        kind: "characters",
        id: "char-1",
        avatarExt: "png",
        avatarAssetId: null,
        updatedAt: "2024-01-01T00:00:00.000Z",
        preferFull: true,
      });
      const after = resolveEntityAvatarUrl({
        kind: "characters",
        id: "char-1",
        avatarExt: "png",
        avatarAssetId: null,
        updatedAt: "2024-06-01T00:00:00.000Z",
        preferFull: true,
      });
      expect(before).toBe(`${BASE}/api/characters/char-1/avatar/full?v=1704067200000`);
      expect(after).toBe(`${BASE}/api/characters/char-1/avatar/full?v=1717200000000`);
      expect(before).not.toBe(after);
    });

    test("full and thumbnail share the same ?v= for one updatedAt (consistent bust)", () => {
      // Both leaves are written together on upload, so both bust together.
      const full = resolveEntityAvatarUrl({
        kind: "characters",
        id: "char-1",
        avatarExt: "png",
        avatarAssetId: null,
        updatedAt: "2024-01-01T00:00:00.000Z",
        preferFull: true,
      });
      const thumb = resolveEntityAvatarUrl({
        kind: "characters",
        id: "char-1",
        avatarExt: "png",
        avatarAssetId: null,
        updatedAt: "2024-01-01T00:00:00.000Z",
        preferFull: false,
      });
      expect(full).toContain("?v=1704067200000");
      expect(thumb).toContain("?v=1704067200000");
    });

    test("missing updatedAt still yields a non-empty ?v= (defense in depth, no infinite cache)", () => {
      // If a future DTO drops updatedAt, the URL must NOT collapse to a
      // cache-bust-less path (that would re-introduce Bug #2). Fall back to
      // Date.now() so the avatar at least updates, rather than being pinned.
      const url = resolveEntityAvatarUrl({
        kind: "characters",
        id: "char-1",
        avatarExt: "png",
        avatarAssetId: null,
        updatedAt: undefined,
        preferFull: true,
      })!;
      expect(url).toMatch(/\/avatar\/full\?v=\d+$/);
      expect(url).not.toEndWith("/avatar/full");
    });

    test("invalid updatedAt string falls back like missing", () => {
      const url = resolveEntityAvatarUrl({
        kind: "characters",
        id: "char-1",
        avatarExt: "png",
        avatarAssetId: null,
        updatedAt: "not-a-date",
        preferFull: false,
      })!;
      expect(url).toMatch(/\/avatar\?v=\d+$/);
    });
  });
});

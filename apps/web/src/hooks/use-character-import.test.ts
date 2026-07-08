/**
 * Characterization test for the PNG-import avatar path (AIF-1, C2 finisher).
 *
 * Pins the folder-resident avatar route and guards against regression to the
 * legacy two-step `uploadAsset` + `updateCharacterAvatar` PATCH. The hook is a
 * glue-only orchestrator (no branching around which avatar fn is called), so
 * the load-bearing assertions are: on a PNG import, `uploadCharacterAvatar` is
 * issued (folder route) and the legacy `uploadAsset` / `updateCharacterAvatar`
 * are NOT. The three network modules are mocked at the module boundary
 * (`mock.module`, gallery-store.test.ts idiom) so the Hono RPC client never
 * runs against a fake fetch; the real `png-reader` runs against a synthesized
 * minimal PNG carrying a base64 `chara` tEXt chunk.
 *
 * CRITICAL regression guard: the returned snapshot's `character.avatarExt`
 * MUST be set. The caller (handleImportFiles) writes this snapshot into the
 * active snapshot store via writeSnapshot, which is what the top bar, chat,
 * and character editor read for the avatar. An earlier draft spliced the
 * extensions only into the bootstrap refresh (allCharacters → sidebar) and
 * forgot the active snapshot, so those slots rendered the fallback initial
 * until the next full fetch.
 *
 * See AGENTS.md §1 (write a characterization test before changing behavior)
 * and the `mock.module` cross-file-leak gotcha (reals are captured and spread
 * first, only the specific fns are overridden).
 */
import { test, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";


// ─── Mock fns (captured real modules are spread in to avoid cross-file leak) ─

// vi.hoisted: vi.mock (below) is hoisted above these consts, so the factory
// would close over uninitialized bindings. Hoisting the fns alongside the mock
// keeps the vi.mock factory and all test-body assertions unchanged.
const {
  uploadCharacterAvatar,
  uploadAsset,
  updateCharacterAvatar,
  fetchBootstrapAction,
  importCharacterAction,
} = vi.hoisted(() => ({
  uploadCharacterAvatar: vi.fn((_id: string, _file: File, _full?: File) =>
    Promise.resolve({ avatarExt: ".png", avatarFullExt: ".png" })),
  // Legacy fns that must NEVER be called by the migrated hook.
  uploadAsset: vi.fn((_f: File) => Promise.resolve({ assetId: "asset-legacy" })),
  updateCharacterAvatar: vi.fn((_cid: string, _chatId: unknown, _aid: string) =>
    Promise.resolve({} as never)),
  fetchBootstrapAction: vi.fn((_opts?: { silent?: boolean; skipSnapshotSync?: boolean }) =>
    Promise.resolve()),
  importCharacterAction: vi.fn((_input: { fileName: string; jsonText: string }) =>
    Promise.resolve({
      activeChatId: "chat-1",
      snapshot: { character: { id: "char-imported", name: "Test", avatarExt: null } },
      imported: { kind: "character", name: "Test", fileName: "card.png", warningCount: 0, warnings: [] },
    } as never)),
}));

// vitest: vi.mock is hoisted above top-level `await import`, so capturing real
// modules up top would resolve to the MOCKED module. Each factory reads the
// real module via `importOriginal` instead. (The `await` on vi.mock was a
// bun:test-ism; vitest hoists vi.mock regardless and returns synchronously.)
vi.mock("../app-client.js", async (importOriginal) => {
  const realAppClient = await importOriginal() as typeof import("../app-client.js");
  return {
    ...realAppClient,
    uploadCharacterAvatar,
    uploadAsset,
    updateCharacterAvatar,
  };
});
vi.mock("../stores/api-actions/character-actions.js", async (importOriginal) => {
  const realCharacterActions = await importOriginal() as typeof import("../stores/api-actions/character-actions.js");
  return {
    ...realCharacterActions,
    importCharacterAction,
  };
});
vi.mock("../stores/api-actions/bootstrap-actions.js", async (importOriginal) => {
  const realBootstrapActions = await importOriginal() as typeof import("../stores/api-actions/bootstrap-actions.js");
  return {
    ...realBootstrapActions,
    fetchBootstrapAction,
  };
});

const { useCharacterImport } = await import("./use-character-import.js");

// ─── Synthesized PNG with a base64 `chara` tEXt chunk ───────────────────────
//
// extractPngMetadata is a pure chunk-walker: it checks only the 8-byte PNG
// signature, walks chunks by length, and does NOT validate CRC or decode
// IDAT. So a minimal PNG = signature + dummy IHDR + our tEXt chunk + IEND.

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 4 + data.length + 4); // len + type + data + crc
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  // CRC left zero — the walker never validates it.
  return out;
}

function makeCharaPng(): File {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
  const charaText = new TextEncoder().encode("chara\0" + btoa(JSON.stringify({ name: "Test", description: "" })));
  const text = pngChunk("tEXt", charaText);
  const iend = pngChunk("IEND", new Uint8Array(0));
  const total = sig.length + ihdr.length + text.length + iend.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of [sig, ihdr, text, iend]) {
    out.set(part, o);
    o += part.length;
  }
  return new File([out], "card.png", { type: "image/png" });
}

beforeEach(() => {
  uploadCharacterAvatar.mockClear();
  uploadAsset.mockClear();
  updateCharacterAvatar.mockClear();
  fetchBootstrapAction.mockClear();
  importCharacterAction.mockClear();
});

test("PNG import uploads via the folder route and skips legacy asset+PATCH", async () => {
  const { result } = renderHook(() => useCharacterImport());
  const file = makeCharaPng();

  let imported: { snapshot?: { character?: { avatarExt?: string | null } } } | undefined;
  await act(async () => {
    imported = await result.current.importFile(file);
  });

  // Folder route fired with the created character id + the PNG as BOTH crop
  // and full (ST cards are uncropped, so the same bytes feed avatar.png and
  // avatar-full.png — wires the imported card into the crop-confirm flow).
  expect(uploadCharacterAvatar).toHaveBeenCalledTimes(1);
  expect(uploadCharacterAvatar.mock.calls[0][0]).toBe("char-imported");
  expect(uploadCharacterAvatar.mock.calls[0][1]).toBe(file);
  expect(uploadCharacterAvatar.mock.calls[0][2]).toBe(file);

  // Legacy path must NOT have been touched.
  expect(uploadAsset).not.toHaveBeenCalled();
  expect(updateCharacterAvatar).not.toHaveBeenCalled();

  // Character created + a silent skip-sync bootstrap refresh.
  expect(importCharacterAction).toHaveBeenCalledTimes(1);
  expect(importCharacterAction.mock.calls[0][0].fileName).toBe("card.png");
  expect(fetchBootstrapAction).toHaveBeenCalledTimes(1);
  expect(fetchBootstrapAction.mock.calls[0][0]).toEqual({ silent: true, skipSnapshotSync: true });

  // REGRESSION GUARD: the returned snapshot's character carries avatarExt so
  // the caller's writeSnapshot lands the avatar in the active snapshot store
  // (top bar / chat / editor). importCharacterAction's fixture returned
  // avatarExt:null; the hook MUST overwrite it with the folder route's value.
  expect(imported?.snapshot?.character?.avatarExt).toBe(".png");
});

test("non-PNG (jsonl) import does not trigger any avatar upload", async () => {
  const { result } = renderHook(() => useCharacterImport());
  const file = new File(['{"lines":[]}'], "chat.jsonl", { type: "application/jsonl" });

  await act(async () => {
    await result.current.importFile(file);
  });

  expect(importCharacterAction).toHaveBeenCalledTimes(1);
  expect(uploadCharacterAvatar).not.toHaveBeenCalled();
  expect(uploadAsset).not.toHaveBeenCalled();
  expect(updateCharacterAvatar).not.toHaveBeenCalled();
  // No avatar upload means no avatar-driven bootstrap refresh.
  expect(fetchBootstrapAction).not.toHaveBeenCalled();
});

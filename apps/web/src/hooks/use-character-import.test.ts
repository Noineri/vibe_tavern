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
import { test, expect, beforeEach, mock } from "bun:test";

import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const { renderHook, act } = await import("@testing-library/react");


// ─── Mock fns (captured real modules are spread in to avoid cross-file leak) ─

const uploadCharacterAvatar = mock((_id: string, _file: File, _full?: File) =>
	Promise.resolve({ avatarExt: ".png", avatarFullExt: ".png" }));
const uploadAsset = mock((_f: File) => Promise.resolve({ assetId: "asset-legacy" }));
const fetchBootstrapAction = mock((_opts?: { silent?: boolean; skipSnapshotSync?: boolean }) =>
	Promise.resolve());
const importCharacterAction = mock((_input: { fileName: string; jsonText?: string; importEmbeddedBook?: boolean; enableImportedRegexProfile?: boolean }) =>
	Promise.resolve({
		activeChatId: "chat-1",
		snapshot: { character: { id: "char-imported", name: "Test", avatarExt: null } },
		imported: { kind: "character", name: "Test", fileName: "card.png", warningCount: 0, warnings: [] },
	} as never));

// ─── Wire capture for the import-api transports (importJson / importJsonBatch) ─
// import-api passes its input straight into `{ json: input }`, so capturing
// the Hono `$post` arg pins the EXACT wire body per transport. The client mock
// is registered BEFORE any transitive import-api load so the api module binds
// to the fake (mock.module does not rewire already-loaded live bindings).
const importJsonPost = mock((..._args: unknown[]) =>
	Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ activeChatId: "chat-1" }), text: () => Promise.resolve("") }));
const importBatchPost = mock((..._args: unknown[]) =>
	Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }), text: () => Promise.resolve("") }));

const realClientModule = await import("../api/client.js");
const fakeImportClient = {
	api: { import: { json: { $post: importJsonPost }, batch: { $post: importBatchPost } } },
} as unknown as typeof realClientModule.client;
mock.module("../api/client.js", () => ({ ...realClientModule, client: fakeImportClient }));

const realCharacterApi = await import("../api/character-api.js");
const realAssetApi = await import("../api/asset-api.js");
const realCharacterActions = await import("../stores/api-actions/character-actions.js");
const realBootstrapActions = await import("../stores/api-actions/bootstrap-actions.js");
mock.module("../api/character-api.js", () => ({ ...realCharacterApi, uploadCharacterAvatar }));
mock.module("../api/asset-api.js", () => ({ ...realAssetApi, uploadAsset }));
mock.module("../stores/api-actions/character-actions.js", () => {
	return {
		...realCharacterActions,
		importCharacterAction,
	};
});
mock.module("../stores/api-actions/bootstrap-actions.js", () => {
	return {
		...realBootstrapActions,
    fetchBootstrapAction,
  };
});

const { useCharacterImport } = await import("./use-character-import.js");
const { importJson, importJsonBatch } = await import("../api/import-api.js");

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
  fetchBootstrapAction.mockClear();
  importCharacterAction.mockClear();
  importJsonPost.mockClear();
  importBatchPost.mockClear();
});

test("PNG import uploads via the folder route and skips legacy asset+PATCH", async () => {
  const { result } = renderHook(() => useCharacterImport());
  const file = makeCharaPng();

  let imported: { snapshot?: { character?: { avatarExt?: string | null } } } | undefined;
  await act(async () => {
    imported = await result.current.importFile(file, { importEmbeddedBook: true });
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

  // Character created + a silent skip-sync bootstrap refresh.
  expect(importCharacterAction).toHaveBeenCalledTimes(1);
  expect(importCharacterAction.mock.calls[0][0].fileName).toBe("card.png");
  expect(importCharacterAction.mock.calls[0][0].importEmbeddedBook).toBe(true);
  expect(fetchBootstrapAction).toHaveBeenCalledTimes(1);
  expect(fetchBootstrapAction.mock.calls[0][0]).toEqual({ silent: true, skipSnapshotSync: true });

  // REGRESSION GUARD: the returned snapshot's character carries avatarExt so
  // the caller's writeSnapshot lands the avatar in the active snapshot store
  // (top bar / chat / editor). importCharacterAction's fixture returned
  // avatarExt:null; the hook MUST overwrite it with the folder route's value.
  expect(imported?.snapshot?.character?.avatarExt).toBe(".png");
});

// ─── RXU-24: enableImportedRegexProfile transport ─────────────────────────
// The hook threads the option into the single-file body; import-api carries it
// on both transports. Omitted must stay ABSENT (not false) — the server
// boundary owns the default (off), so no-Regex behavior is byte-identical.

function jsonlFile(): File {
  return new File(['{"lines":[]}'], "chat.jsonl", { type: "application/jsonl" });
}

test("single-file import omits enableImportedRegexProfile when the option is not provided", async () => {
  const { result } = renderHook(() => useCharacterImport());

  await act(async () => {
    await result.current.importFile(jsonlFile());
  });

  expect(importCharacterAction).toHaveBeenCalledTimes(1);
  expect("enableImportedRegexProfile" in importCharacterAction.mock.calls[0][0]).toBe(false);
});

test("single-file import carries enableImportedRegexProfile: true", async () => {
  const { result } = renderHook(() => useCharacterImport());

  await act(async () => {
    await result.current.importFile(jsonlFile(), { enableImportedRegexProfile: true });
  });

  expect(importCharacterAction).toHaveBeenCalledTimes(1);
  expect(importCharacterAction.mock.calls[0][0].enableImportedRegexProfile).toBe(true);
});

test("single-file import carries explicit enableImportedRegexProfile: false", async () => {
  const { result } = renderHook(() => useCharacterImport());

  await act(async () => {
    await result.current.importFile(jsonlFile(), { enableImportedRegexProfile: false });
  });

  expect(importCharacterAction).toHaveBeenCalledTimes(1);
  const body = importCharacterAction.mock.calls[0][0];
  expect("enableImportedRegexProfile" in body).toBe(true);
  expect(body.enableImportedRegexProfile).toBe(false);
});

test("single importJson posts the exact JSON body (true carries, omitted absents)", async () => {
  await importJson({ fileName: "card.json", jsonText: "{}", enableImportedRegexProfile: true });
  expect(importJsonPost).toHaveBeenCalledTimes(1);
  expect(importJsonPost.mock.calls[0][0]).toEqual({
    json: { fileName: "card.json", jsonText: "{}", enableImportedRegexProfile: true },
  });

  await importJson({ fileName: "card.json", jsonText: "{}" });
  expect(importJsonPost).toHaveBeenCalledTimes(2);
  const omitted = importJsonPost.mock.calls[1][0] as { json: Record<string, unknown> };
  expect("enableImportedRegexProfile" in omitted.json).toBe(false);
});

test("batch importJsonBatch carries the per-item choice (omitted/true/false)", async () => {
  await importJsonBatch({
    items: [
      { fileName: "a.json", jsonText: "{}" },
      { fileName: "b.json", jsonText: "{}", enableImportedRegexProfile: true },
      { fileName: "c.json", jsonText: "{}", enableImportedRegexProfile: false },
    ],
  });
  expect(importBatchPost).toHaveBeenCalledTimes(1);
  const posted = importBatchPost.mock.calls[0][0] as {
    json: { items: Array<{ fileName: string; enableImportedRegexProfile?: boolean }> };
  };
  expect(posted.json.items).toHaveLength(3);
  expect("enableImportedRegexProfile" in posted.json.items[0]).toBe(false);
  expect(posted.json.items[1].enableImportedRegexProfile).toBe(true);
  expect(posted.json.items[2].enableImportedRegexProfile).toBe(false);
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
  // No avatar upload means no avatar-driven bootstrap refresh.
  expect(fetchBootstrapAction).not.toHaveBeenCalled();
});

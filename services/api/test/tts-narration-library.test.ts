// hygiene:allow-abs-path-inputs — paths are hostile inputs for validation/reveal-command mapping, never loaded
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore, createFileStore, STORAGE_FOLDERS } from "@vibe-tavern/db";
import { createDb } from "@vibe-tavern/db";
import { ProviderStore, TtsStore } from "@vibe-tavern/db";

import {
  NarrationLibraryService,
  NarrationLibraryValidationError,
  NarrationRevealUnsupportedError,
  narrationLibraryLeaf,
  parseNarrationLibraryKey,
  revealCommandForPlatform,
} from "../src/domain/tts/narration-library.js";
import type { NarrationLibraryKey } from "../src/domain/tts/narration-library.js";
import { TtsAdapter } from "../src/api/adapters/tts-adapter.js";
import { createTtsRoutes } from "../src/api/routes/tts.js";
import {
  __resetTtsRegistryForTests,
  __snapshotTtsRegistryForTests,
  __restoreTtsRegistryForTests,
} from "../src/domain/tts/tts-registry.js";

// Shared-process rule (see tts-routes.test.ts): restore the registry state
// this file found, so reset-free later files keep their import-time factories.
const registrySnapshot = __snapshotTtsRegistryForTests();

afterAll(() => {
  __restoreTtsRegistryForTests(registrySnapshot);
});

const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);

function key(overrides: Partial<NarrationLibraryKey> = {}): NarrationLibraryKey {
  return {
    characterId: "char_abc123",
    chatId: "chat_seed_0001",
    branchId: "brnch_seed_0001",
    messageId: "msg_seed_0001",
    variantIndex: 0,
    ...overrides,
  };
}

async function setupService(opts?: { platform?: string; spawn?: (argv: string[]) => void }) {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-narration-lib-"));
  const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
  const spawned: string[][] = [];
  const service = new NarrationLibraryService({
    content,
    resolveCharacterFolder: (id) => Promise.resolve(id),
    spawn: opts?.spawn ?? ((argv) => { spawned.push(argv); }),
    ...(opts?.platform !== undefined ? { platform: opts.platform } : {}),
  });
  return { dataRoot, content, service, spawned };
}

beforeEach(() => {
  __resetTtsRegistryForTests();
});

afterEach(async () => {
  __resetTtsRegistryForTests();
});

describe("narration library key validation (TPE-18c)", () => {
  test("valid key parses; leaf is the EXACT owner path narrations/chat/branch/message/variant.ogg", () => {
    const parsed = parseNarrationLibraryKey(key({ variantIndex: 2 }));
    expect(parsed.variantIndex).toBe(2);
    expect(narrationLibraryLeaf(parsed)).toBe(
      "narrations/chat_seed_0001/brnch_seed_0001/msg_seed_0001/2.ogg",
    );
  });

  test("multipart/query string variantIndex coerces (\"1\" → 1)", () => {
    expect(parseNarrationLibraryKey({ ...key(), variantIndex: "1" }).variantIndex).toBe(1);
  });

  test("traversal (../), absolute (/etc), backslash and empty segments reject with 400-class error", () => {
    for (const evil of ["../x", "..", "/etc/passwd", "C:\\win", "", "a/b", "a b", "x".repeat(129)]) {
      expect(() => parseNarrationLibraryKey({ ...key(), messageId: evil })).toThrow(
        NarrationLibraryValidationError,
      );
    }
    expect(() => parseNarrationLibraryKey({ ...key(), characterId: "../other" })).toThrow(
      NarrationLibraryValidationError,
    );
  });

  test("non-integer / negative / oversized variantIndex rejects", () => {
    for (const bad of [-1, 1.5, 1000, "abc", "", null, undefined]) {
      expect(() => parseNarrationLibraryKey({ ...key(), variantIndex: bad as never })).toThrow(
        NarrationLibraryValidationError,
      );
    }
  });

  test("reveal argv per platform: win32 explorer /select, darwin open -R, linux xdg-open dir", () => {
    expect(revealCommandForPlatform("win32", "C:\\data\\f.ogg")).toEqual([
      "explorer.exe",
      "/select,C:\\data\\f.ogg",
    ]);
    expect(revealCommandForPlatform("darwin", "/data/f.ogg")).toEqual(["open", "-R", "/data/f.ogg"]);
    const linux = revealCommandForPlatform("linux", "/data/narrations/f.ogg");
    expect(linux[0]).toBe("xdg-open");
    expect(linux[1]).toBe("/data/narrations");
  });

  test("reveal on an unsupported platform (android) throws the 501-class error", () => {
    expect(() => revealCommandForPlatform("android", "/data/f.ogg")).toThrow(
      NarrationRevealUnsupportedError,
    );
  });
});

describe("NarrationLibraryService over a tmp data root", () => {
  test("save produces ONE .ogg at the EXACT path; read returns byte-identical audio", async () => {
    const { dataRoot, service } = await setupService();
    try {
      const saved = await service.save(key(), OGG_BYTES);
      expect(saved.leaf).toBe("narrations/chat_seed_0001/brnch_seed_0001/msg_seed_0001/0.ogg");
      const onDisk = Buffer.from(
        await Bun.file(join(dataRoot, STORAGE_FOLDERS.characters, "char_abc123", saved.leaf)).arrayBuffer(),
      );
      expect(onDisk).toEqual(Buffer.from(OGG_BYTES));
      expect(await service.exists(key())).toBe(true);
      expect(await service.read(key())).toEqual(Buffer.from(OGG_BYTES));
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("wrong character cannot read another character's file (folder isolation)", async () => {
    const { dataRoot, service } = await setupService();
    try {
      await service.save(key(), OGG_BYTES);
      expect(await service.exists(key({ characterId: "char_other" }))).toBe(false);
      expect(await service.read(key({ characterId: "char_other" }))).toBeNull();
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("drop removes the file; a second drop reports deleted:false (idempotent)", async () => {
    const { dataRoot, service } = await setupService();
    try {
      await service.save(key(), OGG_BYTES);
      expect(await service.remove(key())).toEqual({ deleted: true });
      expect(await service.exists(key())).toBe(false);
      expect(await service.remove(key())).toEqual({ deleted: false });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("reveal spawns the platform command with the ABSOLUTE saved path", async () => {
    const { dataRoot, service, spawned } = await setupService({ platform: "win32" });
    try {
      await service.save(key(), OGG_BYTES);
      const { argv } = await service.reveal(key());
      expect(argv).toEqual([
        "explorer.exe",
        `/select,${join(dataRoot, STORAGE_FOLDERS.characters, "char_abc123", "narrations", "chat_seed_0001", "brnch_seed_0001", "msg_seed_0001", "0.ogg")}`,
      ]);
      expect(spawned).toEqual([argv]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

describe("narration library routes (TPE-18c)", () => {
  async function setupApp(opts?: { platform?: string }) {
    const dataRoot = await mkdtemp(join(tmpdir(), "vt-narration-routes-"));
    const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
    const spawned: string[][] = [];
    const service = new NarrationLibraryService({
      content,
      resolveCharacterFolder: (id) => Promise.resolve(id),
      spawn: (argv) => { spawned.push(argv); },
      ...(opts?.platform !== undefined ? { platform: opts.platform } : {}),
    });
    const db = await createDb(":memory:");
    const store = new TtsStore(db);
    const providers = new ProviderStore(db);
    const adapter = new TtsAdapter({ tts: store, providers }, service);
    return { app: createTtsRoutes(adapter), dataRoot, spawned };
  }

  function query(k: NarrationLibraryKey): string {
    const params = new URLSearchParams({
      characterId: k.characterId,
      chatId: k.chatId,
      branchId: k.branchId,
      messageId: k.messageId,
      variantIndex: String(k.variantIndex),
    });
    return params.toString();
  }

  function saveForm(k: NarrationLibraryKey, bytes: Uint8Array, name: string, type: string): FormData {
    const form = new FormData();
    form.set("characterId", k.characterId);
    form.set("chatId", k.chatId);
    form.set("branchId", k.branchId);
    form.set("messageId", k.messageId);
    form.set("variantIndex", String(k.variantIndex));
    form.set("audio", new File([bytes], name, { type }));
    return form;
  }

  test("POST save → 201, exists → true, GET file returns the bytes as audio/ogg, DELETE drops it", async () => {
    const { app, dataRoot } = await setupApp();
    try {
      const k = key();
      const saveRes = await app.request("/api/tts/narrations", { method: "POST", body: saveForm(k, OGG_BYTES, "merged.ogg", "audio/ogg") });
      expect(saveRes.status).toBe(201);
      const saved = (await saveRes.json()) as { saved: boolean; leaf: string };
      expect(saved.saved).toBe(true);
      expect(saved.leaf).toBe("narrations/chat_seed_0001/brnch_seed_0001/msg_seed_0001/0.ogg");

      const existsRes = await app.request(`/api/tts/narrations/exists?${query(k)}`);
      expect(existsRes.status).toBe(200);
      expect(((await existsRes.json()) as { exists: boolean }).exists).toBe(true);

      const fileRes = await app.request(`/api/tts/narrations/file?${query(k)}`);
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get("content-type")).toBe("audio/ogg");
      expect(new Uint8Array(await fileRes.arrayBuffer())).toEqual(OGG_BYTES);

      const delRes = await app.request(`/api/tts/narrations?${query(k)}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);
      expect(((await delRes.json()) as { deleted: boolean }).deleted).toBe(true);

      const goneRes = await app.request(`/api/tts/narrations/file?${query(k)}`);
      expect(goneRes.status).toBe(404);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("traversal key in query rejects with 400 (never reaches the filesystem)", async () => {
    const { app, dataRoot } = await setupApp();
    try {
      const evil = query(key({ messageId: "../escape" as never }));
      // URLSearchParams encodes the dots — the route still sees the raw ".." value.
      const res = await app.request(`/api/tts/narrations/exists?${evil}`);
      expect(res.status).toBe(400);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("save without the audio file → 400; non-audio mime → 400", async () => {
    const { app, dataRoot } = await setupApp();
    try {
      const k = key();
      const noFile = new FormData();
      noFile.set("characterId", k.characterId);
      const res1 = await app.request("/api/tts/narrations", { method: "POST", body: noFile });
      expect(res1.status).toBe(400);

      const res2 = await app.request("/api/tts/narrations", {
        method: "POST",
        body: saveForm(k, new Uint8Array([1, 2, 3]), "cover.png", "image/png"),
      });
      expect(res2.status).toBe(400);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("reveal without a saved file → 404; with a saved file → revealed:true + spawned command", async () => {
    const { app, dataRoot, spawned } = await setupApp({ platform: "darwin" });
    try {
      const k = key();
      const missing = await app.request("/api/tts/narrations/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...k }),
      });
      expect(missing.status).toBe(404);

      await app.request("/api/tts/narrations", { method: "POST", body: saveForm(k, OGG_BYTES, "merged.ogg", "audio/ogg") });
      const res = await app.request("/api/tts/narrations/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...k }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { revealed: boolean }).revealed).toBe(true);
      expect(spawned.length).toBe(1);
      expect(spawned[0]![0]).toBe("open");
      expect(spawned[0]![1]).toBe("-R");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("reveal on an unsupported platform → 501 (never spawns)", async () => {
    const { app, dataRoot, spawned } = await setupApp({ platform: "android" });
    try {
      const k = key();
      await app.request("/api/tts/narrations", { method: "POST", body: saveForm(k, OGG_BYTES, "merged.ogg", "audio/ogg") });
      const res = await app.request("/api/tts/narrations/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...k }),
      });
      expect(res.status).toBe(501);
      expect(spawned.length).toBe(0);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

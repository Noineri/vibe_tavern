/**
 * deletePromptPreset — last-preset protection + chat reassignment.
 *
 * Pins the behavior that replaced the dead `!bindProviderPresetId` "global
 * preset" no-op filter (see reports/prompt-preset-dead-bind-model.md). The
 * old guard filtered on a column that was null for every row, so it reduced
 * to "block deleting the last preset" by accident. This states that intent
 * honestly and locks the chat-reassignment fallback to the isDefault preset.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { deletePromptPreset, type PresetModuleDeps } from "../src/runtime/session/session-runtime-presets.js";

type Stores = Awaited<ReturnType<typeof createRuntimeStore>>;

/** Fake chats dependency that records setPromptPreset reassignments. */
function makeFakeChats(chatsByPreset: Record<string, string[]>) {
  const reassignments: Record<string, string> = {};
  const chats: PresetModuleDeps["chats"] = {
    async listByPreset(presetId: string) {
      return (chatsByPreset[presetId] ?? []).map((id) => ({ id }));
    },
    async setPromptPreset(chatId: string, presetId: string) {
      reassignments[chatId] = presetId;
    },
  };
  return { chats, reassignments };
}

describe("deletePromptPreset — last-preset protection + reassignment", () => {
  let tmpDir: string;
  let stores: Stores;

  beforeAll(async () => {
    tmpDir = resolve(tmpdir(), "vt-preset-del-" + crypto.randomUUID().slice(0, 8));
    await mkdir(resolve(tmpDir, "data"), { recursive: true });
    stores = await createRuntimeStore(resolve(tmpDir, "data"));
    // Seed the default preset (isDefault: true) as every fresh install does.
    await stores.presets.ensureDefault();
  });

  afterAll(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("refuses to delete the last remaining preset", async () => {
    const presets = await stores.presets.listAll();
    expect(presets).toHaveLength(1);
    const onlyId = presets[0].id;
    const { chats } = makeFakeChats({});

    await expect(deletePromptPreset({ presets: stores.presets, chats }, onlyId))
      .rejects.toThrow(/last prompt preset/i);

    // The preset must still exist.
    expect(await stores.presets.listAll()).toHaveLength(1);
  });

  test("deletes a non-last preset and reassigns its chats to the isDefault fallback", async () => {
    // Add a second, non-default preset.
    const other = await stores.presets.create({ name: "Other", systemPrompt: "x" });
    const def = (await stores.presets.listAll()).find((p) => p.isDefault)!;
    expect(def).toBeTruthy();

    // Two chats reference the soon-to-be-deleted preset.
    const { chats, reassignments } = makeFakeChats({
      [other.id]: ["chat_A", "chat_B"],
    });

    await deletePromptPreset({ presets: stores.presets, chats }, other.id);

    // The deleted preset is gone; the default survived.
    const remaining = await stores.presets.listAll();
    expect(remaining.find((p) => p.id === other.id)).toBeUndefined();
    expect(remaining.find((p) => p.id === def.id)).toBeTruthy();

    // Both chats were reassigned to the default preset.
    expect(reassignments).toEqual({
      chat_A: def.id,
      chat_B: def.id,
    });
  });
});

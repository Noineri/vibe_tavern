import { test, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";

// Star-prompt counter. `prepareLiveTurn` is the single place a live user turn is
// committed (it owns the only `appendUserMessage` call site), and the increment
// sits AFTER prompt assembly so a turn that gets rolled back by the
// assembly-failure compensating write does not leave a phantom count behind.

const tmpDirs: string[] = [];

async function setup(): Promise<{
  runtime: SessionRuntime;
  stores: Awaited<ReturnType<typeof createRuntimeStore>>;
  chatId: ChatId;
}> {
  const tmpDir = resolve(tmpdir(), "vt-star-count-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({
    name: "CountProbe",
    description: "a probe",
    firstMessage: "Hi!",
  });
  return { runtime, stores, chatId: created.activeChatId };
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

test("each live user turn bumps the persisted counter by exactly one", async () => {
  const { runtime, stores, chatId } = await setup();

  expect((await stores.uiSettings.get()).userMessageCount).toBe(0);

  await runtime.chatRuntime.prepareLiveTurn(chatId, "first", "test-model");
  expect((await stores.uiSettings.get()).userMessageCount).toBe(1);

  await runtime.chatRuntime.prepareLiveTurn(chatId, "second", "test-model");
  expect((await stores.uiSettings.get()).userMessageCount).toBe(2);
});

test("a continue turn with no content and no attachments does not count", async () => {
  const { runtime, stores, chatId } = await setup();

  await runtime.chatRuntime.prepareLiveTurn(chatId, "   ", "test-model");

  expect((await stores.uiSettings.get()).userMessageCount).toBe(0);
});

test("the counter starts from the stored value on a row that already has one", async () => {
  const { runtime, stores, chatId } = await setup();
  await stores.uiSettings.update({ userMessageCount: 99 });

  await runtime.chatRuntime.prepareLiveTurn(chatId, "hundredth", "test-model");

  expect((await stores.uiSettings.get()).userMessageCount).toBe(100);
});

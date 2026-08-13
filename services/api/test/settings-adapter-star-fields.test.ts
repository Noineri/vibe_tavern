import { test, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SettingsAdapter } from "../src/api/adapters/settings-adapter.js";

// The PATCH body is untyped at the wire boundary (`Record<string, unknown>`),
// so the adapter's explicit allowlist is the only thing standing between a
// client and the star-prompt state. `userMessageCount` is server-owned and its
// absence from the allowlist IS the enforcement — pin that it stays absent.

const tmpDirs: string[] = [];

async function setup(): Promise<{
  adapter: SettingsAdapter;
  stores: Awaited<ReturnType<typeof createRuntimeStore>>;
}> {
  const tmpDir = resolve(tmpdir(), "vt-star-adapter-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await stores.uiSettings.ensureDefaults();
  return { adapter: new SettingsAdapter(stores), stores };
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

test("the adapter accepts the three client-writable star fields", async () => {
  const { adapter, stores } = await setup();

  const updated = await adapter.updateUiSettings({
    githubStarred: true,
    nextStarPromptAt: 400,
    starPromptDeferrals: 1,
  });

  expect(updated.githubStarred).toBe(true);
  expect(updated.nextStarPromptAt).toBe(400);
  expect(updated.starPromptDeferrals).toBe(1);
  expect((await stores.uiSettings.get()).githubStarred).toBe(true);
});

test("the adapter refuses a client-supplied message count", async () => {
  const { adapter, stores } = await setup();
  await stores.uiSettings.update({ userMessageCount: 7 });

  const updated = await adapter.updateUiSettings({ userMessageCount: 9999 });

  expect(updated.userMessageCount).toBe(7);
});

test("the adapter ignores star fields of the wrong type", async () => {
  const { adapter } = await setup();

  const updated = await adapter.updateUiSettings({ githubStarred: "yes", nextStarPromptAt: 12.5 });

  expect(updated.githubStarred).toBe(false);
  expect(updated.nextStarPromptAt).toBe(100);
});

test("the adapter refuses a negative due point", async () => {
  const { adapter } = await setup();

  const updated = await adapter.updateUiSettings({ nextStarPromptAt: -1, starPromptDeferrals: -5 });

  expect(updated.nextStarPromptAt).toBe(100);
  expect(updated.starPromptDeferrals).toBe(0);
});

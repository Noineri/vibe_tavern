import { test, expect } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { UiSettingsStore } from "../src/stores/ui-settings-store.js";

test("a fresh settings row defaults to un-starred with the first prompt due at 100", async () => {
  const db = await createDb(":memory:");
  const store = new UiSettingsStore(db);

  const settings = await store.ensureDefaults();

  expect(settings.githubStarred).toBe(false);
  expect(settings.userMessageCount).toBe(0);
  expect(settings.nextStarPromptAt).toBe(100);
  expect(settings.starPromptDeferrals).toBe(0);
});

test("star fields round-trip through update()", async () => {
  const db = await createDb(":memory:");
  const store = new UiSettingsStore(db);
  await store.ensureDefaults();

  const updated = await store.update({ githubStarred: true, nextStarPromptAt: 400, starPromptDeferrals: 1 });

  expect(updated.githubStarred).toBe(true);
  expect(updated.nextStarPromptAt).toBe(400);
  expect(updated.starPromptDeferrals).toBe(1);
  expect((await store.get()).githubStarred).toBe(true);
});

test("update() leaves unmentioned star fields untouched", async () => {
  const db = await createDb(":memory:");
  const store = new UiSettingsStore(db);
  await store.ensureDefaults();
  await store.update({ userMessageCount: 42 });

  const settings = await store.update({ theme: "coffee" });

  expect(settings.userMessageCount).toBe(42);
  expect(settings.theme).toBe("coffee");
});

test("update() on a missing row inserts the star defaults", async () => {
  const db = await createDb(":memory:");
  const store = new UiSettingsStore(db);

  const settings = await store.update({ userMessageCount: 1 });

  expect(settings.userMessageCount).toBe(1);
  expect(settings.githubStarred).toBe(false);
  expect(settings.nextStarPromptAt).toBe(100);
  expect(settings.starPromptDeferrals).toBe(0);
});

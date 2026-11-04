import { describe, expect, test } from "bun:test";
import type { UserTheme } from "@vibe-tavern/api-contracts";
import { createUserThemesStore } from "./user-themes-store.js";
import type { UserThemeApi } from "../api/user-theme-api.js";

// L1: factory-local API seam only; no paths/globals/mocks/DBs/platform assumptions.
// Parked promises force request races; all assertions follow terminal actions.
const theme: UserTheme = { id: "sample", name: "sample.css", css: ":root.user-sample { --bg: red; }" };
function api(overrides: Partial<UserThemeApi> = {}): UserThemeApi {
  return { list: async () => [], read: async () => null, upload: async () => theme, remove: async () => {}, ...overrides };
}
function parked<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
describe("user theme catalog", () => {
  test("uploads, caches CSS and removes the exact catalog item", async () => {
    let rows: UserTheme[] = [];
    const store = createUserThemesStore(api({ list: async () => rows, upload: async () => { rows = [theme]; return theme; }, remove: async () => { rows = []; } }));
    await store.getState().load();
    await store.getState().upload({ name: theme.name, css: theme.css });
    expect(await store.getState().read(theme.id)).toEqual(theme);
    expect(store.getState().themes).toEqual([theme]);
    await store.getState().remove(theme.id);
    expect(store.getState().themes).toEqual([]);
    expect(store.getState().documents[theme.id]).toBeUndefined();
  });

  test("a stale initial listing cannot erase an upload completed while it was in flight", async () => {
    const first = parked<UserTheme[]>();
    let calls = 0;
    const store = createUserThemesStore(api({ list: async () => ++calls === 1 ? first.promise : [theme] }));
    const load = store.getState().load();
    await store.getState().upload({ name: theme.name, css: theme.css });
    first.resolve([]);
    await load;
    expect(store.getState().themes).toEqual([theme]);
    expect(store.getState().loaded).toBe(true);
  });

  test("a late CSS response cannot repopulate a deleted item", async () => {
    const read = parked<UserTheme | null>();
    const store = createUserThemesStore(api({ list: async () => [theme], read: () => read.promise }));
    await store.getState().load();
    const pending = store.getState().read(theme.id);
    await store.getState().remove(theme.id);
    read.resolve(theme);
    expect(await pending).toBeNull();
    expect(store.getState().documents[theme.id]).toBeUndefined();
    expect(store.getState().themes).toEqual([]);
  });

  test("failed discovery is not a successful empty catalog and can be retried", async () => {
    let fail = true;
    const store = createUserThemesStore(api({ list: async () => { if (fail) throw new Error("offline"); return [theme]; } }));
    await expect(store.getState().load()).rejects.toThrow("offline");
    expect(store.getState().loaded).toBe(false);
    expect(store.getState().error).toBeInstanceOf(Error);
    fail = false;
    await store.getState().load();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().error).toBeNull();
    expect(store.getState().themes).toEqual([theme]);
  });
});

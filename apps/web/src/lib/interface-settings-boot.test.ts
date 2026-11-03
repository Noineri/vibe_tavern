import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { INTERFACE_SETTINGS_STORAGE_KEY } from "../stores/interface-settings-store.js";

// L1: one repo-relative source read, no scratch paths or DB; the real pre-React
// script executes in a test-owned VM with synchronous storage, no global edits.
const html = await Bun.file(new URL("../../index.html", import.meta.url)).text();
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("Missing theme first-paint script");

function splash(values: Record<string, string>, blocked = false) {
  const properties: Record<string, string> = {};
  runInNewContext(script!, {
    localStorage: { getItem: (key: string) => {
      if (blocked) throw new Error("blocked");
      return values[key] ?? null;
    } },
    document: { documentElement: { style: { setProperty: (key: string, value: string) => { properties[key] = value; } } } },
  });
  return properties;
}

function persisted(theme: string) {
  return JSON.stringify({ state: { settings: { theme } }, version: 1 });
}

describe("interface theme first paint", () => {
  test("legacy theme and missing storage keep the original splash palettes", () => {
    expect(Object.keys(splash({})).sort()).toEqual(["--accent", "--accent-mid", "--bg"]);
    expect(splash({ "vibe-tavern.theme": "coffee" })).toEqual(splash({}));
    expect(splash({ "vibe-tavern.theme": "mystic-night" })).not.toEqual(splash({}));
  });

  test("blocked storage remains a usable default splash", () => {
    expect(splash({}, true)).toEqual(splash({}));
  });

  test("new persisted theme is used before React hydrates", () => {
    expect(splash({ [INTERFACE_SETTINGS_STORAGE_KEY]: persisted("mystic-night") })).toEqual(splash({ "vibe-tavern.theme": "mystic-night" }));
  });

  test("new preferences win over stale legacy theme", () => {
    expect(splash({ [INTERFACE_SETTINGS_STORAGE_KEY]: persisted("coffee"), "vibe-tavern.theme": "mystic-night" })).toEqual(splash({}));
  });

  test("malformed new preferences do not hide a valid legacy theme", () => {
    expect(splash({ [INTERFACE_SETTINGS_STORAGE_KEY]: "{", "vibe-tavern.theme": "mystic-night" })).toEqual(splash({ "vibe-tavern.theme": "mystic-night" }));
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFileStore } from "@vibe-tavern/db";
import { MAX_USER_THEME_BYTES, uploadUserThemeSchema } from "@vibe-tavern/api-contracts";
import { normalizeUserThemeCss } from "../src/domain/themes/user-theme-css.js";
import { UserThemeLibrary } from "../src/domain/themes/user-theme-library.js";

// L1: import.meta.dir fixtures + tmpdir scratch; no globals/mocks/DBs/waits;
// one private file tree per test, swept in afterEach; stable awaited file state.
let root: string;
let library: UserThemeLibrary;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vt-user-themes-"));
  library = new UserThemeLibrary(createFileStore(root));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("user-theme CSS normalization", () => {
  test("normalizes bare/named roots, descendants and media rules without changing strings/comments/keyframes", () => {
    const css = `/* :root.old { untouched } */
:root.old { --bg: #123; --quoted: ":root.old {}"; }
:root.old body, :root { color: var(--bg); }
@media (prefers-reduced-motion: reduce) { :root.old body { animation: none; } }
@keyframes drift { from { opacity: 0; } to { opacity: 1; } }`;
    const actual = normalizeUserThemeCss(css, "sample");
    expect(actual).toBe(css
      .replace(":root.old { --bg", ":root.user-sample { --bg")
      .replace(":root.old body, :root {", ":root.user-sample body, :root.user-sample {")
      .replace(":root.old body { animation", ":root.user-sample body { animation"));
  });

  test("accepts all six shipped CSS files as compatibility fixtures", async () => {
    const folder = resolve(import.meta.dir, "../../../apps/web/src/themes");
    const files = (await readdir(folder)).filter((file) => file.endsWith(".css")).sort();
    expect(files).toHaveLength(6);
    for (const file of files) {
      const original = await Bun.file(join(folder, file)).text();
      const css = normalizeUserThemeCss(original, "fixture");
      expect(css).toContain(":root.user-fixture");
      expect(css).toContain("--bg:");
      expect(normalizeUserThemeCss(css, "fixture")).toBe(css);
    }
  });

  test("requires a real top-level root token rule, not comments, quoted values or only descendants", () => {
    for (const css of ["/* :root {} */ body { color: red; }", 'body { --quoted: ":root {}"; }', ":root body { --bg: red; }", "@media screen { :root { --bg: red; } }"]) {
      expect(() => normalizeUserThemeCss(css, "sample")).toThrow(/:root/);
    }
    expect(() => normalizeUserThemeCss(":root { broken declaration; }", "sample")).toThrow(/CSS/);
  });
});

describe("user-theme file library", () => {
  test("starts empty, persists original filename and normalized CSS across library recreation, then deletes", async () => {
    expect(await library.list()).toEqual([]);
    const saved = await library.upload({ name: "My theme.CSS", css: ":root { --bg: #123; }" });
    expect(saved.name).toBe("My theme.CSS");
    expect(saved.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(saved.css).toContain(`:root.user-${saved.id}`);
    const fresh = new UserThemeLibrary(createFileStore(root));
    expect(await fresh.list()).toEqual([{ id: saved.id, name: saved.name }]);
    expect(await fresh.read(saved.id)).toEqual(saved);
    expect((await readdir(join(root, "themes"))).sort()).toEqual([`${saved.id}.css`]);
    await fresh.delete(saved.id);
    expect(await library.list()).toEqual([]);
    await expect(library.read(saved.id)).rejects.toMatchObject({ kind: "NotFound" });
  });

  test("concurrent same-name uploads have independent ids and cannot overwrite one another", async () => {
    const saved = await Promise.all(["red", "blue"].map((color) => library.upload({ name: "same.css", css: `:root { --bg: ${color}; }` })));
    expect(new Set(saved.map((theme) => theme.id)).size).toBe(2);
    expect(await library.list()).toHaveLength(2);
    for (const theme of saved) expect(await library.read(theme.id)).toEqual(theme);
  });

  test("rejects traversal, wrong extensions, invalid syntax and oversized UTF-8 before writing", async () => {
    expect(uploadUserThemeSchema.safeParse({ name: "../theme.css", css: ":root { --bg: red; }" }).success).toBe(false);
    for (const name of ["theme.js", "a/b.css", "a\\b.css"]) {
      await expect(library.upload({ name, css: ":root { --bg: red; }" })).rejects.toMatchObject({ kind: "Validation" });
    }
    await expect(library.upload({ name: "theme.css", css: "body { color: red; }" })).rejects.toMatchObject({ kind: "Validation", details: { code: "missing-root" } });
    await expect(library.upload({ name: "theme.css", css: `:root { --label: "${"\u2603".repeat(MAX_USER_THEME_BYTES / 2)}"; }` })).rejects.toMatchObject({ kind: "Validation", details: { code: "too-large" } });
    for (const id of ["../outside", "a/b", "a\\b", "", ".", "THEME"]) {
      await expect(library.read(id)).rejects.toMatchObject({ kind: "Validation" });
      await expect(library.delete(id)).rejects.toMatchObject({ kind: "Validation" });
    }
    expect(await library.list()).toEqual([]);
  });

  test("does not list or follow symlinked CSS files", async () => {
    const saved = await library.upload({ name: "real.css", css: ":root { --bg: red; }" });
    await Bun.write(join(root, "outside.css"), ":root { --bg: blue; }");
    // File symlinks require elevated privileges on some Windows installations.
    // A directory junction is portable and must be rejected by the same gate.
    await symlink(root, join(root, "themes", "linked.css"), "junction");
    expect(await library.list()).toEqual([{ id: saved.id, name: saved.name }]);
    await expect(library.read("linked")).rejects.toMatchObject({ kind: "NotFound" });
    await expect(library.delete("linked")).rejects.toMatchObject({ kind: "NotFound" });
    expect(await Bun.file(join(root, "outside.css")).text()).toContain("blue");
  });
});

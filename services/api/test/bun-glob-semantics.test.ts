import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GlobScanOptions = {
  readonly cwd: string;
  readonly dot?: boolean;
  readonly followSymlinks?: boolean;
  readonly throwErrorOnBrokenSymlink?: boolean;
  readonly onlyFiles?: boolean;
};

async function scanGlob(pattern: string, options: GlobScanOptions): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of new Bun.Glob(pattern).scan(options)) entries.push(entry);
  return entries;
}

// Bun.Glob returns platform-native separators in scan results (\ on win32,
// / elsewhere) — g() builds expectations in the platform's shape.
function g(path: string): string {
  return process.platform === "win32" ? path.replaceAll("/", "\\") : path;
}

async function buildPatternFixture(root: string): Promise<void> {
  await Promise.all([
    mkdir(join(root, ".hidden-dir"), { recursive: true }),
    mkdir(join(root, "visible-dir"), { recursive: true }),
    mkdir(join(root, "top-skill"), { recursive: true }),
    mkdir(join(root, "nested", "deep-skill"), { recursive: true }),
  ]);
  await Promise.all([
    Bun.write(join(root, "visible.json"), "visible"),
    Bun.write(join(root, ".hidden.json"), "hidden"),
    Bun.write(join(root, ".hidden-dir", "hidden-dir.json"), "hidden-dir"),
    Bun.write(join(root, "visible-dir", ".hidden-child.json"), "hidden-child"),
    Bun.write(join(root, "visible-dir", "visible-child.json"), "visible-child"),
    Bun.write(join(root, "top-skill", "SKILL.md"), "top"),
    Bun.write(join(root, "nested", "deep-skill", "SKILL.md"), "deep"),
    Bun.write(join(root, "nested", "inside.json"), "inside"),
  ]);
}

describe("Bun.Glob semantics on Bun 1.3.14-canary.1", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "vt-bun-glob-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("dot controls both hidden files and descendants of hidden directories", async () => {
    await buildPatternFixture(tempRoot);

    const withoutDot = await scanGlob("**/*.json", { cwd: tempRoot, dot: false });
    const withDot = await scanGlob("**/*.json", { cwd: tempRoot, dot: true });

    expect(withoutDot.sort()).toEqual([
      g("nested/inside.json"),
      g("visible-dir/visible-child.json"),
      "visible.json",
    ]);
    expect(withDot.sort()).toEqual([
      g(".hidden-dir/hidden-dir.json"),
      ".hidden.json",
      g("nested/inside.json"),
      g("visible-dir/.hidden-child.json"),
      g("visible-dir/visible-child.json"),
      "visible.json",
    ]);
  });

  test("onlyFiles excludes directories, while false includes every matching entry", async () => {
    await buildPatternFixture(tempRoot);

    const defaultEntries = await scanGlob("**/*", { cwd: tempRoot, dot: true });
    const files = await scanGlob("**/*", { cwd: tempRoot, dot: true, onlyFiles: true });
    const entries = await scanGlob("**/*", { cwd: tempRoot, dot: true, onlyFiles: false });

    expect(defaultEntries).toEqual(files);
    expect(files).not.toContain("nested");
    expect(entries).toEqual(expect.arrayContaining(["nested", g("nested/deep-skill"), g("nested/inside.json")]));
  });

  test("distinguishes immediate and nested patterns", async () => {
    await buildPatternFixture(tempRoot);

    const json = await scanGlob("**/*.json", { cwd: tempRoot, dot: true });
    const immediateSkill = await scanGlob("*/SKILL.md", { cwd: tempRoot, dot: true });
    const immediate = await scanGlob("*", { cwd: tempRoot, dot: true, onlyFiles: false });
    const recursive = await scanGlob("**/*", { cwd: tempRoot, dot: true, onlyFiles: false });

    expect(json).toContain(g("nested/inside.json"));
    expect(immediateSkill).toEqual([g("top-skill/SKILL.md")]);
    expect(immediate.every((entry) => !entry.includes("/") && !entry.includes("\\"))).toBe(true);
    expect(recursive).toEqual(expect.arrayContaining([g("nested/inside.json"), g("nested/deep-skill/SKILL.md")]));
  });

  test("matches with forward-slash separators and not with backslash separators", async () => {
    await buildPatternFixture(tempRoot);

    expect(await scanGlob("nested/*.json", { cwd: tempRoot })).toEqual([g("nested/inside.json")]);
    expect(await scanGlob("nested\\*.json", { cwd: tempRoot })).toEqual([]);
  });

  // Backslashes are legal in POSIX filenames but illegal on win32, so the
  // literal-backslash fixture can only exist on POSIX.
  (process.platform === "win32" ? test.skip : test)("preserves literal backslashes in file names", async () => {
    const backslash = String.fromCharCode(92);
    await Bun.write(join(tempRoot, `literal${backslash}name.json`), "literal");

    expect(await scanGlob(`literal${backslash}name.json`, { cwd: tempRoot })).toEqual([`literal${backslash}name.json`]);
  });

  test("rejects a missing root instead of yielding an empty result", async () => {
    await expect(scanGlob("**/*", { cwd: join(tempRoot, "missing") })).rejects.toThrow("ENOENT");
  });

  test("does not traverse links by default, follows escaping links when enabled, and can throw for broken links", async () => {
    const root = join(tempRoot, "root");
    const outside = join(tempRoot, "outside");
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await Promise.all([
      mkdir(join(root, "inside"), { recursive: true }),
      mkdir(join(outside, "outside-dir"), { recursive: true }),
      Bun.write(join(root, "inside", "inside.json"), "inside"),
      Bun.write(join(outside, "outside.json"), "outside"),
      Bun.write(join(outside, "outside-dir", "escaped.json"), "escaped"),
    ]);
    await Promise.all([
      symlink(join(root, "inside"), join(root, "linked-inside"), directoryLinkType),
      symlink(join(outside, "outside-dir"), join(root, "linked-outside"), directoryLinkType),
      symlink(join(outside, "outside.json"), join(root, "escaping.json"), "file"),
      symlink(join(root, "missing.json"), join(root, "broken.json"), "file"),
    ]);

    const withoutFollowing = await scanGlob("**/*.json", { cwd: root, dot: true, followSymlinks: false });
    const withFollowing = await scanGlob("**/*.json", { cwd: root, dot: true, followSymlinks: true });
    const lenientEntries = await scanGlob("**/*", {
      cwd: root,
      dot: true,
      followSymlinks: true,
      throwErrorOnBrokenSymlink: false,
      onlyFiles: false,
    });

    expect(withoutFollowing).toEqual([g("inside/inside.json")]);
    expect(withFollowing.sort()).toEqual([
      "escaping.json",
      g("inside/inside.json"),
      g("linked-inside/inside.json"),
      g("linked-outside/escaped.json"),
    ]);
    expect(lenientEntries).toContain("broken.json");
    await expect(scanGlob("**/*", {
      cwd: root,
      dot: true,
      followSymlinks: true,
      throwErrorOnBrokenSymlink: true,
      onlyFiles: false,
    })).rejects.toThrow("ENOENT");
  });

  test("rejects a circular symlink chain with ELOOP when following links", async () => {
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await mkdir(join(tempRoot, "real"));
    await Bun.write(join(tempRoot, "real", "safe.json"), "safe");
    await symlink(join(tempRoot, "b"), join(tempRoot, "a"), directoryLinkType);
    await symlink(join(tempRoot, "a"), join(tempRoot, "b"), directoryLinkType);

    await expect(scanGlob("**/*", {
      cwd: tempRoot,
      dot: true,
      followSymlinks: true,
      throwErrorOnBrokenSymlink: true,
      onlyFiles: false,
    })).rejects.toThrow("ELOOP");
  });

  test("is repeatable across async and sync scans, with stable but non-lexical traversal order", async () => {
    await buildPatternFixture(tempRoot);
    const options = { cwd: tempRoot, dot: true, onlyFiles: false };

    const first = await scanGlob("**/*", options);
    const second = await scanGlob("**/*", options);
    const sync = [...new Bun.Glob("**/*").scanSync(options)];

    expect(first).toEqual(second);
    expect(sync).toEqual(first);
    // The non-lexical claim is an empirical POSIX filesystem
    // characterization; NTFS enumeration is often alphabetical.
    if (process.platform !== "win32") {
      expect(first).not.toEqual([...first].sort());
    }
  });
});

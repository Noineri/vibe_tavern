import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillCatalog,
  discoverSkills,
  parseSkillManifest,
  resolveBuiltinSkillsRoot,
  resolveUserSkillsRoot,
  scanSkillRoot,
  type ScanRoot,
} from "../src/domain/coauthor/skills/skill-scanner.js";

/**
 * CTX-S1 — Filesystem skill scanner contract. Pins the discovery rules the
 * COAUTHOR_TOOLSET_EXPANSION_PLAN Wave 1 exit gate requires: the nine-skill
 * fixture shape, read-only/unknown-frontmatter preservation, duplicate-name
 * handling, malformed-manifest rejection, and the shared-directory (no
 * SKILL.md) non-skill case. The synthetic fixture mirrors the external
 * N:/.../.roo/skills shape (skill-local assets/references, a shared sibling
 * references dir, a folded-block-scalar description, and an unknown `modeSlugs`
 * field) so the scanner is exercised against realistic manifests without
 * depending on that external path.
 */

let tmpRoot = "";
const tmpRoots: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `coauthor-skill-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

/** Write `<root>/<id>/SKILL.md` with the given raw manifest text. */
async function writeManifest(root: string, id: string, text: string): Promise<string> {
  const skillDir = join(root, id);
  await mkdir(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  await Bun.write(path, text);
  return path;
}

/** Convenience: build a manifest from name/description (+ optional extra raw frontmatter lines). */
function manifest(name: string, description: string, extraFrontmatter = "", body = `# ${name}\nBody.\n`): string {
  return `---\nname: ${name}\ndescription: ${description}${extraFrontmatter ? `\n${extraFrontmatter}` : ""}\n---\n\n${body}`;
}

beforeEach(async () => {
  tmpRoot = await makeTmpDir("root");
});

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Build the nine-skill compatibility-shape fixture under `root`. */
async function buildNineSkillFixture(root: string): Promise<void> {
  // Eight plain skills + one with the tricky frontmatter shapes. Mirrors the
  // .roo fixture's spread (creator, editor, analyzer, first-message, etc.).
  const plain = [
    ["janitor-card-creator", "Creates a full character card from scratch using a structured template."],
    ["janitor-card-editor", "Edits and restructures existing cards while preserving useful logic."],
    ["janitor-card-analyzer", "Audits cards for weak hooks, empty traits, and structural flaws."],
    ["janitor-card-antislop", "Separates functional card logic from decorative prose."],
    ["janitor-first-message", "Writes or rewrites primary first messages and alternate openers."],
    ["janitor-market-predictor", "Evaluates whether a bot offers a strong playable fantasy engine."],
    ["janitor-modern-botmaking", "Architectural guidelines for modern bot building."],
    ["janitor-css-writer", "Plans and writes CSS for profile pages."],
  ] as const;
  for (const [id, desc] of plain) {
    await writeManifest(root, id, manifest(id, desc));
  }

  // Tricky skill: folded block-scalar description + an unknown `modeSlugs` array.
  // The scanner must extract the unfolded description and ignore modeSlugs.
  await writeManifest(
    root,
    "janitor-public-bio",
    [
      "---",
      "name: janitor-public-bio",
      "description: >-",
      "  Builds and rewrites public bio text by extracting the core fantasy,",
      "  clarifying the user role, and generating click-oriented hooks.",
      "modeSlugs:",
      "  - janitor-unhinged-coauthor",
      "---",
      "",
      "# Public Bio",
      "Body.",
      "",
    ].join("\n"),
  );

  // Local assets/references inside one skill (must NOT be treated as skills).
  const creatorDir = join(root, "janitor-card-creator");
  await mkdir(join(creatorDir, "assets"), { recursive: true });
  await mkdir(join(creatorDir, "references"), { recursive: true });
  await Bun.write(join(creatorDir, "assets", "character-template.md"), "# Template\n...");
  await Bun.write(join(creatorDir, "references", "creation-rules.md"), "# Rules\n...");

  // Shared sibling references directory with NO SKILL.md — not a skill.
  const sharedDir = join(root, "shared-card-references");
  await mkdir(sharedDir, { recursive: true });
  await Bun.write(join(sharedDir, "evaluation-principles.md"), "# Evaluation principles");
  await Bun.write(join(sharedDir, "patterns-personality.md"), "# Personality patterns");
}

// ─── parseSkillManifest (pure) ───────────────────────────────────────────────

describe("parseSkillManifest", () => {
  test("extracts name + description from simple frontmatter", () => {
    const res = parseSkillManifest("---\nname: foo\ndescription: A skill.\n---\n# Foo\n");
    expect(res).toEqual({ name: "foo", description: "A skill." });
  });

  test("unfolds a folded block-scalar description and ignores unknown fields", () => {
    const text = [
      "---",
      "name: public-bio",
      "description: >-",
      "  Line one of the bio.",
      "  Line two of the bio.",
      "modeSlugs:",
      "  - some-mode",
      "---",
      "# Public Bio",
    ].join("\n");
    const res = parseSkillManifest(text);
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.name).toBe("public-bio");
      expect(res.description).toBe("Line one of the bio. Line two of the bio.");
    }
  });

  test("description is optional (empty string when absent)", () => {
    const res = parseSkillManifest("---\nname: foo\n---\n# Foo\n");
    expect(res).toEqual({ name: "foo", description: "" });
  });

  test("rejects a manifest with no frontmatter block", () => {
    const res = parseSkillManifest("# No frontmatter\nJust a body.");
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("no YAML frontmatter");
  });

  test("rejects a frontmatter missing a non-empty name", () => {
    const noName = parseSkillManifest("---\ndescription: no name here\n---\n# X\n");
    expect("error" in noName).toBe(true);
    const emptyName = parseSkillManifest("---\nname: \"\"\ndescription: x\n---\n# X\n");
    expect("error" in emptyName).toBe(true);
  });

  test("rejects invalid YAML", () => {
    const res = parseSkillManifest("---\nname: [unclosed array\n---\n# X\n");
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("invalid YAML");
  });

  test("rejects a non-mapping frontmatter (bare scalar)", () => {
    const res = parseSkillManifest("---\njustastring\n---\n# X\n");
    expect("error" in res).toBe(true);
  });
});

// ─── scanSkillRoot ───────────────────────────────────────────────────────────

describe("scanSkillRoot — nine-skill fixture", () => {
  test("discovers exactly nine skills, not the shared directory", async () => {
    await buildNineSkillFixture(tmpRoot);
    const { skills, errors } = await scanSkillRoot({ path: tmpRoot, source: "user" });

    expect(errors).toEqual([]);
    expect(skills).toHaveLength(9);
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toEqual(
      [
        "janitor-card-analyzer",
        "janitor-card-antislop",
        "janitor-card-creator",
        "janitor-card-editor",
        "janitor-css-writer",
        "janitor-first-message",
        "janitor-market-predictor",
        "janitor-modern-botmaking",
        "janitor-public-bio",
      ],
    );
    // The shared references directory has no SKILL.md → never discovered.
    expect(skills.find((s) => s.id === "shared-card-references")).toBeUndefined();
  });

  test("extracts unfolded description + correct paths for the tricky skill", async () => {
    await buildNineSkillFixture(tmpRoot);
    const { skills } = await scanSkillRoot({ path: tmpRoot, source: "user" });
    const bio = skills.find((s) => s.id === "janitor-public-bio");
    expect(bio).toBeDefined();
    expect(bio!.name).toBe("janitor-public-bio");
    expect(bio!.description).toBe(
      "Builds and rewrites public bio text by extracting the core fantasy, clarifying the user role, and generating click-oriented hooks.",
    );
    expect(bio!.rootRelativeManifestPath).toBe("janitor-public-bio/SKILL.md");
    expect(bio!.manifestPath).toBe(join(tmpRoot, "janitor-public-bio", "SKILL.md"));
    expect(bio!.skillDir).toBe(join(tmpRoot, "janitor-public-bio"));
    expect(bio!.source).toBe("user");
  });

  test("discovery is read-only: every manifest byte is unchanged after scan", async () => {
    await buildNineSkillFixture(tmpRoot);
    const before = await collectManifestTexts(tmpRoot);
    await scanSkillRoot({ path: tmpRoot, source: "user" });
    const after = await collectManifestTexts(tmpRoot);
    expect(after).toEqual(before);
  });

  test("a missing root scans as empty (no throw) — fresh install with no user skills", async () => {
    const { skills, errors } = await scanSkillRoot({
      path: join(tmpRoot, "does-not-exist"),
      source: "user",
    });
    expect(skills).toEqual([]);
    expect(errors).toEqual([]);
  });
});

async function collectManifestTexts(root: string): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const out: Record<string, string> = {};
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const p = join(root, dir.name, "SKILL.md");
    const f = Bun.file(p);
    if (await f.exists()) out[dir.name] = await f.text();
  }
  return out;
}

// ─── malformed manifests ─────────────────────────────────────────────────────

describe("scanSkillRoot — malformed manifests", () => {
  test("rejects a manifest with no frontmatter but keeps discovering the rest", async () => {
    await writeManifest(tmpRoot, "good-one", manifest("good-one", "ok"));
    await writeManifest(tmpRoot, "no-frontmatter", "# Just a heading\nNo frontmatter at all.");
    await writeManifest(tmpRoot, "good-two", manifest("good-two", "ok"));

    const { skills, errors } = await scanSkillRoot({ path: tmpRoot, source: "user" });
    expect(skills.map((s) => s.id).sort()).toEqual(["good-one", "good-two"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].skillDir).toBe(join(tmpRoot, "no-frontmatter"));
    expect(errors[0].reason).toContain("no YAML frontmatter");
  });

  test("rejects missing-name and invalid-YAML manifests, reports distinct reasons", async () => {
    await writeManifest(tmpRoot, "missing-name", "---\ndescription: no name\n---\n# X\n");
    await writeManifest(tmpRoot, "bad-yaml", "---\nname: [oops\n---\n# X\n");
    const { skills, errors } = await scanSkillRoot({ path: tmpRoot, source: "builtin" });
    expect(skills).toEqual([]);
    expect(errors).toHaveLength(2);
    const reasons = errors.map((e) => e.reason).sort();
    expect(reasons.some((r) => r.includes("non-empty string 'name'"))).toBe(true);
    expect(reasons.some((r) => r.includes("invalid YAML"))).toBe(true);
  });
});

// ─── duplicate names / cross-root ────────────────────────────────────────────

describe("scanSkillRoot — duplicate names", () => {
  test("two skills sharing the same frontmatter name are both surfaced (dedup is a catalog concern)", async () => {
    await writeManifest(tmpRoot, "alpha", manifest("shared-name", "first"));
    await writeManifest(tmpRoot, "beta", manifest("shared-name", "second"));
    const { skills } = await scanSkillRoot({ path: tmpRoot, source: "user" });
    expect(skills).toHaveLength(2);
    expect(skills.every((s) => s.name === "shared-name")).toBe(true);
    expect(skills.map((s) => s.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("discoverSkills surfaces a user skill alongside a same-id built-in (catalog decides precedence)", async () => {
    const builtinRoot = await makeTmpDir("builtin");
    const userRoot = await makeTmpDir("user");
    await writeManifest(builtinRoot, "card-creator", manifest("card-creator", "built-in"));
    await writeManifest(userRoot, "card-creator", manifest("card-creator", "user override"));

    const roots: ScanRoot[] = [
      { path: builtinRoot, source: "builtin" },
      { path: userRoot, source: "user" },
    ];
    const { skills, errors } = await discoverSkills(roots);
    expect(errors).toEqual([]);
    expect(skills).toHaveLength(2);
    const builtin = skills.find((s) => s.source === "builtin");
    const user = skills.find((s) => s.source === "user");
    expect(builtin!.description).toBe("built-in");
    expect(user!.description).toBe("user override");
  });
});

// ─── resolvers ───────────────────────────────────────────────────────────────

describe("root resolvers", () => {
  test("resolveBuiltinSkillsRoot points at the built-in tree and finds the five workflow bundles", async () => {
    const root = await resolveBuiltinSkillsRoot();
    const { skills, errors } = await scanSkillRoot({ path: root, source: "builtin" });
    expect(errors).toEqual([]);
    expect(skills.map((s) => s.id).sort()).toEqual([
      "character-workshop",
      "dialogue-studio",
      "lorebook-authoring",
      "quick-draft",
      "revision-workshop",
    ]);
    // Every workflow bundle carries a parsed description (catalog metadata).
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(0);
    }
  });

  test("quick-draft ships a card template that resolves as a skill-local reference (CTX-M1)", async () => {
    // Self-check: every manifest parses and every local/shared reference resolves.
    // Quick Draft's SKILL.md references references/card-template.md; confirm that
    // file exists under the built-in root and is non-empty.
    const root = await resolveBuiltinSkillsRoot();
    const templatePath = join(root, "quick-draft", "references", "card-template.md");
    const templateFile = Bun.file(templatePath);
    expect(await templateFile.exists()).toBe(true);
    expect((await templateFile.text()).length).toBeGreaterThan(0);
  });

  test("resolveUserSkillsRoot builds <dataDir>/coauthor/skills", () => {
    const root = resolveUserSkillsRoot(join(tmpRoot, "data"));
    expect(root.replace(/\\/g, "/").endsWith("data/coauthor/skills")).toBe(true);
  });
});

// ─── buildSkillCatalog (merge + user > builtin precedence) ────────────────────

/**
 * CTX-S3 — the merged catalog. Discovery (S1) deliberately surfaces same-id
 * collisions; the catalog decides precedence: user > builtin (a user skill
 * shadows a same-id built-in), flagged `shadowsBuiltin`. Entries are deduped by
 * id and sorted; malformed manifests are surfaced, not fatal.
 */
describe("buildSkillCatalog — merge + user precedence", () => {
  test("merges builtin + user roots into one sorted, deduped-by-id catalog", async () => {
    const builtin = await makeTmpDir("builtin");
    const user = await makeTmpDir("user");
    await writeManifest(builtin, "alpha", manifest("alpha", "builtin alpha"));
    await writeManifest(builtin, "beta", manifest("beta", "builtin beta"));
    await writeManifest(user, "gamma", manifest("gamma", "user gamma"));

    const { entries, errors } = await buildSkillCatalog([
      { path: builtin, source: "builtin" },
      { path: user, source: "user" },
    ]);

    expect(errors).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(entries.map((e) => e.source)).toEqual(["builtin", "builtin", "user"]);
    expect(entries.every((e) => e.shadowsBuiltin === false)).toBe(true);
    // Portable root-relative manifest path, no absolute path leaks on the entry.
    expect(entries[0].manifestPath).toBe(join(builtin, "alpha", "SKILL.md"));
    expect(entries[0].rootRelativeManifestPath).toBe("alpha/SKILL.md");
  });

  test("a user skill with a built-in id SHADOWS it (user precedence) and is flagged", async () => {
    const builtin = await makeTmpDir("builtin");
    const user = await makeTmpDir("user");
    await writeManifest(builtin, "profile-overview", manifest("profile-overview", "built-in version"));
    await writeManifest(user, "profile-overview", manifest("profile-overview", "user-customized version"));
    await writeManifest(user, "only-user", manifest("only-user", "user only"));

    const { entries } = await buildSkillCatalog([
      { path: builtin, source: "builtin" },
      { path: user, source: "user" },
    ]);

    // One entry per id (deduped), user version won.
    const overview = entries.find((e) => e.id === "profile-overview");
    expect(overview?.source).toBe("user");
    expect(overview?.description).toBe("user-customized version");
    expect(overview?.shadowsBuiltin).toBe(true);
    // A non-colliding user skill is not flagged.
    expect(entries.find((e) => e.id === "only-user")?.shadowsBuiltin).toBe(false);
    expect(entries.map((e) => e.id)).toEqual(["only-user", "profile-overview"]);
  });

  test("precedence is independent of the input root order", async () => {
    const builtin = await makeTmpDir("builtin");
    const user = await makeTmpDir("user");
    await writeManifest(builtin, "shared", manifest("shared", "built-in"));
    await writeManifest(user, "shared", manifest("shared", "user"));

    // User-first input order must still yield the user version (precedence is
    // not "last root wins" — it is explicitly user > builtin).
    const { entries } = await buildSkillCatalog([
      { path: user, source: "user" },
      { path: builtin, source: "builtin" },
    ]);
    expect(entries[0].source).toBe("user");
    expect(entries[0].description).toBe("user");
    expect(entries[0].shadowsBuiltin).toBe(true);
  });

  test("malformed manifests are surfaced in errors and do not abort the catalog", async () => {
    const builtin = await makeTmpDir("builtin");
    const user = await makeTmpDir("user");
    await writeManifest(builtin, "good", manifest("good", "ok"));
    await writeManifest(user, "broken", "# no frontmatter at all");

    const { entries, errors } = await buildSkillCatalog([
      { path: builtin, source: "builtin" },
      { path: user, source: "user" },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("user");
    expect(errors[0].reason).toMatch(/frontmatter/);
  });

  test("the nine-skill fixture imports as one catalog of nine skills (S3 self-check)", async () => {
    await buildNineSkillFixture(tmpRoot);
    const { entries, errors } = await buildSkillCatalog([{ path: tmpRoot, source: "user" }]);
    expect(errors).toEqual([]);
    // Eight plain + one tricky (janitor-public-bio) = nine skills; the
    // shared-card-references dir (no SKILL.md) is NOT a skill.
    expect(entries).toHaveLength(9);
    expect(entries.find((e) => e.id === "janitor-public-bio")?.description).toMatch(/Builds and rewrites public bio/);
  });
});

// ─── filesystem entry semantics ──────────────────────────────────────────────

describe("scanSkillRoot — directory-entry characterization", () => {
  test("considers immediate real directories in localeCompare id order, including ordinary and staging/trash dot directories", async () => {
    const stagingId = ".~vt-skill-staging-interrupted";
    const trashId = ".~vt-skill-trash-interrupted";
    const ids = ["zeta-skill", ".hidden-skill", "alpha-skill", stagingId, trashId];
    for (const id of ids) {
      await writeManifest(tmpRoot, id, manifest(id, `Description for ${id}.`));
    }
    await mkdir(join(tmpRoot, "nested-only", "child-skill"), { recursive: true });
    await Bun.write(join(tmpRoot, "nested-only", "child-skill", "SKILL.md"), manifest("child-skill", "nested only"));
    await Bun.write(join(tmpRoot, "plain-file.md"), "not a directory");

    const { skills, errors } = await scanSkillRoot({ path: tmpRoot, source: "user" });

    // listSkillDirs sorts with localeCompare; preserve that exact current contract.
    expect(skills.map((skill) => skill.id)).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(errors).toEqual([]);
    expect(skills.map((skill) => skill.id)).not.toContain("nested-only");
    // OBSERVED PLAN DIVERGENCE: this scanner does not exclude the library's
    // staging/trash prefixes or ordinary hidden directory names.
    expect(skills.map((skill) => skill.id)).toEqual(expect.arrayContaining([".hidden-skill", stagingId, trashId]));
  });

  test("rejects escaping and dangling manifest links, while silently excluding symlinked skill directories", async () => {
    const outsideRoot = await makeTmpDir("outside");
    await writeManifest(tmpRoot, "real-skill", manifest("real-skill", "real"));
    await writeManifest(outsideRoot, "outside-skill", manifest("outside-skill", "outside"));
    const linkedSkillDir = join(tmpRoot, "linked-skill");
    const danglingSkillDir = join(tmpRoot, "dangling-skill");
    const linkedManifestDir = join(tmpRoot, "linked-manifest");
    const danglingManifestDir = join(tmpRoot, "dangling-manifest");
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await Promise.all([mkdir(linkedManifestDir), mkdir(danglingManifestDir)]);
    // Deliberately uncaught: a runner without symlink permission fails this gate.
    symlinkSync(join(outsideRoot, "outside-skill"), linkedSkillDir, directoryLinkType);
    symlinkSync(join(outsideRoot, "missing-skill"), danglingSkillDir, directoryLinkType);
    symlinkSync(join(outsideRoot, "outside-skill", "SKILL.md"), join(linkedManifestDir, "SKILL.md"), "file");
    symlinkSync(join(outsideRoot, "missing-manifest.md"), join(danglingManifestDir, "SKILL.md"), "file");

    const { skills, errors } = await scanSkillRoot({ path: tmpRoot, source: "user" });

    expect(skills.map((skill) => skill.id)).toEqual(["real-skill"]);
    expect(errors).toEqual([
      { source: "user", skillDir: danglingManifestDir, reason: "manifest SKILL.md is a symlink (rejected)" },
      { source: "user", skillDir: linkedManifestDir, reason: "manifest SKILL.md is a symlink (rejected)" },
    ]);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  await writeFile(path, text, "utf8");
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
  await writeFile(join(creatorDir, "assets", "character-template.md"), "# Template\n...", "utf8");
  await writeFile(join(creatorDir, "references", "creation-rules.md"), "# Rules\n...", "utf8");

  // Shared sibling references directory with NO SKILL.md — not a skill.
  const sharedDir = join(root, "shared-card-references");
  await mkdir(sharedDir, { recursive: true });
  await writeFile(join(sharedDir, "evaluation-principles.md"), "# Evaluation principles", "utf8");
  await writeFile(join(sharedDir, "patterns-personality.md"), "# Personality patterns", "utf8");
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
  test("resolveBuiltinSkillsRoot points at the converted built-in tree and finds the five skills", async () => {
    const root = await resolveBuiltinSkillsRoot();
    const { skills, errors } = await scanSkillRoot({ path: root, source: "builtin" });
    expect(errors).toEqual([]);
    expect(skills.map((s) => s.id).sort()).toEqual([
      "dialogue-generation",
      "general-writing",
      "personality-deepen",
      "profile-analysis",
      "profile-overview",
    ]);
    // The two skills that already carried frontmatter keep their parsed names.
    const overview = skills.find((s) => s.id === "profile-overview");
    expect(overview?.description.length).toBeGreaterThan(0);
  });

  test("resolveUserSkillsRoot builds <dataDir>/coauthor/skills", () => {
    const root = resolveUserSkillsRoot(join(tmpRoot, "data"));
    expect(root.replace(/\\/g, "/").endsWith("data/coauthor/skills")).toBe(true);
  });
});

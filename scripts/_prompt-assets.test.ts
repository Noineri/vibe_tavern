import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyPromptAssets } from "./_prompt-assets.js";

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-prompt-assets-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Fixture assets tree shaped like the real services/api/assets layout. */
async function makeAssets(root: string): Promise<string> {
  const assets = join(root, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, "summary-ai-prompt.md"), "summary");
  await writeFile(join(assets, "regex-ai-prompt.md"), "regex");
  await mkdir(join(assets, "coauthor", "skills", "quick-draft"), { recursive: true });
  await writeFile(join(assets, "coauthor", "base.md"), "coauthor base");
  await writeFile(join(assets, "coauthor", "skills", "quick-draft", "SKILL.md"), "skill");
  await mkdir(join(assets, "experience-copilot", "skills", "grill-me"), { recursive: true });
  await writeFile(join(assets, "experience-copilot", "base.md"), "copilot base");
  await writeFile(join(assets, "experience-copilot", "skills", "grill-me", "SKILL.md"), "grill");
  await mkdir(join(assets, "tokenizers"), { recursive: true });
  await writeFile(join(assets, "tokenizers", "tokenizer.json"), "{}");
  return assets;
}

describe("copyPromptAssets", () => {
  test("copies flat .md files AND every nested prompt tree (coauthor + experience-copilot), skips tokenizers", async () => {
    const root = await makeTempDir();
    const assets = await makeAssets(root);
    const target = join(root, "out", "prompts");

    const targets = await copyPromptAssets(assets, target);

    // The regression this pins: the copilot tree MUST arrive in every artifact.
    expect(await Bun.file(join(target, "experience-copilot", "base.md")).text()).toBe("copilot base");
    expect(await Bun.file(join(target, "experience-copilot", "skills", "grill-me", "SKILL.md")).text()).toBe("grill");
    expect(await Bun.file(join(target, "coauthor", "skills", "quick-draft", "SKILL.md")).text()).toBe("skill");
    expect(await Bun.file(join(target, "summary-ai-prompt.md")).text()).toBe("summary");
    expect(await Bun.file(join(target, "regex-ai-prompt.md")).text()).toBe("regex");
    // tokenizers have their own per-script target — never swept in here.
    expect(await Bun.file(join(target, "tokenizers", "tokenizer.json")).exists()).toBe(false);
    expect(targets.some((p) => p.endsWith("experience-copilot"))).toBe(true);
  });

  test("a NEW nested prompt tree added tomorrow is included without touching packagers", async () => {
    const root = await makeTempDir();
    const assets = await makeAssets(root);
    await mkdir(join(assets, "future-feature"), { recursive: true });
    await writeFile(join(assets, "future-feature", "prompt.md"), "future");
    const target = join(root, "out2");
    await copyPromptAssets(assets, target);
    expect(await Bun.file(join(target, "future-feature", "prompt.md")).text()).toBe("future");
  });

  test("empty assets dir (no flat .md) aborts the copy — historical build guard", async () => {
    const root = await makeTempDir();
    const assets = join(root, "empty-assets");
    await mkdir(assets, { recursive: true });
    await expect(copyPromptAssets(assets, join(root, "out3"))).rejects.toThrow(/No \.md prompt files found/);
  });
});

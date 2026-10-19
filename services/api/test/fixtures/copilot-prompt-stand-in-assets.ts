/**
 * Stand-in prompt assets for the Experience-Copilot prompt pins (S2-0a).
 *
 * WHY: the byte/SHA pins of the Copilot system prompt exist to catch drift in
 * HOW the prompt is assembled — which sections, in what order, which blocks
 * the code inserts (skill-catalog frame, RU label map, API-reference headers,
 * context package, digest, plan). They are NOT meant to freeze the prose of
 * the asset `.md` files: a prose edit to `base.md` is an intentional change and
 * used to force a mechanical re-capture of every pin, so the pins protected
 * only against code changes while costing a re-capture per asset edit.
 *
 * HOW: the pinned runs execute inside {@link withStandInAssets}, which points
 * the loader's documented env override (`VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR`,
 * first rung of the `resolvePromptAssetPath` ladder) at a temp directory holding
 * one short marker text per asset, e.g. `[[asset:base.md]]`. Every asset the
 * assembler reads goes through that ladder:
 * - `base.md` — via `resolveBuiltinCopilotProfile` (`loadPromptAsset`);
 * - `interactive-rules.md`, `interactive-visual.md`, `experience-copilot/user-flow.md`
 *   — via `resolveRef` in `experience-copilot-prompt.ts` (`loadPromptAsset` when
 *   no DB handle is given, `resolveServicePromptText` -> `loadPromptAsset` for
 *   the default profile otherwise);
 * - the skill manifests (`description` is the catalog line) — the skills root is
 *   located through `resolvePromptAssetPath`, so the whole root moves with it.
 *
 * A moved, dropped, or duplicated section changes the order/occurrence of the
 * markers; a changed code-built block changes its own bytes. Prose inside the
 * real assets changes nothing the pins see. {@link standInAssetNames} lists the
 * files the stand-in directory MUST contain: if one were missing, the ladder
 * would silently fall through to the real asset and prose would leak into the
 * pin again — the "every asset resolves inside the stand-in directory" test in
 * `experience-copilot-prompt.test.ts` guards that, next to the "every real
 * asset loads non-empty" test.
 *
 * Like the real assets, every stand-in ends with a single `\n`.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ENV_KEY = "VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR";

/** Skill ids shipped in the built-in copilot skills root. */
export const STAND_IN_SKILL_IDS = ["experience-authoring", "grill-me"] as const;

/** Plain-text assets: relative path under the asset root -> stand-in text. */
const PLAIN_ASSETS: Readonly<Record<string, string>> = {
  "experience-copilot/base.md": "[[asset:base.md]]\n",
  "interactive-rules.md": "[[asset:interactive-rules.md]]\n",
  "interactive-visual.md": "[[asset:interactive-visual.md]]\n",
  "experience-copilot/user-flow.md": "[[asset:user-flow.md]]\n",
};

function skillManifest(id: string): string {
  return `---\nname: ${id}\ndescription: "[[skill-description:${id}]]"\n---\n[[skill-body:${id}]]\n`;
}

/** Relative asset paths the stand-in directory contains (and the prompt reads). */
export function standInAssetNames(): string[] {
  return [
    ...Object.keys(PLAIN_ASSETS),
    ...STAND_IN_SKILL_IDS.map((id) => `experience-copilot/skills/${id}/SKILL.md`),
  ];
}

async function writeStandIns(root: string): Promise<void> {
  const files: Array<[string, string]> = [
    ...Object.entries(PLAIN_ASSETS),
    ...STAND_IN_SKILL_IDS.map((id): [string, string] => [
      `experience-copilot/skills/${id}/SKILL.md`,
      skillManifest(id),
    ]),
  ];
  for (const [rel, text] of files) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

/**
 * Run `fn` with the prompt-asset loader pointed at the stand-in directory.
 * The env var is restored (or removed) and the directory deleted in `finally`,
 * so nothing leaks into sibling tests sharing the process.
 */
export async function withStandInAssets<T>(fn: (standInRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "vt-copilot-stand-ins-"));
  const original = process.env[ENV_KEY];
  try {
    await writeStandIns(root);
    process.env[ENV_KEY] = root;
    return await fn(root);
  } finally {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    await rm(root, { recursive: true, force: true });
  }
}

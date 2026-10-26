/**
 * Parse pin for the tracker-template teaching asset (R7).
 *
 * The asset's final worked example is the exact shape the background delegate
 * is taught to emit, and delegate output is validated by the same strict
 * `trackerTemplateSchema` — so the taught example must parse through it
 * forever. This extracts the LAST fenced ```json block (the full worked
 * example, not the minimal shape in the output contract) and pins: parse
 * success, at least one node carrying `tone`, and at least one string node
 * carrying `toneBy` (the R7 tone teaching must stay demonstrated).
 */
import { describe, expect, it } from "bun:test";
import { trackerTemplateSchema } from "@vibe-tavern/api-contracts";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";

const ASSET_FILE = "tracker-template.md";

/** All ```json fenced blocks in the asset, in document order. */
function jsonBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

/**
 * Structural probe for walking parsed schema nodes without coupling to the
 * exact zod infer type — the walk only needs the tone fields and the two
 * nesting shapes.
 */
interface ToneProbeNode {
  $type: string;
  tone?: string;
  toneBy?: Record<string, string>;
  properties?: Record<string, ToneProbeNode>;
  items?: ToneProbeNode;
}

/** Depth-first node list of a parsed schema (objects → properties, arrays → items). */
function collectNodes(nodes: ToneProbeNode[], into: ToneProbeNode[] = []): ToneProbeNode[] {
  for (const node of nodes) {
    into.push(node);
    if (node.$type === "object" && node.properties) collectNodes(Object.values(node.properties), into);
    else if (node.$type === "array" && node.items) collectNodes([node.items], into);
  }
  return into;
}

describe("tracker-template asset (R7)", () => {
  it("the final worked example parses through trackerTemplateSchema and carries tone hints", async () => {
    const asset = await loadPromptAsset(ASSET_FILE);
    const blocks = jsonBlocks(asset);
    expect(blocks.length).toBeGreaterThan(1);

    const parsed: unknown = JSON.parse(blocks[blocks.length - 1]!);
    const result = trackerTemplateSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`asset worked example failed trackerTemplateSchema: ${detail}`);
    }
    if (!result.data.scene) throw new Error("asset worked example has no scene section");

    const nodes = collectNodes(Object.values(result.data.scene.config.schema as Record<string, ToneProbeNode>));
    expect(nodes.some((node) => node.tone !== undefined)).toBe(true);
    expect(nodes.some((node) => node.$type === "string" && node.toneBy !== undefined)).toBe(true);
  });
});

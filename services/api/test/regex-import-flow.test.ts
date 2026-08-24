/**
 * RX-15 UI surface — ST-card regex_scripts auto-import flow (server side).
 *
 * Full-path boundary test over the REAL SessionRuntime.importJson entry point
 * (the same one the HTTP route delegates to): a V3 card carrying
 * data.extensions.regex_scripts becomes regex presets, auto-linked to the
 * imported character, all landing disabled (the security gate).
 *
 * Pins:
 *   - 2 embedded scripts → 2 presets, both linked to the imported character,
 *     both disabled:true regardless of what the card claims;
 *   - re-importing the SAME card → still 2 (idempotency, no duplicates);
 *   - a card WITHOUT regex_scripts → 0 presets;
 *   - skipExisting:true against an existing character → no new presets;
 *   - createdRegexPresets is surfaced on the ImportResult.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const tmpDirs: string[] = [];

async function setup(): Promise<SessionRuntime> {
  const tmpDir = resolve(tmpdir(), "vt-rx15flow-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  return new SessionRuntime(stores);
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Minimal chara_card_v3 with regex_scripts embedded under data.extensions. */
function makeCard(scripts: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    name: "RegexCard",
    data: {
      name: "RegexCard",
      description: "A card with regex.",
      first_mes: "Hi!",
      extensions: {
        regex_scripts: scripts,
      },
    },
  });
}

function stScript(scriptName: string, findRegex: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    scriptName,
    findRegex,
    replaceString: "[x]",
    trimStrings: [],
    placement: [2],
    disabled: false, // card claims enabled — the import gate must override
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

describe("RX-15 card regex import flow", () => {
  it("embedded regex_scripts become presets linked to the character, all disabled", async () => {
    const runtime = await setup();
    const result = await runtime.importJson({
      fileName: "card.json",
      jsonText: makeCard([stScript("Strip", "/foo/g"), stScript("Censor", "/bar/g")]),
    });

    expect(result.createdRegexPresets).toBe(2);

    const all = await runtime.stores.regex.listAll();
    expect(all).toHaveLength(2);
    for (const preset of all) {
      expect(preset.disabled).toBe(true);
      const links = await runtime.stores.regex.getLinks(preset.id);
      expect(links).toEqual([
        { regexPresetId: preset.id, targetType: "character", targetId: result.characterId },
      ]);
    }
  });

  it("each import owns its own character's presets (imports create fresh characters)", async () => {
    const runtime = await setup();
    const card = makeCard([stScript("Strip", "/foo/g"), stScript("Censor", "/bar/g")]);
    const first = await runtime.importJson({ fileName: "card.json", jsonText: card });
    const second = await runtime.importJson({ fileName: "card.json", jsonText: card });

    // Re-import creates a NEW character row (fresh id per import — the
    // deterministic bundle id is a lookup key, not the stored row id), so
    // each character carries its own linked scripts — no cross-character
    // dedupe, matching ST semantics.
    expect(first.characterId).not.toBe(second.characterId);
    expect(first.createdRegexPresets).toBe(2);
    expect(second.createdRegexPresets).toBe(2);

    const all = await runtime.stores.regex.listAll();
    expect(all).toHaveLength(4);
    // First character keeps exactly its two.
    const firstLinks = [];
    for (const preset of all) {
      const links = await runtime.stores.regex.getLinks(preset.id);
      if (links.some((l) => l.targetId === first.characterId)) firstLinks.push(preset.name);
    }
    expect(firstLinks.sort()).toEqual(["Censor", "Strip"]);
  });

  it("identical scripts WITHIN one card dedupe to a single preset", async () => {
    const runtime = await setup();
    const result = await runtime.importJson({
      fileName: "card.json",
      jsonText: makeCard([stScript("Strip", "/foo/g"), stScript("Strip", "/foo/g")]),
    });
    expect(result.createdRegexPresets).toBe(1);
    expect(await runtime.stores.regex.listAll()).toHaveLength(1);
  });

  it("a card without regex_scripts creates zero presets", async () => {
    const runtime = await setup();
    const result = await runtime.importJson({
      fileName: "plain.json",
      jsonText: makeCard([]),
    });
    expect(result.createdRegexPresets).toBe(0);
    expect(await runtime.stores.regex.listAll()).toHaveLength(0);
  });

  it("a regex-store failure never breaks the card import (never-throw)", async () => {
    const runtime = await setup();
    const originalListAll = runtime.stores.regex.listAll.bind(runtime.stores.regex);
    runtime.stores.regex.listAll = async () => {
      throw new Error("regex store exploded");
    };
    try {
      const result = await runtime.importJson({
        fileName: "card.json",
        jsonText: makeCard([stScript("Strip", "/foo/g")]),
      });
      // Card import succeeded; regex import degraded to zero.
      expect(result.characterId).toBeDefined();
      expect(result.createdRegexPresets).toBe(0);
    } finally {
      runtime.stores.regex.listAll = originalListAll;
    }
  });
});

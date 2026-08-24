import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  REGEX_PLACEMENT,
  REGEX_SUBSTITUTE,
  REGEX_TARGET_TYPE,
  brandId,
  type ActiveLoreEntry,
  type ChatBranchId,
  type ChatId,
} from "@vibe-tavern/domain";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";

// ════════════════════════════════════════════════════════════════════════════
// RX-9 (REGEX_EXTENSION_PLAN, Wave 2b) — WORLD_INFO hook.
//
// Full-path boundary test through the REAL StaticPromptResolver +
// RegexHookService over real stores (no provider executors involved — no
// mock.module needed). Pins:
//
//   - persist-mode WORLD_INFO preset transforms the ACTIVATED entry content
//     in the resolver's output while the lorebook ROW stays original (lore
//     content is shared content, NOT a chat variant — no DB write);
//   - prompt-only ALSO transforms here (every prompt-affecting apply-target:
//     persist / prompt / display_prompt; only display-only is excluded);
//   - display-only does NOT transform;
//   - disabled preset / invalid pattern: no-op, no throw;
//   - {{char}} in a find pattern with substituteRegex RAW resolves against
//     the resolver's own macroMap (reused, not rebuilt);
//   - no presets at all: entries pass through byte-for-byte, and the service
//     returns the SAME array reference (pinned with toBe at the service seam).
// ════════════════════════════════════════════════════════════════════════════

const tmpDirs: string[] = [];

interface TestWorld {
  stores: Awaited<ReturnType<typeof createRuntimeStore>>;
  resolver: StaticPromptResolver;
  service: RegexHookService;
  chatId: ChatId;
  branchId: string;
  characterId: string;
  lorebookId: string;
  entryId: string;
  entryContent: string;
}

/** Scan-trigger message content: the entry's key ("tavern") must activate. */
const SCAN_MESSAGE = "the tavern feels warm tonight";

async function setup(
  options: { characterName?: string; entryContent?: string; entryKeys?: string[] } = {},
): Promise<TestWorld> {
  const tmpDir = resolve(tmpdir(), "vt-rx9-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);

  const character = await stores.characters.create({
    name: options.characterName ?? "LoreProbe",
    firstMessage: "Hi!",
  });
  const persona = await stores.personas.getDefault();
  const chat = await stores.chats.createChat({
    characterId: character.id,
    personaId: persona?.id,
    title: "RX-9 test",
    promptPresetId: null,
    mode: "rp",
  });

  // A user message in the branch so the activation scan has text to match.
  await stores.messages.addMessage({
    chatId: chat.id,
    branchId: chat.activeBranchId,
    role: "user",
    authorType: "user",
    content: SCAN_MESSAGE,
  });

  // Character-scoped lorebook with one keyed entry.
  const lorebook = await stores.lorebooks.createLorebook({
    name: "RX-9 lore",
    scopeType: "character",
    characterId: character.id,
  });
  const entry = await stores.lorebooks.createEntry(lorebook.id, {
    title: "Tavern",
    content: options.entryContent ?? "The tavern has a secret room.",
    keys: options.entryKeys ?? ["tavern"],
  });

  const service = new RegexHookService(stores);
  const resolver = new StaticPromptResolver(stores, service);

  return {
    stores,
    resolver,
    service,
    chatId: brandId<ChatId>(chat.id),
    branchId: chat.activeBranchId,
    characterId: character.id,
    lorebookId: lorebook.id,
    entryId: entry.id,
    entryContent: entry.content,
  };
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function listActive(world: TestWorld): Promise<ActiveLoreEntry[]> {
  const entries = await world.resolver.listActiveLoreEntries({
    chatId: world.chatId,
    branchId: brandId<ChatBranchId>(world.branchId),
    recentText: SCAN_MESSAGE,
  });
  // The scan message contains the entry key — the entry MUST activate for
  // these tests to exercise the transform path at all.
  expect(entries.length).toBeGreaterThan(0);
  return entries;
}

/** Full field set minus store-generated columns (CreateRegexPresetData). */
function presetInput(overrides: Record<string, unknown>) {
  return {
    name: "preset",
    findRegex: "/nope/g",
    replaceString: "",
    trimStrings: [] as string[],
    substituteRegex: REGEX_SUBSTITUTE.None,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [REGEX_PLACEMENT.WorldInfo],
    isGlobal: false,
    sortOrder: 0,
    ...overrides,
  };
}

async function storedEntryContent(world: TestWorld): Promise<string> {
  const row = await world.stores.lorebooks.getEntry(world.entryId);
  if (!row) throw new Error("entry vanished from the lorebook store");
  return row.content;
}

// ════════════════════════════════════════════════════════════════════════════

describe("RX-9 WORLD_INFO — persist-mode transform", () => {
  it("transforms activated entry content; lorebook row stays original", async () => {
    const world = await setup({
      entryContent: "Secret: <!-- dev note: cut before shipping --> real lore",
    });
    const preset = await world.stores.regex.create(presetInput({
      name: "strip HTML comments",
      findRegex: "/<!--[\\s\\S]*?-->/g",
      replaceString: "",
    }));
    await world.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, world.characterId);

    const entries = await listActive(world);
    expect(entries[0].content).toBe("Secret:  real lore");

    // The shared lorebook row was NOT rewritten.
    expect(await storedEntryContent(world)).toBe(
      "Secret: <!-- dev note: cut before shipping --> real lore",
    );
  });
});

describe("RX-9 WORLD_INFO — apply-target mode rules", () => {
  it("prompt-only preset ALSO transforms (prompt-affecting mode)", async () => {
    const world = await setup({ entryContent: "plain secret room" });
    const preset = await world.stores.regex.create(presetInput({
      name: "prompt-only secrecy",
      findRegex: "/secret/g",
      replaceString: "[redacted]",
      promptOnly: true,
    }));
    await world.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, world.characterId);

    const entries = await listActive(world);
    expect(entries[0].content).toBe("plain [redacted] room");
    expect(await storedEntryContent(world)).toBe("plain secret room");
  });

  it("display-only preset does NOT transform (the sole exclusion)", async () => {
    const world = await setup({ entryContent: "plain secret room" });
    const preset = await world.stores.regex.create(presetInput({
      name: "display-only secrecy",
      findRegex: "/secret/g",
      replaceString: "[redacted]",
      markdownOnly: true,
    }));
    await world.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, world.characterId);

    const entries = await listActive(world);
    expect(entries[0].content).toBe("plain secret room");
    expect(await storedEntryContent(world)).toBe("plain secret room");
  });
});

describe("RX-9 WORLD_INFO — degradation cases", () => {
  it("disabled preset: no-op", async () => {
    const world = await setup({ entryContent: "plain secret room" });
    const preset = await world.stores.regex.create(presetInput({
      name: "disabled secrecy",
      findRegex: "/secret/g",
      replaceString: "[redacted]",
      disabled: true,
    }));
    await world.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, world.characterId);

    const entries = await listActive(world);
    expect(entries[0].content).toBe("plain secret room");
  });

  it("invalid find pattern: preset skipped by the engine, no throw", async () => {
    const world = await setup({ entryContent: "plain secret room" });
    const preset = await world.stores.regex.create(presetInput({
      name: "broken pattern",
      findRegex: "/([/g",
      replaceString: "[redacted]",
    }));
    await world.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, world.characterId);

    const entries = await listActive(world);
    expect(entries[0].content).toBe("plain secret room");
  });
});

describe("RX-9 WORLD_INFO — macro source wiring", () => {
  it("substituteRegex RAW resolves {{char}} from the resolver's macroMap", async () => {
    const world = await setup({
      characterName: "MacroKeeper",
      entryContent: "MacroKeeper's cellar is damp",
      entryKeys: ["cellar"],
    });
    await world.stores.messages.addMessage({
      chatId: world.chatId as string,
      branchId: world.branchId,
      role: "user",
      authorType: "user",
      content: "about the cellar please",
    });
    const preset = await world.stores.regex.create(presetInput({
      name: "{{char}}'s → THE",
      findRegex: "/{{char}}'s/g",
      replaceString: "THE",
      substituteRegex: REGEX_SUBSTITUTE.Raw,
    }));
    await world.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, world.characterId);

    const entries = await listActive(world);
    expect(entries[0].content).toBe("THE cellar is damp");
  });
});

describe("RX-9 WORLD_INFO — identity when nothing applies", () => {
  it("no presets at all: resolver output matches the entry content byte-for-byte", async () => {
    const world = await setup();
    const entries = await listActive(world);
    expect(entries[0].content).toBe(world.entryContent);
  });

  it("service seam: same array AND element references returned when nothing applies", async () => {
    const world = await setup();
    const entries = await listActive(world);
    const result = await world.service.transformWorldInfo(
      world.chatId as string,
      entries,
      { characterId: world.characterId, presetId: null, macroMap: { "{{char}}": "LoreProbe" } },
    );
    expect(result).toBe(entries);
    expect(result[0]).toBe(entries[0]);
  });
});

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  brandId,
  REGEX_PLACEMENT,
  REGEX_SUBSTITUTE,
  REGEX_TARGET_TYPE,
  type ChatBranchId,
  type ChatId,
} from "@vibe-tavern/domain";
import { assemblePrompt, buildPromptVariableContext, createFullMacroEngine } from "@vibe-tavern/prompt-pipeline";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";

/**
 * ST P16 macro parity: world-info keys use the shared full macro engine, and
 * committed content is macro-expanded before it enters recursion or the
 * WORLD_INFO regex hook (ST world-info.js:4803-4804, 4938-4939, 5020-5024).
 *
 * Local harness fork of the sibling lore-activation suites' makeEntry /
 * makeInput (tri-state-matching carries the canonical copy).
 */

function makeEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    content: `content of ${id}`,
    keys: [] as string[],
    secondaryKeys: [] as string[],
    logic: "and_any",
    position: "before_char",
    depth: 0,
    priority: 100,
    stickyWindow: 0,
    cooldownWindow: 0,
    minChatMessages: 0,
    constant: false,
    probability: 100,
    ignoreBudget: false,
    role: "system",
    groupName: "",
    groupWeight: 0,
    prioritizeInclusion: false,
    useGroupScoring: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    recursionLevel: 0,
    scanDepthOverride: null,
    caseSensitive: null,
    matchWholeWords: null,
    characterFilter: [] as Array<{ id: string | null; name: string }>,
    characterFilterExclude: false,
    matchSources: [] as string[],
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

function macroResolver() {
  const engine = createFullMacroEngine();
  const context = buildPromptVariableContext({
    character: { name: "Keeper", description: "basalt archive" },
    persona: { name: "Reader", description: "caretaker ledger" },
  });
  return (text: string) => engine.resolve(text, context);
}

function makeInput(
  entries: ReturnType<typeof makeEntry>[],
  text: string,
  lorebookOverrides: Record<string, unknown> = {},
): ActivationInput & { resolveMacros: (value: string) => string } {
  return {
    lorebooks: [{
      id: "lb_test",
      scanDepth: 1,
      tokenBudget: 100_000,
      tokenBudgetPercent: null,
      recursiveScanning: false,
      maxRecursionSteps: 0,
      includeNames: false,
      minActivations: 0,
      minActivationsDepthMax: 0,
      entries,
      ...lorebookOverrides,
    }],
    messages: [{ role: "user", content: text }],
    macroMap: {},
    resolveMacros: macroResolver(),
    characterId: "c_test",
    characterName: "Keeper",
    activationState: {},
    currentTurn: 1,
  };
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
  return result.activatedEntries.map((entry) => entry.id).sort();
}

const tmpDirs: string[] = [];
const databases: Array<{ close(): void }> = [];

async function makeResolverWorld(entryContent: string) {
  const tmpDir = resolve(tmpdir(), `vt-lore-macros-${crypto.randomUUID().slice(0, 8)}`);
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  databases.push(stores.db.$client);
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);

  const persona = await stores.personas.getDefault();
  if (!persona) throw new Error("default persona was not created");
  await stores.personas.update(persona.id, {
    name: "Reader",
    description: "caretaker ledger",
  });
  const character = await stores.characters.create({
    name: "Keeper",
    description: "basalt archive",
    firstMessage: "Hello",
  });
  const chat = await stores.chats.createChat({
    characterId: character.id,
    personaId: persona.id,
    title: "macro ordering",
    promptPresetId: null,
    mode: "rp",
  });
  await stores.messages.addMessage({
    chatId: chat.id,
    branchId: chat.activeBranchId,
    role: "user",
    authorType: "user",
    content: "open the archive",
  });
  const lorebook = await stores.lorebooks.createLorebook({
    name: "macro lore",
    scopeType: "entity",
    characterId: character.id,
  });
  await stores.lorebooks.createEntry(lorebook.id, {
    title: "Archive",
    content: entryContent,
    keys: ["archive"],
  });

  return {
    stores,
    resolver: new StaticPromptResolver(stores, new RegexHookService(stores)),
    chatId: brandId<ChatId>(chat.id),
    branchId: brandId<ChatBranchId>(chat.activeBranchId),
    characterId: character.id,
  };
}

async function removeTestDirectory(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    // bun:sqlite can retain the final connection briefly on Windows; the
    // official spot-runner owns and sweeps this private TEMP root on exit.
    if (!(error instanceof Error && "code" in error && error.code === "EBUSY")) throw error;
  }
}

afterAll(async () => {
  for (const database of databases) database.close();
  await Promise.all(tmpDirs.map(removeTestDirectory));
});

describe("lore activation engine — full macro resolution (P16)", () => {
  it("matches non-identity full-engine macros in keys only after expansion", () => {
    const entries = [
      makeEntry("persona_key", { keys: ["{{persona}}"] }),
      makeEntry("description_key", { keys: ["{{description}}"] }),
    ];

    expect(activatedIds(resolveActivatedEntries(makeInput(entries, "caretaker ledger / basalt archive")))).toEqual([
      "description_key",
      "persona_key",
    ]);
    expect(activatedIds(resolveActivatedEntries(makeInput(entries, "{{persona}} / {{description}}")))).toEqual([]);
  });

  it("seeds recursion with macro-expanded, decorator-stripped content", () => {
    const result = resolveActivatedEntries(makeInput([
      makeEntry("anchor", {
        keys: ["open"],
        content: "@@activate\nThe key is {{persona}}.",
      }),
      makeEntry("recursive_target", { keys: ["caretaker ledger"] }),
    ], "open", { recursiveScanning: true, maxRecursionSteps: 2 }));

    expect(activatedIds(result)).toEqual(["anchor", "recursive_target"]);
    expect(result.activatedEntries.find((entry) => entry.id === "anchor")?.content).toBe("The key is caretaker ledger.");
  });

  it("preserves macro-free lore and does not re-expand resolver-owned output in prompt assembly", () => {
    // Resolving {{char}} where the character name itself is "{{user}}" yields
    // this exact literal. A second assembly pass would incorrectly turn it
    // into Reader, so this pins exactly one lore-content expansion.
    const prompt = assemblePrompt({
      identity: { chatId: "macro_lore" },
      chat: { recentMessages: [] },
      character: { id: "character", name: "Keeper", description: "" },
      persona: { id: "persona", name: "Reader", description: "" },
      lore: [
        {
          id: "resolved_lore",
          title: "Resolved",
          content: "{{user}}",
          macrosResolved: true,
          priority: 100,
        },
        {
          id: "plain_lore",
          title: "Plain",
          content: "plain lore body",
          macrosResolved: true,
          priority: 100,
        },
      ],
    });

    expect(prompt.layers.find((layer) => layer.id === "lore_resolved_lore")?.text).toContain("{{user}}");
    expect(prompt.layers.find((layer) => layer.id === "lore_plain_lore")?.text).toBe("Lore: Plain\nplain lore body");
  });
});

describe("lore activation resolver — macro before WORLD_INFO regex (P16)", () => {
  it("hands fully expanded lore content to the WORLD_INFO regex hook", async () => {
    const world = await makeResolverWorld("{{persona}} | {{description}}");
    const preset = await world.stores.regex.create({
      name: "expanded lore marker",
      findRegex: "/caretaker ledger \\| basalt archive/g",
      replaceString: "expanded by regex",
      trimStrings: [],
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
    });
    await world.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, world.characterId);

    const result = await world.resolver.listActiveLoreEntries({
      chatId: world.chatId,
      branchId: world.branchId,
      recentText: "open the archive",
      scanMessages: [{ role: "user", content: "open the archive" }],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("expanded by regex");
  });

  it("keeps macro-free resolver output byte-identical", async () => {
    const world = await makeResolverWorld("plain lore body");
    const result = await world.resolver.listActiveLoreEntries({
      chatId: world.chatId,
      branchId: world.branchId,
      recentText: "open the archive",
      scanMessages: [{ role: "user", content: "open the archive" }],
    });

    expect(result.entries[0]?.content).toBe("plain lore body");
  });
});

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  brandId,
  type ChatBranchId,
  type ChatId,
} from "@vibe-tavern/domain";
import {
  resolveActivatedEntries,
  type ActivationInput,
  type LoreActivationState,
} from "../src/domain/prompt/lore-activation-engine.js";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";

function makeActivationInput(options: {
  activationState: LoreActivationState;
  currentTurn: number;
  dryRun?: boolean;
  stickyWindow?: number;
  messages?: Array<{ role: string; content: string }>;
}): ActivationInput {
  return {
    lorebooks: [{
      id: "lorebook",
      scanDepth: 1,
      tokenBudget: 10_000,
      tokenBudgetPercent: null,
      recursiveScanning: false,
      maxRecursionSteps: 0,
      includeNames: false,
      minActivations: 0,
      minActivationsDepthMax: 0,
      entries: [{
        id: "timed_entry",
        title: "Timed entry",
        content: "Timed lore",
        keys: ["needle"],
        secondaryKeys: [],
        logic: "and_any",
        position: "before_char",
        depth: 0,
        priority: 100,
        stickyWindow: options.stickyWindow ?? 0,
        cooldownWindow: 3,
        minChatMessages: 0,
        constant: false,
        probability: 100,
        ignoreBudget: false,
        role: "system",
        groupName: "",
        groupWeight: 100,
        prioritizeInclusion: false,
        useGroupScoring: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        recursionLevel: 0,
        scanDepthOverride: null,
        caseSensitive: false,
        matchWholeWords: false,
        characterFilter: [],
        characterFilterExclude: false,
        matchSources: [],
        enabled: true,
        sortOrder: 0,
      }],
    }],
    messages: options.messages ?? [{ role: "user", content: "no matching key" }],
    macroMap: {},
    characterId: "character",
    characterName: "Character",
    activationState: options.activationState,
    currentTurn: options.currentTurn,
    dryRun: options.dryRun,
  };
}

const tmpDirs: string[] = [];
const databases: Array<{ close(): void }> = [];

async function makeResolverWorld() {
  const tmpDir = resolve(tmpdir(), `vt-lore-dry-run-${crypto.randomUUID().slice(0, 8)}`);
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
  const character = await stores.characters.create({
    name: "Keeper",
    firstMessage: "Hello",
  });
  const chat = await stores.chats.createChat({
    characterId: character.id,
    personaId: persona?.id,
    title: "Dry run",
    promptPresetId: null,
    mode: "rp",
  });
  await stores.messages.addMessage({
    chatId: chat.id,
    branchId: chat.activeBranchId,
    role: "user",
    authorType: "user",
    content: "needle",
  });
  const lorebook = await stores.lorebooks.createLorebook({
    name: "Timed lore",
    scopeType: "entity",
  });
  await stores.lorebooks.addLink(lorebook.id, "character", character.id);
  const entry = await stores.lorebooks.createEntry(lorebook.id, {
    title: "Needle",
    content: "Matched lore",
    keys: ["needle"],
    stickyWindow: 3,
    cooldownWindow: 3,
  });

  return {
    stores,
    resolver: new StaticPromptResolver(stores, new RegexHookService(stores)),
    chatId: brandId<ChatId>(chat.id),
    branchId: brandId<ChatBranchId>(chat.activeBranchId),
    entryId: entry.id,
  };
}

async function branchStateJson(
  stores: Awaited<ReturnType<typeof createRuntimeStore>>,
  branchId: ChatBranchId,
): Promise<string> {
  const branch = await stores.chats.getBranch(branchId);
  if (!branch) throw new Error("test branch was not found");
  return JSON.stringify(branch.loreActivationState);
}

async function removeTestDirectory(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EBUSY")) throw error;
  }
}

afterAll(async () => {
  for (const database of databases) database.close();
  await Promise.all(tmpDirs.map(removeTestDirectory));
});

describe("lore activation — dry-run timed state", () => {
  it("shows a live sticky entry without pruning its same-turn state", () => {
    const activationState = {
      timed_entry: { activatedAtTurn: 4, lastMatchedAtTurn: 4 },
    };

    const result = resolveActivatedEntries(makeActivationInput({
      activationState,
      currentTurn: 4,
      stickyWindow: 3,
      dryRun: true,
    }));

    expect(result.activatedEntries.map((entry) => entry.id)).toEqual(["timed_entry"]);
    expect(result.updatedState).toEqual(activationState);
  });

  it("does not persist newly activated timed state from a dry resolver resolve", async () => {
    const world = await makeResolverWorld();
    const before = await branchStateJson(world.stores, world.branchId);

    const result = await world.resolver.listActiveLoreEntries({
      chatId: world.chatId,
      branchId: world.branchId,
      recentText: "needle",
      scanMessages: [{ role: "user", content: "needle" }],
      dryRun: true,
    });

    expect(result.entries.map((entry) => entry.id)).toEqual([world.entryId]);
    expect(await branchStateJson(world.stores, world.branchId)).toBe(before);
  });

  it("persists timed state for a normal generation resolve", async () => {
    const world = await makeResolverWorld();
    const before = await branchStateJson(world.stores, world.branchId);

    await world.resolver.listActiveLoreEntries({
      chatId: world.chatId,
      branchId: world.branchId,
      recentText: "needle",
      scanMessages: [{ role: "user", content: "needle" }],
    });

    expect(await branchStateJson(world.stores, world.branchId)).not.toBe(before);
  });

  it("activates from included chat-summary snapshots only", async () => {
    const world = await makeResolverWorld();
    const lorebook = await world.stores.lorebooks.createLorebook({
      name: "Summary lore",
      scopeType: "chat",
      chatId: world.chatId,
    });
    const included = await world.stores.lorebooks.createEntry(lorebook.id, {
      title: "Included summary",
      content: "Included summary lore",
      keys: ["included-summary-key"],
      matchSources: ["chat_summary"],
    });
    await world.stores.lorebooks.createEntry(lorebook.id, {
      title: "Excluded summary",
      content: "Excluded summary lore",
      keys: ["excluded-summary-key"],
      matchSources: ["chat_summary"],
    });
    await world.stores.chatSummaries.create({
      chatId: world.chatId,
      branchId: world.branchId,
      content: "included-summary-key",
      summarizedFrom: 1,
      summarizedTo: 1,
      includeInContext: true,
    });
    await world.stores.chatSummaries.create({
      chatId: world.chatId,
      branchId: world.branchId,
      content: "excluded-summary-key",
      summarizedFrom: 1,
      summarizedTo: 1,
      includeInContext: false,
    });

    const result = await world.resolver.listActiveLoreEntries({
      chatId: world.chatId,
      branchId: world.branchId,
      recentText: "",
      scanMessages: [],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual([included.id]);
  });
});

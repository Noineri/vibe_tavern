import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  brandId,
  type ChatBranchId,
  type ChatId,
} from "@vibe-tavern/domain";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";

const tmpDirs: string[] = [];
const databases: Array<{ close(): void }> = [];

const expectedByStrategy = {
  0: ["chat-high", "chat-low", "persona-high", "persona-low", "character-high", "global-high", "global-low", "character-low"],
  1: ["chat-high", "chat-low", "persona-high", "persona-low", "character-high", "character-low", "global-high", "global-low"],
  2: ["chat-high", "chat-low", "persona-high", "persona-low", "global-high", "global-low", "character-high", "character-low"],
} as const;

async function makeWorld(strategy: number, chatStrategy = strategy, includeBoundBooks = true) {
  const tmpDir = resolve(tmpdir(), `vt-lore-insertion-${crypto.randomUUID().slice(0, 8)}`);
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
  const character = await stores.characters.create({ name: "Keeper", firstMessage: "Hello" });
  const chat = await stores.chats.createChat({
    characterId: character.id,
    personaId: persona.id,
    title: "Insertion order",
    promptPresetId: null,
    mode: "rp",
  });

  const globalBook = await stores.lorebooks.createLorebook({
    name: "global",
    scopeType: "global",
    characterStrategy: strategy,
  });
  const chatBook = await stores.lorebooks.createLorebook({
    name: "chat",
    scopeType: "chat",
    chatId: chat.id,
    characterStrategy: chatStrategy,
  });
  const characterBook = includeBoundBooks
    ? await stores.lorebooks.createLorebook({
      name: "character",
      scopeType: "entity",
      characterStrategy: strategy,
    }).then(async (book) => {
      await stores.lorebooks.addLink(book.id, "character", character.id);
      return book;
    })
    : null;
  const personaBook = includeBoundBooks
    ? await stores.lorebooks.createLorebook({
      name: "persona",
      scopeType: "entity",
      characterStrategy: strategy,
    }).then(async (book) => {
      await stores.lorebooks.addLink(book.id, "persona", persona.id);
      return book;
    })
    : null;
  const entries = [
    [globalBook, "global-high", 800],
    [globalBook, "global-low", 200],
    [chatBook, "chat-high", 500],
    [chatBook, "chat-low", 400],
    ...(characterBook ? [[characterBook, "character-high", 900], [characterBook, "character-low", 100]] : []),
    ...(personaBook ? [[personaBook, "persona-high", 700], [personaBook, "persona-low", 600]] : []),
  ] as Array<[typeof globalBook, string, number]>;
  for (const [book, title, priority] of entries) {
    await stores.lorebooks.createEntry(book.id, {
      title,
      content: title,
      keys: [],
      constant: true,
      priority,
    });
  }

  return {
    resolver: new StaticPromptResolver(stores, new RegexHookService(stores)),
    chatId: brandId<ChatId>(chat.id),
    branchId: brandId<ChatBranchId>(chat.activeBranchId),
  };
}

async function activatedTitles(world: Awaited<ReturnType<typeof makeWorld>>): Promise<string[]> {
  const result = await world.resolver.listActiveLoreEntries({
    chatId: world.chatId,
    branchId: world.branchId,
    recentText: "",
    scanMessages: [],
  });
  return result.entries.map((entry) => entry.title);
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

describe("lore insertion ordering — ST character strategy (N7)", () => {
  for (const strategy of [0, 1, 2] as const) {
    it(`uses ST strategy ${strategy} for chat, persona, character, and global books`, async () => {
      const world = await makeWorld(strategy);
      expect(await activatedTitles(world)).toEqual(expectedByStrategy[strategy]);
    });
  }

  for (const strategy of [0, 1, 2] as const) {
    it(`keeps chat then global ordering deterministic without persona or character books for strategy ${strategy}`, async () => {
      const world = await makeWorld(strategy, strategy, false);
      expect(await activatedTitles(world)).toEqual(["chat-high", "chat-low", "global-high", "global-low"]);
    });
  }

  it("uses the chat-bound book strategy when active books disagree", async () => {
    const world = await makeWorld(1, 2);
    expect(await activatedTitles(world)).toEqual(expectedByStrategy[2]);
  });
});

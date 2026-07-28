import { describe, expect, mock, test } from "bun:test";
import {
  loadPromptCanvasLoreEntries,
  type PromptCanvasLoreLoadDeps,
} from "./prompt-canvas-lore.js";

function deps(): PromptCanvasLoreLoadDeps {
  return {
    listLorebooks: mock(async (scopeType: string) => {
      if (scopeType === "global") {
        return [
          { id: "global", name: "Global Book", enabled: true },
          { id: "disabled", name: "Disabled Book", enabled: false },
        ];
      }
      if (scopeType === "character") {
        return [
          { id: "character", name: "Character Book", enabled: true },
          { id: "global", name: "Global Book", enabled: true },
        ];
      }
      if (scopeType === "persona") {
        return [{ id: "persona", name: "Persona Book", enabled: true }];
      }
      return [{ id: "chat", name: "Chat Book", enabled: true }];
    }),
    listLoreEntries: mock(async (lorebookId: string) => [
      {
        id: `${lorebookId}-before`,
        lorebookId,
        title: `${lorebookId} before`,
        position: "before_char",
        enabled: true,
        priority: 10,
        sortOrder: 0,
        content: "before content",
        keys: ["rose", "thorn"],
        secondaryKeys: ["petal"],
        logic: "AND(any)",
        constant: false,
        probability: 100,
        role: "system",
      },
      {
        id: `${lorebookId}-after`,
        lorebookId,
        title: `${lorebookId} after`,
        position: "after_char",
        enabled: true,
        priority: 20,
        sortOrder: 1,
        content: "after content",
        keys: ["moon"],
        secondaryKeys: [],
        logic: "AND(any)",
        constant: true,
        probability: 80,
        role: "system",
      },
      {
        id: `${lorebookId}-disabled`,
        lorebookId,
        title: "disabled entry",
        position: "before_char",
        enabled: false,
        priority: 30,
        sortOrder: 2,
      },
      {
        id: `${lorebookId}-depth`,
        lorebookId,
        title: "depth entry",
        position: "at_depth",
        enabled: true,
        priority: 40,
        sortOrder: 3,
      },
    ]),
  };
}

describe("loadPromptCanvasLoreEntries", () => {
  test("mirrors active-chat scopes, deduplicates books, and keeps enabled anchor entries", async () => {
    const api = deps();
    const result = await loadPromptCanvasLoreEntries({
      chatId: "chat-1",
      characterId: "char-1",
      personaId: "persona-1",
    }, api);

    expect(api.listLorebooks).toHaveBeenCalledTimes(4);
    expect(api.listLorebooks).toHaveBeenCalledWith("global");
    expect(api.listLorebooks).toHaveBeenCalledWith("character", "char-1");
    expect(api.listLorebooks).toHaveBeenCalledWith("persona", "persona-1");
    expect(api.listLorebooks).toHaveBeenCalledWith("chat", "chat-1");

    // Four unique enabled books × two enabled anchor positions. The duplicate
    // global book is loaded once; disabled books and non-anchor entries vanish.
    expect(api.listLoreEntries).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({
      id: "global-before",
      lorebookId: "global",
      lorebookName: "Global Book",
      title: "global before",
      position: "before_char",
      priority: 10,
      sortOrder: 0,
      content: "before content",
      keys: ["rose", "thorn"],
      secondaryKeys: ["petal"],
      logic: "AND(any)",
      constant: false,
      probability: 100,
      role: "system",
    });
    expect(result.some((entry) => entry.title === "disabled entry")).toBe(false);
    expect(result.some((entry) => entry.title === "depth entry")).toBe(false);
  });

  test("omits the persona scope when the chat has no bound persona", async () => {
    const api = deps();
    await loadPromptCanvasLoreEntries({
      chatId: "chat-1",
      characterId: "char-1",
      personaId: null,
    }, api);

    expect(api.listLorebooks).toHaveBeenCalledTimes(3);
    expect(api.listLorebooks).not.toHaveBeenCalledWith("persona", expect.anything());
  });
});

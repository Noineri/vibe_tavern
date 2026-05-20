import { describe, it, expect } from "bun:test";
import { importCharacterCardV3Json } from "../src/cards/chara-card-v3.js";
import { parseSillyTavernChat, serializeSillyTavernChat } from "../src/chats/st-chat.js";
import { importStLorebookJson } from "../src/lorebooks/st-lorebook.js";

// ─── Character card V3 import ─────────────────────────────────────────────

describe("importCharacterCardV3Json", () => {
  const minimalCard = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Test Character",
      description: "A test character.",
      first_mes: "Hello there!",
      personality: "Cheerful",
      scenario: "A test room.",
      mes_example: "<START>\n{{user}}: Hi\n{{char}}: Hello!",
    },
  };

  it("imports a minimal valid V3 card", () => {
    const result = importCharacterCardV3Json(JSON.stringify(minimalCard));
    expect(result.format).toBe("chara_card_v3_json");
    expect(result.character.name).toBe("Test Character");
    expect(result.character.firstMessage).toBe("Hello there!");
    expect(result.character.description).toBe("A test character.");
    expect(result.character.personalitySummary).toBe("Cheerful");
    expect(result.character.defaultScenario).toBe("A test room.");
    expect(result.version.cardFormat).toBe("st_v3");
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts a parsed object instead of JSON string", () => {
    const result = importCharacterCardV3Json(minimalCard);
    expect(result.character.name).toBe("Test Character");
  });

  it("imports a V2 card (legacy, no spec field)", () => {
    const result = importCharacterCardV3Json({ name: "Legacy Character", description: "Old card", first_mes: "Hi" });
    expect(result.character.name).toBe("Legacy Character");
    expect(result.character.firstMessage).toBe("Hi");
  });

  it("imports a V2 card with explicit spec", () => {
    const result = importCharacterCardV3Json({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "V2 Char", description: "v2" } });
    expect(result.character.name).toBe("V2 Char");
  });

  it("throws on truly unsupported spec", () => {
    expect(() =>
      importCharacterCardV3Json({ spec: "something_else_v99", data: { name: "X" } }),
    ).toThrow("Unsupported character card spec");
  });

  it("throws on missing name", () => {
    expect(() =>
      importCharacterCardV3Json({ spec: "chara_card_v3", data: {} }),
    ).toThrow("missing `name`");
  });

  it("throws on empty name", () => {
    expect(() =>
      importCharacterCardV3Json({ spec: "chara_card_v3", data: { name: "   " } }),
    ).toThrow("missing `name`");
  });

  it("throws on invalid JSON string", () => {
    expect(() => importCharacterCardV3Json("{not json")).toThrow();
  });

  it("throws when JSON is not an object", () => {
    expect(() => importCharacterCardV3Json('"hello"')).toThrow("Expected a top-level JSON object");
  });

  it("warns when first message is empty", () => {
    const card = { ...minimalCard, data: { ...minimalCard.data, first_mes: "" } };
    const result = importCharacterCardV3Json(card);
    expect(result.warnings).toContain("Character card has no first message.");
    expect(result.character.firstMessage).toBeNull();
  });

  it("warns when scenario is empty", () => {
    const card = { ...minimalCard, data: { ...minimalCard.data, scenario: "" } };
    const result = importCharacterCardV3Json(card);
    expect(result.warnings).toContain("Character card has no scenario.");
    expect(result.character.defaultScenario).toBeNull();
  });

  it("handles card without data wrapper (flat fields)", () => {
    const flatCard = {
      spec: "chara_card_v3",
      name: "Flat Card",
      description: "No data wrapper.",
      first_mes: "Hi",
    };
    const result = importCharacterCardV3Json(flatCard);
    expect(result.character.name).toBe("Flat Card");
  });

  it("strips control characters from text fields", () => {
    const card = {
      ...minimalCard,
      data: {
        ...minimalCard.data,
        name: "Test\u0001Char",
        description: "desc\u0002ription",
      },
    };
    const result = importCharacterCardV3Json(card);
    expect(result.character.name).toBe("TestChar");
    expect(result.character.description).toBe("description");
  });

  it("generates deterministic IDs from the same input", () => {
    const result1 = importCharacterCardV3Json(minimalCard);
    const result2 = importCharacterCardV3Json(minimalCard);
    expect(result1.character.id).toBe(result2.character.id);
    expect(result1.version.id).toBe(result2.version.id);
  });

  it("generates different IDs for different cards", () => {
    const card2 = { ...minimalCard, data: { ...minimalCard.data, name: "Other" } };
    const result1 = importCharacterCardV3Json(minimalCard);
    const result2 = importCharacterCardV3Json(card2);
    expect(result1.character.id).not.toBe(result2.character.id);
  });

  it("parses alternate greetings as string array", () => {
    const card = {
      ...minimalCard,
      data: {
        ...minimalCard.data,
        alternate_greetings: ["Hey!", "Yo!"],
      },
    };
    const result = importCharacterCardV3Json(card);
    expect(result.character.alternateGreetings).toEqual(["Hey!", "Yo!"]);
  });

  it("handles non-array alternate greetings gracefully", () => {
    const card = {
      ...minimalCard,
      data: { ...minimalCard.data, alternate_greetings: "not an array" },
    };
    const result = importCharacterCardV3Json(card);
    expect(result.character.alternateGreetings).toEqual([]);
  });

  it("preserves character_book as raw record", () => {
    const book = { name: "test book", entries: [] };
    const card = {
      ...minimalCard,
      data: { ...minimalCard.data, character_book: book },
    };
    const result = importCharacterCardV3Json(card);
    expect(result.character.characterBook).toEqual(book);
  });

  it("sets character_book to null when absent", () => {
    const result = importCharacterCardV3Json(minimalCard);
    expect(result.character.characterBook).toBeNull();
  });

  it("uses provided now timestamp for createdAt", () => {
    const fixedTime = "2025-06-01T12:00:00.000Z";
    const result = importCharacterCardV3Json(minimalCard, { now: fixedTime });
    expect(result.character.createdAt).toBe(fixedTime);
    expect(result.version.createdAt).toBe(fixedTime);
  });

  it("respects characterStatus option", () => {
    const result = importCharacterCardV3Json(minimalCard, { characterStatus: "draft" });
    expect(result.character.status).toBe("draft");
  });

  it("slugifies the character name", () => {
    const card = { ...minimalCard, data: { ...minimalCard.data, name: "My Cool Character!" } };
    const result = importCharacterCardV3Json(card);
    expect(result.character.slug).toBe("my-cool-character");
  });

  it("parses depth_prompt fields", () => {
    const card = {
      ...minimalCard,
      data: {
        ...minimalCard.data,
        depth_prompt: "Hidden note",
        depth_prompt_depth: 4,
        depth_prompt_role: "system",
      },
    };
    const result = importCharacterCardV3Json(card);
    expect(result.character.depthPrompt).toBe("Hidden note");
    expect(result.character.depthPromptDepth).toBe(4);
    expect(result.character.depthPromptRole).toBe("system");
  });

  it("parses tags array", () => {
    const card = {
      ...minimalCard,
      data: { ...minimalCard.data, tags: ["fantasy", "OC"] },
    };
    const result = importCharacterCardV3Json(card);
    expect(result.character.tags).toEqual(["fantasy", "OC"]);
  });
});

// ─── SillyTavern chat import/export ───────────────────────────────────────

describe("parseSillyTavernChat", () => {
  it("parses a simple two-message chat", () => {
    const jsonl = [
      JSON.stringify({ user_name: "User", character_name: "Bot" }),
      JSON.stringify({ name: "User", is_user: true, mes: "Hello!", send_date: Date.now() }),
      JSON.stringify({ name: "Bot", is_user: false, mes: "Hi there!", send_date: Date.now() }),
    ].join("\n");

    const result = parseSillyTavernChat(jsonl);
    expect(result.metadata.userName).toBe("User");
    expect(result.metadata.characterName).toBe("Bot");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello!");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("Hi there!");
  });

  it("extracts swipes as variants", () => {
    const jsonl = [
      JSON.stringify({}),
      JSON.stringify({
        name: "Bot",
        is_user: false,
        mes: "Reply A",
        swipes: ["Reply A", "Reply B", "Reply C"],
        swipe_id: 1,
        send_date: Date.now(),
      }),
    ].join("\n");

    const result = parseSillyTavernChat(jsonl);
    expect(result.messages[0].variants).toHaveLength(3);
    expect(result.messages[0].variants[0].isSelected).toBe(false);
    expect(result.messages[0].variants[1].isSelected).toBe(true);
    expect(result.messages[0].variants[2].isSelected).toBe(false);
  });

  it("identifies system messages", () => {
    const jsonl = [
      JSON.stringify({}),
      JSON.stringify({ name: "System", is_system: true, mes: "[System note]", send_date: Date.now() }),
    ].join("\n");

    const result = parseSillyTavernChat(jsonl);
    expect(result.messages[0].role).toBe("system");
  });

  it("skips empty lines", () => {
    const jsonl = [
      JSON.stringify({}),
      "",
      "  ",
      JSON.stringify({ name: "User", is_user: true, mes: "Hi", send_date: Date.now() }),
    ].join("\n");

    const result = parseSillyTavernChat(jsonl);
    expect(result.messages).toHaveLength(1);
  });

  it("skips unparseable lines gracefully", () => {
    const jsonl = [
      JSON.stringify({}),
      "this is not json",
      JSON.stringify({ name: "User", is_user: true, mes: "Hi", send_date: Date.now() }),
    ].join("\n");

    const result = parseSillyTavernChat(jsonl);
    expect(result.messages).toHaveLength(1);
  });

  it("skips metadata-only first line without message", () => {
    const jsonl = [
      JSON.stringify({ user_name: "User", character_name: "Bot" }),
      JSON.stringify({ name: "User", is_user: true, mes: "Hi", send_date: Date.now() }),
    ].join("\n");

    const result = parseSillyTavernChat(jsonl);
    expect(result.messages).toHaveLength(1);
    expect(result.metadata.userName).toBe("User");
  });

  it("creates single variant when no swipes", () => {
    const jsonl = [
      JSON.stringify({}),
      JSON.stringify({ name: "Bot", is_user: false, mes: "Hello", send_date: Date.now() }),
    ].join("\n");

    const result = parseSillyTavernChat(jsonl);
    expect(result.messages[0].variants).toHaveLength(1);
    expect(result.messages[0].variants[0].isSelected).toBe(true);
  });

  it("returns empty on empty input", () => {
    const result = parseSillyTavernChat("");
    expect(result.messages).toHaveLength(0);
  });
});

describe("serializeSillyTavernChat", () => {
  it("roundtrips through parse", () => {
    const serialized = serializeSillyTavernChat({
      userName: "User",
      characterName: "Bot",
      messages: [
        { name: "User", isUser: true, isSystem: false, content: "Hello!", sendDate: "1234" },
        { name: "Bot", isUser: false, isSystem: false, content: "Hi!", sendDate: "1235", swipes: ["Hi!", "Hey!"], swipeId: 0 },
      ],
    });

    const parsed = parseSillyTavernChat(serialized);
    expect(parsed.metadata.userName).toBe("User");
    expect(parsed.metadata.characterName).toBe("Bot");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].content).toBe("Hello!");
    expect(parsed.messages[1].variants).toHaveLength(2);
  });
});

// ─── SillyTavern lorebook import ──────────────────────────────────────────

describe("importStLorebookJson", () => {
  const minimalLorebook = {
    name: "Test Lorebook",
    description: "A test lorebook.",
    entries: [
      {
        key: ["dragon"],
        keysecondary: [],
        content: "Dragons are ancient creatures.",
        extensions: {
          position: 0,
          exclude_recursion: false,
          display_index: 0,
          probability: 100,
          useProbability: true,
        },
        enabled: true,
      },
    ],
  };

  it("imports a minimal lorebook with entries", () => {
    const result = importStLorebookJson(JSON.stringify(minimalLorebook));
    expect(result.format).toBe("st_lorebook_json");
    expect(result.lorebook.name).toBe("Test Lorebook");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toBe("Dragons are ancient creatures.");
    expect(result.warnings).toHaveLength(0);
  });

  it("throws on missing name", () => {
    expect(() =>
      importStLorebookJson({ entries: [] }),
    ).toThrow("missing `name`");
  });

  it("handles entries as object (ST format)", () => {
    const lorebook = {
      name: "Obj Entries",
      entries: {
        "0": { keys: ["test"], content: "Test entry.", extensions: { position: 0 } },
        "1": { keys: ["other"], content: "Other entry.", extensions: { position: 0 } },
      },
    };
    const result = importStLorebookJson(lorebook);
    expect(result.entries).toHaveLength(2);
  });

  it("maps selective logic values correctly", () => {
    const cases: Array<[number, string]> = [
      [0, "and_any"],
      [1, "not_all"],
      [2, "not_any"],
      [3, "and_all"],
    ];
    for (const [logic, expected] of cases) {
      const lorebook = {
        name: `Logic ${logic}`,
        entries: [{
          keys: ["a"],
          keysecondary: ["b"],
          content: "Test",
          selective: true,
          selectiveLogic: logic,
          extensions: { position: 0 },
        }],
      };
      const result = importStLorebookJson(lorebook);
      expect(result.entries[0].logic).toBe(expected);
    }
  });

  it("defaults logic to and_any without selective flag", () => {
    const lorebook = {
      name: "No Selective",
      entries: [{ keys: ["a"], content: "Test", extensions: { position: 0 } }],
    };
    const result = importStLorebookJson(lorebook);
    expect(result.entries[0].logic).toBe("and_any");
  });

  it("maps position values to prompt layer positions", () => {
    const cases: Array<[number, string]> = [
      [0, "in_prompt"],
      [4, "in_chat"],
      [7, "hidden_system"],
    ];
    for (const [pos, expected] of cases) {
      const lorebook = {
        name: `Pos ${pos}`,
        entries: [{ keys: ["a"], content: "Test", position: pos, extensions: {} }],
      };
      const result = importStLorebookJson(lorebook);
      expect(result.entries[0].position).toBe(expected);
    }
  });

  it("warns on entries with empty content", () => {
    const lorebook = {
      name: "Empty",
      entries: [{ keys: ["a"], content: "", extensions: { position: 0 } }],
    };
    const result = importStLorebookJson(lorebook);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("empty content"))).toBe(true);
  });

  it("warns on entries with no keys and not constant", () => {
    const lorebook = {
      name: "No Keys",
      entries: [{ keys: [], content: "Some content", constant: false, extensions: { position: 0 } }],
    };
    const result = importStLorebookJson(lorebook);
    expect(result.warnings.some((w) => w.includes("no primary keys"))).toBe(true);
  });

  it("does not warn on constant entries without keys", () => {
    const lorebook = {
      name: "Constant",
      entries: [{ keys: [], content: "Always included", constant: true, extensions: { position: 0 } }],
    };
    const result = importStLorebookJson(lorebook);
    expect(result.warnings.some((w) => w.includes("no primary keys"))).toBe(false);
  });

  it("generates deterministic IDs", () => {
    const result1 = importStLorebookJson(minimalLorebook);
    const result2 = importStLorebookJson(minimalLorebook);
    expect(result1.lorebook.id).toBe(result2.lorebook.id);
    expect(result1.entries[0].id).toBe(result2.entries[0].id);
  });

  it("uses provided now timestamp", () => {
    const fixedTime = "2025-06-01T12:00:00.000Z";
    const result = importStLorebookJson(minimalLorebook, { now: fixedTime });
    expect(result.lorebook.createdAt).toBe(fixedTime);
  });

  it("defaults disabled entries to enabled=false", () => {
    const lorebook = {
      name: "Disabled",
      entries: [{ keys: ["a"], content: "Test", disable: true, extensions: { position: 0 } }],
    };
    const result = importStLorebookJson(lorebook);
    expect(result.entries[0].enabled).toBe(false);
  });
});

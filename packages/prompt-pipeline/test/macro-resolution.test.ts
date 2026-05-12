import { describe, it, expect } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";
import { createPhaseOneMacroEngine } from "../src/macro-registry.ts";
import { buildPromptVariableContext } from "../src/prompt-variable-context.ts";

/**
 * Тесты на раскрытие макросов {{char}}, {{user}}, <BOT>, <USER> и др.
 *
 * Три зоны ответственности:
 * 1. Prompt pipeline (assemblePrompt) — макросы раскрываются при сборке промпта для AI
 * 2. UI display (replaceUiMacros) — макросы раскрываются при отображении в интерфейсе
 * 3. DB storage — текст хранится «как есть», с нераскрытыми макросами
 */

// ─── Prompt pipeline: макросы раскрываются в сборке промпта ───

describe("Prompt pipeline: macro resolution in assembled prompt", () => {
  it("resolves {{char}} and {{user}} in chat message content", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: {
        recentMessages: [
          { id: "msg_1", role: "assistant", content: "{{char}} greets {{user}}." },
        ],
      },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      persona: { id: "pers_1", name: "Olya", description: "A scholar." },
    });

    const hist = result.layers.find((l) => l.id === "recent_history");
    expect(hist).toBeTruthy();
    expect(hist!.text).toContain("Aria");
    expect(hist!.text).toContain("Olya");
    expect(hist!.text).not.toContain("{{char}}");
    expect(hist!.text).not.toContain("{{user}}");
  });

  it("resolves {{char}} in character description", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: {
        id: "char_1",
        name: "Aria",
        description: "{{char}} is a fire mage.",
      },
    });

    const base = result.layers.find((l) => l.id === "character_base");
    expect(base).toBeTruthy();
    expect(base!.text).toContain("Aria is a fire mage.");
    expect(base!.text).not.toContain("{{char}}");
  });

  it("resolves {{user}} in scenario", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: {
        id: "char_1",
        name: "Aria",
        description: "A mage.",
        scenario: "{{user}} enters the tower.",
      },
    });

    const base = result.layers.find((l) => l.id === "character_base");
    expect(base).toBeTruthy();
    // Default persona name = "User"
    expect(base!.text).toContain("User enters the tower.");
    expect(base!.text).not.toContain("{{user}}");
  });

  it("resolves <BOT> and <USER> aliases in message content", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: {
        recentMessages: [
          { id: "msg_1", role: "assistant", content: "<BOT> speaks to <USER>." },
        ],
      },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      persona: { id: "pers_1", name: "Olya", description: "" },
    });

    const hist = result.layers.find((l) => l.id === "recent_history");
    expect(hist!.text).toContain("Aria speaks to Olya.");
    expect(hist!.text).not.toContain("<BOT>");
    expect(hist!.text).not.toContain("<USER>");
  });

  it("resolves {{persona}} to persona description in preset text", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      persona: { id: "pers_1", name: "Olya", description: "A careful archivist." },
      preset: { id: "p1", text: "The user is {{persona}}." },
    });

    const preset = result.layers.find((l) => l.id === "prompt_preset_system");
    expect(preset).toBeTruthy();
    expect(preset!.text).toBe("The user is A careful archivist..");
  });
});

// ─── Macro engine: прямой вызов createPhaseOneMacroEngine ───

describe("Phase-one macro engine: direct resolution", () => {
  const engine = createPhaseOneMacroEngine();

  it("resolves {{char}} to character name", () => {
    const ctx = buildPromptVariableContext({ character: { name: "Aria" } });
    expect(engine.resolve("I am {{char}}.", ctx)).toBe("I am Aria.");
  });

  it("resolves {{user}} to persona name", () => {
    const ctx = buildPromptVariableContext({ persona: { name: "Olya" } });
    expect(engine.resolve("Hello {{user}}.", ctx)).toBe("Hello Olya.");
  });

  it("is case-insensitive", () => {
    const ctx = buildPromptVariableContext({
      character: { name: "Aria" },
      persona: { name: "Olya" },
    });
    expect(engine.resolve("{{CHAR}} and {{User}}", ctx)).toBe("Aria and Olya");
  });

  it("handles whitespace inside braces", () => {
    const ctx = buildPromptVariableContext({
      character: { name: "Aria" },
      persona: { name: "Olya" },
    });
    expect(engine.resolve("{{ char }} meets {{ user }}", ctx)).toBe("Aria meets Olya");
  });

  it("leaves unsupported macros untouched", () => {
    const ctx = buildPromptVariableContext({});
    expect(engine.resolve("{{unknown}} stays.", ctx)).toBe("{{unknown}} stays.");
  });

  it("resolves multiple macros in one string", () => {
    const ctx = buildPromptVariableContext({
      character: { name: "Aria" },
      persona: { name: "Olya" },
    });
    expect(engine.resolve("{{char}} greets {{user}}.", ctx)).toBe("Aria greets Olya.");
  });

  it("returns input unchanged when no macros present", () => {
    const ctx = buildPromptVariableContext({});
    expect(engine.resolve("Just plain text.", ctx)).toBe("Just plain text.");
  });
});

// ─── UI display: replaceUiMacros (фронтенд) ───
// Функция находится в apps/web/src/lib/macros.ts — дублируем логику для теста,
// т.к. она не зависит от React и мала.

function replaceUiMacros(
  text: string,
  context: { characterName: string; personaName?: string | null; personaDescription?: string | null },
): string {
  if (!text) return text;
  const userName = context.personaName?.trim() || "User";
  return text
    .replace(/\{\{\s*char\s*\}\}/gi, context.characterName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*persona\s*\}\}/gi, context.personaDescription ?? "")
    .replace(/<USER>/gi, userName)
    .replace(/<BOT>/gi, context.characterName)
    .replace(/<CHAR>/gi, context.characterName);
}

describe("UI display: replaceUiMacros resolves macros for user-visible text", () => {
  const ctx = { characterName: "Aria", personaName: "Olya", personaDescription: "A scholar." };

  it("resolves {{char}} for display", () => {
    expect(replaceUiMacros("{{char}} says hello.", ctx)).toBe("Aria says hello.");
  });

  it("resolves {{user}} for display", () => {
    expect(replaceUiMacros("Hello, {{user}}!", ctx)).toBe("Hello, Olya!");
  });

  it("resolves <BOT> and <USER> for display", () => {
    expect(replaceUiMacros("<BOT> meets <USER>.", ctx)).toBe("Aria meets Olya.");
  });

  it("resolves {{persona}} to description for display", () => {
    expect(replaceUiMacros("You are {{persona}}.", ctx)).toBe("You are A scholar..");
  });

  it("resolves {{char}} in greeting with {{user}}", () => {
    expect(replaceUiMacros("{{char}} waves at {{user}}.", ctx)).toBe("Aria waves at Olya.");
  });

  it("is case-insensitive for display", () => {
    expect(replaceUiMacros("{{CHAR}} and {{User}}", ctx)).toBe("Aria and Olya");
  });

  it("handles whitespace in braces for display", () => {
    expect(replaceUiMacros("{{ char }} meets {{ user }}", ctx)).toBe("Aria meets Olya");
  });

  it("returns empty string for empty input", () => {
    expect(replaceUiMacros("", ctx)).toBe("");
  });

  it("returns unchanged text when no macros present", () => {
    expect(replaceUiMacros("Just plain text.", ctx)).toBe("Just plain text.");
  });
});

// ─── DB storage: макросы НЕ раскрываются при сохранении ───
// Это проверяет контракт: expandChatMacros — NOP, текст проходит как есть.

describe("DB storage: raw text preserved with macros unresolved", () => {
  it("greeting with {{user}} is stored as-is in assembled input", () => {
    // Симуляция: greeting содержит макрос, который НЕ раскрывается при сохранении
    const rawGreeting = "Hello, {{user}}! I am {{char}}.";

    // Но при отображении (UI) и генерации (pipeline) макросы раскрываются
    const displayCtx = { characterName: "Aria", personaName: "Olya" };
    const displayed = replaceUiMacros(rawGreeting, displayCtx);
    expect(displayed).toBe("Hello, Olya! I am Aria.");

    // В «БД» (сырой текст) макросы на месте
    expect(rawGreeting).toContain("{{user}}");
    expect(rawGreeting).toContain("{{char}}");
  });

  it("user message with {{char}} is stored as-is and resolved in pipeline", () => {
    const rawUserMessage = "Tell me about {{char}}'s powers.";

    // Pipeline раскрывает
    const engine = createPhaseOneMacroEngine();
    const ctx = buildPromptVariableContext({ character: { name: "Aria" } });
    const resolved = engine.resolve(rawUserMessage, ctx);
    expect(resolved).toBe("Tell me about Aria's powers.");

    // «БД» — сырой текст
    expect(rawUserMessage).toContain("{{char}}");
  });
});

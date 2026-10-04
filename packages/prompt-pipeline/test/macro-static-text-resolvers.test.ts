import { describe, expect, it } from "bun:test";
import { createFullMacroEngine } from "../src/macro-registry.ts";
import { buildPromptVariableContext } from "../src/prompt-variable-context.ts";

const engine = createFullMacroEngine();
const context = buildPromptVariableContext({
  character: { systemPrompt: "Character system", postHistoryInstructions: "Character instruction" },
  prompt: {
    system: "Preset system",
    defaultSystemPrompt: "Default system",
    authorsNote: "Preset note",
    defaultAuthorsNote: "Default note",
  },
  names: { userName: "User", notChar: "Not character" },
  chat: { idleDuration: "five minutes" },
  now: new Date("2026-10-04T12:34:56.000Z"),
});

describe("static text macro resolvers", () => {
  it("resolves {{charPrompt}} from the character system prompt", () => {
    expect(engine.resolve("{{charPrompt}}", context)).toBe("Character system");
  });

  it("resolves {{charInstruction}} from the character post-history instructions", () => {
    expect(engine.resolve("{{charInstruction}}", context)).toBe("Character instruction");
  });

  it("resolves {{systemPrompt}} with the simple-mode override precedence", () => {
    expect(engine.resolve("{{systemPrompt}}", context)).toBe("Character system");
    const noOverride = buildPromptVariableContext({
      character: { systemPrompt: "   " },
      prompt: { system: "Preset system" },
    });
    expect(engine.resolve("{{systemPrompt}}", noOverride)).toBe("Preset system");
  });

  it("resolves {{defaultSystemPrompt}} from the default preset", () => {
    expect(engine.resolve("{{defaultSystemPrompt}}", context)).toBe("Default system");
  });

  it("resolves {{authorsNote}} from the active preset", () => {
    expect(engine.resolve("{{authorsNote}}", context)).toBe("Preset note");
  });

  it("resolves {{defaultAuthorsNote}} from the default preset", () => {
    expect(engine.resolve("{{defaultAuthorsNote}}", context)).toBe("Default note");
  });

  it("resolves {{notChar}} from the non-character participant", () => {
    expect(engine.resolve("{{notChar}}", context)).toBe("Not character");
  });

  it("resolves {{reverse}}", () => {
    expect(engine.resolve("{{reverse::abc}}", context)).toBe("cba");
  });

  it("resolves {{datetimeformat}}", () => {
    expect(engine.resolve("{{datetimeformat::YYYY-MM-DD HH:mm:ss}}", context)).toBe("2026-10-04 12:34:56");
  });

  it("resolves {{idleDuration}} and its {{idle_duration}} alias", () => {
    expect(engine.resolve("{{idleDuration}}/{{idle_duration}}", context)).toBe("five minutes/five minutes");
  });

  it("resolves {{timeDiff}}", () => {
    expect(engine.resolve("{{timeDiff::2026-10-04T12:05:00Z::2026-10-04T12:00:00Z}}", context)).toBe("in 5 minutes");
  });

  it("resolves {{time::UTC±n}} while preserving the local-time output", () => {
    expect(engine.resolve("{{time}}/{{time::UTC+2}}/{{time::UTC-2}}", context)).toBe("12:34/14:34/10:34");
  });
});

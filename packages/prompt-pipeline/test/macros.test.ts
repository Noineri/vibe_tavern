import { describe, it, expect } from "bun:test";
// TODO: macros.ts was removed from src — this test references deleted code.
// Re-enable when/if macro replacement is re-implemented.
describe.skip("macros (module removed)", () => {
  it.todo("re-enable when macros.ts is restored");
});

/*
import { replaceMacros } from "../src/macros.ts";
import { createPhaseOneMacroEngine } from "../src/macro-registry.ts";
import { buildPromptVariableContext, computeTimeContext } from "../src/prompt-variable-context.ts";

describe("replaceMacros", () => {
  const ctx = {
    charName: "Aria",
    userName: "Olya",
  };

  it("resolves {{char}}", () => {
    expect(
      replaceMacros("I am {{char}}.", ctx),
    ).toBe("I am Aria.");
  });

  it("resolves {{user}}", () => {
    expect(
      replaceMacros("Hello {{user}}.", ctx),
    ).toBe("Hello Olya.");
  });

  it("resolves {{persona}} to active persona description", () => {
    expect(
      replaceMacros("You are {{persona}}", {
        ...ctx,
        personaDescription: "A careful archivist.",
      }),
    ).toBe("You are A careful archivist.");
  });

  it("resolves <BOT> and <USER>", () => {
    expect(
      replaceMacros("<BOT> speaks to <USER>.", ctx),
    ).toBe("Aria speaks to Olya.");
  });

  it("resolves first {{original}} to supplied original prompt text", () => {
    expect(
      replaceMacros("{{original}} Override.", { ...ctx, originalText: "Default prompt." }),
    ).toBe("Default prompt. Override.");
  });

  it("resolves second {{original}} in the same substitution to empty string", () => {
    expect(
      replaceMacros("{{original}} Then {{original}}", { ...ctx, originalText: "Default prompt." }),
    ).toBe("Default prompt. Then ");
  });

  it("resolves missing supported fields to empty string", () => {
    expect(
      replaceMacros("{{original}} {{persona}}", ctx),
    ).toBe(" ");
  });

  it("leaves unsupported macros unresolved", () => {
    expect(
      replaceMacros("{{unknown}} stays.", ctx),
    ).toBe("{{unknown}} stays.");
  });

  it("handles whitespace inside braces", () => {
    expect(
      replaceMacros("{{ char }} meets {{ user }}", ctx),
    ).toBe("Aria meets Olya");
  });

  it("is case-insensitive for macro names", () => {
    expect(
      replaceMacros("{{CHAR}} and {{User}}", ctx),
    ).toBe("Aria and Olya");
  });

  it("resolves multiple macros in one string", () => {
    const result = replaceMacros(
      "{{char}} greets {{user}}.",
      ctx,
    );
    expect(result).toBe("Aria greets Olya.");
    expect(result).not.toContain("{{");
  });

  it("returns input unchanged when no macros present", () => {
    expect(
      replaceMacros("Just plain text.", ctx),
    ).toBe("Just plain text.");
  });

  it("returns input for empty/falsy values", () => {
    expect(replaceMacros("", ctx)).toBe("");
    // @ts-expect-error testing null input
    expect(replaceMacros(null, ctx)).toBe(null);
  });
});

describe("createPhaseOneMacroEngine", () => {
  const engine = createPhaseOneMacroEngine();

  it("resolves {{user}} and <USER> to active persona/user name", () => {
    const context = buildPromptVariableContext({
      persona: { name: "Olya" },
    });

    expect(engine.resolve("{{user}} <USER>", context)).toBe("Olya Olya");
  });

  it("resolves {{char}}, <CHAR>, and <BOT> to character name", () => {
    const context = buildPromptVariableContext({
      character: { name: "Aria" },
    });

    expect(engine.resolve("{{char}} <CHAR> <BOT>", context)).toBe("Aria Aria Aria");
  });

  it("resolves {{persona}} to persona description", () => {
    const context = buildPromptVariableContext({
      persona: {
        name: "Olya",
        description: "A careful archivist.",
      },
    });

    expect(engine.resolve("{{persona}}", context)).toBe("A careful archivist.");
  });

  it("resolves supported missing fields to empty string", () => {
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{personality}}/{{model}}/{{maxResponse}}", context)).toBe("//");
  });

  it("leaves unsupported macros untouched", () => {
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{unsupported}} {{random::a,b}}", context)).toBe("{{unsupported}} {{random::a,b}}");
  });

  it("resolves {{original}} once per resolution", () => {
    const context = buildPromptVariableContext({
      prompt: { original: "Default prompt." },
    });

    expect(engine.resolve("{{original}} Then {{original}}", context)).toBe("Default prompt. Then ");
    expect(engine.resolve("{{original}}", context)).toBe("Default prompt.");
  });

  it("resolves character-field aliases from namespaced character context", () => {
    const context = buildPromptVariableContext({
      character: {
        name: "Aria",
        description: "Kind mage.",
        personality: "Patient.",
        scenario: "Library.",
        mesExample: "<START>",
        firstMessage: "Hello.",
        creatorNotes: "Imported card.",
        depthPrompt: "Stay in character.",
        version: {
          versionNumber: 2,
          title: "v2",
          cardFormat: "sillytavern",
          definition: {},
        },
      },
    });

    expect(engine.resolve("{{description}}|{{charDescription}}", context)).toBe("Kind mage.|Kind mage.");
    expect(engine.resolve("{{personality}}|{{charPersonality}}", context)).toBe("Patient.|Patient.");
    expect(engine.resolve("{{scenario}}|{{charScenario}}", context)).toBe("Library.|Library.");
    expect(engine.resolve("{{mesExamplesRaw}}|{{mesExamples}}", context)).toBe("<START>|<START>");
    expect(engine.resolve("{{charFirstMessage}}|{{greeting}}", context)).toBe("Hello.|Hello.");
    expect(engine.resolve("{{charCreatorNotes}}|{{creatorNotes}}", context)).toBe("Imported card.|Imported card.");
    expect(engine.resolve("{{charDepthPrompt}}|{{charVersion}}|{{version}}|{{char_version}}", context)).toBe("Stay in character.|v2|v2|v2");
  });

  it("resolves time macros deterministically from a fixed Date", () => {
    const now = new Date(2024, 0, 2, 3, 4, 5);
    const time = computeTimeContext(now);
    const context = buildPromptVariableContext({ now });

    expect(engine.resolve("{{time}} {{date}} {{weekday}} {{isotime}} {{isodate}}", context)).toBe(
      `${time.time} ${time.date} ${time.weekday} ${time.isotime} ${time.isodate}`,
    );
  });
});
*/

import { describe, it, expect } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";
import { createFullMacroEngine } from "../src/macro-registry.ts";
import { buildPromptVariableContext } from "../src/prompt-variable-context.ts";

/**
 * Tests for macro resolution: {{char}}, {{user}}, <BOT>, <USER>, setvar/getvar, random, roll, if/else, comments.
 */

// ─── Prompt pipeline: macros resolved in assembled prompt ───

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

    const scenario = result.layers.find((l) => l.id === "character_scenario");
    expect(scenario).toBeTruthy();
    expect(scenario!.text).toContain("User enters the tower.");
    expect(scenario!.text).not.toContain("{{user}}");
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

  it("resolves ST field macros inside custom injection content", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: {
        id: "char_1",
        name: "Aria",
        description: "A mage.",
        personality: "Careful.",
        scenario: "The tower burns.",
      },
      persona: { id: "pers_1", name: "Olya", description: "A careful archivist." },
      preset: {
        id: "p1",
        text: "",
        advancedMode: true,
        customInjections: [{
          identifier: "database",
          name: "Database",
          content: "<scenario>\n{{scenario}}\n</scenario>\n<{{char}}>\n{{personality}}\n{{description}}\n</{{char}}>\n<{{user}}>\n{{persona}}\n</{{user}}>",
          role: "system",
        }],
        promptOrder: [
          { identifier: "database", enabled: true, zone: "in_chat", depth: 4, order: 60, kind: "custom" },
        ],
      },
    });

    const injection = result.layers.find((l) => l.id === "preset_injection_database");
    expect(injection).toBeTruthy();
    expect(injection!.text).toContain("<scenario>\nThe tower burns.\n</scenario>");
    expect(injection!.text).toContain("<Aria>\nCareful.\nA mage.\n</Aria>");
    expect(injection!.text).toContain("<Olya>\nA careful archivist.\n</Olya>");
    expect(injection!.text).not.toContain("{{scenario}}");
    expect(injection!.text).not.toContain("{{personality}}");
    expect(injection!.text).not.toContain("{{description}}");
    expect(injection!.text).not.toContain("{{persona}}");
  });
});

// ─── Macro engine: direct resolution ───

describe("Macro engine: direct resolution", () => {
  const engine = createFullMacroEngine();

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

  it("preserves unknown space-form macros literally", () => {
    const ctx = buildPromptVariableContext({});
    expect(engine.resolve("{{unknown argument}} stays.", ctx)).toBe("{{unknown argument}} stays.");
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

// ─── UI display: replaceUiMacros (frontend) ───

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

// ─── DB storage: raw text preserved with macros unresolved ───

describe("DB storage: raw text preserved with macros unresolved", () => {
  it("greeting with {{user}} is stored as-is in assembled input", () => {
    const rawGreeting = "Hello, {{user}}! I am {{char}}.";

    const displayCtx = { characterName: "Aria", personaName: "Olya" };
    const displayed = replaceUiMacros(rawGreeting, displayCtx);
    expect(displayed).toBe("Hello, Olya! I am Aria.");

    expect(rawGreeting).toContain("{{user}}");
    expect(rawGreeting).toContain("{{char}}");
  });

  it("user message with {{char}} is stored as-is and resolved in pipeline", () => {
    const rawUserMessage = "Tell me about {{char}}'s powers.";

    const engine = createFullMacroEngine();
    const ctx = buildPromptVariableContext({ character: { name: "Aria" } });
    const resolved = engine.resolve(rawUserMessage, ctx);
    expect(resolved).toBe("Tell me about Aria's powers.");

    expect(rawUserMessage).toContain("{{char}}");
  });
});

// ─── Variable macros: setvar / getvar ───

describe("Variable macros: setvar/getvar", () => {
  const engine = createFullMacroEngine();

  it("setvar sets a variable, getvar retrieves it", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::color::red}}{{getvar::color}}", ctx);
    expect(result).toBe("red");
  });

  it("getvar returns empty string for unset variable", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    expect(engine.resolve("{{getvar::unknown}}", ctx)).toBe("");
  });

  it("getvar returns fallback for unset variable", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    expect(engine.resolve("{{getvar::unknown::default}}", ctx)).toBe("default");
  });

  it("getvar accepts the single-argument space separator", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    expect(engine.resolve("{{setvar::color::red}}{{getvar color}}", ctx)).toBe("red");
  });

  it("setvar with empty value resets variable", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::x::hello}}{{setvar::x::}}{{getvar::x}}", ctx);
    expect(result).toBe("");
  });

  it("variables persist across resolve calls on same engine", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    engine.resolve("{{setvar::mood::happy}}", ctx);
    expect(engine.resolve("The mood is {{getvar::mood}}.", ctx)).toBe("The mood is happy.");
  });

  it("resetVariables clears state", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    engine.resolve("{{setvar::x::1}}", ctx);
    engine.resetVariables();
    expect(engine.resolve("{{getvar::x}}", ctx)).toBe("");
  });

  it("incvar increments and returns value", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::counter::5}}{{incvar::counter}}", ctx);
    expect(result).toBe("6");
  });

  it("decvar decrements and returns value", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::counter::3}}{{decvar::counter}}", ctx);
    expect(result).toBe("2");
  });

  it("addvar appends strings", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::list::a}}{{addvar::list::,b}}{{getvar::list}}", ctx);
    expect(result).toBe("a,b");
  });

  it("hasvar returns true/false", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::x::1}}has={{hasvar::x}} missing={{hasvar::y}}", ctx);
    expect(result).toBe("has=true missing=false");
  });

  it("deletevar removes a variable", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::x::1}}{{deletevar::x}}{{hasvar::x}}", ctx);
    expect(result).toBe("false");
  });
});

// ─── Random macro ───

describe("Random macro: {{random::a::b::c}}", () => {
  const engine = createFullMacroEngine();

  it("picks one of the options", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{random::a::b::c}}", ctx);
    expect(["a", "b", "c"]).toContain(result);
  });

  it("handles comma-separated legacy format", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{random:x,y,z}}", ctx);
    expect(["x", "y", "z"]).toContain(result);
  });

  it("returns empty for no args", () => {
    const ctx = buildPromptVariableContext({});
    expect(engine.resolve("{{random}}", ctx)).toBe("");
  });

  it("accepts the single-argument space separator", () => {
    const ctx = buildPromptVariableContext({});
    expect(["a", "b", "c"]).toContain(engine.resolve("{{random a,b,c}}", ctx));
  });
});

describe("Variable macros: assembly scope", () => {
  it("resolves a variable set by an earlier preset block in prompt order", () => {
    const result = assemblePrompt({
      identity: { chatId: "variable-preset-order" },
      character: { id: "character", name: "Keeper", description: "" },
      chat: { recentMessages: [] },
      preset: {
        id: "preset",
        text: "{{setvar::tone::formal}}",
        prefill: "Reply in {{getvar::tone}} prose.",
      },
    });

    expect(result.prefill).toBe("Reply in formal prose.");
  });
});

describe("Variable shorthand and global macros", () => {
  it("evaluates local shorthand, operators, and shorthand conditions", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{.count = 1}}{{.count += 2}}{{.count++}}{{if .count}}count={{.count}}{{/if}}", context))
      .toBe("4count=4");
  });

  it("evaluates global shorthand mutations and reads from the global namespace", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{$count = 1}}{{$count += 2}}{{$count}}", context)).toBe("3");
  });

  it("evaluates global shorthand conditions for truthy and falsy values", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{setglobalvar::enabled::true}}{{if $enabled}}yes{{else}}no{{/if}}{{setglobalvar::enabled::}}{{if $enabled}}yes{{else}}no{{/if}}", context))
      .toBe("yesno");
  });

  it("supports every shorthand fallback, comparison, and mutation operator", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{.x ??= 5}}/{{.x ?? 9}}/{{.x ||= 8}}/{{.x == 5}}/{{.x != 4}}/{{.x > 4}}/{{.x >= 5}}/{{.x < 6}}/{{.x <= 5}}{{.x -= 2}}{{.x || 9}}{{.x--}}{{.x}}", context))
      .toBe("5/5/5/true/true/true/true/true/true322");
  });

  it("keeps global variables separate from local variables", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{setvar::scope::local}}{{setglobalvar::scope::global}}{{getvar::scope}}/{{getglobalvar::scope}}", context))
      .toBe("local/global");
  });

  it("registers the variable existence and deletion aliases", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{setvar::x::1}}{{varexists::x}}{{flushvar::x}}{{hasvar::x}}", context)).toBe("truefalse");
    expect(engine.resolve("{{setglobalvar::x::1}}{{globalvarexists::x}}{{flushglobalvar::x}}{{hasglobalvar::x}}", context)).toBe("truefalse");
  });

  it("supports every global mutation macro within the assembly scope", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{setglobalvar::count::1}}{{addglobalvar::count::2}}{{incglobalvar::count}}{{decglobalvar::count}}/{{getglobalvar::count}}", context))
      .toBe("43/3");
  });

  it("reads and writes local and global object keys through key and index aliases", () => {
    const engine = createFullMacroEngine();
    const context = buildPromptVariableContext({});

    expect(engine.resolve("{{setvarkey::profile::name::Ada}}{{setvarkey::profile::role::captain}}{{getvarindex::profile::name}}/{{getvarkey::profile::role}}", context))
      .toBe("Ada/captain");
    expect(engine.resolve("{{setglobalvarkey::profile::rank::one}}{{setglobalvarindex::profile::rank::two}}{{getglobalvarkey::profile::rank}}", context))
      .toBe("two");
    expect(engine.resolve("{{setvarindex::list::0::first}}{{getvarkey::list::0}}", context)).toBe("first");
  });

  it("passes a toggle-set global value to the prefill in one assembly", () => {
    const result = assemblePrompt({
      identity: { chatId: "w7bw55" },
      character: { id: "character", name: "Keeper", description: "" },
      chat: { recentMessages: [] },
      preset: {
        id: "w7bw55",
        text: "{{setglobalvar::length::concise}}{{setglobalvar::pov::first person}}",
        prefill: "Write {{getglobalvar::length}}, {{getglobalvar::pov}}.",
      },
    });

    expect(result.prefill).toBe("Write concise, first person.");
  });

  it("does not persist local or global state into the next assembly", () => {
    const makeAssembly = (text: string) => assemblePrompt({
      identity: { chatId: "isolated-variable-assembly" },
      character: { id: "character", name: "Keeper", description: "" },
      chat: { recentMessages: [] },
      preset: { id: "preset", text },
    });

    makeAssembly("{{setvar::local::one}}{{setglobalvar::global::one}}");
    const next = makeAssembly("{{getvar::local}}/{{getglobalvar::global}}");

    expect(next.layers.find((layer) => layer.id === "prompt_preset_system")?.text).toBe("/");
  });
});

describe("Pick macro: {{pick::a::b::c}}", () => {
  it("is stable across assemblies and regenerations for one chat", () => {
    const makeAssembly = () => assemblePrompt({
      identity: { chatId: "stable-pick-chat" },
      chat: { recentMessages: [{ id: "message_1", role: "assistant", content: "{{pick::a::b::c}}" }] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
    });

    const first = makeAssembly().layers.find((layer) => layer.id === "recent_history")?.text;
    const regenerated = makeAssembly().layers.find((layer) => layer.id === "recent_history")?.text;

    expect(first).toBe(regenerated);
    expect(first).toMatch(/ASSISTANT: [abc]/);
  });

  it("selects a different stable option for a different chat", () => {
    const resolvePick = (chatId: string) => assemblePrompt({
      identity: { chatId },
      chat: { recentMessages: [{ id: "message_1", role: "assistant", content: "{{pick::a::b::c}}" }] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
    }).layers.find((layer) => layer.id === "recent_history")?.text;

    expect(resolvePick("stable-pick-chat")).not.toBe(resolvePick("different-pick-chat"));
  });

  it("uses the macro position as part of its stable seed", () => {
    const options = Array.from({ length: 100 }, (_, index) => String(index)).join("::");
    const result = assemblePrompt({
      identity: { chatId: "stable-pick-chat" },
      chat: { recentMessages: [{ id: "message_1", role: "assistant", content: `{{pick::${options}}} {{pick::${options}}}` }] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
    }).layers.find((layer) => layer.id === "recent_history")?.text ?? "";

    const [, first, second] = result.match(/^ASSISTANT: (\d+) (\d+)$/) ?? [];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

// ─── Roll macro ───

describe("Roll macro: {{roll::1d20}}", () => {
  const engine = createFullMacroEngine();

  it("returns a number for valid formula", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{roll::1d20}}", ctx);
    const num = Number(result);
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(20);
  });

  it("handles d6 shorthand", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{roll::d6}}", ctx);
    const num = Number(result);
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(6);
  });

  it("handles 3d6", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{roll::3d6}}", ctx);
    const num = Number(result);
    expect(num).toBeGreaterThanOrEqual(3);
    expect(num).toBeLessThanOrEqual(18);
  });

  it("handles modifier", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{roll::1d10+5}}", ctx);
    const num = Number(result);
    expect(num).toBeGreaterThanOrEqual(6);
    expect(num).toBeLessThanOrEqual(15);
  });

  it("treats a bare number as a one-die formula", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{roll::20}}", ctx);
    const num = Number(result);
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(20);
  });

  it("accepts the single-argument space separator", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{roll 1d20}}", ctx);
    const num = Number(result);
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(20);
  });
});

// ─── Comment macro ───

describe("Comment macro: {{// ...}}", () => {
  const engine = createFullMacroEngine();

  it("strips comments completely", () => {
    const ctx = buildPromptVariableContext({});
    expect(engine.resolve("before{{// this is a comment}}after", ctx)).toBe("beforeafter");
  });

  it("strips comment with long text", () => {
    const ctx = buildPromptVariableContext({});
    expect(engine.resolve("{{// Make sure to edit both!}}text", ctx)).toBe("text");
  });
});

// ─── Trim macro ─────────────────────────────────────────────────────────

describe("Trim macro", () => {
  it("removes the line breaks around a non-scoped marker", () => {
    const engine = createFullMacroEngine();
    const ctx = buildPromptVariableContext({});

    expect(engine.resolve("Enabled\n{{trim}}\nDisabled", ctx)).toBe("EnabledDisabled");
  });

  it("trims the resolved content of a scoped block", () => {
    const engine = createFullMacroEngine();
    const ctx = buildPromptVariableContext({ character: { name: "Aria" } });

    expect(engine.resolve("before{{trim}}\n  {{char}}  \n{{/trim}}after", ctx)).toBe("beforeAriaafter");
  });

  it("preserves trim markers during selective resolution", () => {
    const engine = createFullMacroEngine();
    const ctx = buildPromptVariableContext({});

    expect(engine.resolveSelected("Enabled\n{{trim}}\nDisabled", ctx, new Set(["random"])))
      .toBe("Enabled\n{{trim}}\nDisabled");
  });

  it("keeps a toggle-heavy preset compact in the Marinara style", () => {
    const result = assemblePrompt({
      identity: { chatId: "marinara-trim" },
      chat: { recentMessages: [] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      persona: { id: "persona_1", name: "Olya", description: "A scholar." },
      preset: {
        id: "marinara-style",
        text: [
          "<identity>",
          "{{if {{char}}}}Character: {{char}}{{/if}}",
          "{{trim}}",
          "{{if {{user}}}}User: {{user}}{{/if}}",
          "{{trim}}",
          "</identity>",
        ].join("\n"),
      },
    });

    const preset = result.layers.find((layer) => layer.id === "prompt_preset_system");
    expect(preset?.text).toBe("<identity>\nCharacter: AriaUser: Olya</identity>");
  });
});

// ─── Conditional macro: if/else ───

describe("Conditional macro: {{if}}...{{else}}...{{/if}}", () => {
  const engine = createFullMacroEngine();

  it("shows then-branch when condition is truthy", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::x::yes}}{{if {{getvar::x}}}}shown{{/if}}", ctx);
    expect(result).toBe("shown");
  });

  it("hides then-branch when condition is falsy (empty)", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{if {{getvar::x}}}}hidden{{/if}}", ctx);
    expect(result).toBe("");
  });

  it("shows else-branch when condition is falsy", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{if {{getvar::x}}}}then{{else}}else{{/if}}", ctx);
    expect(result).toBe("else");
  });

  it("negation with ! inverts condition", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::x::yes}}{{if !{{getvar::x}}}}no{{else}}yes{{/if}}", ctx);
    expect(result).toBe("yes");
  });

  it("condition 'false' is falsy", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{setvar::x::false}}{{if {{getvar::x}}}}no{{else}}yes{{/if}}", ctx);
    expect(result).toBe("yes");
  });

  it("simple non-empty condition is truthy", () => {
    const ctx = buildPromptVariableContext({ character: { name: "Aria" } });
    const result = engine.resolve("{{if {{char}}}}char exists{{/if}}", ctx);
    expect(result).toBe("char exists");
  });

  it("nested if blocks work", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const input = "{{setvar::a::1}}{{setvar::b::1}}{{if {{getvar::a}}}}{{if {{getvar::b}}}}both{{/if}}{{/if}}";
    const result = engine.resolve(input, ctx);
    expect(result).toBe("both");
  });
});

// ─── Celia preset stress test ───

describe("Celia preset stress test", () => {
  const engine = createFullMacroEngine();

  it("initializes many variables and reads them back", () => {
    const ctx = buildPromptVariableContext({
      character: { name: "Elena", description: "A pirate captain." },
      persona: { name: "Human" },
    });
    engine.resetVariables();

    const input = [
      "{{setvar::clauword::}}",
      "{{setvar::rating::}}",
      "{{setvar::roleplay::}}",
      "{{setvar::clauagency1::Simulating within}}",
      "{{setvar::clauagency2::immediate perceptive area.}}",
      "{{setvar::novelty::Assuming memory of previous history}}",
      "",
      "{{getvar::clauagency1}} {{getvar::clauagency2}}",
      "Novelty: {{getvar::novelty}}",
    ].join("\n");

    const result = engine.resolve(input, ctx);

    expect(result).toContain("Simulating within");
    expect(result).toContain("immediate perceptive area.");
    expect(result).toContain("Novelty: Assuming memory of previous history");
  });

  it("random name generation pattern works", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{random:a,b,c,d,e,f}}", ctx);
    expect(["a", "b", "c", "d", "e", "f"]).toContain(result);
  });

  it("comment lines are stripped", () => {
    const ctx = buildPromptVariableContext({});
    const result = engine.resolve("{{// This dis-includes the below information}}visible", ctx);
    expect(result).toBe("visible");
  });

  it("roll dice in naming macro", () => {
    const ctx = buildPromptVariableContext({});
    engine.resetVariables();
    const result = engine.resolve("{{roll::1d6}}", ctx);
    const num = Number(result);
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(6);
  });
});

import type { PromptVariableContext } from "./prompt-variable-context.js";

export interface MacroResolutionState {
  didUseOriginal: boolean;
}

export interface MacroResolver {
  name: string;
  aliases?: readonly string[];
  resolve: (context: PromptVariableContext, state: MacroResolutionState) => string | number | boolean | null | undefined;
}

export class MacroEngine {
  private readonly resolvers = new Map<string, MacroResolver>();

  register(resolver: MacroResolver): this {
    this.resolvers.set(normalizeName(resolver.name), resolver);
    for (const alias of resolver.aliases ?? []) {
      this.resolvers.set(normalizeName(alias), resolver);
    }

    return this;
  }

  resolve(text: string, context: PromptVariableContext): string {
    if (!text) return text;

    const state: MacroResolutionState = { didUseOriginal: false };
    const resolveName = (name: string): string | undefined => {
      const resolver = this.resolvers.get(normalizeName(name));
      if (!resolver) return undefined;

      const value = resolver.resolve(context, state);
      return value == null ? "" : String(value);
    };

    const withCurly = text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (token: string, name: string) => {
      const value = resolveName(name);
      return value ?? token;
    });

    return withCurly.replace(/<(USER|CHAR|BOT)>/gi, (token: string) => {
      const value = resolveName(token);
      return value ?? token;
    });
  }
}

const normalizeName = (name: string): string => name.toLowerCase();

const firstDefined = (...values: Array<string | number | null | undefined>): string | number | null | undefined => {
  for (const value of values) {
    if (value != null) return value;
  }

  return undefined;
};

export function createPhaseOneMacroEngine(): MacroEngine {
  return new MacroEngine()
    .register({
      name: "user",
      aliases: ["<USER>"],
      resolve: (context) => context.names.userName,
    })
    .register({
      name: "char",
      aliases: ["<CHAR>", "<BOT>"],
      resolve: (context) => context.names.charName,
    })
    .register({
      name: "persona",
      resolve: (context) => context.persona.description,
    })
    .register({
      name: "description",
      aliases: ["charDescription"],
      resolve: (context) => context.character.description,
    })
    .register({
      name: "personality",
      aliases: ["charPersonality"],
      resolve: (context) => context.character.personality,
    })
    .register({
      name: "scenario",
      aliases: ["charScenario"],
      resolve: (context) => context.character.scenario,
    })
    .register({
      name: "mesExamplesRaw",
      aliases: ["mesExamples"],
      resolve: (context) => context.character.mesExample,
    })
    .register({
      name: "charFirstMessage",
      aliases: ["greeting"],
      resolve: (context) => context.character.firstMessage,
    })
    .register({
      name: "charCreatorNotes",
      aliases: ["creatorNotes"],
      resolve: (context) => context.character.creatorNotes,
    })
    .register({
      name: "charDepthPrompt",
      resolve: (context) => context.character.depthPrompt,
    })
    .register({
      name: "charVersion",
      aliases: ["version", "char_version"],
      resolve: (context) => context.character.version?.title,
    })
    .register({
      name: "newline",
      resolve: () => "\n",
    })
    .register({
      name: "noop",
      resolve: () => "",
    })
    .register({
      name: "time",
      resolve: (context) => context.time.time,
    })
    .register({
      name: "date",
      resolve: (context) => context.time.date,
    })
    .register({
      name: "weekday",
      resolve: (context) => context.time.weekday,
    })
    .register({
      name: "isotime",
      resolve: (context) => context.time.isotime,
    })
    .register({
      name: "isodate",
      resolve: (context) => context.time.isodate,
    })
    .register({
      name: "model",
      resolve: (context) => context.runtime.model,
    })
    .register({
      name: "maxPrompt",
      aliases: ["maxPromptTokens"],
      resolve: (context) => firstDefined(context.runtime.maxPromptTokens, context.prompt.contextBudget, context.runtime.contextBudget),
    })
    .register({
      name: "maxContext",
      aliases: ["maxContextTokens"],
      resolve: (context) => firstDefined(context.runtime.contextBudget, context.prompt.contextBudget),
    })
    .register({
      name: "maxResponse",
      aliases: ["maxResponseTokens"],
      resolve: (context) => firstDefined(context.runtime.maxResponseTokens, context.prompt.maxResponseTokens),
    })
    .register({
      name: "original",
      resolve: (context, state) => {
        if (state.didUseOriginal) return "";
        state.didUseOriginal = true;
        return context.prompt.original;
      },
    });
}

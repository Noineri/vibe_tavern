import type { MacroCategory, MacroResolver } from "./macro-registry.js";
import { formatExampleDialogue } from "./macro-example-dialogue.js";

type CharacterMacroCategory = Pick<typeof MacroCategory, "Character">;

/** Registers character-card field resolvers with their ST aliases. */
export function registerCharacterMacroResolvers(
  register: (resolver: MacroResolver) => void,
  categories: CharacterMacroCategory,
): void {
  register({
    name: "description",
    aliases: ["charDescription"],
    description: "The character's description field.",
    category: categories.Character,
    resolve: (_args, context) => context.character.description ?? "",
  });

  register({
    name: "personality",
    aliases: ["charPersonality"],
    description: "The character's personality field.",
    category: categories.Character,
    resolve: (_args, context) => context.character.personality ?? "",
  });

  register({
    name: "scenario",
    aliases: ["charScenario"],
    description: "The character's scenario field.",
    category: categories.Character,
    resolve: (_args, context) => context.character.scenario ?? "",
  });

  register({
    name: "mesExamplesRaw",
    description: "The character's example dialogue, raw text.",
    category: categories.Character,
    resolve: (_args, context) => context.character.mesExample ?? "",
  });

  register({
    name: "mesExamples",
    description: "The character's example dialogue, formatted into example blocks.",
    category: categories.Character,
    resolve: (_args, context) => formatExampleDialogue(context.character.mesExample ?? ""),
  });

  register({
    name: "charFirstMessage",
    aliases: ["greeting"],
    description: "The character's first message / greeting.",
    category: categories.Character,
    resolve: (_args, context) => context.character.firstMessage ?? "",
  });

  register({
    name: "charCreatorNotes",
    aliases: ["creatorNotes"],
    description: "The character's creator notes.",
    category: categories.Character,
    resolve: (_args, context) => context.character.creatorNotes ?? "",
  });

  register({
    name: "charDepthPrompt",
    description: "The character's depth-prompt.",
    category: categories.Character,
    resolve: (_args, context) => context.character.depthPrompt ?? "",
  });

  register({
    name: "charVersion",
    aliases: ["version", "char_version"],
    description: "The character's version string.",
    category: categories.Character,
    resolve: (_args, context) => context.character.version?.title ?? "",
  });
}

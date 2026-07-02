import { CoauthorModule } from "@vibe-tavern/api-contracts";

const SEED_MODULES: CoauthorModule[] = [
  {
    id: "default",
    name: "Default Co-Author",
    description: "A balanced co-author module for general roleplay, scene continuation, and editing.",
    basePromptFile: "coauthor/modules/default.md",
    skillIds: ["general-writing"],
    toolSet: {
      edit_profile: true,
      edit_personality: true,
      edit_scenario: true,
      edit_examples: true,
      edit_greeting: true,
      add_alt_greeting: true,
      edit_alt_greeting: true,
    },
    maxSteps: 5,
  },
  {
    id: "profile-editor",
    name: "Profile Editor",
    description: "Focuses entirely on refining character profiles, personalities, and scenarios.",
    basePromptFile: "coauthor/modules/profile-editor.md",
    skillIds: ["profile-analysis"],
    toolSet: {
      edit_profile: true,
      edit_personality: true,
      edit_scenario: true,
    },
    maxSteps: 3,
  },
  {
    id: "dialogue-writer",
    name: "Dialogue Writer",
    description: "Specializes in writing character greetings and example dialogue.",
    basePromptFile: "coauthor/modules/dialogue-writer.md",
    skillIds: ["dialogue-generation"],
    toolSet: {
      edit_examples: true,
      edit_greeting: true,
      add_alt_greeting: true,
      edit_alt_greeting: true,
    },
    maxSteps: 3,
  },
];

export function getCoauthorModules(): CoauthorModule[] {
  return SEED_MODULES;
}

export function getCoauthorModule(id: string | null | undefined): CoauthorModule {
  if (!id) return SEED_MODULES[0];
  const found = SEED_MODULES.find((m) => m.id === id);
  return found || SEED_MODULES[0];
}

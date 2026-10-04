import type { PromptAssemblyContext } from "./types.js";
import { buildPromptVariableContext, type PromptVariableContext } from "./prompt-variable-context.js";

/** Build the macro context shared by all fields in one prompt assembly. */
export function buildAssemblyVariableContext(context: PromptAssemblyContext): PromptVariableContext {
  return buildPromptVariableContext({
    outlets: context.outletEntries ?? {},
    character: {
      name: context.character.name,
      description: context.character.description,
      personality: context.character.personality ?? null,
      scenario: context.character.scenario ?? null,
      systemPrompt: context.character.systemPrompt ?? null,
      mesExample: context.character.mesExample ?? null,
      postHistoryInstructions: context.character.postHistoryInstructions ?? null,
    },
    persona: {
      name: context.persona?.name ?? "User",
      description: context.persona?.description ?? "",
      pronouns: context.persona?.pronouns ?? null,
      pronounForms: context.persona?.pronounForms ?? null,
    },
    prompt: {
      system: context.preset?.text ?? "",
      jailbreak: context.preset?.jailbreak ?? "",
      summary: context.preset?.summary ?? "",
      tools: context.preset?.tools ?? context.instructions?.toolInstructions ?? "",
      contextBudget: context.config?.contextBudget ?? null,
    },
    chat: {
      id: context.identity.chatId,
      messages: context.chat.recentMessages,
      messageIds: context.chat.recentMessages.map((message) => message.id),
    },
    runtime: {
      contextBudget: context.config?.contextBudget ?? null,
      maxPromptTokens: context.config?.contextBudget ?? null,
    },
  });
}

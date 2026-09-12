import type { AiAssistantMode } from "../types.js";
import {
  DefaultAiAssistantAssembler,
  MessageAiAssistantAssembler,
  type AiAssistantAssembler,
} from "./ai-assistant-assembler.js";

export const AI_ASSISTANT_ASSEMBLERS = {
  script: DefaultAiAssistantAssembler,
  dice_script: DefaultAiAssistantAssembler,
  lore_entry: DefaultAiAssistantAssembler,
  lore_keys: DefaultAiAssistantAssembler,
  chat_impersonate: DefaultAiAssistantAssembler,
  md_import: DefaultAiAssistantAssembler,
  vision_describe: DefaultAiAssistantAssembler,
  scene_schema: DefaultAiAssistantAssembler,
  scene_rules: DefaultAiAssistantAssembler,
  // Regex-rule authoring (REGEX_AI_ASSISTANT_PLAN): background-LLM route,
  // no chat context — the default assembler fits.
  regex: DefaultAiAssistantAssembler,
  message_edit: MessageAiAssistantAssembler,
  message_merge: MessageAiAssistantAssembler,
  // TPE-2 (AN-1): same assembler as edit/merge — it feeds the selected
  // variant's content to the model; only the system prompt differs (the
  // annotate contract: insert canonical [tag] tokens, never touch words).
  message_tts_annotate: MessageAiAssistantAssembler,
} as const satisfies Record<AiAssistantMode, AiAssistantAssembler>;

export function getAiAssistantAssembler(mode: AiAssistantMode): AiAssistantAssembler {
  return AI_ASSISTANT_ASSEMBLERS[mode];
}

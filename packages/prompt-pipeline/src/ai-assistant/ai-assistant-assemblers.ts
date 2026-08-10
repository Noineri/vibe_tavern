import type { AiAssistantMode } from "../types.js";
import {
  DefaultAiAssistantAssembler,
  MessageAiAssistantAssembler,
  type AiAssistantAssembler,
} from "./ai-assistant-assembler.js";

export const AI_ASSISTANT_ASSEMBLERS = {
  script: DefaultAiAssistantAssembler,
  dice_script: DefaultAiAssistantAssembler,
  interactive_rules: DefaultAiAssistantAssembler,
  lore_entry: DefaultAiAssistantAssembler,
  lore_keys: DefaultAiAssistantAssembler,
  chat_impersonate: DefaultAiAssistantAssembler,
  md_import: DefaultAiAssistantAssembler,
  vision_describe: DefaultAiAssistantAssembler,
  scene_schema: DefaultAiAssistantAssembler,
  scene_rules: DefaultAiAssistantAssembler,
  message_edit: MessageAiAssistantAssembler,
  message_merge: MessageAiAssistantAssembler,
} as const satisfies Record<AiAssistantMode, AiAssistantAssembler>;

export function getAiAssistantAssembler(mode: AiAssistantMode): AiAssistantAssembler {
  return AI_ASSISTANT_ASSEMBLERS[mode];
}

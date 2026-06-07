export { assemblePrompt } from "./assemble.js";
export { activateLoreEntries, type ActivatableLoreEntry } from "./lore-activation.js";
export { createPhaseOneMacroEngine, createFullMacroEngine } from "./macro-registry.js";
export { buildPromptVariableContext } from "./prompt-variable-context.js";
export { PROMPT_LAYER_ID, PROMPT_LAYER_PRIORITY, LAYER_MODES } from "./prompt-layer-constants.js";
export { setTokenCountFn, setModelHint, estimateMessageArrayTokens } from "./compaction.js";
export type { AssemblyMode, AiAssistantMode, PromptAssemblyContext, PromptAssemblyResult, PromptLayer, RecentMessage } from "./types.js";

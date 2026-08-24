export { assemblePrompt } from "./assemble.js";
export { getSummaryStrategy, SUMMARY_STRATEGIES } from "./summary/summary-strategies.js";
export { getAiAssistantAssembler, AI_ASSISTANT_ASSEMBLERS } from "./ai-assistant/ai-assistant-assemblers.js";
export { getInsightsAssembler, INSIGHTS_ASSEMBLERS } from "./insights/insights-assemblers.js";
export type { AiAssistantAssembler } from "./ai-assistant/ai-assistant-assembler.js";
export type { InsightsAssembler, InsightsKind } from "./insights/insights-assembler.js";
export type { SummaryStrategy } from "./summary/summary-strategy.js";
export { activateLoreEntries, type ActivatableLoreEntry } from "./lore-activation.js";
export { parseFindRegex, compileRegexScript, filterRegexPresets, applyRegexLayer, applyRegexToChatHistory, escapeRegexLiteral, createValueEscapingMacroSource } from "./regex-engine.js";
export type { ParsedFindRegex, RegexMacroSource, CompiledRegexScript, RegexHistoryMessage } from "./regex-engine.js";
export { createPhaseOneMacroEngine, createFullMacroEngine, getMacroCatalog, extractMacroNames } from "./macro-registry.js";
export type { MacroCatalogEntry, MacroCategory } from "./macro-registry.js";
export { PRESET_PRONOUN_FORMS, resolvePronounForms } from "./pronoun-forms.js";
export { buildPromptVariableContext } from "./prompt-variable-context.js";
export { PROMPT_LAYER_ID, PROMPT_LAYER_PRIORITY } from "./prompt-layer-constants.js";
export { formatSceneHistory, escapeXml, type SceneInjectionEntry, type SceneInjectionFormat } from "./scene-injection.js";
export { setTokenCountFn, setModelHint, estimateMessageArrayTokens, findSafeCompactionBoundary, planHistoryCompaction, estimateTokens } from "./compaction.js";
// ─── Experience model-effect prompt (IR-41, Wave 4) ───────────────────────────
// Pure frozen-RP-context construction + budget reduction, and fixed-order model
// prompt assembly → AssemblePromptResponse. No I/O; the experience services
// (IR-42 / IR-43) resolve inputs and call these.
export {
	buildExperienceContext,
	characterSnapshotText,
	personaSnapshotText,
	type ExperienceBudget,
	type ExperienceContextBundle,
	type ExperienceContextCharacter,
	type ExperienceContextInput,
	type ExperienceContextMessage,
	type ExperienceContextPersona,
	type ExperienceContextSummary,
	type ExperienceContextTokenAccounting,
} from "./experience-context.js";
export { buildExperienceModelPrompt, type ExperienceModelPromptInput } from "./experience-model-prompt.js";
export type { AiAssistantMode, PromptAssemblyContext, PromptAssemblyResult, PromptLayer, RecentMessage } from "./types.js";

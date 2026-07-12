import { assembleSummaryPrompt } from "../assemble.js";
import type { PromptAssemblyContext, PromptAssemblyResult } from "../types.js";

/** Pure assembly seam for chat summaries. */
export interface SummaryStrategy {
  assemble(context: PromptAssemblyContext): PromptAssemblyResult;
}

export const DefaultSummaryStrategy: SummaryStrategy = {
  assemble: assembleSummaryPrompt,
};

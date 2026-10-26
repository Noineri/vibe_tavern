import type { RegexPreset } from "@vibe-tavern/domain";
import { createFullMacroEngine, type MacroEngine } from "./macro-registry.js";
import {
  applyRegexToChatHistory,
  createValueEscapingMacroSource,
  type RegexMacroSource,
} from "./regex-engine.js";
import { formatDiceMessageBlock } from "./dice-message-format.js";
import { formatExperienceMessageBlock } from "./experience-report.js";
import type { PromptVariableContext } from "./prompt-variable-context.js";
import type { RecentMessage } from "./types.js";

/**
 * The ONE source for "what the model sees of a history message" (SIDECHAT_PLAN
 * SC-2a). Extracted move-verbatim from applyMacrosToContext in assemble.ts:
 * prompt-placement regex presets on the RAW text → macro resolution → the dice
 * block and the experience-report block appended. assemblePrompt calls this for
 * its history window; the whole-branch sidechat reader (services/api,
 * rp-branch-view.ts → resolveHistoryAsModelSees) calls the same transform for
 * an entire branch. The logic here must stay byte-identical to the inline
 * closure it replaced — the RP prompt is pinned by assembly tests.
 *
 * Inputs are exactly what the closure read from the surrounding assembly pass
 * (now passed explicitly — see HistoryMessageTransformInputs docs).
 */
export interface HistoryMessageTransformInputs {
  /** The chat's active regex presets, unfiltered (mode filtering is
   *  applyRegexToChatHistory's authoritative gate). */
  regexPresets: RegexPreset[];
  /** First-stage variable context built from the RAW character/persona fields
   *  — the context find-pattern macros of regex presets resolve against. */
  baseVariableContext: PromptVariableContext;
  /** Second-stage variable context built from the RESOLVED character/persona
   *  fields — the context message content macros resolve against. */
  variableContext: PromptVariableContext;
  /** The assembly's content macro engine (carries the service-provided
   *  variable scope when one bridges activation and assembly). */
  macroEngine: MacroEngine;
}

export function transformHistoryMessages(
  messages: RecentMessage[],
  inputs: HistoryMessageTransformInputs,
): RecentMessage[] {
  // RX-13 assembled-prompt regex seam: prompt-affecting presets (ST
  // `promptOnly` — "prompt" / "display+prompt" apply-targets) transform the
  // RAW stored message text before macro resolution below (ST parity: the
  // regex sees the unexpanded text; find-pattern macros resolve only via the
  // preset's own substituteRegex mode). The macro source rides a FRESH engine
  // per assembly (RX-8 rule) so find-pattern variable state never leaks into
  // content macro state. persist presets are excluded inside
  // applyRegexToChatHistory (they already applied at generation time, RX-5/8);
  // display-only presets belong to the client render seam.
  const regexPresets = inputs.regexPresets;
  let regexMacroSource: RegexMacroSource | undefined;
  if (regexPresets.length > 0) {
    const regexMacroEngine = createFullMacroEngine();
    regexMacroSource = createValueEscapingMacroSource((text) =>
      regexMacroEngine.resolve(text, inputs.baseVariableContext),
    );
  }

  // SINGLE DERIVATION SEAM (Wave B5 / DICE-B13, extended IR-52): effective
  // message content is derived ONCE here — prompt-regex-transformed prose
  // (RX-13: same array when no prompt-mode preset applies), macro-resolved,
  // plus the
  // compact Dice block (when the message carries bound rolls) PLUS the
  // delimited experience-report block (when it carries a frozen public
  // report). Every downstream consumer (compaction token-counting via
  // formatRecentMessages, the history layer text, and the final payload
  // mapping in finalizeAssembly) reads this same effective content, so
  // neither Dice nor experience text is undercounted or appended twice.
  // Absent diceRolls / experienceReports → no-op (content unchanged).
  // The regex transform runs on the RAW stored content (before macros),
  // and only on the prose — structured dice/experience blocks are appended
  // after, outside regex reach.
  return applyRegexToChatHistory(messages, regexPresets, regexMacroSource).map((msg) => {
    // Same guard semantics as assemble.ts's applyMacros over a `string`
    // field: "" stays "" (MacroEngine.resolveWith returns falsy text
    // unchanged, so the direct call is byte-identical without re-deriving
    // that helper here).
    const baseContent = msg.content
      ? inputs.macroEngine.resolve(msg.content, inputs.variableContext)
      : "";
    const diceBlock = msg.diceRolls?.length
      ? formatDiceMessageBlock(msg.diceRolls)
      : "";
    const experienceBlock = msg.experienceReports?.length
      ? formatExperienceMessageBlock(msg.experienceReports)
      : "";
    const appended = [diceBlock, experienceBlock].filter((block) => block.length > 0).join("\n");
    return {
      ...msg,
      content: appended ? `${baseContent}\n${appended}` : baseContent,
    };
  });
}

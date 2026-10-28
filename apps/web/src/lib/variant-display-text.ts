import type { RegexPreset } from "@vibe-tavern/domain";
import { applyRegexLayer, createValueEscapingMacroSource } from "@vibe-tavern/prompt-pipeline";
import { replaceUiMacros, type MacroContext } from "./macros.js";

type VariantDisplayOptions = {
  macroContext: MacroContext | null;
  /** Already filtered for display mode, placement and message depth. */
  presets: RegexPreset[];
  /** False for an already resolved base, or the Co-Author literal-base path. */
  resolveBaseMacros?: boolean;
};

/** One render-only pipeline for static content and every carousel variant.
 * Never write the output back into the canonical message or variant data. */
export function deriveVariantDisplayText(content: string, options: VariantDisplayOptions): string {
  const { macroContext, presets, resolveBaseMacros = true } = options;
  const resolve = (text: string) => macroContext ? replaceUiMacros(text, macroContext) : text;
  const base = resolveBaseMacros ? resolve(content) : content;
  if (!base || presets.length === 0) return base;
  const output = applyRegexLayer(base, presets, createValueEscapingMacroSource(resolve));
  // Keep RX-13/R-14's single post-layer pass: replacement-introduced macros
  // resolve too, without changing the accepted ST per-script timing delta.
  return resolve(output);
}

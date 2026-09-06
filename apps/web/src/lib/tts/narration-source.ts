import type { AppMessage } from "../../api/types.js";
import { readTtsNarrationMode } from "../local-storage.js";
import { replaceUiMacros, type MacroContext } from "../macros.js";
import { narrationTextOptionsForMode, prepareNarrationTextPreservingTags } from "./narration-text.js";

/** TPE-18a: the single seam that turns a chat message into narration input —
 *  the selected variant's TTS annotation when present (authored FOR
 *  narration), else the variant content; UI macros resolved (never speak
 *  `{{user}}` raw — TPE-19), then the standard narration text preparation.
 *  Shared by the manual button (useMessageNarration), auto-narrate
 *  (useAutoNarrate) and the playlist panel so all three speak byte-identical
 *  text for the same message. */
export interface VoicedVariantSource {
  /** Final prepared narration text (what the synthesizer receives). */
  text: string;
  variantId: string;
  variantIndex: number;
  /** First two lines of the voiced text (owner decision, playlist rows). */
  snippet: string;
}

export function firstTwoLines(text: string): string {
  return text.split("\n").slice(0, 2).join("\n");
}

export function voicedVariantSource(
  message: AppMessage | null | undefined,
  macroContext: MacroContext | null,
  isCoauthor: boolean,
): VoicedVariantSource | null {
  if (!message) return null;
  const variants = message.variants;
  // Variant-less messages (streaming/settle edge) fall back to the
  // message content itself — the historical auto-narrate seam. The
  // variant pointer is empty but the text stays speakable.
  const selected =
    variants.length === 0
      ? undefined
      : ((message.selectedVariantIndex !== null && message.selectedVariantIndex !== undefined
          ? variants[message.selectedVariantIndex]
          : undefined) ??
        variants.find((variant) => variant.isSelected) ??
        variants[0]);
  const raw = selected?.ttsAnnotation ?? selected?.content ?? message.content;
  const base = macroContext && !isCoauthor ? replaceUiMacros(raw, macroContext) : raw;
  const text = prepareNarrationTextPreservingTags(base, {
    regexPresets: [],
    skipCodeblocks: true,
    stripHtml: true,
    ...narrationTextOptionsForMode(readTtsNarrationMode()),
  });
  if (text.trim().length === 0) return null;
  return {
    text,
    variantId: selected ? String(selected.id) : "",
    variantIndex: selected?.variantIndex ?? 0,
    snippet: firstTwoLines(text),
  };
}

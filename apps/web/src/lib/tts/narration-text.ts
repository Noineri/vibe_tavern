import type { RegexPreset } from "@vibe-tavern/domain";
import { applyRegexLayer, type RegexMacroSource } from "@vibe-tavern/prompt-pipeline";

export interface NarrationTextOptions {
  /** Apply these (already-filtered) regex presets to the raw text first. */
  regexPresets: RegexPreset[];
  macroSource?: RegexMacroSource;
  /** Remove fenced ``` code blocks entirely. Default false. */
  skipCodeblocks: boolean;
  /** Strip HTML tags + decode the common entities. Default false. */
  stripHtml: boolean;
  /** Remove *action* spans (content too); strip **bold** markers keeping content. Default false. */
  stripAsteriskActions: boolean;
  /** Keep only quoted dialogue; if NO quotes found, keep the full text (fallback). Default false. */
  quotedOnly: boolean;
}

/** Pre-narration text pipeline (TTS_PLAN TS-10). Stage order is FIXED:
 *  regex layer → stripHtml → skipCodeblocks → stripAsteriskActions → quotedOnly → whitespace collapse + trim.
 *  Returns "" when nothing survives the filters (the orchestrator's
 *  splitParagraphs then yields zero paragraphs → immediate complete). */
export function prepareNarrationText(text: string, options: NarrationTextOptions): string {
  let out = text;

  // 1. regex layer — already-filtered presets, array order.
  if (options.regexPresets.length > 0) {
    out = applyRegexLayer(out, options.regexPresets, options.macroSource);
  }

  // 2. stripHtml
  if (options.stripHtml) {
    out = stripHtml(out);
  }

  // 3. skipCodeblocks — fenced ``` blocks
  if (options.skipCodeblocks) {
    out = stripCodeblocks(out);
  }

  // 4. stripAsteriskActions
  if (options.stripAsteriskActions) {
    out = stripAsteriskActions(out);
  }

  // 5. quotedOnly
  if (options.quotedOnly) {
    out = extractQuotedOnly(out);
  }

  // 6. whitespace collapse + trim
  out = out.replace(/\s+/g, " ").trim();

  return out;
}

/** Convenience factory: every filter off, no regex presets. */
export function defaultNarrationTextOptions(): NarrationTextOptions {
  return {
    regexPresets: [],
    macroSource: undefined,
    skipCodeblocks: false,
    stripHtml: false,
    stripAsteriskActions: false,
    quotedOnly: false,
  };
}

function stripHtml(input: string): string {
  // Replace tags with a space so block boundaries don't join words (e.g. <br>).
  let out = input.replace(/<[^>]*>/g, " ");
  // Decode common entities via naive literal replacement — no full table needed.
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return out;
}

function stripCodeblocks(input: string): string {
  // Fenced blocks ``` ... ``` with optional language tag, non-greedy, multiline.
  // Matches ```lang?\n ... ``` including the fences and interior.
  return input.replace(/```[\s\S]*?```/g, " ");
}

function stripAsteriskActions(input: string): string {
  let out = input;
  // **bold** → bold  (strip the paired markers, keep content). Must run before
  // single-asterisk removal so **bold** doesn't become an empty single-span.
  out = out.replace(/\*\*([^*]+?)\*\*/g, "$1");
  // *action* spans with content → removed entirely. Underscore _emphasis_ is
  // intentionally NOT touched in this slice (word-internal underscores make
  // naive removal unsafe).
  out = out.replace(/\*[^*]*?\*/g, "");
  // Unmatched trailing/remaining asterisks → stripped.
  out = out.replace(/\*/g, "");
  return out;
}

function extractQuotedOnly(input: string): string {
  const parts: string[] = [];
  // Quote forms: ASCII "…", «…», curly “…” . Newlines inside are kept here
  // and collapsed later by the final whitespace step.
  const re = /"([^"]*?)"|«([^»]*?)»|“([^”]*?)”/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const inner = match[1] ?? match[2] ?? match[3] ?? "";
    // Keep even empty inner? Join will collapse, but avoid pushing empty that
    // would add extra spaces. Preserve non-empty after trim? Spec: join kept
    // quoted contents. Empty quotes contribute nothing.
    if (inner.length > 0) {
      parts.push(inner);
    }
  }
  if (parts.length === 0) {
    // Fallback — never narrate silence for quote-less messages.
    return input;
  }
  return parts.join(" ");
}

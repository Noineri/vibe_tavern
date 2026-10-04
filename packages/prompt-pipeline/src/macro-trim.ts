/** A minimal token shape used to find a scoped trim block's closing marker. */
export interface TrimMacroToken {
  type: string;
  value: string;
}

/** Private evaluation marker for ST's non-scoped trim post-processing. */
export const TRIM_LINE_BREAK_MARKER = "\uE000vt-trim-line-break\uE001";

/** Find the matching closing marker for a scoped {{trim}} block. */
export function findTrimClose(
  tokens: readonly TrimMacroToken[],
  from: number,
  end: number,
): number {
  let depth = 0;

  for (let i = from; i < end; i++) {
    if (tokens[i].type === "macro" && tokens[i].value.toLowerCase() === "trim") {
      depth++;
    } else if (tokens[i].type === "trimClose") {
      if (depth === 0) return i;
      depth--;
    }
  }

  return -1;
}

/**
 * A non-scoped {{trim}} is a post-processing marker in ST: it consumes the
 * line breaks on both sides after every macro in the text has resolved.
 */
export function removeTrimmedLineBreaks(text: string): string {
  return text.replace(new RegExp(`(?:\\r?\\n)?${TRIM_LINE_BREAK_MARKER}(?:\\r?\\n)?`, "g"), "");
}

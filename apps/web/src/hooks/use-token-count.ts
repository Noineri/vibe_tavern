/**
 * React hook that returns the cl100k_base token count for a string.
 * Memoized — only recalculates when text changes.
 */

import { useMemo } from "react";
import { countTokens } from "../utils/tokenizer";

export function useTokenCount(text: string): number {
	return useMemo(() => countTokens(text), [text]);
}

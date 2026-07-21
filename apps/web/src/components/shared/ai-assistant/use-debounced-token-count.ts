import { useEffect, useState } from "react";
import { countAiAssistantTokens, type AiAssistantRequestBody } from "../../../app-client.js";

export interface AiTokenCount {
  tokens: number;
  model: string;
  layerCount: number;
  messageCount: number;
  activatedLoreCount: number;
}

/**
 * Debounced (250 ms) token + assembled-context estimate for an AI-assistant
 * request body. Encapsulates the debounce + AbortController + abort-on-unmount
 * skeleton that `AiAssistantModal` and `MessageAiEditorModal` previously
 * inlined verbatim (AI_ASSISTANT_SHELL_REFACTOR_REPORT Step 1).
 *
 * - `body === null` (or `enabled === false`) → returns `null` and no request
 *   fires. The previous estimate is cleared, so closing a modal resets it.
 * - While `body` changes semantically, the previous estimate stays visible
 *   until the debounced call resolves (no flicker while typing).
 * - The body is serialized for effect identity, so callers may build a fresh
 *   object literal every render without retriggering the fetch.
 */
export function useDebouncedTokenCount(
  body: AiAssistantRequestBody | null,
  opts?: { enabled?: boolean },
): AiTokenCount | null {
  const [count, setCount] = useState<AiTokenCount | null>(null);
  const enabled = opts?.enabled ?? true;
  const bodyKey = body === null ? null : JSON.stringify(body);

  useEffect(() => {
    if (!enabled || bodyKey === null) {
      setCount(null);
      return;
    }
    const request = JSON.parse(bodyKey) as AiAssistantRequestBody;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      countAiAssistantTokens(request, { signal: ac.signal })
        .then((result) => setCount(result))
        .catch((err: unknown) => {
          if (!(err instanceof Error && err.name === "AbortError")) setCount(null);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [enabled, bodyKey]);

  return count;
}

import { REASONING_END_MARKER, REASONING_START_MARKER } from "../ai/openai-reasoning-fetch.js";

export interface AiAssistantStreamChunk {
  type: "text" | "reasoning" | "error" | "done";
  text?: string;
  error?: string;
}

export interface ReasoningSplitState {
  buffer: string;
  insideMarkerReasoning: boolean;
  insideThinkTag: boolean;
}

const THINK_START = "<think";
const THINK_END = "</think>";

function findEarliestToken(input: string, tokens: readonly string[]): { token: string; index: number } | null {
  let best: { token: string; index: number } | null = null;
  for (const token of tokens) {
    const index = input.indexOf(token);
    if (index !== -1 && (!best || index < best.index)) {
      best = { token, index };
    }
  }
  return best;
}

function partialPrefixLength(input: string, tokens: readonly string[]): number {
  const max = Math.min(input.length, Math.max(...tokens.map((token) => token.length - 1)));
  for (let length = max; length > 0; length--) {
    const suffix = input.slice(-length);
    if (tokens.some((token) => token.startsWith(suffix))) return length;
  }
  return 0;
}

function pushChunk(
  out: AiAssistantStreamChunk[],
  type: "text" | "reasoning",
  text: string,
): void {
  if (text) out.push({ type, text });
}

export function splitReasoningFromText(
  state: ReasoningSplitState,
  chunk: string,
  options: { flush?: boolean } = {},
): AiAssistantStreamChunk[] {
  const out: AiAssistantStreamChunk[] = [];
  state.buffer += chunk;

  while (state.buffer.length > 0) {
    if (state.insideThinkTag) {
      const endIndex = state.buffer.indexOf(THINK_END);
      if (endIndex === -1) {
        const keep = options.flush ? 0 : partialPrefixLength(state.buffer, [THINK_END]);
        const emitLength = state.buffer.length - keep;
        pushChunk(out, "reasoning", state.buffer.slice(0, emitLength));
        state.buffer = state.buffer.slice(emitLength);
        break;
      }
      pushChunk(out, "reasoning", state.buffer.slice(0, endIndex));
      state.buffer = state.buffer.slice(endIndex + THINK_END.length);
      state.insideThinkTag = false;
      continue;
    }

    if (state.insideMarkerReasoning) {
      const endIndex = state.buffer.indexOf(REASONING_END_MARKER);
      if (endIndex === -1) {
        const keep = options.flush ? 0 : partialPrefixLength(state.buffer, [REASONING_END_MARKER]);
        const emitLength = state.buffer.length - keep;
        pushChunk(out, "reasoning", state.buffer.slice(0, emitLength));
        state.buffer = state.buffer.slice(emitLength);
        break;
      }
      pushChunk(out, "reasoning", state.buffer.slice(0, endIndex));
      state.buffer = state.buffer.slice(endIndex + REASONING_END_MARKER.length);
      state.insideMarkerReasoning = false;
      continue;
    }

    const token = findEarliestToken(state.buffer, [REASONING_START_MARKER, THINK_START]);
    if (!token) {
      const keep = options.flush ? 0 : partialPrefixLength(state.buffer, [REASONING_START_MARKER, THINK_START]);
      const emitLength = state.buffer.length - keep;
      pushChunk(out, "text", state.buffer.slice(0, emitLength));
      state.buffer = state.buffer.slice(emitLength);
      break;
    }

    pushChunk(out, "text", state.buffer.slice(0, token.index));
    state.buffer = state.buffer.slice(token.index);

    if (state.buffer.startsWith(REASONING_START_MARKER)) {
      state.buffer = state.buffer.slice(REASONING_START_MARKER.length);
      state.insideMarkerReasoning = true;
      continue;
    }

    const thinkTagEnd = state.buffer.indexOf(">");
    if (thinkTagEnd === -1) break;
    state.buffer = state.buffer.slice(thinkTagEnd + 1);
    state.insideThinkTag = true;
  }

  return out;
}
